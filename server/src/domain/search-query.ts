// Turns a user's search text into a safe Postgres tsquery string, expanding NAAC synonyms.
// Postgres synonym dictionaries need server-side files, which managed Postgres and PGlite
// do not allow, so expansion happens here instead.

const SYNONYMS: string[][] = [
  ["iqac", "internal quality assurance cell"],
  ["mou", "memorandum of understanding", "linkage", "collaboration"],
  ["fdp", "faculty development programme", "faculty development program"],
  ["ict", "information and communication technology", "lms", "e-learning"],
  ["cas", "career advancement scheme"],
  ["nirf", "national institutional ranking framework"],
  ["aqar", "annual quality assurance report"],
  ["ssr", "self study report"],
  ["ilms", "integrated library management system", "library automation"],
  ["ipr", "intellectual property rights", "patent"],
  ["nss", "national service scheme", "extension", "outreach"],
  ["ncc", "national cadet corps"],
  ["sss", "student satisfaction survey"],
  ["cbcs", "choice based credit system", "elective"],
  ["po", "programme outcome", "program outcome"],
  ["co", "course outcome"],
  ["mooc", "swayam", "nptel", "online course"],
  ["placement", "campus recruitment", "job offer"],
  ["best practice", "best practices"],
  ["green audit", "environment audit", "energy audit"],
  ["divyangjan", "disabled friendly", "barrier free"],
];

const METRIC_ID_RE = /\b([1-7])\.(\d{1,2})(?:\.(\d{1,2}))?\b/;
const WORD_RE = /[\p{L}\p{N}]+/gu;
const STOP = new Set(["the", "a", "an", "of", "and", "or", "for", "to", "in", "on", "how", "what", "is", "are", "do", "we", "our", "my", "with", "by"]);

export interface ParsedQuery {
  /** A metric or key-indicator ID typed by the user, e.g. "3.3.1" or "3.3". */
  metricId?: string;
  /** tsquery text for to_tsquery('english', ...) or null if nothing searchable remains. */
  tsquery: string | null;
  terms: string[];
}

function phrase(words: string[]): string {
  return words.length === 1 ? words[0] : `(${words.join(" <-> ")})`;
}

export function parseQuery(q: string): ParsedQuery {
  const text = q.trim().toLowerCase().slice(0, 300);
  const idm = METRIC_ID_RE.exec(text);
  const metricId = idm ? idm[0] : undefined;
  const rest = metricId ? text.replace(metricId, " ") : text;
  const words = (rest.match(WORD_RE) ?? []).filter((w) => !STOP.has(w) && w.length > 1);
  if (!words.length) return { metricId, tsquery: null, terms: [] };

  const joined = ` ${words.join(" ")} `;
  const groups: string[] = [];
  const used = new Set<number>();
  // Multi-word synonyms first, so "internal quality assurance cell" becomes one group with "iqac".
  for (const syn of SYNONYMS) {
    const hit = syn.find((s) => joined.includes(` ${s} `));
    if (!hit) continue;
    const hitWords = hit.split(" ");
    const start = indexOfSeq(words, hitWords);
    if (start < 0 || hitWords.some((_, i) => used.has(start + i))) continue;
    hitWords.forEach((_, i) => used.add(start + i));
    groups.push("(" + syn.map((s) => phrase(s.split(/[\s-]+/).filter(Boolean))).join(" | ") + ")");
  }
  words.forEach((w, i) => {
    if (!used.has(i)) groups.push(`${w}:*`);
  });
  return { metricId, tsquery: groups.join(" & "), terms: words };
}

function indexOfSeq(words: string[], seq: string[]): number {
  outer: for (let i = 0; i + seq.length <= words.length; i++) {
    for (let j = 0; j < seq.length; j++) if (words[i + j] !== seq[j]) continue outer;
    return i;
  }
  return -1;
}
