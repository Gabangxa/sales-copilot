export interface TranscriptSegment {
  /** Display label, e.g. "Speaker 1" or a real name from a Teams caption file. */
  speaker: string | null;
  /** Seconds from the start of the recording, when known. */
  start: number | null;
  end: number | null;
  text: string;
}

export interface Transcript {
  segments: TranscriptSegment[];
  /** Where it came from: "deepgram", "openai", "vtt", "srt", "docx" or "text". */
  source: string;
  durationSec?: number;
}

export interface AudioInput {
  data: Uint8Array<ArrayBuffer>;
  filename: string;
  mimeType: string;
}

export interface Transcriber {
  readonly name: string;
  transcribe(audio: AudioInput): Promise<Transcript>;
}

export class TranscriptionError extends Error {}
