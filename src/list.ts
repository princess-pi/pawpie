import * as path from "node:path";
import { scanAdrDir, type AdrRecord } from "./adr.ts";
import { readSidecar, lastCheckByAdr, type CheckEntry } from "./sidecar.ts";

export interface ListedAdr {
  id: string;
  file: string;
  title: string | null;
  date: string | null;
  lastCheck: { date: string; outcome: string; note: string } | null;
  problemWarning: boolean;
  error: { kind: string; message: string } | null;
}

export interface ListResult {
  schema: "pawpie-list@1";
  path: string;
  scanned: number;
  adrs: ListedAdr[];
  exitCode: 0 | 3;
}

// Never-checked ADRs sort above checked ones; among checked ones, an older
// check sorts above a newer one. Ties break by ADR id.
function compareListed(a: ListedAdr, b: ListedAdr): number {
  if (!a.lastCheck && !b.lastCheck) return a.id.localeCompare(b.id);
  if (!a.lastCheck) return -1;
  if (!b.lastCheck) return 1;
  if (a.lastCheck.date !== b.lastCheck.date) return a.lastCheck.date.localeCompare(b.lastCheck.date);
  return a.id.localeCompare(b.id);
}

export function buildListResult(repoPath: string): ListResult {
  const adrDir = path.join(repoPath, "docs", "adr");
  const sidecarPath = path.join(adrDir, "recheck.tsv");
  const { adrs, scanned } = scanAdrDir(adrDir);
  const lastChecks = lastCheckByAdr(readSidecar(sidecarPath));

  const listed: ListedAdr[] = adrs.map((adr: AdrRecord) => {
    const check: CheckEntry | undefined = lastChecks.get(adr.id);
    return {
      id: adr.id,
      file: adr.file,
      title: adr.title,
      date: adr.date,
      lastCheck: check ? { date: check.date, outcome: check.outcome, note: check.note } : null,
      problemWarning: adr.problemWarning,
      error: adr.error,
    };
  });

  listed.sort(compareListed);

  const exitCode = listed.some((a) => a.error !== null) ? 3 : 0;

  return { schema: "pawpie-list@1", path: repoPath, scanned, adrs: listed, exitCode };
}

export function renderListText(result: ListResult): string {
  if (result.adrs.length === 0) {
    return "No ADRs found.";
  }
  const lines: string[] = [];
  for (const adr of result.adrs) {
    const title = adr.title ?? "(untitled)";
    const check = adr.lastCheck
      ? `last checked ${adr.lastCheck.date} (${adr.lastCheck.outcome})`
      : "never checked";
    lines.push(`${adr.id}  ${title}  [${adr.date ?? "no date"}]  ${check}`);
    if (adr.problemWarning) {
      lines.push(
        `  warning: ## Problem may name the chosen option (heuristic, not exhaustive)`,
      );
    }
    if (adr.error) {
      lines.push(`  error: ${adr.error.message}`);
    }
  }
  return lines.join("\n");
}
