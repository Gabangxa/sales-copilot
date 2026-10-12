import { describe, expect, it } from "vitest";
import { buildDraftPrompt, draftFollowUp, toEml } from "../src/followup/draft.js";
import { applyStyleRules, expandContractions, loadStyleProfile, parseStyleProfile, removeEmDashes } from "../src/followup/style.js";
import { FakeLlm, sampleExtraction } from "./fixtures.js";

const strictProfile = parseStyleProfile(`---
noEmDashes: true
noContractions: true
maxWords: 50
---
Be brief.

## Signature
Kind regards,
Sox
`);

describe("style profile", () => {
  it("parses front matter, guidance and signature", () => {
    expect(strictProfile.rules).toEqual({ noEmDashes: true, noContractions: true, maxWords: 50 });
    expect(strictProfile.guidance).toBe("Be brief.");
    expect(strictProfile.signature).toBe("Kind regards,\nSox");
  });

  it("loads the bundled default profile", () => {
    const p = loadStyleProfile();
    expect(p.rules.noEmDashes).toBe(true);
    expect(p.signature).toContain("Sox");
    expect(p.guidance).not.toContain("## Signature");
  });

  it("removes em dashes but keeps hyphens and number ranges", () => {
    const r = removeEmDashes("Thanks for today — it was useful. The 2-3 day delay, 9–5 window.");
    expect(r.text).toBe("Thanks for today, it was useful. The 2-3 day delay, 9–5 window.");
    expect(r.count).toBe(1);
  });

  it("expands contractions with sensible casing", () => {
    const r = expandContractions("I'll send it. We're keen. Don't worry, it’s fine. Let's talk. Kestrel's team.");
    expect(r.text).toBe("I will send it. We are keen. Do not worry, it is fine. Let us talk. Kestrel's team.");
    expect(r.count).toBe(5);
  });

  it("reports word count against the limit", () => {
    const r = applyStyleRules("word ".repeat(60), strictProfile);
    expect(r.report.overMaxWords).toBe(true);
  });
});

describe("draftFollowUp", () => {
  it("passes the record, rules and signature to the model and enforces the rules afterwards", async () => {
    const llm = new FakeLlm({
      save_drafts: {
        drafts: [
          {
            label: "Recap and next steps",
            subject: "Kestrel Foods — next steps",
            body: "Hi Thandi,\n\nThanks for today — we're on it. I'll send pricing by Thursday.\n\nKind regards,\nSox",
          },
        ],
      },
    });
    const drafts = await draftFollowUp(llm, sampleExtraction, strictProfile, { tone: "direct", sender: { name: "Sox" } });
    const prompt = llm.calls[0]!.user;
    expect(prompt).toContain("Tone: direct");
    expect(prompt).toContain("Do not use contractions");
    expect(prompt).toContain("Kind regards,\nSox");
    expect(prompt).toContain("Send indicative USD/ZAR forward pricing");

    const d = drafts[0]!;
    expect(d.to).toBe("thandi.mokoena@kestrelfoods.example");
    expect(d.subject).toBe("Kestrel Foods, next steps");
    expect(d.body).toBe("Hi Thandi,\n\nThanks for today, we are on it. I will send pricing by Thursday.\n\nKind regards,\nSox");
    expect(d.style.emDashesRemoved).toBe(1);
    expect(d.style.contractionsExpanded).toBe(2);
  });

  it("clamps variants to 1..3", () => {
    expect(buildDraftPrompt(sampleExtraction, strictProfile, { variants: 9 })).toContain("Write 3 drafts");
    expect(buildDraftPrompt(sampleExtraction, strictProfile, { variants: 0 })).toContain("Write 1 draft ");
  });

  it("renders an .eml draft", () => {
    const eml = toEml({ label: "x", subject: "Hello", body: "Line 1\nLine 2", to: "a@b.example", style: {} as any }, "Sox");
    expect(eml).toContain("To: a@b.example\r\nSubject: Hello\r\nX-Unsent: 1");
    expect(eml.endsWith("Line 1\r\nLine 2\r\n")).toBe(true);
  });
});
