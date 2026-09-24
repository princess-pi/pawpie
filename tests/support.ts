import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

export function makeTempRepo(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), "pawpie-test-"));
}

export function adrDirOf(repoPath: string): string {
  return path.join(repoPath, "docs", "adr");
}

export function writeAdrFile(repoPath: string, filename: string, content: string): void {
  const dir = adrDirOf(repoPath);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, filename), content, "utf8");
}

export function writeSidecar(repoPath: string, lines: string[]): void {
  const dir = adrDirOf(repoPath);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, "recheck.tsv"), lines.join("\n") + "\n", "utf8");
}

export function captured() {
  const out: string[] = [];
  const err: string[] = [];
  return {
    stdout: (s: string) => out.push(s),
    stderr: (s: string) => err.push(s),
    out,
    err,
  };
}
