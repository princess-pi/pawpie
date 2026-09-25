import * as fs from "node:fs";
import * as path from "node:path";
import { ReadFailure } from "./errors.ts";
import { readSidecar } from "./sidecar.ts";

export interface AdrError {
  kind: "no-problem" | "no-date" | "unreadable" | "duplicate-number";
  message: string;
}

export interface Claim {
  disposition: "taken" | "not-taken";
  text: string;
  source: string;
}

export interface AdrRecord {
  id: string;
  number: number;
  file: string;
  title: string | null;
  date: string | null;
  problemWarning: boolean;
  claims: Claim[];
  claimsMissing: boolean;
  error: AdrError | null;
}

export interface ScanResult {
  adrs: AdrRecord[];
  scanned: number;
}

const README_NAMES = new Set(["readme.md"]);

// Anything else without a leading number (a template, a CHANGELOG, ...) is
// skipped the same way an index file is, rather than scanned and refused.
function isAdrFilename(name: string): boolean {
  const lower = name.toLowerCase();
  if (!lower.endsWith(".md") || README_NAMES.has(lower)) return false;
  return /^\d+/.test(name);
}

function parseLeadingNumber(filename: string): number {
  const m = filename.match(/^(\d+)/);
  return Number(m![1]);
}

const DATE_SHAPES: RegExp[] = [
  /^-\s*\*\*Date:\*\*\s*(\d{4}-\d{2}-\d{2})/m,
  // Greedy `[^\n]*` backtracks to the LAST ", YYYY-MM-DD" on the line, so a
  // <who> that itself contains a comma (e.g. two names) still matches.
  /\*\*Status:\*\*\s*accepted\s*[—–-]\s*[^\n]*,\s*(\d{4}-\d{2}-\d{2})/,
  /\*\*Status:\*\*\s*accepted\s*\(\s*(\d{4}-\d{2}-\d{2})/,
];

export function extractDate(content: string): string | null {
  for (const re of DATE_SHAPES) {
    const m = content.match(re);
    if (m) return m[1];
  }
  return null;
}

export function extractTitle(content: string): string | null {
  const m = content.match(/^#\s+(.+)$/m);
  if (!m) return null;
  return m[1].replace(/^\d+\.\s*/, "").trim();
}

export function extractProblemSection(content: string): string | null {
  const m = content.match(/^##\s+Problem\s*$/m);
  if (!m || m.index === undefined) return null;
  const rest = content.slice(m.index + m[0].length);
  const next = rest.match(/^##\s+/m);
  return (next && next.index !== undefined ? rest.slice(0, next.index) : rest).trim();
}

export const UNFILLED_PROBLEM_PLACEHOLDER =
  "<the query you would type into a search two years later — state the problem without naming the option you chose>";

export function extractClaimsSection(content: string): string | null {
  const m = content.match(/^##\s+Claims\s*$/m);
  if (!m || m.index === undefined) return null;
  const rest = content.slice(m.index + m[0].length);
  const next = rest.match(/^##\s+/m);
  return (next && next.index !== undefined ? rest.slice(0, next.index) : rest).trim();
}

export const UNFILLED_CLAIMS_PLACEHOLDER =
  "- [taken|not-taken] <one claim researched for this decision, in one line> — <its source>";

// The separator is an em or en dash only, never a plain hyphen — a claim's
// own text (e.g. "re-copies") routinely contains hyphens, and a plain-hyphen
// separator would split on the wrong one. Greedy `.+` (not lazy `.+?`) splits
// at the LAST spaced dash, not the first — a claim text containing its own
// spaced dash ("X — faster than Y") must not truncate at that inner dash.
const CLAIM_LINE = /^-\s*\[(taken|not-taken)\]\s*(.+)\s[—–]\s(\S.*)$/;

// Lenient the way sidecar.ts's line reader is: a line that doesn't match the
// shape is skipped rather than refusing the whole scan over one typo.
export function parseClaims(claimsText: string): Claim[] {
  const claims: Claim[] = [];
  for (const line of claimsText.split("\n")) {
    const m = line.trim().match(CLAIM_LINE);
    if (!m) continue;
    claims.push({ disposition: m[1] as "taken" | "not-taken", text: m[2].trim(), source: m[3].trim() });
  }
  return claims;
}

const STOPWORDS = new Set([
  "this", "that", "with", "from", "into", "your", "have", "will",
  "does", "each", "when", "what", "which", "should", "would",
]);

// Heuristic only, and a blunt one: it checks EVERY non-stopword title run of
// 4+ alphanumeric characters (a year like "2026" counts) against the Problem
// text, not just the chosen option's own name. So it can both miss a short
// option name and warn on an unrelated shared domain word. The CLI output
// says so (PROBLEM_WARNING_CAVEAT, list.ts).
export function problemNamesChosenOption(title: string, problemText: string): boolean {
  const words = title
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter((w) => w.length >= 4 && !STOPWORDS.has(w));
  if (words.length === 0) return false;
  const lowerProblem = problemText.toLowerCase();
  return words.some((w) => new RegExp(`\\b${w}\\b`).test(lowerProblem));
}

// Any failure here — including ENOENT — propagates to the caller rather
// than being read as "empty": a caller mid-preflight has already decided
// what ENOENT means, and swallowing it here would let a directory deleted
// between that check and this scan look like a valid empty repo.
export function scanAdrDir(adrDir: string): ScanResult {
  const entries = fs.readdirSync(adrDir).filter(isAdrFilename).sort();

  const numberToFiles = new Map<string, string[]>();
  const records: AdrRecord[] = [];

  for (const file of entries) {
    const number = parseLeadingNumber(file);
    const id = String(number).padStart(4, "0");
    const list = numberToFiles.get(id) ?? [];
    list.push(file);
    numberToFiles.set(id, list);

    let content: string;
    try {
      content = fs.readFileSync(path.join(adrDir, file), "utf8");
    } catch (err) {
      records.push({
        id,
        number,
        file,
        title: null,
        date: null,
        problemWarning: false,
        claims: [],
        claimsMissing: true,
        error: { kind: "unreadable", message: `${file}: could not be read: ${(err as Error).message}` },
      });
      continue;
    }

    const title = extractTitle(content);
    const problemText = extractProblemSection(content);
    const date = extractDate(content);
    const problemIsUnfilled = problemText !== null && problemText.trim().length === 0;
    const claimsText = extractClaimsSection(content);
    const claims = claimsText === null ? [] : parseClaims(claimsText);

    let error: AdrError | null = null;
    if (problemText === null) {
      error = { kind: "no-problem", message: `${file}: no ## Problem section` };
    } else if (problemIsUnfilled) {
      error = { kind: "no-problem", message: `${file}: ## Problem section is empty` };
    } else if (date === null) {
      error = { kind: "no-date", message: `${file}: no date in any known shape` };
    }

    records.push({
      id,
      number,
      file,
      title,
      date,
      problemWarning:
        problemText !== null &&
        title !== null &&
        problemText !== UNFILLED_PROBLEM_PLACEHOLDER &&
        problemNamesChosenOption(title, problemText),
      claims,
      claimsMissing: claims.length === 0,
      error,
    });
  }

  for (const [id, files] of numberToFiles) {
    if (files.length > 1) {
      for (const record of records) {
        if (record.id === id) {
          record.error = {
            kind: "duplicate-number",
            message: `${id}: duplicated by ${files.join(", ")}`,
          };
        }
      }
    }
  }

  return { adrs: records, scanned: records.length };
}

function scanAdrDirWrapped(adrDir: string): ScanResult {
  try {
    return scanAdrDir(adrDir);
  } catch (err) {
    throw new ReadFailure(adrDir, err);
  }
}

function readSidecarWrapped(adrDir: string) {
  const sidecarPath = path.join(adrDir, "recheck.tsv");
  try {
    return readSidecar(sidecarPath);
  } catch (err) {
    throw new ReadFailure(sidecarPath, err);
  }
}

export function nextFreeNumber(adrDir: string): number {
  const { adrs } = scanAdrDirWrapped(adrDir);
  const used = new Set(adrs.map((a) => a.number));
  for (const entry of readSidecarWrapped(adrDir)) {
    if (/^\d+$/.test(entry.adrId)) used.add(Number(entry.adrId));
  }
  let n = 1;
  while (used.has(n)) n++;
  return n;
}

export function hasDuplicateNumbers(adrDir: string): boolean {
  const { adrs } = scanAdrDirWrapped(adrDir);
  return adrs.some((a) => a.error?.kind === "duplicate-number");
}
