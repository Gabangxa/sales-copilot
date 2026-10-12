import { describe, expect, it } from "vitest";
import { extractCallNotes, buildExtractionPrompt } from "../src/notes/extract.js";
import { markdownToSimpleHtml, renderNoteMarkdown } from "../src/notes/render.js";
import { callExtractionJsonSchema } from "../src/schema.js";
import { FakeLlm, sampleExtraction } from "./fixtures.js";

describe("extractCallNotes", () => {
  it("returns a validated record and forces the record_call tool", async () => {
    const llm = new FakeLlm({ record_call: sampleExtraction });
    const out = await extractCallNotes(llm, "some notes", { meetingDate: "2026-10-12" });
    expect(out.account.companyName).toBe("Kestrel Foods");
    expect(llm.calls[0]!.toolName).toBe("record_call");
    expect(llm.calls[0]!.user).toContain("2026-10-12");
    expect(llm.calls[0]!.user).toContain("<call_notes>");
  });

  it("rejects malformed model output", async () => {
    const llm = new FakeLlm({ record_call: { summary: "missing everything else" } });
    await expect(extractCallNotes(llm, "notes")).rejects.toThrow(/does not match the schema/);
  });

  it("rejects empty notes before calling the model", async () => {
    const llm = new FakeLlm({});
    await expect(extractCallNotes(llm, "   ")).rejects.toThrow(/empty/);
    expect(llm.calls).toHaveLength(0);
  });

  it("fills a missing meeting date from the option", async () => {
    const llm = new FakeLlm({ record_call: { ...sampleExtraction, meeting: { ...sampleExtraction.meeting, date: null } } });
    const out = await extractCallNotes(llm, "notes", { meetingDate: "2026-10-01" });
    expect(out.meeting.date).toBe("2026-10-01");
  });

  it("includes seller and context in the prompt", () => {
    const p = buildExtractionPrompt("x", { sellerName: "Sox", sellerCompany: "SGX FX", context: "renewal" });
    expect(p).toContain("Sox at SGX FX");
    expect(p).toContain("renewal");
  });

  it("produces a tool schema the API accepts", () => {
    expect(callExtractionJsonSchema.type).toBe("object");
    expect(callExtractionJsonSchema).not.toHaveProperty("$schema");
  });
});

describe("rendering", () => {
  it("renders the key sections as markdown", () => {
    const md = renderNoteMarkdown(sampleExtraction);
    expect(md).toContain("## Next steps");
    expect(md).toContain("USD/ZAR");
    expect(md).toContain("(due 2026-10-15)");
    expect(md).not.toMatch(/—/);
  });

  it("converts to safe HTML for HubSpot", () => {
    const html = markdownToSimpleHtml("**Bold** <script>\n\n## Next steps\n- one\n- two");
    expect(html).toContain("<strong>Bold</strong> &lt;script&gt;");
    expect(html).toContain("<h3>Next steps</h3><ul><li>one</li><li>two</li></ul>");
  });
});
