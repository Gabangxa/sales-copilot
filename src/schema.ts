import { z } from "zod";

export const DEAL_STAGES = [
  "prospecting",
  "discovery",
  "qualification",
  "proposal",
  "negotiation",
  "closed_won",
  "closed_lost",
  "unknown",
] as const;

const nullableString = z.string().nullable();

/** JSON Schema for a tool input, without the "$schema" key the API does not need. */
function toToolSchema(schema: z.ZodType): Record<string, unknown> {
  const { $schema: _ignored, ...rest } = z.toJSONSchema(schema) as Record<string, unknown>;
  return rest;
}

export const AttendeeSchema = z.object({
  name: z.string(),
  role: nullableString.describe("Job title or role, if mentioned"),
  company: nullableString,
  email: nullableString.describe("Only if it appears in the notes. Never invent one."),
  side: z.enum(["us", "them", "unknown"]).describe("'us' for the seller's side, 'them' for the prospect or client"),
});

export const NextStepSchema = z.object({
  action: z.string().describe("A concrete, verb-first action, e.g. 'Send indicative pricing for USD/NGN forwards'"),
  owner: z.enum(["us", "them", "unknown"]),
  ownerName: nullableString.describe("Named person responsible, if stated"),
  dueDate: nullableString.describe("ISO date YYYY-MM-DD if a date or relative timeframe is stated, resolved against the meeting date"),
  priority: z.enum(["high", "medium", "low"]),
});

export const ObjectionSchema = z.object({
  objection: z.string(),
  response: nullableString.describe("How it was handled on the call, if at all"),
  resolved: z.boolean(),
});

export const CallExtractionSchema = z.object({
  meeting: z.object({
    date: nullableString.describe("ISO date YYYY-MM-DD of the meeting, if known"),
    type: z.enum(["call", "video_meeting", "in_person", "demo", "email_thread", "other"]),
    title: z.string().describe("Short descriptive title, e.g. 'Discovery call: Acme Foods treasury'"),
  }),
  account: z.object({
    companyName: nullableString.describe("The prospect or client company"),
    companyDomain: nullableString.describe("Only if it appears in the notes"),
  }),
  attendees: z.array(AttendeeSchema),
  summary: z.string().describe("3 to 5 sentence factual summary of the conversation"),
  keyPoints: z.array(z.string()),
  painPoints: z.array(z.string()).describe("Problems or needs the client expressed"),
  objections: z.array(ObjectionSchema),
  nextSteps: z.array(NextStepSchema),
  dealStage: z.object({
    suggested: z.enum(DEAL_STAGES),
    rationale: z.string(),
  }),
  commercial: z.object({
    productsDiscussed: z.array(z.string()),
    currencyPairs: z.array(z.string()).describe("e.g. USD/ZAR, EUR/NGN. Empty if not an FX conversation."),
    volumeEstimate: nullableString.describe("Volumes or deal size as stated, keep the client's units"),
    budget: nullableString,
    timeline: nullableString,
    decisionMakers: z.array(z.string()),
    competitors: z.array(z.string()).describe("Incumbent providers, banks or competing vendors mentioned"),
  }),
  sentiment: z.enum(["positive", "neutral", "negative", "mixed"]),
  risks: z.array(z.string()),
  openQuestions: z.array(z.string()).describe("Things still unanswered that we need to follow up on"),
  followUpEmailRecommended: z.boolean(),
});

export type CallExtraction = z.infer<typeof CallExtractionSchema>;
export type NextStep = z.infer<typeof NextStepSchema>;
export type Attendee = z.infer<typeof AttendeeSchema>;

export const callExtractionJsonSchema = toToolSchema(CallExtractionSchema);

export const EmailDraftSchema = z.object({
  drafts: z
    .array(
      z.object({
        label: z.string().describe("2 to 4 word description of the approach, e.g. 'Recap and next steps'"),
        subject: z.string(),
        body: z.string().describe("Plain text email body including greeting and sign-off"),
      }),
    )
    .min(1),
});

export type EmailDrafts = z.infer<typeof EmailDraftSchema>;
export const emailDraftJsonSchema = toToolSchema(EmailDraftSchema);
