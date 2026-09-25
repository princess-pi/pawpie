import * as path from "node:path";
import { scanAdrDir, type AdrRecord } from "./adr.ts";
import { ReadFailure } from "./errors.ts";
import { readSidecar, lastCheckByAdr, type CheckEntry } from "./sidecar.ts";
import { sanitizeForTerminal } from "./terminal.ts";

export interface ListedAdr {
  id: string;
  file: string;
  title: string | null;
  date: string | null;
  lastCheck: { date: string; outcome: string; note: string } | null;
  problemWarning: boolean;
  claimsWarning: boolean;
  error: { kind: string; message: string } | null;
}

export const PROBLEM_WARNING_CAVEAT =
  "heuristic, not exhaustive — compares every title run of 4+ alphanumeric characters (digits count) against the Problem text, not just the chosen option's name; can both miss a short option name and warn on an unrelated shared word";

export interface ListResult {
  schema: "pawpie-list@1";
  ok: true;
  path: string;
  scanned: number;
  problemWarningCaveat: string;
  adrs: ListedAdr[];
  exitCode: 0 | 3;
}

// Never-checked ADRs sort above checked ones; among checked ones, an older
// check sorts above a newer one. Ties break by the numeric ADR id (so id
// 10000 does not sort before 9999).
function compareListed(a: ListedAdr, b: ListedAdr): number {
  if (!a.lastCheck && !b.lastCheck) return Number(a.id) - Number(b.id);
  if (!a.lastCheck) return -1;
  if (!b.lastCheck) return 1;
  if (a.lastCheck.date !== b.lastCheck.date) return a.lastCheck.date.localeCompare(b.lastCheck.date);
  return Number(a.id) - Number(b.id);
}

export function buildListResult(repoPath: string): ListResult {
  const adrDir = path.join(repoPath, "docs", "adr");
  const sidecarPath = path.join(adrDir, "recheck.tsv");

  let adrs: AdrRecord[];
  let scanned: number;
  try {
    ({ adrs, scanned } = scanAdrDir(adrDir));
  } catch (err) {
    throw new ReadFailure(adrDir, err);
  }

  let lastChecks: Map<string, CheckEntry>;
  try {
    lastChecks = lastCheckByAdr(readSidecar(sidecarPath));
  } catch (err) {
    throw new ReadFailure(sidecarPath, err);
  }

  const listed: ListedAdr[] = adrs.map((adr: AdrRecord) => {
    const check: CheckEntry | undefined = lastChecks.get(adr.id);
    return {
      id: adr.id,
      file: adr.file,
      title: adr.title,
      date: adr.date,
      lastCheck: check ? { date: check.date, outcome: check.outcome, note: check.note } : null,
      problemWarning: adr.problemWarning,
      claimsWarning: adr.claimsMissing,
      error: adr.error,
    };
  });

  listed.sort(compareListed);

  const exitCode = listed.some((a) => a.error !== null) ? 3 : 0;

  return {
    schema: "pawpie-list@1",
    ok: true,
    path: repoPath,
    scanned,
    problemWarningCaveat: PROBLEM_WARNING_CAVEAT,
    adrs: listed,
    exitCode,
  };
}

export interface ListRefusal {
  schema: "pawpie-list@1";
  ok: false;
  reason: "no-adr-directory" | "unreadable" | "usage-error";
  path: string;
  message: string;
  exitCode: 2;
}

export function refuseList(
  repoPath: string,
  reason: ListRefusal["reason"],
  message: string,
): ListRefusal {
  return { schema: "pawpie-list@1", ok: false, reason, path: repoPath, message, exitCode: 2 };
}

export function renderListText(result: ListResult): string {
  if (result.adrs.length === 0) {
    return "No ADRs found.";
  }
  const lines: string[] = [];
  for (const adr of result.adrs) {
    const title = sanitizeForTerminal(adr.title ?? "(untitled)");
    const check = adr.lastCheck
      ? `last checked ${sanitizeForTerminal(adr.lastCheck.date)} (${adr.lastCheck.outcome})`
      : "never checked";
    lines.push(`${adr.id}  ${title}  [${adr.date ?? "no date"}]  ${check}`);
    if (adr.problemWarning) {
      lines.push(`  warning: ## Problem may name the chosen option (${result.problemWarningCaveat})`);
    }
    if (adr.claimsWarning) {
      lines.push("  warning: no ## Claims section (or none of its lines parse) — punch will extract its own");
    }
    if (adr.error) {
      lines.push(`  error: ${sanitizeForTerminal(adr.error.message)}`);
    }
  }
  return lines.join("\n");
}
