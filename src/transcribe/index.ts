import { readFile } from "node:fs/promises";
import { basename, extname } from "node:path";
import type { AppConfig } from "../config.js";
import { parseCaptions } from "./captions.js";
import { DeepgramTranscriber } from "./deepgram.js";
import { formatTranscript } from "./format.js";
import { OpenAiTranscriber } from "./openai.js";
import { TranscriptionError, type AudioInput, type Transcriber, type Transcript } from "./types.js";

export const AUDIO_TYPES: Record<string, string> = {
  ".mp3": "audio/mpeg",
  ".mpga": "audio/mpeg",
  ".mpeg": "audio/mpeg",
  ".m4a": "audio/mp4",
  ".mp4": "audio/mp4",
  ".aac": "audio/aac",
  ".wav": "audio/wav",
  ".webm": "audio/webm",
  ".ogg": "audio/ogg",
  ".opus": "audio/ogg",
  ".flac": "audio/flac",
};

export function isAudioPath(path: string): boolean {
  return extname(path).toLowerCase() in AUDIO_TYPES;
}

export function createTranscriber(cfg: AppConfig): Transcriber {
  const t = cfg.transcribe;
  if (t.provider === "openai") return new OpenAiTranscriber(t.openai);
  return new DeepgramTranscriber(t.deepgram);
}

export async function audioFromFile(path: string): Promise<AudioInput> {
  const ext = extname(path).toLowerCase();
  const mimeType = AUDIO_TYPES[ext];
  if (!mimeType) throw new TranscriptionError(`Not a supported audio file: ${path}`);
  return { data: new Uint8Array(await readFile(path)), filename: basename(path), mimeType };
}

/** Extract text from a Word transcript (Teams "Download as .docx"). */
export async function docxToText(data: Uint8Array): Promise<string> {
  const mammoth = await import("mammoth");
  const { value } = await mammoth.extractRawText({ buffer: Buffer.from(data) });
  return value.replace(/\n{2,}/g, "\n").trim();
}

export interface CallInput {
  /** Text sent to Claude for extraction. */
  text: string;
  /** "transcript" switches the extraction prompt to transcript handling (speaker labels, filler, mishearings). */
  kind: "notes" | "transcript";
  /** Present when the input was audio or a caption file. */
  transcript?: Transcript;
}

/**
 * Turn any supported file into text ready for extraction:
 *   audio (.m4a .mp3 .wav ...) -> speech-to-text with speaker labels
 *   captions (.vtt .srt)        -> parsed speaker turns
 *   Word (.docx)                -> raw text, treated as a transcript
 *   anything else               -> read as plain notes
 */
export async function loadCallInput(
  path: string,
  cfg: AppConfig,
  opts: { speakerNames?: Record<string, string>; transcriber?: Transcriber; onProgress?: (msg: string) => void } = {},
): Promise<CallInput> {
  const ext = extname(path).toLowerCase();
  if (ext in AUDIO_TYPES) {
    const audio = await audioFromFile(path);
    const transcriber = opts.transcriber ?? createTranscriber(cfg);
    const mb = (audio.data.byteLength / 1024 / 1024).toFixed(1);
    opts.onProgress?.(`Transcribing ${audio.filename} (${mb} MB) with ${transcriber.name}...`);
    const transcript = await transcriber.transcribe(audio);
    return { text: formatTranscript(transcript, opts.speakerNames), kind: "transcript", transcript };
  }
  if (ext === ".vtt" || ext === ".srt") {
    const transcript = parseCaptions(await readFile(path, "utf8"), ext.slice(1) as "vtt" | "srt");
    return { text: formatTranscript(transcript, opts.speakerNames), kind: "transcript", transcript };
  }
  if (ext === ".docx") {
    return { text: await docxToText(new Uint8Array(await readFile(path))), kind: "transcript" };
  }
  return { text: await readFile(path, "utf8"), kind: "notes" };
}

export * from "./types.js";
export { formatTranscript, parseCaptions };
