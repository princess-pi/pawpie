import { describe, expect, test } from "bun:test";
import * as fs from "node:fs";
import * as path from "node:path";
import { refuseMissingId, runRecheck } from "../src/recheck.ts";
import { adrDirOf, fakeJudgeEnv, makeTempRepo, writeAdrFile } from "./support.ts";

const CLEAR_VERDICT = { outcome: "clear", raises: [], extractedClaims: [], unchecked: [] };

function pass1Raise(disposition: "taken" | "not-taken") {
  return {
    outcome: "raised",
    raises: [
      {
        pass: 1,
        claim: { text: "bun hardlinks packages from a global cache", disposition },
        note: `${disposition} claim no longer holds`,
        evidence: { source: "https://example.com/evidence", quote: "this changed" },
      },
    ],
    extractedClaims: [],
    unchecked: [],
  };
}

function pass2Raise(question: string) {
  return {
    outcome: "raised",
    raises: [
      {
        pass: 2,
        question,
        note: `${question} found`,
        evidence: { source: "https://example.com/evidence", quote: "this changed" },
      },
    ],
    extractedClaims: [],
    unchecked: [],
  };
}

const ADR_WITH_CLAIMS = `# 0001. Use bun for the toolchain

- **Date:** 2026-01-01

## Problem

which javascript package manager and bundler to standardize on

## Decision

## Claims

- [taken] bun hardlinks packages from a global cache — https://bun.sh/docs/install/cache
- [not-taken] npm re-copies every package on every install — https://docs.npmjs.com/cli/v10/commands/npm-install
`;

const ADR_PROSE_ONLY = `# 0001. Use bun for the toolchain

- **Date:** 2026-01-01

## Problem

which javascript package manager and bundler to standardize on

## Decision

Chose bun because it hardlinks from a shared cache, which npm does not.
`;

function seedAdr(repo: string, content: string = ADR_WITH_CLAIMS): void {
  writeAdrFile(repo, "0001-use-bun.md", content);
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
    const badVerdict = {
      outcome: "raised",
      raises: [{ pass: 1, claim: { text: "x", disposition: "taken" }, note: "x" }],
      extractedClaims: [],
      unchecked: [],
    };
    const result = runRecheck(repo, "0001", { env: fakeJudgeEnv(badVerdict) });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.reason).toBe("judge-failed");
  });

  test("a pass-1 raise missing its claim is judge-failed rather than silently accepted", () => {
    const repo = makeTempRepo();
    seedAdr(repo);
    const badVerdict = {
      outcome: "raised",
      raises: [{ pass: 1, note: "x", evidence: { source: "https://a", quote: "q" } }],
      extractedClaims: [],
      unchecked: [],
    };
    const result = runRecheck(repo, "0001", { env: fakeJudgeEnv(badVerdict) });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.reason).toBe("judge-failed");
  });
});

describe("pawpie recheck/punch — pass 1 (the recorded claims)", () => {
  for (const disposition of ["taken", "not-taken"] as const) {
    test(`a canned pass-1 raise on a "${disposition}" claim carries its disposition and evidence`, () => {
      const repo = makeTempRepo();
      seedAdr(repo);
      const result = runRecheck(repo, "0001", { env: fakeJudgeEnv(pass1Raise(disposition)) });

      expect(result.ok).toBe(true);
      if (!result.ok) return;
      expect(result.outcome).toBe("raised");
      expect(result.exitCode).toBe(10);
      expect(result.raises).toHaveLength(1);
      const raise = result.raises[0];
      expect(raise.pass).toBe(1);
      if (raise.pass !== 1) return;
      expect(raise.claim.disposition).toBe(disposition);
      expect(raise.evidence.source).toBe("https://example.com/evidence");
      expect(raise.evidence.quote).toBe("this changed");
    });
  }
});

describe("pawpie recheck/punch — pass 2 (the four questions)", () => {
  for (const question of ["new-options", "changed-capabilities", "new-make-abilities", "changed-spec"] as const) {
    test(`a canned "${question}" result raises with that question and its evidence`, () => {
      const repo = makeTempRepo();
      seedAdr(repo);
      const result = runRecheck(repo, "0001", { env: fakeJudgeEnv(pass2Raise(question)) });

      expect(result.ok).toBe(true);
      if (!result.ok) return;
      expect(result.outcome).toBe("raised");
      const raise = result.raises[0];
      expect(raise.pass).toBe(2);
      if (raise.pass !== 2) return;
      expect(raise.question).toBe(question);
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

  test("reports pass-2 questions the judge could not check, never folded into 'clear'", () => {
    const repo = makeTempRepo();
    seedAdr(repo);
    const verdict = { ...CLEAR_VERDICT, unchecked: ["new-make-abilities", "changed-spec"] };
    const result = runRecheck(repo, "0001", { env: fakeJudgeEnv(verdict) });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.outcome).toBe("clear");
    expect(result.unchecked).toEqual(["new-make-abilities", "changed-spec"]);
  });
});

describe("pawpie recheck/punch — claims: recorded vs. extracted", () => {
  test("a prose-only ADR (no usable ## Claims) has its claims extracted by the judge, reported in --json, and the ADR is never edited", () => {
    const repo = makeTempRepo();
    seedAdr(repo, ADR_PROSE_ONLY);
    const adrPath = path.join(adrDirOf(repo), "0001-use-bun.md");
    const before = fs.readFileSync(adrPath, "utf8");

    const verdict = {
      outcome: "clear",
      raises: [],
      extractedClaims: [{ text: "bun hardlinks from a shared cache", disposition: "taken" }],
      unchecked: [],
    };
    const result = runRecheck(repo, "0001", { env: fakeJudgeEnv(verdict) });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.extractedClaims).toHaveLength(1);
    expect(result.extractedClaims[0].disposition).toBe("taken");
    expect(fs.readFileSync(adrPath, "utf8")).toBe(before);
  });

  test("an ADR with a usable ## Claims section reports no extractedClaims", () => {
    const repo = makeTempRepo();
    seedAdr(repo);
    const result = runRecheck(repo, "0001", { env: fakeJudgeEnv(CLEAR_VERDICT) });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.extractedClaims).toHaveLength(0);
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

  test("a raise's sidecar note tags each raise with its pass, and folds multiple raises onto one line", () => {
    const repo = makeTempRepo();
    seedAdr(repo);
    const verdict = {
      outcome: "raised",
      raises: [
        { pass: 1, claim: { text: "x", disposition: "taken" }, note: "found X", evidence: { source: "https://a", quote: "q1" } },
        { pass: 2, question: "changed-capabilities", note: "price dropped", evidence: { source: "https://b", quote: "q2" } },
      ],
      extractedClaims: [],
      unchecked: [],
    };
    runRecheck(repo, "0001", { env: fakeJudgeEnv(verdict) });

    const row = fs.readFileSync(path.join(adrDirOf(repo), "recheck.tsv"), "utf8").trim();
    const [, , outcome, note] = row.split("\t");
    expect(outcome).toBe("raised");
    expect(note).toBe("pass1:taken found X; pass2:changed-capabilities price dropped");
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
