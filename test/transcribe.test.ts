import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { getConfig } from "../src/config.js";
import { buildExtractionPrompt } from "../src/notes/extract.js";
import { parseCaptions } from "../src/transcribe/captions.js";
import { DeepgramTranscriber } from "../src/transcribe/deepgram.js";
import { formatTimestamp, formatTranscript, parseSpeakerMap } from "../src/transcribe/format.js";
import { loadCallInput } from "../src/transcribe/index.js";
import { OPENAI_MAX_BYTES, OpenAiTranscriber } from "../src/transcribe/openai.js";
import type { Transcriber } from "../src/transcribe/types.js";

const audio = (bytes = 16) => ({ data: new Uint8Array(bytes), filename: "call.m4a", mimeType: "audio/mp4" });

describe("caption parsing", () => {
  it("reads Teams VTT voice tags", () => {
    const vtt = `WEBVTT

0f2e/12-0
00:00:01.200 --> 00:00:04.900
<v Thandi Mokoena>Thanks for making the time.</v>

0f2e/13-0
00:00:05.000 --> 00:00:09.100
<v Sox>Of course. Shall we start with the EUR settlement issue?</v>`;
    const t = parseCaptions(vtt, "vtt");
    expect(t.segments).toEqual([
      { speaker: "Thandi Mokoena", start: 1.2, end: 4.9, text: "Thanks for making the time." },
      { speaker: "Sox", start: 5, end: 9.1, text: "Of course. Shall we start with the EUR settlement issue?" },
    ]);
  });

  it("reads Zoom-style 'Name: text' captions and SRT", () => {
    const srt = `1
00:00:01,000 --> 00:00:03,000
Pieter Venter: Onboarding took four months last time.

2
00:00:03,500 --> 00:00:05,000
We cannot do that again.`;
    const t = parseCaptions(srt, "srt");
    expect(t.segments[0]).toMatchObject({ speaker: "Pieter Venter", start: 1, text: "Onboarding took four months last time." });
    expect(t.segments[1]).toMatchObject({ speaker: null, text: "We cannot do that again." });
  });
});

describe("transcript formatting", () => {
  it("merges consecutive turns, adds timestamps and renames speakers", () => {
    const text = formatTranscript(
      {
        source: "deepgram",
        segments: [
          { speaker: "Speaker 1", start: 0, end: 2, text: "Hi Thandi." },
          { speaker: "Speaker 1", start: 2, end: 4, text: "Thanks for joining." },
          { speaker: "Speaker 2", start: 65, end: 70, text: "Happy to." },
        ],
      },
      parseSpeakerMap("Speaker 1=Sox, Speaker 2 = Thandi"),
    );
    expect(text).toBe("[00:00] Sox: Hi Thandi. Thanks for joining.\n[01:05] Thandi: Happy to.");
  });

  it("formats long recordings with hours", () => {
    expect(formatTimestamp(3725)).toBe("1:02:05");
  });
});

describe("DeepgramTranscriber", () => {
  it("sends the raw file with diarization and maps utterances to speakers", async () => {
    let seen: { url: string; init: RequestInit } | undefined;
    const fetchImpl = (async (url: string, init: RequestInit) => {
      seen = { url, init };
      return new Response(
        JSON.stringify({
          metadata: { duration: 12.5 },
          results: {
            utterances: [
              { start: 0.5, end: 3, transcript: "Thanks for the time.", speaker: 0 },
              { start: 3.2, end: 6, transcript: "Pleasure.", speaker: 1 },
            ],
          },
        }),
      );
    }) as unknown as typeof fetch;
    const t = await new DeepgramTranscriber({ apiKey: "dg", model: "nova-3", language: "en" }, fetchImpl).transcribe(audio());
    const url = new URL(seen!.url);
    expect(url.searchParams.get("model")).toBe("nova-3");
    expect(url.searchParams.get("diarize_model")).toBe("latest");
    expect(url.searchParams.get("utterances")).toBe("true");
    expect((seen!.init.headers as Record<string, string>).Authorization).toBe("Token dg");
    expect((seen!.init.headers as Record<string, string>)["Content-Type"]).toBe("audio/mp4");
    expect(t.segments.map((s) => s.speaker)).toEqual(["Speaker 1", "Speaker 2"]);
    expect(t.durationSec).toBe(12.5);
  });

  it("reports API errors clearly", async () => {
    const fetchImpl = (async () => new Response("bad key", { status: 401 })) as unknown as typeof fetch;
    await expect(new DeepgramTranscriber({ apiKey: "x", model: "nova-3", language: "en" }, fetchImpl).transcribe(audio())).rejects.toThrow(
      /Deepgram transcription failed \(401\)/,
    );
  });

  it("requires an API key", () => {
    expect(() => new DeepgramTranscriber({ model: "nova-3", language: "en" })).toThrow(/DEEPGRAM_API_KEY/);
  });
});

describe("OpenAiTranscriber", () => {
  it("asks the diarize model for diarized_json with auto chunking", async () => {
    let form: FormData | undefined;
    const fetchImpl = (async (_url: string, init: RequestInit) => {
      form = init.body as FormData;
      return new Response(
        JSON.stringify({ duration: 8, segments: [{ speaker: "A", start: 0, end: 4, text: "Hello." }, { speaker: "B", start: 4, end: 8, text: "Hi." }] }),
      );
    }) as unknown as typeof fetch;
    const t = await new OpenAiTranscriber({ apiKey: "sk", model: "gpt-4o-transcribe-diarize" }, fetchImpl).transcribe(audio());
    expect(form!.get("model")).toBe("gpt-4o-transcribe-diarize");
    expect(form!.get("response_format")).toBe("diarized_json");
    expect(form!.get("chunking_strategy")).toBe("auto");
    expect((form!.get("file") as File).name).toBe("call.m4a");
    expect(t.segments.map((s) => s.speaker)).toEqual(["Speaker A", "Speaker B"]);
  });

  it("refuses files over the upload limit before sending", async () => {
    let called = false;
    const fetchImpl = (async () => {
      called = true;
      return new Response("{}");
    }) as unknown as typeof fetch;
    await expect(
      new OpenAiTranscriber({ apiKey: "sk", model: "gpt-4o-transcribe-diarize" }, fetchImpl).transcribe(audio(OPENAI_MAX_BYTES + 1)),
    ).rejects.toThrow(/25 MB/);
    expect(called).toBe(false);
  });
});

describe("loadCallInput", () => {
  const dir = mkdtempSync(join(tmpdir(), "sc-in-"));
  const cfg = getConfig({} as NodeJS.ProcessEnv);

  it("transcribes audio files and marks them as transcripts", async () => {
    const path = join(dir, "kestrel.m4a");
    writeFileSync(path, Buffer.from([1, 2, 3]));
    const fake: Transcriber = {
      name: "fake",
      async transcribe(a) {
        expect(a).toMatchObject({ filename: "kestrel.m4a", mimeType: "audio/mp4" });
        return { source: "fake", segments: [{ speaker: "Speaker 1", start: 0, end: 1, text: "Hello" }] };
      },
    };
    const input = await loadCallInput(path, cfg, { transcriber: fake, speakerNames: { "Speaker 1": "Sox" } });
    expect(input).toMatchObject({ kind: "transcript", text: "[00:00] Sox: Hello" });
  });

  it("reads caption files as transcripts and text files as notes", async () => {
    const vtt = join(dir, "call.vtt");
    writeFileSync(vtt, "WEBVTT\n\n00:00:01.000 --> 00:00:02.000\n<v Sox>Hi</v>\n");
    expect(await loadCallInput(vtt, cfg)).toMatchObject({ kind: "transcript", text: "[00:01] Sox: Hi" });
    const txt = join(dir, "notes.txt");
    writeFileSync(txt, "- rough notes");
    expect(await loadCallInput(txt, cfg)).toEqual({ kind: "notes", text: "- rough notes" });
  });
});

describe("transcript-aware extraction prompt", () => {
  it("adds transcript guidance only for transcripts", () => {
    const t = buildExtractionPrompt("[00:00] Speaker 1: hi", { inputKind: "transcript" });
    expect(t).toContain("<call_transcript>");
    expect(t).toContain("Speech-to-text can mishear");
    const n = buildExtractionPrompt("notes");
    expect(n).toContain("<call_notes>");
    expect(n).not.toContain("Speech-to-text");
  });
});
