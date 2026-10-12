import type { AddressInfo } from "node:net";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { getConfig } from "../src/config.js";
import { createApp } from "../src/server.js";
import { FakeLlm, sampleExtraction } from "./fixtures.js";

const llm = new FakeLlm({
  record_call: sampleExtraction,
  save_drafts: { drafts: [{ label: "Recap", subject: "Next steps", body: "Hi Thandi,\n\nThank you.\n\nSox" }] },
});
const cfg = getConfig({ CRM: "none", APP_API_KEY: "secret" } as NodeJS.ProcessEnv);
const server = createApp(cfg, () => llm);
let base = "";

beforeAll(async () => {
  await new Promise<void>((r) => server.listen(0, r));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});
afterAll(() => server.close());

const post = (path: string, body: unknown, key = "secret") =>
  fetch(`${base}${path}`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${key}` },
    body: JSON.stringify(body),
  });

describe("HTTP API", () => {
  it("serves health without auth", async () => {
    expect((await fetch(`${base}/health`)).status).toBe(200);
  });

  it("rejects a wrong API key", async () => {
    expect((await post("/api/notes", { notes: "x" }, "nope")).status).toBe(401);
  });

  it("validates input", async () => {
    expect((await post("/api/notes", {})).status).toBe(400);
    expect((await post("/api/notes", { notes: "x", crm: "salesforce" })).status).toBe(400);
  });

  it("extracts notes", async () => {
    const res = await post("/api/notes", { notes: "call notes" });
    const json = await res.json();
    expect(res.status).toBe(200);
    expect(json.extraction.account.companyName).toBe("Kestrel Foods");
    expect(json.crm.crm).toBe("none");
  });

  it("drafts a follow-up from a saved extraction without re-extracting", async () => {
    const before = llm.calls.length;
    const res = await post("/api/followup", { extraction: sampleExtraction, tone: "formal" });
    const json = await res.json();
    expect(res.status).toBe(200);
    expect(json.drafts[0].subject).toBe("Next steps");
    expect(json.eml[0]).toContain("Subject: Next steps");
    expect(llm.calls.slice(before).map((c) => c.toolName)).toEqual(["save_drafts"]);
  });
});
