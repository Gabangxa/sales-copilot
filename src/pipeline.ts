import type { AppConfig, CrmName } from "./config.js";
import { createCrmAdapter, type PushOptions, type PushResult } from "./crm/index.js";
import { draftFollowUp, type DraftOptions, type FollowUpDraft } from "./followup/draft.js";
import { loadStyleProfile, type StyleProfile } from "./followup/style.js";
import type { LlmClient } from "./llm.js";
import { extractCallNotes, type ExtractOptions } from "./notes/extract.js";
import { CallExtractionSchema, type CallExtraction } from "./schema.js";

export interface NotesToCrmInput {
  notes: string;
  crm?: CrmName;
  extract?: ExtractOptions;
  push?: PushOptions;
}

export async function notesToCrm(
  llm: LlmClient,
  cfg: AppConfig,
  input: NotesToCrmInput,
): Promise<{ extraction: CallExtraction; crm: PushResult }> {
  const extraction = await extractCallNotes(llm, input.notes, {
    sellerName: cfg.sender.name,
    sellerCompany: cfg.sender.company,
    ...input.extract,
  });
  const adapter = createCrmAdapter(input.crm ?? cfg.crm, cfg);
  const crm = await adapter.push(extraction, { taskOwnerFilter: cfg.taskOwnerFilter, ...input.push });
  return { extraction, crm };
}

export interface FollowUpInput {
  /** Either raw notes (extracted first) or an extraction produced earlier. */
  notes?: string;
  extraction?: unknown;
  extract?: ExtractOptions;
  draft?: DraftOptions;
  stylePath?: string;
  style?: StyleProfile;
}

export async function followUp(
  llm: LlmClient,
  cfg: AppConfig,
  input: FollowUpInput,
): Promise<{ extraction: CallExtraction; drafts: FollowUpDraft[] }> {
  let extraction: CallExtraction;
  if (input.extraction) {
    const parsed = CallExtractionSchema.safeParse(input.extraction);
    if (!parsed.success) throw new Error(`extraction is not a valid call record:\n${parsed.error.message}`);
    extraction = parsed.data;
  } else if (input.notes) {
    extraction = await extractCallNotes(llm, input.notes, {
      sellerName: cfg.sender.name,
      sellerCompany: cfg.sender.company,
      ...input.extract,
    });
  } else {
    throw new Error("Provide either notes or extraction.");
  }
  const style = input.style ?? loadStyleProfile(input.stylePath ?? cfg.stylePath);
  const drafts = await draftFollowUp(llm, extraction, style, { sender: cfg.sender, ...input.draft });
  return { extraction, drafts };
}
