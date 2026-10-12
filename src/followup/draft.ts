import type { LlmClient } from "../llm.js";
import { EmailDraftSchema, emailDraftJsonSchema, type CallExtraction } from "../schema.js";
import { formatNextStep } from "../notes/render.js";
import { applyStyleRules, type StyleFixReport, type StyleProfile } from "./style.js";

export type Tone = "warm" | "direct" | "formal";

export interface DraftOptions {
  tone?: Tone;
  /** How many alternative drafts to produce (1 to 3). */
  variants?: number;
  sender?: { name?: string; title?: string; company?: string };
  /** Override the recipient. Defaults to the first client-side attendee. */
  recipientName?: string;
  recipientEmail?: string;
  /** The single thing this email should get the recipient to do. */
  callToAction?: string;
  /** Anything else to weave in, e.g. "attach the onboarding pack". */
  extraInstructions?: string;
}

export interface FollowUpDraft {
  label: string;
  subject: string;
  body: string;
  to?: string;
  style: StyleFixReport;
}

const TONE_GUIDE: Record<Tone, string> = {
  warm: "Friendly and personable, while still concise and professional. One line of genuine rapport at most.",
  direct: "Brisk and businesslike. Lead with the recap and the ask. No pleasantries beyond the greeting.",
  formal: "Polished and formal, suitable for a senior executive or a first meeting with a large institution.",
};

export const DRAFT_SYSTEM_PROMPT = `You write post-meeting follow-up emails for a B2B salesperson, in their voice.

What a good follow-up does:
- Thanks them briefly and anchors on what matters to THEM (their pain points and goals), not on our product.
- Recaps the agreed next steps clearly, with owners and dates, so nothing is ambiguous.
- Handles open objections or questions honestly. Never promise anything that was not committed on the call.
- Ends with exactly one clear call to action.
- Is short: usually 90 to 180 words. Plain text, no markdown, no bold, no headings. Short bullet lists with "-" are fine for next steps.
- Uses only facts from the meeting record. Never invent figures, prices, dates, names or attachments.

When asked for several drafts, make them meaningfully different approaches (for example "Recap and next steps" versus "Lead with the value" versus "Short nudge"), not the same email reworded.`;

function recipientOf(x: CallExtraction, opts: DraftOptions) {
  const client = x.attendees.find((a) => a.side === "them") ?? x.attendees.find((a) => a.side !== "us");
  return {
    name: opts.recipientName ?? client?.name,
    email: opts.recipientEmail ?? client?.email ?? undefined,
  };
}

export function buildDraftPrompt(x: CallExtraction, profile: StyleProfile, opts: DraftOptions = {}): string {
  const tone = opts.tone ?? "warm";
  const variants = Math.min(Math.max(opts.variants ?? 1, 1), 3);
  const r = recipientOf(x, opts);
  const sender = opts.sender ?? {};
  const senderLine = [sender.name, sender.title, sender.company].filter(Boolean).join(", ");

  const record = {
    meeting: x.meeting,
    company: x.account.companyName,
    attendees: x.attendees,
    summary: x.summary,
    keyPoints: x.keyPoints,
    painPoints: x.painPoints,
    objections: x.objections,
    nextSteps: x.nextSteps.map(formatNextStep),
    commercial: x.commercial,
    openQuestions: x.openQuestions,
  };

  const rules: string[] = [];
  if (profile.rules.noEmDashes) rules.push("Do not use em dashes or en dashes as punctuation. Use commas, full stops or brackets.");
  if (profile.rules.noContractions) rules.push('Do not use contractions. Write "do not", "I will", "we are" in full.');
  if (profile.rules.maxWords) rules.push(`Keep each body under ${profile.rules.maxWords} words.`);

  return [
    `<meeting_record>\n${JSON.stringify(record, null, 2)}\n</meeting_record>`,
    `Recipient: ${r.name ?? "the main client contact"}${r.email ? ` <${r.email}>` : ""}`,
    `Sender: ${senderLine || "the salesperson who ran the meeting"}`,
    `Tone: ${tone}. ${TONE_GUIDE[tone]}`,
    opts.callToAction ? `Call to action: ${opts.callToAction}` : "Call to action: choose the single most useful next step from the record.",
    opts.extraInstructions ? `Extra instructions: ${opts.extraInstructions}` : "",
    profile.guidance ? `<voice_and_style>\n${profile.guidance}\n</voice_and_style>` : "",
    profile.signature ? `End every email with this exact sign-off:\n${profile.signature}` : "",
    rules.length ? `Hard rules:\n${rules.map((x) => `- ${x}`).join("\n")}` : "",
    `Write ${variants} draft${variants > 1 ? "s" : ""} and return them by calling save_drafts.`,
  ]
    .filter(Boolean)
    .join("\n\n");
}

export async function draftFollowUp(
  llm: LlmClient,
  x: CallExtraction,
  profile: StyleProfile,
  opts: DraftOptions = {},
): Promise<FollowUpDraft[]> {
  const raw = await llm.structured({
    system: DRAFT_SYSTEM_PROMPT,
    user: buildDraftPrompt(x, profile, opts),
    toolName: "save_drafts",
    toolDescription: "Save the follow-up email drafts.",
    inputSchema: emailDraftJsonSchema,
    maxTokens: 3000,
  });
  const parsed = EmailDraftSchema.safeParse(raw);
  if (!parsed.success) throw new Error(`Model returned drafts that do not match the schema:\n${parsed.error.message}`);

  const to = recipientOf(x, opts).email;
  return parsed.data.drafts.map((d) => {
    // The model is told the rules; this is the belt-and-braces pass that guarantees them.
    const body = applyStyleRules(d.body, profile);
    const subject = applyStyleRules(d.subject, profile).text;
    return { label: d.label, subject, body: body.text.trim(), to, style: body.report };
  });
}

/** Render a draft as an .eml file most mail clients open as an editable draft. */
export function toEml(draft: FollowUpDraft, from?: string): string {
  const headers = [
    from ? `From: ${from}` : undefined,
    draft.to ? `To: ${draft.to}` : undefined,
    `Subject: ${draft.subject}`,
    "X-Unsent: 1",
    "MIME-Version: 1.0",
    "Content-Type: text/plain; charset=utf-8",
    "Content-Transfer-Encoding: 8bit",
  ].filter(Boolean);
  return `${headers.join("\r\n")}\r\n\r\n${draft.body.replace(/\r?\n/g, "\r\n")}\r\n`;
}

/** Plain text email for .txt export. */
export function toPlainText(draft: FollowUpDraft): string {
  return `${draft.to ? `To: ${draft.to}\n` : ""}Subject: ${draft.subject}\n\n${draft.body}\n`;
}

export function toMarkdown(drafts: FollowUpDraft[]): string {
  return drafts
    .map(
      (d, i) =>
        `## Draft ${i + 1}: ${d.label}\n\n**To:** ${d.to ?? "(add recipient)"}  \n**Subject:** ${d.subject}\n\n${d.body}\n\n` +
        `_${d.style.wordCount} words` +
        (d.style.emDashesRemoved ? `, ${d.style.emDashesRemoved} em dash(es) removed` : "") +
        (d.style.contractionsExpanded ? `, ${d.style.contractionsExpanded} contraction(s) expanded` : "") +
        (d.style.overMaxWords ? ", over the word limit" : "") +
        "_",
    )
    .join("\n\n---\n\n");
}
