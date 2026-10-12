import type { Transcript, TranscriptSegment } from "./types.js";

export function formatTimestamp(sec: number): string {
  const s = Math.max(0, Math.floor(sec));
  const hh = Math.floor(s / 3600);
  const mm = Math.floor((s % 3600) / 60);
  const ss = s % 60;
  const two = (n: number) => String(n).padStart(2, "0");
  return hh ? `${hh}:${two(mm)}:${two(ss)}` : `${two(mm)}:${two(ss)}`;
}

/** Merge consecutive segments from the same speaker so the transcript reads as turns, not fragments. */
export function mergeTurns(segments: TranscriptSegment[]): TranscriptSegment[] {
  const out: TranscriptSegment[] = [];
  for (const seg of segments) {
    const text = seg.text.trim();
    if (!text) continue;
    const prev = out[out.length - 1];
    if (prev && prev.speaker === seg.speaker) {
      prev.text = `${prev.text} ${text}`;
      prev.end = seg.end ?? prev.end;
    } else {
      out.push({ ...seg, text });
    }
  }
  return out;
}

/**
 * Plain-text transcript, one speaker turn per line:
 *   [00:42] Speaker 1: Thanks for making the time...
 * Speaker names can be substituted with a map such as {"Speaker 1": "Sox"}.
 */
export function formatTranscript(t: Transcript, speakerNames: Record<string, string> = {}): string {
  return mergeTurns(t.segments)
    .map((s) => {
      const time = s.start != null ? `[${formatTimestamp(s.start)}] ` : "";
      const who = s.speaker ? `${speakerNames[s.speaker] ?? s.speaker}: ` : "";
      return `${time}${who}${s.text}`;
    })
    .join("\n");
}

/** Parse "Speaker 1=Sox, Speaker 2=Thandi" into a map. */
export function parseSpeakerMap(raw: string | undefined): Record<string, string> {
  if (!raw) return {};
  const map: Record<string, string> = {};
  for (const pair of raw.split(",")) {
    const [k, v] = pair.split("=").map((s) => s.trim());
    if (k && v) map[k] = v;
  }
  return map;
}
