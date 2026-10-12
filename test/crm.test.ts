import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { FileAdapter } from "../src/crm/file.js";
import { HUBSPOT_ASSOC, HubSpotAdapter } from "../src/crm/hubspot.js";
import { TwentyAdapter } from "../src/crm/twenty.js";
import { mockFetch, sampleExtraction } from "./fixtures.js";

describe("TwentyAdapter", () => {
  const routes = (): Parameters<typeof mockFetch>[0] => [
    ["GET /rest/companies", () => ({ data: { companies: [{ id: "co-1", name: "Kestrel Foods" }] } })],
    ["GET /rest/people", () => ({ data: { people: [{ id: "p-1" }] } })],
    ["POST /rest/notes", () => ({ data: { createNote: { id: "note-1" } } })],
    ["POST /rest/noteTargets", () => ({ data: { createNoteTarget: { id: "nt" } } })],
    ["POST /rest/tasks", () => ({ data: { createTask: { id: "task-1" } } })],
    ["POST /rest/taskTargets", () => ({ data: { createTaskTarget: { id: "tt" } } })],
    ["PATCH /rest/opportunities/opp-9", () => ({ data: { updateOpportunity: { id: "opp-9" } } })],
  ];

  it("creates a note, our tasks, and links them to company, person and opportunity", async () => {
    const f = mockFetch(routes());
    const a = new TwentyAdapter({ baseUrl: "https://crm.example", apiKey: "k", stageMap: { discovery: "MEETING" } }, f.impl);
    const r = await a.push(sampleExtraction, { dealId: "opp-9", updateStage: true });

    expect(r.noteId).toBe("note-1");
    expect(r.taskIds).toEqual(["task-1"]); // only the "us" step
    expect(r.linked).toEqual({ companyId: "co-1", personIds: ["p-1"], dealId: "opp-9" });
    expect(r.stageUpdated).toEqual({ dealId: "opp-9", stage: "MEETING" });

    const note = f.requests.find((q) => q.url.endsWith("/rest/notes"))!;
    expect(note.body.bodyV2.markdown).toContain("## Next steps");
    const task = f.requests.find((q) => q.url.endsWith("/rest/tasks"))!;
    expect(task.body).toMatchObject({ status: "TODO", dueAt: "2026-10-15T09:00:00.000Z" });
    const noteTargets = f.requests.filter((q) => q.url.endsWith("/rest/noteTargets")).map((q) => q.body);
    expect(noteTargets).toEqual([
      { noteId: "note-1", companyId: "co-1" },
      { noteId: "note-1", personId: "p-1" },
      { noteId: "note-1", opportunityId: "opp-9" },
    ]);
    const companyLookup = f.requests.find((q) => q.url.includes("/rest/companies"))!;
    expect(decodeURIComponent(companyLookup.url)).toContain('name[ilike]:"%Kestrel Foods%"');
  });

  it("writes nothing in dry run", async () => {
    const f = mockFetch(routes());
    const a = new TwentyAdapter({ baseUrl: "https://crm.example", apiKey: "k", stageMap: {} }, f.impl);
    const r = await a.push(sampleExtraction, { dryRun: true });
    expect(f.requests.every((q) => q.method === "GET")).toBe(true);
    expect(r.actions.some((x) => x.startsWith("[dry run] Create note"))).toBe(true);
  });

  it("turns link failures into warnings", async () => {
    const f = mockFetch(routes().filter(([k]) => !k.includes("Targets")));
    const a = new TwentyAdapter({ baseUrl: "https://crm.example", apiKey: "k", stageMap: {} }, f.impl);
    const r = await a.push(sampleExtraction);
    expect(r.noteId).toBe("note-1");
    expect(r.warnings.some((w) => w.includes("noteTargets"))).toBe(true);
  });

  it("warns instead of guessing when the stage map has no entry", async () => {
    const f = mockFetch(routes());
    const a = new TwentyAdapter({ baseUrl: "https://crm.example", apiKey: "k", stageMap: {} }, f.impl);
    const r = await a.push(sampleExtraction, { dealId: "opp-9", updateStage: true });
    expect(r.stageUpdated).toBeUndefined();
    expect(r.warnings.join()).toMatch(/TWENTY_STAGE_MAP/);
  });
});

describe("HubSpotAdapter", () => {
  it("creates an HTML note and tasks with HubSpot-defined associations", async () => {
    const f = mockFetch([
      ["POST /companies/search", () => ({ results: [{ id: "c1", properties: { name: "Kestrel Foods" } }] })],
      ["POST /contacts/search", () => ({ results: [{ id: "ct1", properties: { email: "thandi.mokoena@kestrelfoods.example" } }] })],
      ["POST /crm/v3/objects/notes", () => ({ id: "n1" })],
      ["POST /crm/v3/objects/tasks", () => ({ id: "t1" })],
      ["PATCH /crm/v3/objects/deals/d1", () => ({ id: "d1" })],
    ]);
    const a = new HubSpotAdapter({ accessToken: "x", stageMap: { discovery: "appointmentscheduled" } }, f.impl);
    const r = await a.push(sampleExtraction, { dealId: "d1", updateStage: true });

    expect(r).toMatchObject({ noteId: "n1", taskIds: ["t1"], stageUpdated: { dealId: "d1", stage: "appointmentscheduled" } });
    const note = f.requests.find((q) => q.url.endsWith("/objects/notes"))!;
    expect(note.body.properties.hs_note_body).toContain("<h3>Next steps</h3>");
    expect(note.body.associations.map((x: any) => x.types[0].associationTypeId)).toEqual([
      HUBSPOT_ASSOC.note.company,
      HUBSPOT_ASSOC.note.contact,
      HUBSPOT_ASSOC.note.deal,
    ]);
    const task = f.requests.find((q) => q.url.endsWith("/objects/tasks"))!;
    expect(task.body.properties).toMatchObject({ hs_task_priority: "HIGH", hs_task_status: "NOT_STARTED" });
    const deal = f.requests.find((q) => q.method === "PATCH")!;
    expect(deal.body).toEqual({ properties: { dealstage: "appointmentscheduled" } });
  });
});

describe("FileAdapter", () => {
  it("writes markdown, plain text and JSON", async () => {
    const dir = mkdtempSync(join(tmpdir(), "sc-"));
    const r = await new FileAdapter(dir).push(sampleExtraction);
    expect(r.files).toHaveLength(3);
    const txt = readFileSync(join(dir, "2026-10-12-kestrel-foods.txt"), "utf8");
    expect(txt).toMatch(/^Discovery call: Kestrel Foods treasury \(2026-10-12\)\n=+\n/);
    expect(txt).toContain("\nNEXT STEPS\n- Send indicative USD/ZAR");
    expect(txt).not.toMatch(/\*\*|##/);
    const json = JSON.parse(readFileSync(join(dir, "2026-10-12-kestrel-foods.json"), "utf8"));
    expect(json.account.companyName).toBe("Kestrel Foods");
  });
});
