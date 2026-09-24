import * as fs from "node:fs";
import * as path from "node:path";
import { extractClaimsSection, parseClaims, scanAdrDir, type Claim } from "./adr.ts";
import { JudgeError, runJudge, type ClaimRef, type JudgeUsage, type Pass2Context, type Question, type Raise } from "./judge.ts";
import { createExaAdapter, loadFixtureAdapter } from "./search-adapter.ts";
import type { SearchAdapter } from "./search-adapter.ts";

export interface RecheckRefusal {
  schema: "pawpie-recheck@1";
  ok: false;
  reason:
    | "missing-id"
    | "usage-error"
    | "adr-dir-unreadable"
    | "adr-not-found"
    | "adr-invalid"
    | "search-not-configured"
    | "judge-failed"
    | "sidecar-unwritable";
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
  const sidecarPath = path.join(adrDir, "recheck.tsv");

  // recheck.tsv is a committed, hand-editable file: it may not end in a
  // newline. Gluing the new row onto that last line would corrupt it —
  // either the reader skips the new row as malformed, or folds it into the
  // prior row's note — so a leading newline is added whenever the existing
  // content doesn't already end in one.
  let needsLeadingNewline = false;
  try {
    const fd = fs.openSync(sidecarPath, "r");
    try {
      const size = fs.fstatSync(fd).size;
      if (size > 0) {
        const buf = Buffer.alloc(1);
        fs.readSync(fd, buf, 0, 1, size - 1);
        needsLeadingNewline = buf[0] !== 0x0a;
      }
    } finally {
      fs.closeSync(fd);
    }
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== "ENOENT") throw err;
  }

  const row = `${needsLeadingNewline ? "\n" : ""}${id}\t${today}\t${outcome}\t${safeNote}\n`;
  fs.appendFileSync(sidecarPath, row, "utf8");
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

// Chooses which search backend the spawned `__mcp-serve` child should use.
// `recheck.ts` itself still imports search-adapter.ts (createSearchAdapterFromEnv
// below is what `__mcp-serve` calls, in that separate process) — this
// function only decides which env vars to forward to that child.
function searchAdapterEnv(env: NodeJS.ProcessEnv): Record<string, string> {
  if (env.PAWPIE_SEARCH_FIXTURE) {
    return { PAWPIE_SEARCH_ADAPTER: "fixture", PAWPIE_SEARCH_FIXTURE: env.PAWPIE_SEARCH_FIXTURE };
  }
  return { PAWPIE_SEARCH_ADAPTER: "exa", EXA_API_KEY: env.EXA_API_KEY ?? "" };
}

// Checked in the parent process before the judge ever runs: an unconfigured
// backend must refuse loudly here, not fail silently inside the spawned MCP
// server (where `createSearchAdapterFromEnv`'s own throw is invisible to the
// judge — it just proceeds with no tools, and a resulting "clear" verdict
// would misrepresent a decision that was never actually searched).
function searchConfigError(env: NodeJS.ProcessEnv): string | null {
  if (env.PAWPIE_SEARCH_FIXTURE) return null;
  if (!env.EXA_API_KEY || env.EXA_API_KEY.trim() === "") {
    return "no search backend is configured: set EXA_API_KEY, or PAWPIE_SEARCH_FIXTURE for a test fixture";
  }
  return null;
}

export function createSearchAdapterFromEnv(env: NodeJS.ProcessEnv): SearchAdapter {
  if (env.PAWPIE_SEARCH_ADAPTER === "fixture") {
    if (!env.PAWPIE_SEARCH_FIXTURE) throw new Error("PAWPIE_SEARCH_ADAPTER=fixture requires PAWPIE_SEARCH_FIXTURE");
    return loadFixtureAdapter(env.PAWPIE_SEARCH_FIXTURE);
  }
  if (!env.EXA_API_KEY) throw new Error("EXA_API_KEY is required for the exa search adapter");
  return createExaAdapter(env.EXA_API_KEY);
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
    return {
      schema: "pawpie-recheck@1",
      ok: false,
      reason: "adr-dir-unreadable",
      id,
      message: `could not read ${adrDir}: ${(err as Error).message}`,
      exitCode: 2,
    };
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

  const configError = searchConfigError(env);
  if (configError) {
    return { schema: "pawpie-recheck@1", ok: false, reason: "search-not-configured", id, message: configError, exitCode: 2 };
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

