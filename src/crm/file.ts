import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { CallExtraction } from "../schema.js";
import { formatNextStep, noteTitle, noteToPlainText, renderNoteMarkdown } from "../notes/render.js";
import { tasksToCreate, type CrmAdapter, type PushOptions, type PushResult } from "./types.js";

export function slugify(s: string): string {
  return (
    s
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-+|-+$/g, "")
      .slice(0, 60) || "call"
  );
}

/** Writes the record to local files. Useful before a CRM is connected, and for keeping an audit trail. */
export class FileAdapter implements CrmAdapter {
  readonly name = "file";
  constructor(private outDir: string) {}

  async push(x: CallExtraction, opts: PushOptions = {}): Promise<PushResult> {
    const base = `${x.meeting.date ?? new Date().toISOString().slice(0, 10)}-${slugify(x.account.companyName ?? x.meeting.title)}`;
    const md = `# ${noteTitle(x)}\n\n${renderNoteMarkdown(x)}\n`;
    const tasks = tasksToCreate(x, opts.taskOwnerFilter).map(formatNextStep);
    const result: PushResult = {
      crm: this.name,
      dryRun: !!opts.dryRun,
      taskIds: [],
      linked: { personIds: [] },
      warnings: [],
      actions: [],
      files: [],
    };
    const files = {
      [`${base}.md`]: md,
      [`${base}.txt`]: noteToPlainText(x),
      [`${base}.json`]: JSON.stringify(x, null, 2) + "\n",
    };
    if (opts.dryRun) {
      result.actions.push(...Object.keys(files).map((f) => `[dry run] Write ${join(this.outDir, f)}`));
    } else {
      mkdirSync(this.outDir, { recursive: true });
      for (const [name, content] of Object.entries(files)) {
        const p = join(this.outDir, name);
        writeFileSync(p, content);
        result.files!.push(p);
        result.actions.push(`Wrote ${p}`);
      }
    }
    result.actions.push(...tasks.map((t) => `Task: ${t}`));
    return result;
  }
}

/** Adapter that does nothing, for "just show me the extraction". */
export class NoopAdapter implements CrmAdapter {
  readonly name = "none";
  async push(_x: CallExtraction, opts: PushOptions = {}): Promise<PushResult> {
    return { crm: this.name, dryRun: !!opts.dryRun, taskIds: [], linked: { personIds: [] }, warnings: [], actions: [] };
  }
}
