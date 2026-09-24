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

// Writes a throwaway node script that ignores its input entirely and prints
// a canned verdict to stdout, then returns the env to run recheck/punch
// against it — the fake judge required by the workflow's "never call the
// real judge in a test" rule. `exitCode` lets a test simulate a judge that
// fails outright.
export function fakeJudgeEnv(verdict: unknown, exitCode = 0): NodeJS.ProcessEnv {
  const scriptPath = path.join(
    fs.mkdtempSync(path.join(os.tmpdir(), "pawpie-fake-judge-")),
    "judge.mjs",
  );
  const body =
    exitCode === 0
      ? `process.stdout.write(process.env.PAWPIE_TEST_VERDICT ?? "");\n`
      : `process.stderr.write("fake judge failure\\n"); process.exit(${exitCode});\n`;
  fs.writeFileSync(scriptPath, body, "utf8");
  return {
    ...process.env,
    PAWPIE_JUDGE_CMD: `node ${scriptPath}`,
    PAWPIE_TEST_VERDICT: typeof verdict === "string" ? verdict : JSON.stringify(verdict),
  };
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
