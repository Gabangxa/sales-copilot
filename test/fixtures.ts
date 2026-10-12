import type { LlmClient } from "../src/llm.js";
import type { CallExtraction } from "../src/schema.js";

export const sampleExtraction: CallExtraction = {
  meeting: { date: "2026-10-12", type: "video_meeting", title: "Discovery call: Kestrel Foods treasury" },
  account: { companyName: "Kestrel Foods", companyDomain: null },
  attendees: [
    { name: "Thandi Mokoena", role: "Group Treasurer", company: "Kestrel Foods", email: "thandi.mokoena@kestrelfoods.example", side: "them" },
    { name: "Pieter Venter", role: "Head of Procurement", company: "Kestrel Foods", email: null, side: "them" },
    { name: "Sox", role: null, company: null, email: null, side: "us" },
  ],
  summary: "Kestrel Foods imports in USD and EUR and is frustrated by settlement delays with its bank.",
  keyPoints: ["USD 3-4m a month, EUR 1m"],
  painPoints: ["Settlement delays of 2-3 days on EUR payments"],
  objections: [{ objection: "Existing bank credit line", response: "Run alongside the bank for spot", resolved: false }],
  nextSteps: [
    { action: "Send indicative USD/ZAR forward pricing for 1m and 3m", owner: "us", ownerName: "Sox", dueDate: "2026-10-15", priority: "high" },
    { action: "Share last quarter's trade blotter", owner: "them", ownerName: "Thandi Mokoena", dueDate: "2026-10-23", priority: "medium" },
  ],
  dealStage: { suggested: "discovery", rationale: "Needs identified, pricing not yet sent." },
  commercial: {
    productsDiscussed: ["Spot", "Forwards"],
    currencyPairs: ["USD/ZAR", "EUR/ZAR"],
    volumeEstimate: "USD 3-4m a month",
    budget: null,
    timeline: "Before January wheat contracts",
    decisionMakers: ["Johan Smit (CFO)"],
    competitors: ["Main bank"],
  },
  sentiment: "mixed",
  risks: ["Onboarding took 4 months last time"],
  openQuestions: ["Can we provide TCA against mid?"],
  followUpEmailRecommended: true,
};

/** A fake LLM that records what it was asked and returns canned tool input. */
export class FakeLlm implements LlmClient {
  calls: Array<Parameters<LlmClient["structured"]>[0]> = [];
  constructor(private responses: Record<string, unknown>) {}
  async structured(args: Parameters<LlmClient["structured"]>[0]): Promise<unknown> {
    this.calls.push(args);
    if (!(args.toolName in this.responses)) throw new Error(`No fake response for ${args.toolName}`);
    return structuredClone(this.responses[args.toolName]);
  }
}

/** Minimal fetch mock: routes by "METHOD path-prefix" and records every request. */
export function mockFetch(routes: Array<[string, (body: any, url: string) => unknown]>) {
  const requests: Array<{ method: string; url: string; body: any }> = [];
  const impl = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input);
    const method = init?.method ?? "GET";
    const body = init?.body ? JSON.parse(String(init.body)) : undefined;
    requests.push({ method, url, body });
    const route = routes.find(([key]) => {
      const [m, frag] = key.split(" ");
      return m === method && url.includes(frag!);
    });
    if (!route) return new Response(JSON.stringify({ error: "no route" }), { status: 404 });
    return new Response(JSON.stringify(route[1](body, url)), { status: 200 });
  }) as typeof fetch;
  return { impl, requests };
}
