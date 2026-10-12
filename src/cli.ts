#!/usr/bin/env node
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { Command, Option } from "commander";
import { getConfig, loadDotEnv, type CrmName } from "./config.js";
import { slugify } from "./crm/file.js";
import { toEml, toMarkdown, type Tone } from "./followup/draft.js";
import { AnthropicLlm } from "./llm.js";
import { renderNoteMarkdown, noteTitle } from "./notes/render.js";
import { followUp, notesToCrm } from "./pipeline.js";
import type { PushResult } from "./crm/types.js";

loadDotEnv();

async function readInput(file: string | undefined): Promise<string> {
  if (file && file !== "-") return readFileSync(file, "utf8");
  if (process.stdin.isTTY) throw new Error("Pass a notes file, or pipe notes in on stdin.");
  const chunks: Buffer[] = [];
  for await (const chunk of process.stdin) chunks.push(chunk as Buffer);
  return Buffer.concat(chunks).toString("utf8");
}

function printPush(r: PushResult) {
  console.log(`\nCRM: ${r.crm}${r.dryRun ? " (dry run, nothing written)" : ""}`);
  for (const a of r.actions) console.log(`  - ${a}`);
  for (const w of r.warnings) console.log(`  ! ${w}`);
}

const program = new Command()
  .name("sales-copilot")
  .description("Turn call notes into CRM updates and draft follow-up emails with Claude.")
  .version("0.1.0");

const crmOption = new Option("--crm <crm>", "where to push: twenty, hubspot, file, none").choices([
  "twenty",
  "hubspot",
  "file",
  "none",
]);
const toneOption = new Option("--tone <tone>", "email tone").choices(["warm", "direct", "formal"]).default("warm");

program
  .command("notes")
  .description("Extract a structured record from call notes and push it to your CRM")
  .argument("[file]", "notes or transcript file (or - / stdin)")
  .addOption(crmOption)
  .option("--date <yyyy-mm-dd>", "meeting date, used to resolve 'next Friday' style deadlines")
  .option("--context <text>", "extra context, e.g. 'existing client, renewal in March'")
  .option("--deal <id>", "deal / opportunity id to attach the note and tasks to")
  .option("--company <id>", "company id to attach to (skips lookup by name)")
  .option("--update-stage", "update the deal stage using the configured stage map")
  .option("--all-tasks", "create tasks for the client's next steps as well as ours")
  .option("--dry-run", "show what would be written without writing")
  .option("--json", "print the extraction as JSON")
  .option("--save-json <path>", "save the extraction JSON (feed it to `followup --from-json`)")
  .option("--followup", "also draft the follow-up email in the same run")
  .addOption(toneOption)
  .action(async (file: string | undefined, o) => {
    const cfg = getConfig();
    const llm = new AnthropicLlm(cfg.anthropicApiKey, cfg.model);
    const notes = await readInput(file);
    const { extraction, crm } = await notesToCrm(llm, cfg, {
      notes,
      crm: o.crm as CrmName | undefined,
      extract: { meetingDate: o.date, context: o.context },
      push: {
        dealId: o.deal,
        companyId: o.company,
        updateStage: !!o.updateStage,
        dryRun: !!o.dryRun,
        taskOwnerFilter: o.allTasks ? "all" : cfg.taskOwnerFilter,
      },
    });

    if (o.json) console.log(JSON.stringify(extraction, null, 2));
    else console.log(`# ${noteTitle(extraction)}\n\n${renderNoteMarkdown(extraction)}`);
    if (o.saveJson) {
      writeFileSync(o.saveJson, JSON.stringify(extraction, null, 2) + "\n");
      console.log(`\nSaved extraction to ${o.saveJson}`);
    }
    printPush(crm);

    if (o.followup) {
      const { drafts } = await followUp(llm, cfg, { extraction, draft: { tone: o.tone as Tone } });
      writeDrafts(cfg.outDir, extraction.account.companyName ?? extraction.meeting.title, drafts, cfg.sender.name);
    }
  });

program
  .command("followup")
  .description("Draft a follow-up email from call notes or a saved extraction")
  .argument("[file]", "notes or transcript file (or - / stdin)")
  .option("--from-json <path>", "use an extraction saved by `notes --save-json` instead of raw notes")
  .addOption(toneOption)
  .option("--variants <n>", "number of alternative drafts (1 to 3)", "1")
  .option("--to <email>", "recipient email (defaults to the client attendee in the notes)")
  .option("--to-name <name>", "recipient name")
  .option("--cta <text>", "the one thing this email should ask for")
  .option("--extra <text>", "anything else to include")
  .option("--style <path>", "style profile markdown file (default: styles/default.md)")
  .option("--date <yyyy-mm-dd>", "meeting date")
  .option("--no-save", "print only, do not write files to OUT_DIR")
  .action(async (file: string | undefined, o) => {
    const cfg = getConfig();
    const llm = new AnthropicLlm(cfg.anthropicApiKey, cfg.model);
    const extractionJson = o.fromJson ? JSON.parse(readFileSync(o.fromJson, "utf8")) : undefined;
    const notes = extractionJson ? undefined : await readInput(file);
    const { extraction, drafts } = await followUp(llm, cfg, {
      notes,
      extraction: extractionJson,
      extract: { meetingDate: o.date },
      stylePath: o.style,
      draft: {
        tone: o.tone as Tone,
        variants: Number(o.variants),
        recipientEmail: o.to,
        recipientName: o.toName,
        callToAction: o.cta,
        extraInstructions: o.extra,
      },
    });
    if (o.save === false) console.log(toMarkdown(drafts));
    else writeDrafts(cfg.outDir, extraction.account.companyName ?? extraction.meeting.title, drafts, cfg.sender.name);
  });

function writeDrafts(outDir: string, name: string, drafts: Parameters<typeof toMarkdown>[0], from?: string) {
  console.log(`\n${toMarkdown(drafts)}\n`);
  mkdirSync(outDir, { recursive: true });
  const base = `${new Date().toISOString().slice(0, 10)}-${slugify(name)}-followup`;
  const md = join(outDir, `${base}.md`);
  writeFileSync(md, toMarkdown(drafts) + "\n");
  const written = [md];
  drafts.forEach((d, i) => {
    const eml = join(outDir, `${base}${drafts.length > 1 ? `-${i + 1}` : ""}.eml`);
    writeFileSync(eml, toEml(d, from));
    written.push(eml);
  });
  console.log(`Saved: ${written.join(", ")}`);
}

program.parseAsync().catch((err: Error) => {
  console.error(`Error: ${err.message}`);
  process.exit(1);
});
