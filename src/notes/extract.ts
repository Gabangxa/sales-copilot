import type { LlmClient } from "../llm.js";
import { CallExtractionSchema, callExtractionJsonSchema, type CallExtraction } from "../schema.js";

export interface ExtractOptions {
  /** Meeting date to resolve relative deadlines ("next Friday") against. Defaults to today. */
  meetingDate?: string;
  /** Who "us" is, so the model can tell the two sides apart. */
  sellerName?: string;
  sellerCompany?: string;
  /** Extra context the rep wants considered, e.g. "Existing client, renewal due in March". */
  context?: string;
}

export const EXTRACTION_SYSTEM_PROMPT = `You are a meticulous sales operations analyst. You turn raw call notes or transcripts into a structured CRM record.

Rules:
- Record only what the notes support. Never invent names, emails, numbers, dates or commitments. Use null or an empty array when something is not stated.
- Write next steps as concrete, verb-first actions that someone could tick off. Split compound commitments into separate steps.
- Mark owner "us" for commitments made by the seller's side, "them" for the client's side.
- Resolve relative dates ("Friday", "end of next week", "in two weeks") into ISO dates using the meeting date provided. If no timeframe is given, leave dueDate null.
- Priority: high if it unblocks the deal or has a date within 3 business days, low if it is nice to have, otherwise medium.
- Suggest the deal stage from the evidence and explain why in one sentence. Use "unknown" if the notes do not say enough.
- Keep the client's own units for volumes and amounts (e.g. "USD 2m per month").
- For FX conversations capture currency pairs in BASE/QUOTE form, such as USD/ZAR.
- Write in plain English. Do not use em dashes.`;

export function buildExtractionPrompt(notes: string, opts: ExtractOptions = {}): string {
  const meetingDate = opts.meetingDate ?? new Date().toISOString().slice(0, 10);
  const seller = [opts.sellerName, opts.sellerCompany].filter(Boolean).join(" at ");
  const lines = [
    `Meeting date (use for resolving relative dates): ${meetingDate}`,
    seller ? `Seller ("us"): ${seller}` : `Seller ("us"): the person who wrote these notes`,
  ];
  if (opts.context) lines.push(`Additional context from the rep: ${opts.context}`);
  lines.push("", "<call_notes>", notes.trim(), "</call_notes>", "", "Extract the CRM record by calling record_call.");
  return lines.join("\n");
}

export async function extractCallNotes(llm: LlmClient, notes: string, opts: ExtractOptions = {}): Promise<CallExtraction> {
  if (!notes.trim()) throw new Error("Call notes are empty.");
  const raw = await llm.structured({
    system: EXTRACTION_SYSTEM_PROMPT,
    user: buildExtractionPrompt(notes, opts),
    toolName: "record_call",
    toolDescription: "Record the structured outcome of a sales conversation for the CRM.",
    inputSchema: callExtractionJsonSchema,
    maxTokens: 4096,
  });
  const parsed = CallExtractionSchema.safeParse(raw);
  if (!parsed.success) {
    throw new Error(`Model returned data that does not match the schema:\n${parsed.error.message}`);
  }
  if (!parsed.data.meeting.date && opts.meetingDate) parsed.data.meeting.date = opts.meetingDate;
  return parsed.data;
}
