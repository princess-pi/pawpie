import * as fs from "node:fs";
import * as path from "node:path";
import { UNFILLED_PROBLEM_PLACEHOLDER, hasDuplicateNumbers, nextFreeNumber } from "./adr.ts";

export interface NewAdrError {
  kind: "duplicate-number";
  message: string;
}

export type NewAdrResult =
  | { ok: true; file: string; id: string }
  | { ok: false; error: NewAdrError };

function slugify(title: string): string {
  return title
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "") || "untitled";
}

function todayIso(): string {
  return new Date().toISOString().slice(0, 10);
}

export function createAdr(repoPath: string, title: string): NewAdrResult {
  const adrDir = path.join(repoPath, "docs", "adr");
  fs.mkdirSync(adrDir, { recursive: true });

  if (hasDuplicateNumbers(adrDir)) {
    return {
      ok: false,
      error: {
        kind: "duplicate-number",
        message: "docs/adr/ already has a duplicated ADR number — fix that before adding a new one",
      },
    };
  }

  const number = nextFreeNumber(adrDir);
  const id = String(number).padStart(4, "0");
  const file = `${id}-${slugify(title)}.md`;
  const content = `# ${id}. ${title}

- **Status:** proposed
- **Date:** ${todayIso()}

## Problem

${UNFILLED_PROBLEM_PLACEHOLDER}

## Decision

## Consequences
`;

  fs.writeFileSync(path.join(adrDir, file), content, { encoding: "utf8", flag: "wx" });
  return { ok: true, file, id };
}
