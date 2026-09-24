import * as fs from "node:fs";
import * as path from "node:path";
import { extractClaimsSection, parseClaims, scanAdrDir, type Claim } from "./adr.ts";
import { JudgeError, runJudge, type ClaimRef, type JudgeUsage, type Pass2Context, type Question, type Raise } from "./judge.ts";
import { createExaAdapter, createFixtureAdapter, loadFixtureAdapter } from "./search-adapter.ts";
import type { SearchAdapter } from "./search-adapter.ts";
import { ReadFailure } from "./errors.ts";

export interface RecheckRefusal {
  schema: "pawpie-recheck@1";
  ok: false;
  reason: "missing-id" | "usage-error" | "adr-not-found" | "adr-invalid" | "judge-failed" | "sidecar-unwritable";
  id: string | null;
  message: string;
  exitCode: 1 | 2;
}

export interface RecheckResult {
  schema: "pawpie-recheck@1";
  ok: true;
  id: string;
  outcome: "raised" | "clear";
  raises: Raise[];
  extractedClaims: ClaimRef[];
  unchecked: Question[];
  usage: JudgeUsage;
  exitCode: 0 | 10;
}

export function refuseRecheckUsage(id: string | null, message: string): RecheckRefusal {
  return { schema: "pawpie-recheck@1", ok: false, reason: "usage-error", id, message, exitCode: 2 };
}

export function refuseMissingId(): RecheckRefusal {
  return {
    schema: "pawpie-recheck@1",
    ok: false,
    reason: "missing-id",
    id: null,
    message: "recheck/punch requires an ADR id",
    exitCode: 2,
  };
}

// Normalizes the way sidecar.ts does, so `pawpie punch 4` finds ADR 0004.
function normalizeId(raw: string): string {
  return /^\d+$/.test(raw) ? String(Number(raw)).padStart(4, "0") : raw;
}

function appendSidecarLine(adrDir: string, id: string, outcome: "raised" | "clear", note: string): void {
  const today = new Date().toISOString().slice(0, 10);
  const safeNote = note.replace(/[\t\r\n]/g, " ").trim();
  fs.appendFileSync(path.join(adrDir, "recheck.tsv"), `${id}\t${today}\t${outcome}\t${safeNote}\n`, "utf8");
}

function noteFor(raises: Raise[]): string {
  if (raises.length === 0) return "clear";
  return raises
    .map((r) => `${r.pass === 1 ? `pass1:${r.claim.disposition}` : `pass2:${r.question}`} ${r.note}`)
    .join("; ");
}

// null means "no usable ## Claims section" — judge.ts reads that as an
// instruction to extract the claims itself rather than iterate an empty list.
function claimsFor(adrContent: string): Claim[] | null {
  const text = extractClaimsSection(adrContent);
  if (text === null) return null;
  const claims = parseClaims(text);
  return claims.length === 0 ? null : claims;
}

// Pass 2's "changed-spec" and "new-make-abilities" questions need context the
// web cannot answer. Both are best-effort and explicitly opt-in for the repo
// lookup (never attempted in a test, and never silently attempted against a
// directory that isn't actually a GitHub-backed repo): missing input is
// reported to the judge as UNAVAILABLE, per the issue's own instruction that
// this must read "unchecked", never "no change".
function gatherPass2Context(repoPath: string, env: NodeJS.ProcessEnv): Pass2Context {
  let readme: string | null = null;
  try {
    readme = fs.readFileSync(path.join(repoPath, "README.md"), "utf8");
  } catch {
    readme = null;
  }

  let openIssues: string | null = null;
  if (env.PAWPIE_PASS2_ISSUES_FIXTURE) {
    try {
      openIssues = fs.readFileSync(env.PAWPIE_PASS2_ISSUES_FIXTURE, "utf8");
    } catch {
      openIssues = null;
    }
  }

  let agentCapabilities: string | null = null;
  if (env.PAWPIE_AGENT_CAPABILITIES) {
    try {
      agentCapabilities = fs.readFileSync(env.PAWPIE_AGENT_CAPABILITIES, "utf8");
    } catch {
      agentCapabilities = null;
    }
  }

  return { readme, openIssues, agentCapabilities };
}

// Chooses which search backend the spawned MCP server child should use, by
// env var alone — this process never imports the adapter for a live judge
// run, only forwards the choice down to `__mcp-serve`.
function searchAdapterEnv(env: NodeJS.ProcessEnv): Record<string, string> {
  if (env.PAWPIE_SEARCH_FIXTURE) {
    return { PAWPIE_SEARCH_ADAPTER: "fixture", PAWPIE_SEARCH_FIXTURE: env.PAWPIE_SEARCH_FIXTURE };
  }
  return { PAWPIE_SEARCH_ADAPTER: "exa", EXA_API_KEY: env.EXA_API_KEY ?? "" };
}

export function createSearchAdapterFromEnv(env: NodeJS.ProcessEnv): SearchAdapter {
  if (env.PAWPIE_SEARCH_ADAPTER === "fixture") {
    if (!env.PAWPIE_SEARCH_FIXTURE) throw new Error("PAWPIE_SEARCH_ADAPTER=fixture requires PAWPIE_SEARCH_FIXTURE");
    return loadFixtureAdapter(env.PAWPIE_SEARCH_FIXTURE);
  }
  if (!env.EXA_API_KEY) throw new Error("EXA_API_KEY is required for the exa search adapter");
  return createExaAdapter(env.EXA_API_KEY);
}

// Exported only so tests can drive the trigger logic with a canned
// SearchAdapter object directly, without spawning the MCP-server subprocess.
export function fixtureAdapterFor(results: Parameters<typeof createFixtureAdapter>[0]): SearchAdapter {
  return createFixtureAdapter(results);
}

export interface RunRecheckOptions {
  env?: NodeJS.ProcessEnv;
  selfCommand?: string[];
}

export function runRecheck(
  repoPath: string,
  rawId: string,
  opts: RunRecheckOptions = {},
): RecheckResult | RecheckRefusal {
  const env = opts.env ?? process.env;
  const id = normalizeId(rawId);
  const adrDir = path.join(repoPath, "docs", "adr");

  let scan;
  try {
    scan = scanAdrDir(adrDir);
  } catch (err) {
    throw new ReadFailure(adrDir, err);
  }

  const adr = scan.adrs.find((a) => a.id === id);
  if (!adr) {
    return {
      schema: "pawpie-recheck@1",
      ok: false,
      reason: "adr-not-found",
      id,
      message: `no ADR ${id} under ${adrDir}`,
      exitCode: 2,
    };
  }
  if (adr.error) {
    return {
      schema: "pawpie-recheck@1",
      ok: false,
      reason: "adr-invalid",
      id,
      message: `ADR ${id} fails its own checks (${adr.error.kind}) — fix it before punching it`,
      exitCode: 2,
    };
  }

  const adrContent = fs.readFileSync(path.join(adrDir, adr.file), "utf8");

  let judged;
  try {
    judged = runJudge(id, adrContent, {
      env,
      selfCommand: opts.selfCommand,
      searchAdapterEnv: searchAdapterEnv(env),
      claims: claimsFor(adrContent),
      pass2: gatherPass2Context(repoPath, env),
    });
  } catch (err) {
    const message = err instanceof JudgeError ? err.message : `judge invocation failed: ${(err as Error).message}`;
    return { schema: "pawpie-recheck@1", ok: false, reason: "judge-failed", id, message, exitCode: 1 };
  }

  try {
    appendSidecarLine(adrDir, id, judged.verdict.outcome, noteFor(judged.verdict.raises));
  } catch (err) {
    return {
      schema: "pawpie-recheck@1",
      ok: false,
      reason: "sidecar-unwritable",
      id,
      message: `could not append to ${path.join(adrDir, "recheck.tsv")}: ${(err as Error).message}`,
      exitCode: 1,
    };
  }

  return {
    schema: "pawpie-recheck@1",
    ok: true,
    id,
    outcome: judged.verdict.outcome,
    raises: judged.verdict.raises,
    extractedClaims: judged.verdict.extractedClaims,
    unchecked: judged.verdict.unchecked,
    usage: judged.usage,
    exitCode: judged.verdict.outcome === "raised" ? 10 : 0,
  };
}

