import type { FetchLike } from "../crm/types.js";
import { TranscriptionError, type AudioInput, type Transcriber, type Transcript } from "./types.js";

export interface DeepgramConfig {
  apiKey?: string;
  model: string;
  language: string;
}

interface DeepgramUtterance {
  start: number;
  end: number;
  transcript: string;
  speaker?: number;
}

/**
 * Deepgram pre-recorded transcription (https://developers.deepgram.com).
 * Sends the raw file and asks for speaker labels (diarize_model), smart formatting and utterances.
 */
export class DeepgramTranscriber implements Transcriber {
  readonly name = "deepgram";

  constructor(
    private cfg: DeepgramConfig,
    private fetchImpl: FetchLike = fetch,
  ) {
    if (!cfg.apiKey) throw new TranscriptionError("DEEPGRAM_API_KEY is not set.");
  }

  async transcribe(audio: AudioInput): Promise<Transcript> {
    const params = new URLSearchParams({
      model: this.cfg.model,
      smart_format: "true",
      punctuate: "true",
      utterances: "true",
      diarize_model: "latest",
    });
    if (this.cfg.language === "detect") params.set("detect_language", "true");
    else params.set("language", this.cfg.language);

    const url = `https://api.deepgram.com/v1/listen?${params}`;
    const res = await this.fetchImpl(url, {
      method: "POST",
      headers: { Authorization: `Token ${this.cfg.apiKey}`, "Content-Type": audio.mimeType },
      body: audio.data,
    });
    const text = await res.text();
    if (!res.ok) throw new TranscriptionError(`Deepgram transcription failed (${res.status}): ${text.slice(0, 400)}`);

    const json = JSON.parse(text) as {
      metadata?: { duration?: number };
      results?: { utterances?: DeepgramUtterance[]; channels?: Array<{ alternatives?: Array<{ transcript?: string }> }> };
    };
    const utterances = json.results?.utterances ?? [];
    const segments = utterances.length
      ? utterances.map((u) => ({
          speaker: typeof u.speaker === "number" ? `Speaker ${u.speaker + 1}` : null,
          start: u.start ?? null,
          end: u.end ?? null,
          text: u.transcript ?? "",
        }))
      : [{ speaker: null, start: null, end: null, text: json.results?.channels?.[0]?.alternatives?.[0]?.transcript ?? "" }];

    if (!segments.some((s) => s.text.trim())) throw new TranscriptionError("Deepgram returned an empty transcript. Is there speech in the file?");
    return { segments, source: this.name, durationSec: json.metadata?.duration };
  }
}
