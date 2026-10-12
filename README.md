# sales-copilot

Two small tools for salespeople, powered by Claude:

1. **Call notes to CRM**: paste rough call notes or a transcript, get a clean structured record (summary, attendees, next steps with owners and dates, objections, deal stage, commercial details), and push it to **Twenty**, **HubSpot**, or local files. Our next steps become CRM tasks.
2. **Follow-up email drafter**: turns the same record into a follow-up email in your own voice, with the agreed next steps and one clear call to action. Saves `.md` and `.eml` drafts you can open in your mail client.

Both work from the command line or as a small HTTP API you can deploy (Railway, Render, Fly, anywhere Node runs).

## Quick start

```bash
git clone https://github.com/Gabangxa/sales-copilot.git
cd sales-copilot
npm install
cp .env.example .env        # add ANTHROPIC_API_KEY at minimum
npm run build

# 1. Notes to CRM (CRM=file writes to ./out until you connect a CRM)
node dist/cli.js notes examples/sample-call.txt --date 2026-10-12

# 2. Follow-up email from the same notes
node dist/cli.js followup examples/sample-call.txt --tone warm

# Or both in one pass
node dist/cli.js notes examples/sample-call.txt --followup
```

During development you can skip the build: `npm run dev -- notes examples/sample-call.txt`.

## 1. Call notes to CRM

```bash
sales-copilot notes <file> [options]
cat notes.txt | sales-copilot notes          # stdin works too
```

| Option | What it does |
|---|---|
| `--crm twenty\|hubspot\|file\|none` | Override the `CRM` env var |
| `--date YYYY-MM-DD` | Meeting date, used to turn "next Friday" into a real due date |
| `--context "..."` | Extra context, e.g. "existing client, renewal due March" |
| `--deal <id>` | Attach the note and tasks to this deal / opportunity |
| `--company <id>` | Attach to this company (otherwise matched by name) |
| `--update-stage` | Move the deal to the suggested stage, using your stage map |
| `--all-tasks` | Also create tasks for the client's commitments |
| `--dry-run` | Show every CRM write without making it |
| `--json` / `--save-json <path>` | Print or save the structured record |
| `--followup` | Draft the follow-up email in the same run |

**What gets written**

| | Twenty | HubSpot | file |
|---|---|---|---|
| Note | `notes` with markdown body (`bodyV2`) | `notes` with HTML body | `out/<date>-<company>.md` |
| Links | `noteTargets` / `taskTargets` to company, people (by email), opportunity | HubSpot-defined associations to company, contacts, deal | |
| Tasks | One per next step we own, with due date | One per next step, with priority | Listed in the output |
| Stage | `PATCH opportunities/{id}` `stage` | `PATCH deals/{id}` `dealstage` | |
| Raw record | | | `out/<date>-<company>.json` |

Safety defaults: stage changes only happen with `--update-stage` **and** an explicit `--deal`, and only when your stage map has an entry for the suggested stage. Companies are matched by name and people by email; nothing new is created in your contact database. A failed link is reported as a warning rather than losing the note.

### Connecting Twenty

1. In Twenty: **Settings > API & Webhooks > Create key**.
2. Set `CRM=twenty`, `TWENTY_API_KEY`, and `TWENTY_BASE_URL` (cloud is `https://api.twenty.com`, self-hosted is your own domain).
3. Optional: set `TWENTY_STAGE_MAP` to your opportunity stage values.
4. Run once with `--dry-run` to check matching, then for real.

Twenty generates its API per workspace. If you have renamed the standard Notes, Tasks or Opportunities objects, check the field names in the API playground under Settings > API & Webhooks.

### Connecting HubSpot

1. Create a **private app** and copy its access token. Give it read and write scopes for contacts, companies and deals.
2. Set `CRM=hubspot` and `HUBSPOT_ACCESS_TOKEN`.
3. Optional: `HUBSPOT_STAGE_MAP` (your pipeline's internal `dealstage` ids) and `HUBSPOT_OWNER_ID`.

## 2. Follow-up email drafter

```bash
sales-copilot followup <notes-file> [options]
sales-copilot followup --from-json out/2026-10-12-kestrel-foods.json   # reuse a saved record, no re-extraction
```

| Option | What it does |
|---|---|
| `--tone warm\|direct\|formal` | Overall register |
| `--variants 1-3` | Several genuinely different approaches, not rewordings |
| `--to`, `--to-name` | Recipient (defaults to the client attendee in the notes) |
| `--cta "..."` | The one thing the email should ask for |
| `--extra "..."` | Anything else to weave in |
| `--style <file>` | Your style profile (see below) |
| `--no-save` | Print only |

Drafts are saved to `OUT_DIR` as a markdown file plus one `.eml` per draft. Double-click an `.eml` to open it as an unsent draft in Outlook, Apple Mail or Thunderbird.

### Making it sound like you

Edit [`styles/default.md`](styles/default.md), or copy it and point `STYLE_PATH` / `--style` at your copy. It has three parts:

```markdown
---
noEmDashes: true      # enforced after generation, not just requested
noContractions: true  # "I will", not "I'll"; also enforced
maxWords: 180         # flagged if exceeded
---
Free-form guidance and one or two real emails you liked.

## Signature
Kind regards,
Sox
```

The rules in the front matter are given to the model **and** applied afterwards in code, so an em dash or contraction that slips through is fixed before you see the draft. Each draft reports what was corrected.

## HTTP API

```bash
npm run build && npm start      # listens on $PORT (default 3000)
```

Set `APP_API_KEY` and send it as `Authorization: Bearer <key>`.

`POST /api/notes`
```json
{ "notes": "raw notes...", "crm": "twenty", "meetingDate": "2026-10-12", "dealId": "opp-id", "updateStage": false, "dryRun": true }
```
Returns `{ extraction, crm }`, where `crm` lists every action taken and any warnings.

`POST /api/followup`
```json
{ "extraction": { "...": "record from /api/notes" }, "tone": "warm", "variants": 2, "cta": "Book a call with the CFO" }
```
Pass `notes` instead of `extraction` to extract and draft in one call. Returns `{ extraction, drafts, eml }`.

`GET /health` returns `{ "ok": true }`.

### Deploying on Railway

Create a service from this repo. Railway runs `npm install`, `npm run build` and `npm start`. Add the variables from `.env.example` in the service settings. Note that `CRM=file` writes to the container's disk, which is not persistent; use Twenty or HubSpot in production.

## Project layout

```
src/
  schema.ts          Zod schema for the call record and email drafts (also the tool schemas sent to Claude)
  llm.ts             Thin Anthropic wrapper: forced tool use for reliable structured output
  notes/extract.ts   Extraction prompt and validation
  notes/render.ts    Markdown / HTML rendering of the record
  crm/               Twenty, HubSpot, file and no-op adapters behind one interface
  followup/draft.ts  Drafting prompt, .eml and markdown output
  followup/style.ts  Style profile parsing and the em dash / contraction guard
  pipeline.ts        Shared flow used by the CLI and the server
  cli.ts, server.ts
test/                Vitest suite with a fake LLM and mocked CRM APIs (no network needed)
```

## Development

```bash
npm test          # 27 tests, no API keys needed
npm run typecheck
```

Adding another CRM means implementing `CrmAdapter.push()` in `src/crm/` and registering it in `src/crm/index.ts`.

## Privacy

Call notes are sent to the Anthropic API for processing. Nothing is stored by this tool other than the files it writes to `OUT_DIR` and the records it writes to your CRM. Keep `.env` out of version control (it is in `.gitignore`).

## Licence

MIT
