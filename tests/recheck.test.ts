import { describe, expect, test } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { UNFILLED_PROBLEM_PLACEHOLDER } from "../src/adr.ts";
import { refuseMissingId, runRecheck } from "../src/recheck.ts";
import { adrDirOf, fakeJudgeEnv, makeTempRepo, writeAdrFile } from "./support.ts";

// Must match ADR_WITH_CLAIMS's recorded claims exactly (text and
// disposition) — validateVerdict rejects a pass-1 raise on any claim the ADR
// doesn't actually record, and requires every one of these to be accounted
// for in "checkedClaims" regardless of whether it raised.
const RECORDED_CLAIM_TEXT: Record<"taken" | "not-taken", string> = {
  taken: "bun hardlinks packages from a global cache",
  "not-taken": "npm re-copies every package on every install",
};
const ALL_CLAIMS = [
  { text: RECORDED_CLAIM_TEXT.taken, disposition: "taken" },
  { text: RECORDED_CLAIM_TEXT["not-taken"], disposition: "not-taken" },
];

// "new-options"/"changed-capabilities" need no pass-2 context and so are
// always available; "new-make-abilities"/"changed-spec" need context a test
// must opt into (see the `extraAvailable` param below).
const ALWAYS_AVAILABLE_QUESTIONS = ["new-options", "changed-capabilities"];

const CLEAR_VERDICT = {
  outcome: "clear",
  raises: [],
  extractedClaims: [],
  checkedClaims: ALL_CLAIMS,
  checkedQuestions: ALWAYS_AVAILABLE_QUESTIONS,
  unchecked: [],
};

function pass1Raise(disposition: "taken" | "not-taken") {
  return {
    outcome: "raised",
    raises: [
      {
        pass: 1,
        claim: { text: RECORDED_CLAIM_TEXT[disposition], disposition },
        note: `${disposition} claim no longer holds`,
        evidence: { source: "https://example.com/evidence", quote: "this changed" },
      },
    ],
    extractedClaims: [],
    checkedClaims: ALL_CLAIMS,
    checkedQuestions: ALWAYS_AVAILABLE_QUESTIONS,
    unchecked: [],
  };
}

// `extraAvailable` names any pass-2 context the caller has additionally
// supplied this run (e.g. a README, so "changed-spec" is checkable too) —
// checkedQuestions must equal exactly what's actually available.
function pass2Raise(question: string, extraAvailable: string[] = []) {
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
    checkedClaims: ALL_CLAIMS,
    checkedQuestions: [...ALWAYS_AVAILABLE_QUESTIONS, ...extraAvailable],
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

  test("refuses a freshly created ADR whose ## Problem still holds the unfilled template placeholder", () => {
    const repo = makeTempRepo();
    writeAdrFile(
      repo,
      "0001-fresh.md",
      `# 0001. Fresh\n\n- **Date:** 2026-01-01\n\n## Problem\n\n${UNFILLED_PROBLEM_PLACEHOLDER}\n\n## Decision\n`,
    );
    const result = runRecheck(repo, "0001", { env: fakeJudgeEnv(CLEAR_VERDICT) });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.reason).toBe("adr-invalid");
    expect(result.exitCode).toBe(2);
  });

  test("reports which search backend served the run", () => {
    const repo = makeTempRepo();
    seedAdr(repo);
    const result = runRecheck(repo, "0001", { env: fakeJudgeEnv(CLEAR_VERDICT) });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.backend).toBe("fixture");
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

  test('a "clear" verdict carrying raises is judge-failed — a contradiction, never silently accepted', () => {
    const repo = makeTempRepo();
    seedAdr(repo);
    // Everything else about this verdict must be valid (a real recorded
    // claim, matching preset evidence, complete checkedClaims/checkedQuestions)
    // so the run actually reaches the outcome/raises contradiction check
    // rather than failing earlier for an unrelated reason.
    const contradictory = { ...pass1Raise("taken"), outcome: "clear" };
    const result = runRecheck(repo, "0001", { env: fakeJudgeEnv(contradictory) });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.reason).toBe("judge-failed");
  });

  test("a raise with empty evidence strings is judge-failed rather than accepted as real evidence", () => {
    const repo = makeTempRepo();
    seedAdr(repo);
    const badVerdict = {
      outcome: "raised",
      raises: [{ pass: 1, claim: { text: "x", disposition: "taken" }, note: "x", evidence: { source: "", quote: "" } }],
      extractedClaims: [],
      unchecked: [],
    };
    const result = runRecheck(repo, "0001", { env: fakeJudgeEnv(badVerdict) });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.reason).toBe("judge-failed");
  });

  test("refuses with no search backend configured, before ever invoking the judge", () => {
    const repo = makeTempRepo();
    seedAdr(repo);
    const env = { ...process.env };
    delete env.EXA_API_KEY;
    delete env.PAWPIE_SEARCH_FIXTURE;
    const result = runRecheck(repo, "0001", { env: { ...env, PAWPIE_JUDGE_CMD: "node -e process.exit(1)" } });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.reason).toBe("search-not-configured");
    expect(result.exitCode).toBe(2);
  });

  test("refuses with search-not-configured when PAWPIE_SEARCH_FIXTURE points at unreadable/invalid JSON", () => {
    const repo = makeTempRepo();
    seedAdr(repo);
    const badFixture = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "pawpie-bad-fixture-")), "bad.json");
    fs.writeFileSync(badFixture, "not json");
    const env: NodeJS.ProcessEnv = { ...process.env, PAWPIE_SEARCH_FIXTURE: badFixture, PAWPIE_JUDGE_CMD: "node -e process.exit(1)" };
    delete env.EXA_API_KEY;
    const result = runRecheck(repo, "0001", { env });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.reason).toBe("search-not-configured");
  });

  test("refuses with search-not-configured when a fixture result is missing a string url/text", () => {
    const repo = makeTempRepo();
    seedAdr(repo);
    const badFixture = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "pawpie-bad-fixture-")), "bad.json");
    fs.writeFileSync(badFixture, JSON.stringify({ results: [{ title: "no url or text" }] }));
    const env: NodeJS.ProcessEnv = { ...process.env, PAWPIE_SEARCH_FIXTURE: badFixture, PAWPIE_JUDGE_CMD: "node -e process.exit(1)" };
    delete env.EXA_API_KEY;
    const result = runRecheck(repo, "0001", { env });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.reason).toBe("search-not-configured");
  });

  test("refuses with search-not-configured when a fixture's fetchText has a non-string value", () => {
    const repo = makeTempRepo();
    seedAdr(repo);
    const badFixture = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "pawpie-bad-fixture-")), "bad.json");
    fs.writeFileSync(badFixture, JSON.stringify({ results: [], fetchText: { "https://a": 123 } }));
    const env: NodeJS.ProcessEnv = { ...process.env, PAWPIE_SEARCH_FIXTURE: badFixture, PAWPIE_JUDGE_CMD: "node -e process.exit(1)" };
    delete env.EXA_API_KEY;
    const result = runRecheck(repo, "0001", { env });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.reason).toBe("search-not-configured");
  });

  test("refuses with pass2-context-unreadable when an explicitly configured context file can't be read", () => {
    const repo = makeTempRepo();
    seedAdr(repo);
    const env = fakeJudgeEnv(CLEAR_VERDICT);
    env.PAWPIE_AGENT_CAPABILITIES = "/no/such/file/pawpie-test";
    const result = runRecheck(repo, "0001", { env });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.reason).toBe("pass2-context-unreadable");
    expect(result.exitCode).toBe(2);
  });

  const isRoot = process.getuid !== undefined && process.getuid() === 0;

  test.skipIf(isRoot)("a sidecar-unwritable refusal still carries the judge's completed verdict", () => {
    const repo = makeTempRepo();
    seedAdr(repo);
    fs.writeFileSync(path.join(adrDirOf(repo), "recheck.tsv"), "");
    fs.chmodSync(path.join(adrDirOf(repo), "recheck.tsv"), 0o000);

    const result = runRecheck(repo, "0001", { env: fakeJudgeEnv(pass1Raise("taken")) });

    fs.chmodSync(path.join(adrDirOf(repo), "recheck.tsv"), 0o644);

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.reason).toBe("sidecar-unwritable");
    expect(result.verdict?.outcome).toBe("raised");
    expect(result.verdict?.raises).toHaveLength(1);
  });

  test.skipIf(isRoot)("refuses with a distinct reason when docs/adr/ itself is unreadable", () => {
    const repo = makeTempRepo();
    seedAdr(repo);
    fs.chmodSync(adrDirOf(repo), 0o000);
    const result = runRecheck(repo, "0001", { env: fakeJudgeEnv(CLEAR_VERDICT) });
    fs.chmodSync(adrDirOf(repo), 0o755);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.reason).toBe("adr-dir-unreadable");
    expect(result.exitCode).toBe(2);
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
      // "new-make-abilities" and "changed-spec" are only checkable, and so
      // only raisable, when their pass-2 input is actually available.
      const extraAvailable = question === "new-make-abilities" || question === "changed-spec" ? [question] : [];
      const env = fakeJudgeEnv(pass2Raise(question, extraAvailable));
      if (question === "new-make-abilities") {
        const capsPath = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "pawpie-caps-")), "caps.txt");
        fs.writeFileSync(capsPath, "some skill\n");
        env.PAWPIE_AGENT_CAPABILITIES = capsPath;
      }
      if (question === "changed-spec") {
        fs.writeFileSync(path.join(repo, "README.md"), "some repo readme\n");
      }
      const result = runRecheck(repo, "0001", { env });

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

  test("a 'clear' verdict that never asked an available question is judge-failed, not accepted", () => {
    const repo = makeTempRepo();
    seedAdr(repo);
    // Only "new-options" is reported checked — "changed-capabilities" is
    // always available too, so this claims pass 2 skipped a real question.
    const verdict = { ...CLEAR_VERDICT, checkedQuestions: ["new-options"] };
    const result = runRecheck(repo, "0001", { env: fakeJudgeEnv(verdict) });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.reason).toBe("judge-failed");
  });

  test("an empty README counts as unavailable, not as checked-and-unchanged", () => {
    const repo = makeTempRepo();
    seedAdr(repo);
    fs.writeFileSync(path.join(repo, "README.md"), "   \n", "utf8");
    const result = runRecheck(repo, "0001", { env: fakeJudgeEnv(CLEAR_VERDICT) });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.unchecked).toContain("changed-spec");
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
      checkedClaims: [{ text: "bun hardlinks from a shared cache", disposition: "taken" }],
      checkedQuestions: ALWAYS_AVAILABLE_QUESTIONS,
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

  test("a prose-only ADR whose judge reports zero extractedClaims is judge-failed, not silently accepted as pass 1 done", () => {
    const repo = makeTempRepo();
    seedAdr(repo, ADR_PROSE_ONLY);
    const result = runRecheck(repo, "0001", { env: fakeJudgeEnv(CLEAR_VERDICT) });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.reason).toBe("judge-failed");
  });

  test("an ADR with recorded claims whose judge still returns extractedClaims is judge-failed", () => {
    const repo = makeTempRepo();
    seedAdr(repo);
    const verdict = { ...CLEAR_VERDICT, extractedClaims: [{ text: "invented", disposition: "taken" }] };
    const result = runRecheck(repo, "0001", { env: fakeJudgeEnv(verdict) });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.reason).toBe("judge-failed");
  });

  test("a pass-1 raise naming a claim the ADR never recorded is judge-failed", () => {
    const repo = makeTempRepo();
    seedAdr(repo);
    const verdict = {
      outcome: "raised",
      raises: [
        {
          pass: 1,
          claim: { text: "a claim this ADR never recorded", disposition: "taken" },
          note: "x",
          evidence: { source: "https://a", quote: "q" },
        },
      ],
      extractedClaims: [],
      unchecked: [],
    };
    const result = runRecheck(repo, "0001", { env: fakeJudgeEnv(verdict) });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.reason).toBe("judge-failed");
  });

  test("a pass-2 raise answering a question with no available input is judge-failed", () => {
    const repo = makeTempRepo();
    seedAdr(repo);
    const result = runRecheck(repo, "0001", { env: fakeJudgeEnv(pass2Raise("changed-spec")) });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.reason).toBe("judge-failed");
  });
});

describe("pawpie recheck/punch — the sidecar", () => {
  test("a row appended to a sidecar with no trailing newline never merges into the prior row", () => {
    const repo = makeTempRepo();
    seedAdr(repo);
    const sidecarPath = path.join(adrDirOf(repo), "recheck.tsv");
    fs.writeFileSync(sidecarPath, "0001\t2026-01-01\tclear\tprior run, no trailing newline");

    runRecheck(repo, "0001", { env: fakeJudgeEnv(CLEAR_VERDICT) });

    const rows = fs.readFileSync(sidecarPath, "utf8").trim().split("\n");
    expect(rows).toHaveLength(2);
    expect(rows[0]).toBe("0001\t2026-01-01\tclear\tprior run, no trailing newline");
  });

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
        {
          pass: 1,
          claim: { text: "bun hardlinks packages from a global cache", disposition: "taken" },
          note: "found X",
          evidence: { source: "https://a", quote: "q1" },
        },
        { pass: 2, question: "changed-capabilities", note: "price dropped", evidence: { source: "https://b", quote: "q2" } },
      ],
      extractedClaims: [],
      checkedClaims: ALL_CLAIMS,
      checkedQuestions: ALWAYS_AVAILABLE_QUESTIONS,
      unchecked: [],
    };
    runRecheck(repo, "0001", { env: fakeJudgeEnv(verdict) });

    const row = fs.readFileSync(path.join(adrDirOf(repo), "recheck.tsv"), "utf8").trim();
    const [, , outcome, note] = row.split("\t");
    expect(outcome).toBe("raised");
    // "new-make-abilities"/"changed-spec" are force-reported unchecked here
    // too — this repo has no README and no PAWPIE_AGENT_CAPABILITIES set.
    expect(note).toBe(
      "pass1:taken found X; pass2:changed-capabilities price dropped; unchecked: new-make-abilities,changed-spec; usage unknown; backend:fixture",
    );
  });

  test("reports usage as unknown (null), never a false zero, for a judge that never starts the MCP server", () => {
    const repo = makeTempRepo();
    seedAdr(repo);
    const result = runRecheck(repo, "0001", { env: fakeJudgeEnv(CLEAR_VERDICT) });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.usage).toEqual({ searches: null, fetches: null, searchErrors: null, fetchErrors: null, judgeCalls: 1 });
  });
});

describe("pawpie recheck/punch — evidence is checked, not trusted", () => {
  test("a URL-sourced raise citing a source no search/fetch call returned is rejected", () => {
    const repo = makeTempRepo();
    seedAdr(repo);
    // No preset evidence at all — the fake judge never started a real MCP
    // server, so this URL was never actually returned by anything.
    const result = runRecheck(repo, "0001", { env: fakeJudgeEnv(pass1Raise("taken"), 0, []) });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.reason).toBe("judge-failed");
  });

  test("a URL-sourced raise whose quote does not appear in what that URL actually returned is rejected", () => {
    const repo = makeTempRepo();
    seedAdr(repo);
    const result = runRecheck(repo, "0001", {
      env: fakeJudgeEnv(pass1Raise("taken"), 0, [{ url: "https://example.com/evidence", text: "unrelated text" }]),
    });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.reason).toBe("judge-failed");
  });

  test("a raise citing a source that is neither a URL nor a recognized repo artifact is rejected", () => {
    const repo = makeTempRepo();
    seedAdr(repo);
    const verdict = {
      ...pass1Raise("taken"),
      raises: [{ ...pass1Raise("taken").raises[0], evidence: { source: "my own knowledge", quote: "this changed" } }],
    };
    const result = runRecheck(repo, "0001", { env: fakeJudgeEnv(verdict) });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.reason).toBe("judge-failed");
  });

  test("a raise citing README.md is checked against the README this run actually supplied", () => {
    const repo = makeTempRepo();
    seedAdr(repo);
    fs.writeFileSync(path.join(repo, "README.md"), "this repo now requires node 24", "utf8");
    const verdict = {
      ...pass2Raise("changed-spec", ["changed-spec"]),
      raises: [
        {
          pass: 2,
          question: "changed-spec",
          note: "spec moved",
          evidence: { source: "README.md", quote: "requires node 24" },
        },
      ],
    };
    const result = runRecheck(repo, "0001", { env: fakeJudgeEnv(verdict) });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.outcome).toBe("raised");
  });

  test("a raise citing README.md with a quote the README never contained is rejected", () => {
    const repo = makeTempRepo();
    seedAdr(repo);
    fs.writeFileSync(path.join(repo, "README.md"), "this repo now requires node 24", "utf8");
    const verdict = {
      ...pass2Raise("changed-spec", ["changed-spec"]),
      raises: [
        {
          pass: 2,
          question: "changed-spec",
          note: "spec moved",
          evidence: { source: "README.md", quote: "a quote the README never had" },
        },
      ],
    };
    const result = runRecheck(repo, "0001", { env: fakeJudgeEnv(verdict) });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.reason).toBe("judge-failed");
  });

  test("a README.md quote past the truncation cutoff is rejected — the judge never saw it", () => {
    const repo = makeTempRepo();
    seedAdr(repo);
    const tail = "a fact that only appears after the cutoff";
    fs.writeFileSync(path.join(repo, "README.md"), "x".repeat(20_000) + tail, "utf8");
    const verdict = {
      ...pass2Raise("changed-spec", ["changed-spec"]),
      raises: [
        {
          pass: 2,
          question: "changed-spec",
          note: "spec moved",
          evidence: { source: "README.md", quote: tail },
        },
      ],
    };
    const result = runRecheck(repo, "0001", { env: fakeJudgeEnv(verdict) });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.reason).toBe("judge-failed");
  });

  test("a raise citing 'issue #12' is checked against issue #12's own text, not another issue's", () => {
    const repo = makeTempRepo();
    seedAdr(repo);
    const issuesPath = path.join(repo, "issues.txt");
    fs.writeFileSync(issuesPath, "issue #12\nmentions apples\n\nissue #13\nmentions oranges\n", "utf8");
    const verdict = {
      ...pass2Raise("changed-spec", ["changed-spec"]),
      raises: [
        {
          pass: 2,
          question: "changed-spec",
          note: "spec moved",
          evidence: { source: "issue #12", quote: "mentions oranges" },
        },
      ],
    };
    const env = fakeJudgeEnv(verdict);
    env.PAWPIE_PASS2_ISSUES_FIXTURE = issuesPath;
    const result = runRecheck(repo, "0001", { env });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.reason).toBe("judge-failed");
  });

  test("a raise citing 'issue #12' with a quote actually inside issue #12's own text is accepted", () => {
    const repo = makeTempRepo();
    seedAdr(repo);
    const issuesPath = path.join(repo, "issues.txt");
    fs.writeFileSync(issuesPath, "issue #12\nmentions apples\n\nissue #13\nmentions oranges\n", "utf8");
    const verdict = {
      ...pass2Raise("changed-spec", ["changed-spec"]),
      raises: [
        {
          pass: 2,
          question: "changed-spec",
          note: "spec moved",
          evidence: { source: "issue #12", quote: "mentions apples" },
        },
      ],
    };
    const env = fakeJudgeEnv(verdict);
    env.PAWPIE_PASS2_ISSUES_FIXTURE = issuesPath;
    const result = runRecheck(repo, "0001", { env });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.outcome).toBe("raised");
  });
});
