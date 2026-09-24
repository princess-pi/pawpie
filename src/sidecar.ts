import * as fs from "node:fs";

export type CheckOutcome = "clear" | "raised" | "skipped";

export interface CheckEntry {
  adrId: string;
  date: string;
  outcome: CheckOutcome;
  note: string;
}

export function readSidecar(sidecarPath: string): CheckEntry[] {
  let content: string;
  try {
    content = fs.readFileSync(sidecarPath, "utf8");
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw err;
  }
  const entries: CheckEntry[] = [];
  for (const line of content.split("\n")) {
    if (line.trim() === "") continue;
    const parts = line.split("\t");
    if (parts.length < 4) continue;
    const [adrId, date, outcome, ...noteParts] = parts;
    if (outcome !== "clear" && outcome !== "raised" && outcome !== "skipped") continue;
    entries.push({ adrId, date, outcome, note: noteParts.join("\t") });
  }
  return entries;
}

export function lastCheckByAdr(entries: CheckEntry[]): Map<string, CheckEntry> {
  const last = new Map<string, CheckEntry>();
  for (const entry of entries) {
    const current = last.get(entry.adrId);
    if (!current || entry.date > current.date) last.set(entry.adrId, entry);
  }
  return last;
}
