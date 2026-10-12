import type { Transcript, TranscriptSegment } from "./types.js";

function toSeconds(ts: string): number | null {
  const m = ts.trim().match(/^(?:(\d+):)?(\d{1,2}):(\d{2})[.,](\d{1,3})$/);
  if (!m) return null;
  const [, h, mm, ss, ms] = m;
  return Number(h ?? 0) * 3600 + Number(mm) * 60 + Number(ss) + Number(ms!.padEnd(3, "0")) / 1000;
}

const decodeEntities = (s: string) =>
  s
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;|&apos;/g, "'")
    .replace(/&nbsp;/g, " ");

/**
 * Parse WebVTT (Teams, Zoom, Google Meet) or SRT caption files into speaker segments.
 * Speaker names come from <v Name> voice tags (Teams) or a leading "Name:" (Zoom, Meet).
 */
export function parseCaptions(text: string, kind: "vtt" | "srt"): Transcript {
  const blocks = text.replace(/\r\n?/g, "\n").replace(/^﻿/, "").split(/\n{2,}/);
  const segments: TranscriptSegment[] = [];
  for (const block of blocks) {
    const lines = block.split("\n").filter((l) => l.trim() !== "");
    const timeIdx = lines.findIndex((l) => l.includes("-->"));
    if (timeIdx === -1) continue; // WEBVTT header, NOTE blocks, STYLE blocks
    const [from, to] = lines[timeIdx]!.split("-->").map((p) => p.trim().split(/\s+/)[0] ?? "");
    let body = lines.slice(timeIdx + 1).join(" ");
    let speaker: string | null = null;
    const voice = body.match(/<v(?:\.[^\s>]+)?\s+([^>]+)>/);
    if (voice) speaker = voice[1]!.trim();
    body = decodeEntities(body.replace(/<[^>]+>/g, "")).replace(/\s+/g, " ").trim();
    if (!speaker) {
      const named = body.match(/^([A-Z][\w.'\- ]{0,40}?):\s+(.*)$/);
      if (named) {
        speaker = named[1]!.trim();
        body = named[2]!;
      }
    }
    if (body) segments.push({ speaker, start: toSeconds(from ?? ""), end: toSeconds(to ?? ""), text: body });
  }
  return { segments, source: kind };
}
