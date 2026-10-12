import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { timingSafeEqual } from "node:crypto";
import { getConfig, loadDotEnv, type AppConfig, type CrmName } from "./config.js";
import { AnthropicLlm, type LlmClient } from "./llm.js";
import { followUp, notesToCrm } from "./pipeline.js";
import { toEml } from "./followup/draft.js";

const MAX_BODY_BYTES = 512 * 1024;

async function readJson(req: IncomingMessage): Promise<Record<string, any>> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req) {
    size += (chunk as Buffer).length;
    if (size > MAX_BODY_BYTES) throw new HttpError(413, "Request body too large");
    chunks.push(chunk as Buffer);
  }
  if (!size) return {};
  try {
    return JSON.parse(Buffer.concat(chunks).toString("utf8"));
  } catch {
    throw new HttpError(400, "Body must be JSON");
  }
}

class HttpError extends Error {
  constructor(
    public status: number,
    message: string,
  ) {
    super(message);
  }
}

function send(res: ServerResponse, status: number, body: unknown) {
  res.writeHead(status, { "Content-Type": "application/json" });
  res.end(JSON.stringify(body));
}

function authorised(req: IncomingMessage, key?: string): boolean {
  if (!key) return true;
  const header = req.headers["authorization"] ?? "";
  const given = Buffer.from(String(header).replace(/^Bearer\s+/i, ""));
  const expected = Buffer.from(key);
  return given.length === expected.length && timingSafeEqual(given, expected);
}

const CRMS = ["twenty", "hubspot", "file", "none"];

export function createApp(cfg: AppConfig, llmFactory: () => LlmClient = () => new AnthropicLlm(cfg.anthropicApiKey, cfg.model)) {
  return createServer(async (req, res) => {
    try {
      const url = new URL(req.url ?? "/", "http://localhost");
      if (req.method === "GET" && url.pathname === "/health") return send(res, 200, { ok: true });
      if (req.method !== "POST") throw new HttpError(404, "Not found");
      if (!authorised(req, cfg.appApiKey)) throw new HttpError(401, "Unauthorised");

      if (url.pathname === "/api/notes") {
        const body = await readJson(req);
        if (typeof body.notes !== "string" || !body.notes.trim()) throw new HttpError(400, "notes (string) is required");
        if (body.crm !== undefined && !CRMS.includes(body.crm)) throw new HttpError(400, `crm must be one of ${CRMS.join(", ")}`);
        const result = await notesToCrm(llmFactory(), cfg, {
          notes: body.notes,
          crm: body.crm as CrmName | undefined,
          extract: { meetingDate: body.meetingDate, context: body.context },
          push: {
            dealId: body.dealId,
            companyId: body.companyId,
            updateStage: !!body.updateStage,
            dryRun: !!body.dryRun,
            taskOwnerFilter: body.allTasks ? "all" : cfg.taskOwnerFilter,
          },
        });
        return send(res, 200, result);
      }

      if (url.pathname === "/api/followup") {
        const body = await readJson(req);
        if (!body.notes && !body.extraction) throw new HttpError(400, "notes or extraction is required");
        const result = await followUp(llmFactory(), cfg, {
          notes: body.notes,
          extraction: body.extraction,
          extract: { meetingDate: body.meetingDate },
          draft: {
            tone: body.tone,
            variants: body.variants,
            recipientEmail: body.to,
            recipientName: body.toName,
            callToAction: body.cta,
            extraInstructions: body.extra,
          },
        });
        return send(res, 200, { ...result, eml: result.drafts.map((d) => toEml(d, cfg.sender.name)) });
      }

      throw new HttpError(404, "Not found");
    } catch (err) {
      const status = err instanceof HttpError ? err.status : 500;
      if (status === 500) console.error(err);
      send(res, status, { error: (err as Error).message });
    }
  });
}

const isMain = import.meta.url === `file://${process.argv[1]}`;
if (isMain) {
  loadDotEnv();
  const cfg = getConfig();
  if (!cfg.appApiKey) console.warn("APP_API_KEY is not set: the API is open to anyone who can reach it.");
  createApp(cfg).listen(cfg.port, () => console.log(`sales-copilot listening on :${cfg.port}`));
}
