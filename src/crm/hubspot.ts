import type { CallExtraction } from "../schema.js";
import { markdownToSimpleHtml, noteTitle, renderNoteMarkdown } from "../notes/render.js";
import { CrmHttpError, tasksToCreate, type CrmAdapter, type FetchLike, type PushOptions, type PushResult } from "./types.js";

/** HubSpot-defined association type IDs (CRM v3/v4). */
export const HUBSPOT_ASSOC = {
  note: { contact: 202, company: 190, deal: 214 },
  task: { contact: 204, company: 192, deal: 216 },
} as const;

const PRIORITY: Record<string, string> = { high: "HIGH", medium: "MEDIUM", low: "LOW" };

/**
 * HubSpot adapter using a private app access token.
 * Required scopes: crm.objects.contacts.read, crm.objects.companies.read,
 * crm.objects.deals.read, crm.objects.deals.write (for stage updates). Notes and tasks are
 * written through the engagements objects, which need the matching contacts/companies/deals write scopes.
 */
export class HubSpotAdapter implements CrmAdapter {
  readonly name = "hubspot";
  private base = "https://api.hubapi.com";

  constructor(
    private cfg: { accessToken?: string; stageMap: Record<string, string>; ownerId?: string },
    private fetchImpl: FetchLike = fetch,
  ) {
    if (!cfg.accessToken) throw new Error("HUBSPOT_ACCESS_TOKEN is not set.");
  }

  private async request(method: string, path: string, body?: unknown): Promise<any> {
    const url = `${this.base}${path}`;
    const res = await this.fetchImpl(url, {
      method,
      headers: { Authorization: `Bearer ${this.cfg.accessToken}`, "Content-Type": "application/json" },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    const text = await res.text();
    if (!res.ok) throw new CrmHttpError(res.status, url, text);
    return text ? JSON.parse(text) : {};
  }

  private async searchOne(object: "companies" | "contacts", propertyName: string, operator: string, value: string) {
    const json = await this.request("POST", `/crm/v3/objects/${object}/search`, {
      filterGroups: [{ filters: [{ propertyName, operator, value }] }],
      properties: [propertyName],
      limit: 5,
    });
    const results: Array<{ id: string; properties?: Record<string, string> }> = json.results ?? [];
    const exact = results.find((r) => r.properties?.[propertyName]?.toLowerCase() === value.toLowerCase());
    return (exact ?? results[0])?.id;
  }

  findCompanyByName(name: string) {
    return this.searchOne("companies", "name", "CONTAINS_TOKEN", name);
  }

  findContactByEmail(email: string) {
    return this.searchOne("contacts", "email", "EQ", email);
  }

  private associations(kind: "note" | "task", ids: { companyId?: string; personIds: string[]; dealId?: string }) {
    const a = HUBSPOT_ASSOC[kind];
    const make = (id: string, typeId: number) => ({
      to: { id },
      types: [{ associationCategory: "HUBSPOT_DEFINED", associationTypeId: typeId }],
    });
    return [
      ...(ids.companyId ? [make(ids.companyId, a.company)] : []),
      ...ids.personIds.map((id) => make(id, a.contact)),
      ...(ids.dealId ? [make(ids.dealId, a.deal)] : []),
    ];
  }

  async push(x: CallExtraction, opts: PushOptions = {}): Promise<PushResult> {
    const dry = !!opts.dryRun;
    const result: PushResult = { crm: this.name, dryRun: dry, taskIds: [], linked: { personIds: [] }, warnings: [], actions: [] };

    let companyId = opts.companyId;
    if (!companyId && x.account.companyName) {
      companyId = await this.findCompanyByName(x.account.companyName);
      if (companyId) result.actions.push(`Matched company "${x.account.companyName}" -> ${companyId}`);
      else result.warnings.push(`No HubSpot company matched "${x.account.companyName}".`);
    }
    result.linked.companyId = companyId;
    for (const a of x.attendees.filter((p) => p.side !== "us" && p.email)) {
      const id = await this.findContactByEmail(a.email!);
      if (id) {
        result.linked.personIds.push(id);
        result.actions.push(`Matched contact ${a.email} -> ${id}`);
      }
    }
    result.linked.dealId = opts.dealId;

    const title = noteTitle(x);
    const timestamp = x.meeting.date ? new Date(`${x.meeting.date}T12:00:00Z`).toISOString() : new Date().toISOString();
    const noteHtml = `<p><strong>${title.replace(/</g, "&lt;")}</strong></p>${markdownToSimpleHtml(renderNoteMarkdown(x))}`;

    if (dry) {
      result.actions.push(`[dry run] Create note "${title}" with ${this.associations("note", result.linked).length} association(s)`);
    } else {
      const properties: Record<string, string> = { hs_timestamp: timestamp, hs_note_body: noteHtml };
      if (this.cfg.ownerId) properties.hubspot_owner_id = this.cfg.ownerId;
      const note = await this.request("POST", "/crm/v3/objects/notes", {
        properties,
        associations: this.associations("note", result.linked),
      });
      result.noteId = note.id;
      result.actions.push(`Created note ${note.id}`);
    }

    for (const step of tasksToCreate(x, opts.taskOwnerFilter)) {
      if (dry) {
        result.actions.push(`[dry run] Create task "${step.action}"${step.dueDate ? ` due ${step.dueDate}` : ""}`);
        continue;
      }
      const due = step.dueDate ? new Date(`${step.dueDate}T09:00:00Z`).toISOString() : timestamp;
      const properties: Record<string, string> = {
        hs_timestamp: due,
        hs_task_subject: step.action,
        hs_task_body: `From: ${title}${step.ownerName ? `\nOwner on call: ${step.ownerName}` : ""}`,
        hs_task_status: "NOT_STARTED",
        hs_task_priority: PRIORITY[step.priority] ?? "MEDIUM",
        hs_task_type: "TODO",
      };
      if (this.cfg.ownerId) properties.hubspot_owner_id = this.cfg.ownerId;
      const task = await this.request("POST", "/crm/v3/objects/tasks", {
        properties,
        associations: this.associations("task", result.linked),
      });
      result.taskIds.push(task.id);
      result.actions.push(`Created task ${task.id}: ${step.action}`);
    }

    if (opts.updateStage) {
      const stage = this.cfg.stageMap[x.dealStage.suggested];
      if (!opts.dealId) result.warnings.push("Stage update skipped: pass --deal <dealId>.");
      else if (!stage) result.warnings.push(`Stage update skipped: no HUBSPOT_STAGE_MAP entry for "${x.dealStage.suggested}".`);
      else if (dry) result.actions.push(`[dry run] Set deal ${opts.dealId} dealstage to ${stage}`);
      else {
        await this.request("PATCH", `/crm/v3/objects/deals/${opts.dealId}`, { properties: { dealstage: stage } });
        result.stageUpdated = { dealId: opts.dealId, stage };
        result.actions.push(`Set deal ${opts.dealId} dealstage to ${stage}`);
      }
    }
    return result;
  }
}
