import * as fs from "node:fs";
import * as path from "node:path";
import { UNFILLED_PROBLEM_PLACEHOLDER, extractClaimsSection, extractProblemSection, parseClaims, scanAdrDir, type Claim } from "./adr.ts";
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
    | "adr-file-unreadable"
    | "adr-not-found"
    | "adr-invalid"
    | "search-not-configured"
    | "pass2-context-unreadable"
    | "judge-failed"
    | "sidecar-unwritable";
  id: string | null;
  message: string;
  exitCode: 1 | 2;
  // Populated only for "sidecar-unwritable": the judge already completed a
  // full (uncapped) research run by the time the append fails, and that
  // verdict must not be silently discarded along with the refusal.
  verdict?: {
    outcome: "raised" | "clear";
    raises: Raise[];
    extractedClaims: ClaimRef[];
    unchecked: Question[];
    usage: JudgeUsage;
    backend: "fixture" | "exa";
  };
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
  // Which search backend actually served this run — surfaced because
  // PAWPIE_SEARCH_FIXTURE silently takes priority over EXA_API_KEY when both
  // are set (a leaked test env var would otherwise judge canned results with
  // no other signal).
  backend: "fixture" | "exa";
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
export function normalizeId(raw: string): string {
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

// A committed sidecar row is the only durable record of a run — JudgeUsage's
// error/null counts only reach --json. A bare "clear" here would be
// indistinguishable from a fully researched one, so a run where research
// plainly did not happen (usage unknown, zero calls attempted, or every
// attempted call failed) says so in the row itself.
export function usageCaveat(usage: JudgeUsage): string | null {
  if (usage.searches === null || usage.fetches === null) return "usage unknown";
  const attempted = usage.searches + (usage.searchErrors ?? 0) + usage.fetches + (usage.fetchErrors ?? 0);
  const failed = (usage.searchErrors ?? 0) + (usage.fetchErrors ?? 0);
  if (attempted === 0) return "no search/fetch calls made";
  if (failed === attempted) return "every search/fetch call failed";
  return null;
}

function noteFor(raises: Raise[], unchecked: Question[], usage: JudgeUsage, backend: "fixture" | "exa"): string {
  const raiseNotes = raises.map((r) => `${r.pass === 1 ? `pass1:${r.claim.disposition}` : `pass2:${r.question}`} ${r.note}`);
  const parts = raiseNotes.length === 0 ? ["clear"] : raiseNotes;
  if (unchecked.length > 0) parts.push(`unchecked: ${unchecked.join(",")}`);
  const caveat = usageCaveat(usage);
  if (caveat) parts.push(caveat);
  // Only a fixture backend is worth flagging in a committed row — exa is the
  // expected default, and a fixture here is either a test or a leaked env var.
  if (backend === "fixture") parts.push("backend:fixture");
  return parts.join("; ");
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
// web cannot answer: the README (read unconditionally, since no README at
// all is ordinary), plus open issues and agent capabilities from an
// explicitly configured fixture path (no live lookup yet in v0). Missing
// input reaches the judge as UNAVAILABLE — but a read failure other than the
// README's ENOENT is a misconfiguration, not "unavailable", and propagates
// into runRecheck's pass2-context-unreadable refusal instead of a silent null.
// Empty or whitespace-only counts as unavailable, the same as missing —
// otherwise an existing-but-blank file forces its question "available",
// and a judge honestly reporting it unchecked is rejected as judge-failed.
function nonBlank(text: string | null): string | null {
  return text !== null && text.trim().length > 0 ? text : null;
}

function gatherPass2Context(repoPath: string, env: NodeJS.ProcessEnv): Pass2Context {
  let readme: string | null = null;
  try {
    readme = fs.readFileSync(path.join(repoPath, "README.md"), "utf8");
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== "ENOENT") throw err;
    readme = null;
  }

  const openIssues = env.PAWPIE_PASS2_ISSUES_FIXTURE ? fs.readFileSync(env.PAWPIE_PASS2_ISSUES_FIXTURE, "utf8") : null;
  const agentCapabilities = env.PAWPIE_AGENT_CAPABILITIES ? fs.readFileSync(env.PAWPIE_AGENT_CAPABILITIES, "utf8") : null;

  return { readme: nonBlank(readme), openIssues: nonBlank(openIssues), agentCapabilities: nonBlank(agentCapabilities) };
}

// Decides which env vars to forward to the spawned `__mcp-serve` child;
// createSearchAdapterFromEnv (below) is what that separate process calls.
function searchAdapterEnv(env: NodeJS.ProcessEnv): Record<string, string> {
  if (env.PAWPIE_SEARCH_FIXTURE) {
    return { PAWPIE_SEARCH_ADAPTER: "fixture", PAWPIE_SEARCH_FIXTURE: env.PAWPIE_SEARCH_FIXTURE };
  }
  return { PAWPIE_SEARCH_ADAPTER: "exa", EXA_API_KEY: env.EXA_API_KEY ?? "" };
}

// Checked in the parent process before the judge ever runs: an unconfigured
// OR unreadable/unparseable backend must refuse loudly here, not fail
// silently inside the spawned MCP server (where `createSearchAdapterFromEnv`'s
// own throw is invisible to the judge — it just proceeds with no tools, and a
// resulting "clear" verdict would misrepresent a decision that was never
// actually searched).
function searchConfigError(env: NodeJS.ProcessEnv): string | null {
  if (env.PAWPIE_SEARCH_FIXTURE) {
    try {
      const fixture: unknown = JSON.parse(fs.readFileSync(env.PAWPIE_SEARCH_FIXTURE, "utf8"));
      const results = typeof fixture === "object" && fixture !== null ? (fixture as { results?: unknown }).results : undefined;
      if (!Array.isArray(results)) {
        return `PAWPIE_SEARCH_FIXTURE (${env.PAWPIE_SEARCH_FIXTURE}) is not a fixture: it needs a "results" array`;
      }
      // Each hit's shape is what mcp-server.ts logs as evidence (url/text) —
      // a hit missing either silently discards the *entire* evidence log
      // downstream (judge.ts's shape check on the parsed array), rejecting
      // every URL-sourced raise with a misleading "never returned" error.
      const badHit = results.find(
        (r) => typeof r !== "object" || r === null || typeof (r as { url?: unknown }).url !== "string" || typeof (r as { text?: unknown }).text !== "string",
      );
      if (badHit !== undefined) {
        return `PAWPIE_SEARCH_FIXTURE (${env.PAWPIE_SEARCH_FIXTURE}) has a result missing a string "url" or "text": ${JSON.stringify(badHit)}`;
      }
      // fetchText overrides a hit's text for a given URL — a non-string value
      // here reaches mcp-server.ts as non-string evidence, which runJudge
      // then discards wholesale, turning this malformed fixture into an
      // opaque judge-failed instead of a config error reported upfront.
      const fetchText = (fixture as { fetchText?: unknown }).fetchText;
      if (fetchText !== undefined) {
        if (typeof fetchText !== "object" || fetchText === null) {
          return `PAWPIE_SEARCH_FIXTURE (${env.PAWPIE_SEARCH_FIXTURE}) has a "fetchText" that is not an object`;
        }
        const badEntry = Object.entries(fetchText as Record<string, unknown>).find(([, v]) => typeof v !== "string");
        if (badEntry !== undefined) {
          return `PAWPIE_SEARCH_FIXTURE (${env.PAWPIE_SEARCH_FIXTURE}) has a non-string "fetchText" value for ${JSON.stringify(badEntry[0])}`;
        }
      }
    } catch (err) {
      return `PAWPIE_SEARCH_FIXTURE (${env.PAWPIE_SEARCH_FIXTURE}) could not be read as JSON: ${(err as Error).message}`;
    }
    return null;
  }
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

  const adrContent = fs.readFileSync(path.join(adrDir, adr.file), "utf8");

  // `list`'s own gate (adr.error) does not flag this: a freshly created ADR
  // with its ## Problem still unfilled is a valid, listable ADR — only
  // punching it is meaningless, since there is no real question to research.
  if (extractProblemSection(adrContent) === UNFILLED_PROBLEM_PLACEHOLDER) {
    return {
      schema: "pawpie-recheck@1",
      ok: false,
      reason: "adr-invalid",
      id,
      message: `ADR ${id}'s ## Problem section still holds the unfilled template placeholder — fill it in before punching it`,
      exitCode: 2,
    };
  }

  const configError = searchConfigError(env);
  if (configError) {
    return { schema: "pawpie-recheck@1", ok: false, reason: "search-not-configured", id, message: configError, exitCode: 2 };
  }
  const backend: "fixture" | "exa" = env.PAWPIE_SEARCH_FIXTURE ? "fixture" : "exa";

  let pass2: Pass2Context;
  try {
    pass2 = gatherPass2Context(repoPath, env);
  } catch (err) {
    return {
      schema: "pawpie-recheck@1",
      ok: false,
      reason: "pass2-context-unreadable",
      id,
      message: `a pass-2 context file could not be read: ${(err as Error).message}`,
      exitCode: 2,
    };
  }

  let judged;
  try {
    judged = runJudge(id, adrContent, {
      env,
      selfCommand: opts.selfCommand,
      searchAdapterEnv: searchAdapterEnv(env),
      claims: claimsFor(adrContent),
      pass2,
    });
  } catch (err) {
    const message = err instanceof JudgeError ? err.message : `judge invocation failed: ${(err as Error).message}`;
    return { schema: "pawpie-recheck@1", ok: false, reason: "judge-failed", id, message, exitCode: 1 };
  }

  try {
    appendSidecarLine(
      adrDir,
      id,
      judged.verdict.outcome,
      noteFor(judged.verdict.raises, judged.verdict.unchecked, judged.usage, backend),
    );
  } catch (err) {
    return {
      schema: "pawpie-recheck@1",
      ok: false,
      reason: "sidecar-unwritable",
      id,
      message: `could not append to ${path.join(adrDir, "recheck.tsv")}: ${(err as Error).message}`,
      exitCode: 1,
      verdict: {
        outcome: judged.verdict.outcome,
        raises: judged.verdict.raises,
        extractedClaims: judged.verdict.extractedClaims,
        unchecked: judged.verdict.unchecked,
        usage: judged.usage,
        backend,
      },
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
    backend,
    exitCode: judged.verdict.outcome === "raised" ? 10 : 0,
  };
}

