import { readFileSync, existsSync } from "node:fs";

/**
 * Minimal .env loader so the tool has no runtime dependency beyond the SDK, zod and commander.
 * Existing environment variables always win over values in the file.
 */
export function loadDotEnv(path = ".env"): void {
  if (!existsSync(path)) return;
  const lines = readFileSync(path, "utf8").split(/\r?\n/);
  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    const eq = trimmed.indexOf("=");
    if (eq === -1) continue;
    const key = trimmed.slice(0, eq).trim();
    let value = trimmed.slice(eq + 1).trim();
    if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
      value = value.slice(1, -1);
    }
    if (process.env[key] === undefined) process.env[key] = value;
  }
}

export type CrmName = "twenty" | "hubspot" | "file" | "none";

export interface AppConfig {
  anthropicApiKey?: string;
  model: string;
  crm: CrmName;
  twenty: { baseUrl: string; apiKey?: string; stageMap: Record<string, string> };
  hubspot: { accessToken?: string; stageMap: Record<string, string>; ownerId?: string };
  outDir: string;
  sender: { name?: string; title?: string; company?: string };
  stylePath?: string;
  taskOwnerFilter: "us" | "all";
  appApiKey?: string;
  port: number;
}

function parseJsonMap(raw: string | undefined, label: string): Record<string, string> {
  if (!raw) return {};
  try {
    const parsed = JSON.parse(raw) as unknown;
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
      return Object.fromEntries(Object.entries(parsed).map(([k, v]) => [k, String(v)]));
    }
  } catch {
    /* fall through */
  }
  throw new Error(`${label} must be a JSON object, for example {"proposal":"PROPOSAL"}`);
}

export function getConfig(env: NodeJS.ProcessEnv = process.env): AppConfig {
  const crm = (env.CRM ?? "file").toLowerCase();
  if (!["twenty", "hubspot", "file", "none"].includes(crm)) {
    throw new Error(`CRM must be one of twenty, hubspot, file, none (got "${crm}")`);
  }
  return {
    anthropicApiKey: env.ANTHROPIC_API_KEY,
    model: env.ANTHROPIC_MODEL ?? "claude-sonnet-5-5",
    crm: crm as CrmName,
    twenty: {
      baseUrl: (env.TWENTY_BASE_URL ?? "https://api.twenty.com").replace(/\/+$/, ""),
      apiKey: env.TWENTY_API_KEY,
      stageMap: parseJsonMap(env.TWENTY_STAGE_MAP, "TWENTY_STAGE_MAP"),
    },
    hubspot: {
      accessToken: env.HUBSPOT_ACCESS_TOKEN,
      stageMap: parseJsonMap(env.HUBSPOT_STAGE_MAP, "HUBSPOT_STAGE_MAP"),
      ownerId: env.HUBSPOT_OWNER_ID,
    },
    outDir: env.OUT_DIR ?? "out",
    sender: { name: env.SENDER_NAME, title: env.SENDER_TITLE, company: env.SENDER_COMPANY },
    stylePath: env.STYLE_PATH,
    taskOwnerFilter: env.TASK_OWNER_FILTER === "all" ? "all" : "us",
    appApiKey: env.APP_API_KEY,
    port: Number(env.PORT ?? 3000),
  };
}
