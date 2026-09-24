import { describe, expect, test } from "bun:test";
import * as fs from "node:fs";
import * as path from "node:path";
import { refuseMissingId, runRecheck } from "../src/recheck.ts";
import { adrDirOf, fakeJudgeEnv, makeTempRepo, writeAdrFile } from "./support.ts";

const CLEAR_VERDICT = { outcome: "clear", raises: [] };

function raisedVerdict(trigger: string) {
  return {
    outcome: "raised",
    raises: [
      {
        trigger,
        note: `${trigger} found`,
        evidence: { url: "https://example.com/evidence", quote: "this changed" },
      },
    ],
  };
}

function seedAdr(repo: string): void {
  writeAdrFile(
    repo,
    "0001-use-bun.md",
    "# 0001. Use bun for the toolchain\n\n- **Date:** 2026-01-01\n\n## Problem\n\nwhich javascript package manager and bundler to standardize on\n\n## Decision\n",
  );
}

describe("pawpie recheck/punch — refusals", () => {
  test("refuses with no id, exit 2", () => {
    const result = refuseMissingId();
    expect(result.exitCode).toBe(2);
    expect(result.reason).toBe("missing-id");
  });

  test("refuses when the ADR id does not exist under docs/adr/", () => {
    const repo = makeTempRepo();
    seedAdr(repo);
    const result = runRecheck(repo, "0002", { env: fakeJudgeEnv(CLEAR_VERDICT) });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.reason).toBe("adr-not-found");
    expect(result.exitCode).toBe(2);
  });

  test("refuses when the ADR already fails its own 'list' checks", () => {
    const repo = makeTempRepo();
    writeAdrFile(repo, "0001-no-problem.md", "# 0001. No problem\n\n- **Date:** 2026-01-01\n\n## Decision\n");
    const result = runRecheck(repo, "0001", { env: fakeJudgeEnv(CLEAR_VERDICT) });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.reason).toBe("adr-invalid");
    expect(result.exitCode).toBe(2);
  });

  test("a numeric id is normalized the same way the sidecar normalizes it", () => {
    const repo = makeTempRepo();
    seedAdr(repo);
    const result = runRecheck(repo, "1", { env: fakeJudgeEnv(CLEAR_VERDICT) });
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.id).toBe("0001");
  });

  test("a judge that exits nonzero is reported as judge-failed, exit 1, and appends no sidecar row", () => {
    const repo = makeTempRepo();
    seedAdr(repo);
    const result = runRecheck(repo, "0001", { env: fakeJudgeEnv(CLEAR_VERDICT, 1) });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.reason).toBe("judge-failed");
    expect(result.exitCode).toBe(1);
    expect(fs.existsSync(path.join(adrDirOf(repo), "recheck.tsv"))).toBe(false);
  });

  test("a judge that answers with unparseable JSON is judge-failed, exit 1", () => {
    const repo = makeTempRepo();
    seedAdr(repo);
    const result = runRecheck(repo, "0001", { env: fakeJudgeEnv("not json at all") });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.reason).toBe("judge-failed");
  });

  test("a judge verdict missing evidence on a raise is judge-failed rather than silently accepted", () => {
    const repo = makeTempRepo();
    seedAdr(repo);
    const badVerdict = { outcome: "raised", raises: [{ trigger: "new-option", note: "x" }] };
    const result = runRecheck(repo, "0001", { env: fakeJudgeEnv(badVerdict) });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.reason).toBe("judge-failed");
  });
});

describe("pawpie recheck/punch — the three triggers, each watched failing on fixtures", () => {
  for (const trigger of ["new-option", "driver-moved", "reason-no-longer-holds"] as const) {
    test(`a canned "${trigger}" result raises with that trigger and its evidence`, () => {
      const repo = makeTempRepo();
      seedAdr(repo);
      const result = runRecheck(repo, "0001", { env: fakeJudgeEnv(raisedVerdict(trigger)) });

      expect(result.ok).toBe(true);
      if (!result.ok) return;
      expect(result.outcome).toBe("raised");
      expect(result.exitCode).toBe(10);
      expect(result.raises).toHaveLength(1);
      expect(result.raises[0].trigger).toBe(trigger);
      expect(result.raises[0].evidence.url).toBe("https://example.com/evidence");
      expect(result.raises[0].evidence.quote).toBe("this changed");
    });
  }

  test('a canned "nothing new" result stays quiet: outcome clear, exit 0', () => {
    const repo = makeTempRepo();
    seedAdr(repo);
    const result = runRecheck(repo, "0001", { env: fakeJudgeEnv(CLEAR_VERDICT) });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.outcome).toBe("clear");
    expect(result.exitCode).toBe(0);
    expect(result.raises).toHaveLength(0);
  });
});

describe("pawpie recheck/punch — the sidecar", () => {
  test("appends exactly one row per run, never edits the ADR itself", () => {
    const repo = makeTempRepo();
    seedAdr(repo);
    const adrPath = path.join(adrDirOf(repo), "0001-use-bun.md");
    const before = fs.readFileSync(adrPath, "utf8");

    runRecheck(repo, "0001", { env: fakeJudgeEnv(CLEAR_VERDICT) });

    expect(fs.readFileSync(adrPath, "utf8")).toBe(before);
    const rows = fs
      .readFileSync(path.join(adrDirOf(repo), "recheck.tsv"), "utf8")
      .trim()
      .split("\n");
    expect(rows).toHaveLength(1);
    const [id, date, outcome] = rows[0].split("\t");
    expect(id).toBe("0001");
    expect(date).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    expect(outcome).toBe("clear");
  });

  test("a raise's sidecar note folds every raise's note onto the one line", () => {
    const repo = makeTempRepo();
    seedAdr(repo);
    const verdict = {
      outcome: "raised",
      raises: [
        { trigger: "new-option", note: "found X", evidence: { url: "https://a", quote: "q1" } },
        { trigger: "driver-moved", note: "price dropped", evidence: { url: "https://b", quote: "q2" } },
      ],
    };
    runRecheck(repo, "0001", { env: fakeJudgeEnv(verdict) });

    const row = fs.readFileSync(path.join(adrDirOf(repo), "recheck.tsv"), "utf8").trim();
    const [, , outcome, note] = row.split("\t");
    expect(outcome).toBe("raised");
    expect(note).toBe("found X; price dropped");
  });

  test("reports usage counts even when they are zero (a fake judge that calls no tools)", () => {
    const repo = makeTempRepo();
    seedAdr(repo);
    const result = runRecheck(repo, "0001", { env: fakeJudgeEnv(CLEAR_VERDICT) });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.usage).toEqual({ searches: 0, fetches: 0, judgeCalls: 1 });
  });
});
