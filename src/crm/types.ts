import type { CallExtraction } from "../schema.js";

export interface PushOptions {
  /** Existing deal/opportunity to attach the note and tasks to. */
  dealId?: string;
  /** Existing company record to attach to. Skips the lookup by name. */
  companyId?: string;
  /** Update the deal's stage using the configured stage map. Off by default. */
  updateStage?: boolean;
  /** Which next steps become tasks: only ours (default) or everything. */
  taskOwnerFilter?: "us" | "all";
  /** Log what would happen without writing anything. */
  dryRun?: boolean;
}

export interface PushResult {
  crm: string;
  dryRun: boolean;
  noteId?: string;
  taskIds: string[];
  linked: { companyId?: string; personIds: string[]; dealId?: string };
  stageUpdated?: { dealId: string; stage: string };
  warnings: string[];
  /** Human readable log of every action taken (or planned, in dry run). */
  actions: string[];
  /** Local files written, for the file adapter. */
  files?: string[];
}

export interface CrmAdapter {
  readonly name: string;
  push(extraction: CallExtraction, opts?: PushOptions): Promise<PushResult>;
}

export function tasksToCreate(x: CallExtraction, filter: "us" | "all" = "us") {
  return x.nextSteps.filter((s) => filter === "all" || s.owner === "us" || s.owner === "unknown");
}

export class CrmHttpError extends Error {
  constructor(
    public status: number,
    public url: string,
    public body: string,
  ) {
    super(`CRM request failed: ${status} ${url}\n${body.slice(0, 500)}`);
  }
}

export type FetchLike = typeof fetch;
