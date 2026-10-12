#!/usr/bin/env node
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { basename, extname, join } from "node:path";
import { Command, Option } from "commander";
import { getConfig, loadDotEnv, type AppConfig, type CrmName } from "./config.js";
import { slugify } from "./crm/file.js";
import { toEml, toMarkdown, toPlainText, type Tone } from "./followup/draft.js";
import { AnthropicLlm } from "./llm.js";
import { renderNoteMarkdown, noteTitle } from "./notes/render.js";
import { followUp, notesToCrm } from "./pipeline.js";
import type { PushResult } from "./crm/types.js";
import { isAudioPath, loadCallInput, type CallInput } from "./transcribe/index.js";
import { parseSpeakerMap } from "./transcribe/format.js";

loadDotEnv();

async function readStdin(): Promise<string> {
  if (process.stdin.isTTY) throw new Error("Pass a notes, transcript or audio file, or pipe notes in on stdin.");
  const chunks: Buffer[] = [];
  for await (const chunk of process.stdin) chunks.push(chunk as Buffer);
  return Buffer.concat(chunks).toString("utf8");
}

/** Read notes, a caption/Word transcript, or an audio file (transcribed first). */
async function readCallInput(
  file: string | undefined,
  cfg: AppConfig,
  o: { speakers?: string; saveTranscript?: string; transcript?: boolean },
): Promise<CallInput> {
  let input: CallInput;
  if (!file || file === "-") {
    input = { text: await readStdin(), kind: "notes" };
  } else {
    input = await loadCallInput(file, cfg, {
      speakerNames: parseSpeakerMap(o.speakers),
      onProgress: (msg) => console.error(msg),
    });
  }
  if (o.transcript) input.kind = "transcript";
  if (input.kind === "transcript" && file && file !== "-") {
    const path = o.saveTranscript ?? (isAudioPath(file) ? defaultTranscriptPath(cfg.outDir, file) : undefined);
    if (path) {
      mkdirSync(join(path, ".."), { recursive: true });
      writeFileSync(path, input.text + "\n");
      console.error(`Transcript saved to ${path}`);
    }
  }
  return input;
}

function defaultTranscriptPath(outDir: string, file: string) {
  return join(outDir, `${slugify(basename(file, extname(file)))}-transcript.txt`);
}

function printPush(r: PushResult) {
  console.log(`\nCRM: ${r.crm}${r.dryRun ? " (dry run, nothing written)" : ""}`);
  for (const a of r.actions) console.log(`  - ${a}`);
  for (const w of r.warnings) console.log(`  ! ${w}`);
}

const program = new Command()
  .name("sales-copilot")
  .description("Turn call notes, transcripts or recordings into CRM updates and follow-up emails with Claude.")
  .version("0.2.0");

const crmOption = new Option("--crm <crm>", "where to push: twenty, hubspot, file, none").choices([
  "twenty",
  "hubspot",
  "file",
  "none",
]);
const toneOption = new Option("--tone <tone>", "email tone").choices(["warm", "direct", "formal"]).default("warm");
const inputHelp =
  "notes (.txt/.md), transcript (.vtt/.srt/.docx) or recording (.m4a/.mp3/.wav/.mp4/.webm/.ogg/.flac); - or stdin for pasted notes";

program
  .command("transcribe")
  .description("Transcribe a call recording (or tidy a .vtt/.srt/.docx transcript) into speaker-labelled text")
  .argument("<file>", "audio, caption or Word transcript file")
  .option("-o, --out <path>", "where to save the transcript (default: OUT_DIR/<name>-transcript.txt)")
  .option("--speakers <map>", 'rename speakers, e.g. "Speaker 1=Sox,Speaker 2=Thandi"')
  .action(async (file: string, o) => {
    const cfg = getConfig();
    const input = await loadCallInput(file, cfg, {
      speakerNames: parseSpeakerMap(o.speakers),
      onProgress: (msg) => console.error(msg),
    });
    const out = o.out ?? defaultTranscriptPath(cfg.outDir, file);
    mkdirSync(join(out, ".."), { recursive: true });
    writeFileSync(out, input.text + "\n");
    console.log(input.text);
    const speakers = new Set(input.transcript?.segments.map((s) => s.speaker).filter(Boolean));
    console.error(`\nSaved ${out}${speakers.size ? ` (${speakers.size} speaker${speakers.size > 1 ? "s" : ""})` : ""}`);
  });

program
  .command("notes")
  .description("Extract a structured record from notes, a transcript or a recording, and push it to your CRM")
  .argument("[file]", inputHelp)
  .addOption(crmOption)
  .option("--date <yyyy-mm-dd>", "meeting date, used to resolve 'next Friday' style deadlines")
  .option("--context <text>", "extra context, e.g. 'existing client, renewal in March'")
  .option("--speakers <map>", 'name the speakers in a recording, e.g. "Speaker 1=Sox,Speaker 2=Thandi"')
  .option("--transcript", "treat a text file as a transcript rather than notes")
  .option("--save-transcript <path>", "where to save the transcript of a recording")
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
    const input = await readCallInput(file, cfg, o);
    const { extraction, crm } = await notesToCrm(llm, cfg, {
      notes: input.text,
      crm: o.crm as CrmName | undefined,
      extract: { meetingDate: o.date, context: o.context, inputKind: input.kind },
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
  .description("Draft a follow-up email from notes, a transcript, a recording, or a saved extraction")
  .argument("[file]", inputHelp)
  .option("--from-json <path>", "use an extraction saved by `notes --save-json` instead")
  .addOption(toneOption)
  .option("--variants <n>", "number of alternative drafts (1 to 3)", "1")
  .option("--to <email>", "recipient email (defaults to the client attendee in the notes)")
  .option("--to-name <name>", "recipient name")
  .option("--cta <text>", "the one thing this email should ask for")
  .option("--extra <text>", "anything else to include")
  .option("--style <path>", "style profile markdown file (default: styles/default.md)")
  .option("--date <yyyy-mm-dd>", "meeting date")
  .option("--speakers <map>", 'name the speakers in a recording, e.g. "Speaker 1=Sox,Speaker 2=Thandi"')
  .option("--transcript", "treat a text file as a transcript rather than notes")
  .option("--save-transcript <path>", "where to save the transcript of a recording")
  .option("--no-save", "print only, do not write files to OUT_DIR")
  .action(async (file: string | undefined, o) => {
    const cfg = getConfig();
    const llm = new AnthropicLlm(cfg.anthropicApiKey, cfg.model);
    const extractionJson = o.fromJson ? JSON.parse(readFileSync(o.fromJson, "utf8")) : undefined;
    const input = extractionJson ? undefined : await readCallInput(file, cfg, o);
    const { extraction, drafts } = await followUp(llm, cfg, {
      notes: input?.text,
      extraction: extractionJson,
      extract: { meetingDate: o.date, inputKind: input?.kind },
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
    const name = `${base}${drafts.length > 1 ? `-${i + 1}` : ""}`;
    const eml = join(outDir, `${name}.eml`);
    const txt = join(outDir, `${name}.txt`);
    writeFileSync(eml, toEml(d, from));
    writeFileSync(txt, toPlainText(d));
    written.push(eml, txt);
  });
  console.log(`Saved: ${written.join(", ")}`);
}

program.parseAsync().catch((err: Error) => {
  console.error(`Error: ${err.message}`);
  process.exit(1);
});
