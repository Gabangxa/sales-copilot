import type { CallExtraction, NextStep } from "../schema.js";

const label = (s: string) => s.replace(/_/g, " ");

function list(items: string[]): string {
  return items.map((i) => `- ${i}`).join("\n");
}

export function formatNextStep(step: NextStep): string {
  const who = step.ownerName ?? (step.owner === "us" ? "Us" : step.owner === "them" ? "Client" : "Unassigned");
  const due = step.dueDate ? ` (due ${step.dueDate})` : "";
  return `${step.action} [${who}, ${step.priority}]${due}`;
}

export function noteTitle(x: CallExtraction): string {
  const date = x.meeting.date ? ` (${x.meeting.date})` : "";
  return `${x.meeting.title}${date}`;
}

/** Markdown body used for the CRM note and the local file output. */
export function renderNoteMarkdown(x: CallExtraction): string {
  const out: string[] = [];
  out.push(`**Summary:** ${x.summary}`);
  out.push(
    `**Suggested stage:** ${label(x.dealStage.suggested)} (${x.dealStage.rationale})  \n**Sentiment:** ${x.sentiment}`,
  );

  const them = x.attendees.filter((a) => a.side !== "us");
  const us = x.attendees.filter((a) => a.side === "us");
  if (x.attendees.length) {
    const fmt = (a: CallExtraction["attendees"][number]) =>
      [a.name, a.role, a.company].filter(Boolean).join(", ") + (a.email ? ` <${a.email}>` : "");
    out.push(
      "## Attendees\n" +
        (them.length ? `Client: ${them.map(fmt).join("; ")}\n` : "") +
        (us.length ? `Us: ${us.map(fmt).join("; ")}` : ""),
    );
  }

  if (x.nextSteps.length) out.push("## Next steps\n" + list(x.nextSteps.map(formatNextStep)));
  if (x.keyPoints.length) out.push("## Key points\n" + list(x.keyPoints));
  if (x.painPoints.length) out.push("## Pain points\n" + list(x.painPoints));
  if (x.objections.length) {
    out.push(
      "## Objections\n" +
        list(
          x.objections.map(
            (o) => `${o.objection}${o.response ? `. Response: ${o.response}` : ""} (${o.resolved ? "resolved" : "open"})`,
          ),
        ),
    );
  }

  const c = x.commercial;
  const commercial: string[] = [];
  if (c.productsDiscussed.length) commercial.push(`Products: ${c.productsDiscussed.join(", ")}`);
  if (c.currencyPairs.length) commercial.push(`Currency pairs: ${c.currencyPairs.join(", ")}`);
  if (c.volumeEstimate) commercial.push(`Volume: ${c.volumeEstimate}`);
  if (c.budget) commercial.push(`Budget: ${c.budget}`);
  if (c.timeline) commercial.push(`Timeline: ${c.timeline}`);
  if (c.decisionMakers.length) commercial.push(`Decision makers: ${c.decisionMakers.join(", ")}`);
  if (c.competitors.length) commercial.push(`Competitors / incumbents: ${c.competitors.join(", ")}`);
  if (commercial.length) out.push("## Commercial\n" + list(commercial));

  if (x.risks.length) out.push("## Risks\n" + list(x.risks));
  if (x.openQuestions.length) out.push("## Open questions\n" + list(x.openQuestions));

  out.push("_Logged by sales-copilot_");
  return out.join("\n\n");
}

/** Plain text version of the note for .txt export: no markdown symbols, headings in capitals. */
export function noteToPlainText(x: CallExtraction): string {
  const title = noteTitle(x);
  const body = renderNoteMarkdown(x)
    .replace(/^## (.+)$/gm, (_m, t: string) => t.toUpperCase())
    .replace(/\*\*(.+?)\*\*/g, "$1")
    .replace(/(^|\s)_(.+?)_(?=\s|$)/g, "$1$2")
    .replace(/ {2}$/gm, "");
  return `${title}\n${"=".repeat(Math.min(title.length, 72))}\n\n${body}\n`;
}

/** Very small markdown to HTML conversion for CRMs (HubSpot) that store notes as HTML. */
export function markdownToSimpleHtml(md: string): string {
  const esc = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
  const inline = (s: string) =>
    esc(s)
      .replace(/\*\*(.+?)\*\*/g, "<strong>$1</strong>")
      .replace(/(^|\s)_(.+?)_(?=\s|$)/g, "$1<em>$2</em>");
  const blocks = md.split(/\n{2,}/);
  return blocks
    .map((block) => {
      const lines = block.split("\n");
      const first = lines[0] ?? "";
      if (first.startsWith("## ")) {
        const rest = lines.slice(1);
        const heading = `<h3>${inline(first.slice(3))}</h3>`;
        if (!rest.length) return heading;
        return heading + renderLines(rest);
      }
      return renderLines(lines);
    })
    .join("");

  function renderLines(lines: string[]): string {
    if (lines.every((l) => l.startsWith("- "))) {
      return `<ul>${lines.map((l) => `<li>${inline(l.slice(2))}</li>`).join("")}</ul>`;
    }
    return `<p>${lines.map((l) => inline(l.replace(/ {2}$/, ""))).join("<br>")}</p>`;
  }
}
