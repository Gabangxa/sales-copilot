import type { CallExtraction } from "../schema.js";
import { noteTitle, renderNoteMarkdown } from "../notes/render.js";
import { CrmHttpError, tasksToCreate, type CrmAdapter, type FetchLike, type PushOptions, type PushResult } from "./types.js";

/**
 * Twenty CRM adapter (https://twenty.com), using the REST API.
 *
 * Endpoints are generated per workspace. This adapter uses the standard objects:
 *   notes, noteTargets, tasks, taskTargets, companies, people, opportunities.
 * Note and task bodies are written to `bodyV2.markdown`.
 * If your workspace has renamed or customised these, check Settings > API & Webhooks.
 */
export class TwentyAdapter implements CrmAdapter {
  readonly name = "twenty";

  constructor(
    private cfg: { baseUrl: string; apiKey?: string; stageMap: Record<string, string> },
    private fetchImpl: FetchLike = fetch,
  ) {
    if (!cfg.apiKey) throw new Error("TWENTY_API_KEY is not set.");
  }

  private async request(method: string, path: string, body?: unknown): Promise<unknown> {
    const url = `${this.cfg.baseUrl}/rest/${path}`;
    const res = await this.fetchImpl(url, {
      method,
      headers: {
        Authorization: `Bearer ${this.cfg.apiKey}`,
        "Content-Type": "application/json",
        Accept: "application/json",
      },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    const text = await res.text();
    if (!res.ok) throw new CrmHttpError(res.status, url, text);
    return text ? (JSON.parse(text) as unknown) : {};
  }

  /** Twenty wraps responses as { data: { createNote: {...} } } or { data: { companies: [...] } }. */
  static unwrap(json: unknown): unknown {
    if (json && typeof json === "object" && "data" in json) {
      const data = (json as { data: unknown }).data;
      if (data && typeof data === "object" && !Array.isArray(data)) {
        const values = Object.values(data as Record<string, unknown>);
        if (values.length === 1) return values[0];
      }
      return data;
    }
    return json;
  }

  static recordId(json: unknown): string {
    const rec = TwentyAdapter.unwrap(json) as { id?: string } | undefined;
    if (!rec?.id) throw new Error(`Unexpected Twenty response, no id found: ${JSON.stringify(json).slice(0, 300)}`);
    return rec.id;
  }

  static records(json: unknown): Array<Record<string, unknown>> {
    const list = TwentyAdapter.unwrap(json);
    return Array.isArray(list) ? (list as Array<Record<string, unknown>>) : [];
  }

  private filterQuery(filter: string, limit = 5): string {
    return `filter=${encodeURIComponent(filter)}&limit=${limit}`;
  }

  async findCompanyByName(name: string): Promise<string | undefined> {
    const safe = name.replace(/"/g, "");
    const json = await this.request("GET", `companies?${this.filterQuery(`name[ilike]:"%${safe}%"`)}`);
    const recs = TwentyAdapter.records(json);
    const exact = recs.find((r) => String(r.name ?? "").toLowerCase() === name.toLowerCase());
    return (exact ?? recs[0])?.id as string | undefined;
  }

  async findPersonByEmail(email: string): Promise<string | undefined> {
    const safe = email.replace(/"/g, "");
    const json = await this.request("GET", `people?${this.filterQuery(`emails.primaryEmail[eq]:"${safe}"`, 1)}`);
    return TwentyAdapter.records(json)[0]?.id as string | undefined;
  }

  async push(x: CallExtraction, opts: PushOptions = {}): Promise<PushResult> {
    const dry = !!opts.dryRun;
    const result: PushResult = { crm: this.name, dryRun: dry, taskIds: [], linked: { personIds: [] }, warnings: [], actions: [] };

    // 1. Resolve who this is about.
    let companyId = opts.companyId;
    if (!companyId && x.account.companyName) {
      companyId = await this.findCompanyByName(x.account.companyName);
      if (companyId) result.actions.push(`Matched company "${x.account.companyName}" -> ${companyId}`);
      else result.warnings.push(`No Twenty company matched "${x.account.companyName}". Note will not be linked to a company.`);
    }
    result.linked.companyId = companyId;

    for (const a of x.attendees.filter((p) => p.side !== "us" && p.email)) {
      const id = await this.findPersonByEmail(a.email!);
      if (id) {
        result.linked.personIds.push(id);
        result.actions.push(`Matched person ${a.email} -> ${id}`);
      }
    }
    result.linked.dealId = opts.dealId;

    const targets: Array<Record<string, string>> = [
      ...(companyId ? [{ companyId }] : []),
      ...result.linked.personIds.map((personId) => ({ personId })),
      ...(opts.dealId ? [{ opportunityId: opts.dealId }] : []),
    ];

    // 2. The note.
    const title = noteTitle(x);
    const markdown = renderNoteMarkdown(x);
    if (dry) {
      result.actions.push(`[dry run] Create note "${title}" linked to ${targets.length} record(s)`);
    } else {
      result.noteId = TwentyAdapter.recordId(await this.request("POST", "notes", { title, bodyV2: { markdown } }));
      result.actions.push(`Created note ${result.noteId}`);
      for (const t of targets) await this.link("noteTargets", { noteId: result.noteId, ...t }, result);
    }

    // 3. Tasks from our next steps.
    for (const step of tasksToCreate(x, opts.taskOwnerFilter)) {
      const body = [
        `From: ${title}`,
        step.ownerName ? `Owner on call: ${step.ownerName}` : "",
        `Priority: ${step.priority}`,
      ]
        .filter(Boolean)
        .join("\n\n");
      const task: Record<string, unknown> = { title: step.action, bodyV2: { markdown: body }, status: "TODO" };
      if (step.dueDate) task.dueAt = new Date(`${step.dueDate}T09:00:00Z`).toISOString();
      if (dry) {
        result.actions.push(`[dry run] Create task "${step.action}"${step.dueDate ? ` due ${step.dueDate}` : ""}`);
        continue;
      }
      const taskId = TwentyAdapter.recordId(await this.request("POST", "tasks", task));
      result.taskIds.push(taskId);
      result.actions.push(`Created task ${taskId}: ${step.action}`);
      for (const t of targets) await this.link("taskTargets", { taskId, ...t }, result);
    }

    // 4. Optional stage update.
    if (opts.updateStage) {
      const stage = this.cfg.stageMap[x.dealStage.suggested];
      if (!opts.dealId) result.warnings.push("Stage update skipped: pass --deal <opportunityId>.");
      else if (!stage) result.warnings.push(`Stage update skipped: no TWENTY_STAGE_MAP entry for "${x.dealStage.suggested}".`);
      else if (dry) result.actions.push(`[dry run] Set opportunity ${opts.dealId} stage to ${stage}`);
      else {
        await this.request("PATCH", `opportunities/${opts.dealId}`, { stage });
        result.stageUpdated = { dealId: opts.dealId, stage };
        result.actions.push(`Set opportunity ${opts.dealId} stage to ${stage}`);
      }
    }
    return result;
  }

  /** Linking failures are warnings, not fatal: the note or task already exists. */
  private async link(object: "noteTargets" | "taskTargets", body: Record<string, string>, result: PushResult) {
    try {
      await this.request("POST", object, body);
    } catch (err) {
      result.warnings.push(`Could not create ${object} link ${JSON.stringify(body)}: ${(err as Error).message.split("\n")[0]}`);
    }
  }
}
