import { existsSync, readFileSync } from "node:fs";

export interface StyleProfile {
  /** Free-text guidance and example emails passed to the model. */
  guidance: string;
  rules: {
    noEmDashes: boolean;
    noContractions: boolean;
    maxWords?: number;
  };
  signature?: string;
}

/**
 * A style profile is a markdown file with a simple front matter block:
 *
 * ---
 * noEmDashes: true
 * noContractions: true
 * maxWords: 180
 * ---
 * Free-form guidance, do's and don'ts, and example emails...
 *
 * ## Signature
 * Kind regards,
 * Sox
 */
export function parseStyleProfile(text: string): StyleProfile {
  let body = text;
  const meta: Record<string, string> = {};
  const fm = text.match(/^---\r?\n([\s\S]*?)\r?\n---\r?\n?/);
  if (fm) {
    body = text.slice(fm[0].length);
    for (const line of fm[1]!.split(/\r?\n/)) {
      const m = line.match(/^\s*([A-Za-z][\w]*)\s*:\s*(.*?)\s*$/);
      if (m) meta[m[1]!] = m[2]!;
    }
  }
  let signature: string | undefined;
  const sig = body.match(/^##\s+Signature\s*\r?\n([\s\S]*?)(?=^##\s|$(?![\s\S]))/m);
  if (sig) {
    signature = sig[1]!.trim() || undefined;
    body = body.replace(sig[0], "");
  }
  const bool = (v: string | undefined, d: boolean) => (v === undefined ? d : /^(true|yes|1)$/i.test(v));
  return {
    guidance: body.trim(),
    rules: {
      noEmDashes: bool(meta.noEmDashes, true),
      noContractions: bool(meta.noContractions, false),
      maxWords: meta.maxWords ? Number(meta.maxWords) : undefined,
    },
    signature,
  };
}

export function loadStyleProfile(path?: string): StyleProfile {
  if (path) {
    if (!existsSync(path)) throw new Error(`Style profile not found: ${path}`);
    return parseStyleProfile(readFileSync(path, "utf8"));
  }
  const fallback = new URL("../../styles/default.md", import.meta.url);
  if (existsSync(fallback)) return parseStyleProfile(readFileSync(fallback, "utf8"));
  return { guidance: "", rules: { noEmDashes: true, noContractions: false } };
}

const CONTRACTIONS: Record<string, string> = {
  "aren't": "are not",
  "can't": "cannot",
  "couldn't": "could not",
  "didn't": "did not",
  "doesn't": "does not",
  "don't": "do not",
  "hadn't": "had not",
  "hasn't": "has not",
  "haven't": "have not",
  "he's": "he is",
  "here's": "here is",
  "i'd": "I would",
  "i'll": "I will",
  "i'm": "I am",
  "i've": "I have",
  "isn't": "is not",
  "it'll": "it will",
  "it's": "it is",
  "let's": "let us",
  "she's": "she is",
  "shouldn't": "should not",
  "that's": "that is",
  "there's": "there is",
  "they'd": "they would",
  "they'll": "they will",
  "they're": "they are",
  "they've": "they have",
  "wasn't": "was not",
  "we'd": "we would",
  "we'll": "we will",
  "we're": "we are",
  "we've": "we have",
  "weren't": "were not",
  "what's": "what is",
  "won't": "will not",
  "wouldn't": "would not",
  "you'd": "you would",
  "you'll": "you will",
  "you're": "you are",
  "you've": "you have",
};

function matchCase(original: string, replacement: string): string {
  if (original[0] && original[0] === original[0].toUpperCase() && original[0] !== original[0].toLowerCase()) {
    return replacement[0]!.toUpperCase() + replacement.slice(1);
  }
  return replacement;
}

export function expandContractions(text: string): { text: string; count: number } {
  let count = 0;
  const out = text.replace(/\b[A-Za-z]+['’][a-z]+\b/g, (word) => {
    const key = word.toLowerCase().replace("’", "'");
    const rep = CONTRACTIONS[key];
    if (!rep) return word;
    count++;
    // Keep "I" capitalised however the sentence starts.
    return rep.startsWith("I ") ? rep : matchCase(word, rep);
  });
  return { text: out, count };
}

/** Replace em dashes (and spaced en dashes used as em dashes) with commas, keeping ranges like 9–5 intact. */
export function removeEmDashes(text: string): { text: string; count: number } {
  let count = 0;
  const out = text
    .replace(/\s*—\s*/g, () => {
      count++;
      return ", ";
    })
    .replace(/\s+–\s+/g, () => {
      count++;
      return ", ";
    })
    .replace(/ -- /g, () => {
      count++;
      return ", ";
    })
    .replace(/,\s*([.,;:!?])/g, "$1");
  return { text: out, count };
}

export interface StyleFixReport {
  emDashesRemoved: number;
  contractionsExpanded: number;
  wordCount: number;
  overMaxWords: boolean;
}

export function applyStyleRules(text: string, profile: StyleProfile): { text: string; report: StyleFixReport } {
  let t = text;
  let emDashesRemoved = 0;
  let contractionsExpanded = 0;
  if (profile.rules.noEmDashes) {
    const r = removeEmDashes(t);
    t = r.text;
    emDashesRemoved = r.count;
  }
  if (profile.rules.noContractions) {
    const r = expandContractions(t);
    t = r.text;
    contractionsExpanded = r.count;
  }
  const wordCount = t.split(/\s+/).filter(Boolean).length;
  return {
    text: t,
    report: {
      emDashesRemoved,
      contractionsExpanded,
      wordCount,
      overMaxWords: profile.rules.maxWords !== undefined && wordCount > profile.rules.maxWords,
    },
  };
}
