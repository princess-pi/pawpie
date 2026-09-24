import * as fs from "node:fs";
import * as path from "node:path";
import { readSidecar } from "./sidecar.ts";

export interface AdrError {
  kind: "no-problem" | "no-date" | "unreadable" | "duplicate-number";
  message: string;
}

export interface AdrRecord {
  id: string;
  number: number;
  file: string;
  title: string | null;
  date: string | null;
  problemWarning: boolean;
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
  /\*\*Status:\*\*\s*accepted\s*[—-]\s*[^,\n]*,\s*(\d{4}-\d{2}-\d{2})/,
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

const STOPWORDS = new Set([
  "this", "that", "with", "from", "into", "your", "have", "will",
  "does", "each", "when", "what", "which", "should", "would",
]);

// Heuristic only: catches a title word reused verbatim inside the Problem
// section. It does not catch a paraphrase, and the CLI output says so.
export function problemNamesChosenOption(title: string, problemText: string): boolean {
  const words = title
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter((w) => w.length >= 4 && !STOPWORDS.has(w));
  if (words.length === 0) return false;
  const lowerProblem = problemText.toLowerCase();
  return words.some((w) => new RegExp(`\\b${w}\\b`).test(lowerProblem));
}

export function scanAdrDir(adrDir: string): ScanResult {
  let entries: string[];
  try {
    entries = fs.readdirSync(adrDir).filter(isAdrFilename).sort();
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") {
      return { adrs: [], scanned: 0 };
    }
    throw err;
  }

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
    } catch {
      records.push({
        id,
        number,
        file,
        title: null,
        date: null,
        problemWarning: false,
        error: { kind: "unreadable", message: `${file}: could not be read` },
      });
      continue;
    }

    const title = extractTitle(content);
    const problemText = extractProblemSection(content);
    const date = extractDate(content);
    const problemIsUnfilled = problemText !== null && problemText.trim().length === 0;

    let error: AdrError | null = null;
    if (problemText === null || problemIsUnfilled) {
      error = { kind: "no-problem", message: `${file}: no ## Problem section` };
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

export function nextFreeNumber(adrDir: string): number {
  const { adrs } = scanAdrDir(adrDir);
  const used = new Set(adrs.map((a) => a.number));
  for (const entry of readSidecar(path.join(adrDir, "recheck.tsv"))) {
    if (/^\d+$/.test(entry.adrId)) used.add(Number(entry.adrId));
  }
  let n = 1;
  while (used.has(n)) n++;
  return n;
}

export function hasDuplicateNumbers(adrDir: string): boolean {
  const { adrs } = scanAdrDir(adrDir);
  return adrs.some((a) => a.error?.kind === "duplicate-number");
}
