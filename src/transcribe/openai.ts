import type { FetchLike } from "../crm/types.js";
import { TranscriptionError, type AudioInput, type Transcriber, type Transcript } from "./types.js";

export interface OpenAiTranscribeConfig {
  apiKey?: string;
  model: string;
}

/** OpenAI's documented upload limit for the transcription endpoint. */
export const OPENAI_MAX_BYTES = 25 * 1024 * 1024;

/**
 * OpenAI transcription. With a diarizing model (default: gpt-4o-transcribe-diarize) the response
 * carries speaker-labelled segments; other models return plain text.
 */
export class OpenAiTranscriber implements Transcriber {
  readonly name = "openai";

  constructor(
    private cfg: OpenAiTranscribeConfig,
    private fetchImpl: FetchLike = fetch,
  ) {
    if (!cfg.apiKey) throw new TranscriptionError("OPENAI_API_KEY is not set.");
  }

  async transcribe(audio: AudioInput): Promise<Transcript> {
    if (audio.data.byteLength > OPENAI_MAX_BYTES) {
      const mb = (audio.data.byteLength / 1024 / 1024).toFixed(1);
      throw new TranscriptionError(
        `${audio.filename} is ${mb} MB; OpenAI accepts up to 25 MB. Use TRANSCRIBE_PROVIDER=deepgram, or compress it first, e.g. ffmpeg -i in.m4a -ac 1 -b:a 32k out.mp3`,
      );
    }
    const diarize = this.cfg.model.includes("diarize");
    const form = new FormData();
    form.append("file", new Blob([audio.data], { type: audio.mimeType }), audio.filename);
    form.append("model", this.cfg.model);
    form.append("response_format", diarize ? "diarized_json" : "json");
    if (diarize) form.append("chunking_strategy", "auto");

    const res = await this.fetchImpl("https://api.openai.com/v1/audio/transcriptions", {
      method: "POST",
      headers: { Authorization: `Bearer ${this.cfg.apiKey}` },
      body: form,
    });
    const text = await res.text();
    if (!res.ok) throw new TranscriptionError(`OpenAI transcription failed (${res.status}): ${text.slice(0, 400)}`);

    const json = JSON.parse(text) as {
      text?: string;
      duration?: number;
      segments?: Array<{ speaker?: string; start?: number; end?: number; text?: string }>;
    };
    const segments = json.segments?.length
      ? json.segments.map((s) => ({
          speaker: s.speaker ? `Speaker ${s.speaker}` : null,
          start: s.start ?? null,
          end: s.end ?? null,
          text: s.text ?? "",
        }))
      : [{ speaker: null, start: null, end: null, text: json.text ?? "" }];

    if (!segments.some((s) => s.text.trim())) throw new TranscriptionError("OpenAI returned an empty transcript. Is there speech in the file?");
    return { segments, source: this.name, durationSec: json.duration };
  }
}
