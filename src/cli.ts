#!/usr/bin/env node
import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { ReadFailure, errorCode } from "./errors.ts";
import { buildListResult, refuseList, renderListText } from "./list.ts";
import { createAdr } from "./new.ts";
import {
  createSearchAdapterFromEnv,
  normalizeId,
  refuseMissingId,
  refuseRecheckUsage,
  runRecheck,
  type RecheckResult,
  type RecheckRefusal,
} from "./recheck.ts";
import { runMcpStdioServer } from "./mcp-server.ts";
import { sanitizeForTerminal } from "./terminal.ts";

const HELP = `pawpie — re-triage decision records (ADRs) when the world moves

Usage:
  pawpie                          print this help (also --help / -h)
  pawpie list [path] [--json]     every ADR, oldest check first, never-checked at the top
  pawpie new "<title>" [path]     next free number, a template with ## Problem, ## Claims, one date line
  pawpie recheck <id> [path] [--json]   search the world; raise or stay quiet
  pawpie punch <id> [path] [--json]     alias for recheck

'path' defaults to the current directory. ADRs live under <path>/docs/adr/.
'list' refuses when that directory is missing; 'new' creates it.

recheck/punch never edits an ADR. It searches with EXA (EXA_API_KEY in the
environment) via a judge process — 'claude -p --model opus --effort medium'
by default, overridable with PAWPIE_JUDGE_CMD — then appends one line to
docs/adr/recheck.tsv for every run that reaches a verdict (a refusal appends
nothing). There is no cost cap; --json reports what the judge
actually used.

Exit codes:
  0   ran; nothing raised (also help, and recheck/punch outcome "clear")
  1   recheck/punch: the judge failed, or the sidecar could not be appended to
  2   usage error: unknown command, unknown flag (any '-' or '--' token
      the command doesn't take), an unexpected extra argument, a missing
      or newline-containing title for 'new', no ADR directory or an
      unreadable ADR directory/sidecar for 'list', an unwritable ADR
      directory for 'new' (or an unreadable ADR directory/sidecar, naming
      that path instead), or recheck/punch with no id, an unreadable ADR
      directory or file, an unknown id, an ADR that already fails its own
      'list' checks or still holds 'new''s unfilled ## Problem placeholder
      (an ADR 'list' itself accepts), no search backend configured, or an
      unreadable/malformed PAWPIE_SEARCH_FIXTURE or pass-2 context file
  3   an ADR is present and checks nothing: no ## Problem, no date in any
      known shape, unreadable, or a duplicate number — also returned by
      'new' when the directory already has a duplicate number
  10  recheck/punch raised the ADR for a human to triage
`;

type Schema = "pawpie@1" | null;

function splitFlags(
  args: string[],
  allowed: ReadonlySet<string>,
): { flags: Set<string>; positionals: string[]; unknownFlags: string[] } {
  const positionals: string[] = [];
  const unknownFlags: string[] = [];
  const flags = new Set<string>();
  for (const arg of args) {
    if (!arg.startsWith("-") || arg === "-") positionals.push(arg);
    else if (allowed.has(arg)) flags.add(arg);
    else unknownFlags.push(arg);
  }
  return { flags, positionals, unknownFlags };
}

// For schemas with no typed refusal shape of their own (the top-level
// "pawpie@1" usage error, and `new`, which has no --json contract at all).
function usageError(
  message: string,
  schema: Schema,
  json: boolean,
  stdout: (s: string) => void,
  stderr: (s: string) => void,
): number {
  if (json && schema) {
    stdout(JSON.stringify({ schema, ok: false, reason: "usage-error", message }));
  } else {
    stderr(`pawpie: ${message}`);
  }
  return 2;
}

function runList(args: string[], stdout: (s: string) => void, stderr: (s: string) => void): number {
  const { flags, positionals, unknownFlags } = splitFlags(args, new Set(["--json"]));
  const json = flags.has("--json");
  const repoPath = positionals[0] ?? ".";

  if (unknownFlags.length > 0 || positionals.length > 1) {
    const message =
      unknownFlags.length > 0
        ? `unknown flag "${unknownFlags[0]}"`
        : `unexpected argument "${positionals[1]}"`;
    const refusal = refuseList(repoPath, "usage-error", message);
    if (json) stdout(JSON.stringify(refusal));
    else stderr(`pawpie: ${message}`);
    return refusal.exitCode;
  }

  const adrDir = path.join(repoPath, "docs", "adr");

  let stat: fs.Stats | undefined;
  try {
    stat = fs.statSync(adrDir);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== "ENOENT") {
      const message = `could not read ${adrDir}: ${(err as Error).message}`;
      const refusal = refuseList(repoPath, "unreadable", message);
      if (json) stdout(JSON.stringify(refusal));
      else stderr(`pawpie: ${message}`);
      return refusal.exitCode;
    }
  }
  if (!stat || !stat.isDirectory()) {
    const refusal = refuseList(repoPath, "no-adr-directory", `no ADR directory at ${adrDir}`);
    if (json) stdout(JSON.stringify(refusal));
    else stderr(`pawpie: ${refusal.message}`);
    return refusal.exitCode;
  }

  let result;
  try {
    result = buildListResult(repoPath);
  } catch (err) {
    // The preflight stat above found a directory; if it is gone by the time
    // buildListResult reads it, that is the same "no ADR directory" case,
    // not an unreadable one — a race, not a permissions problem.
    if (errorCode(err) === "ENOENT") {
      const refusal = refuseList(repoPath, "no-adr-directory", `no ADR directory at ${adrDir}`);
      if (json) stdout(JSON.stringify(refusal));
      else stderr(`pawpie: ${refusal.message}`);
      return refusal.exitCode;
    }
    const message = err instanceof ReadFailure ? err.message : `could not read ${adrDir}: ${(err as Error).message}`;
    const refusal = refuseList(repoPath, "unreadable", message);
    if (json) stdout(JSON.stringify(refusal));
    else stderr(`pawpie: ${message}`);
    return refusal.exitCode;
  }

  if (json) stdout(JSON.stringify(result));
  else stdout(renderListText(result));
  return result.exitCode;
}

function runNew(args: string[], stdout: (s: string) => void, stderr: (s: string) => void): number {
  const { positionals, unknownFlags } = splitFlags(args, new Set());
  if (unknownFlags.length > 0) {
    return usageError(`unknown flag "${unknownFlags[0]}"`, null, false, stdout, stderr);
  }
  if (positionals.length > 2) {
    return usageError(`unexpected argument "${positionals[2]}"`, null, false, stdout, stderr);
  }

  const title = positionals[0];
  if (!title) {
    stderr("pawpie: new requires a title, e.g. pawpie new \"<title>\"");
    return 2;
  }
  const repoPath = positionals[1] ?? ".";
  const adrDir = path.join(repoPath, "docs", "adr");

  let result;
  try {
    result = createAdr(repoPath, title);
  } catch (err) {
    const message =
      err instanceof ReadFailure
        ? err.message
        : `could not write to ${adrDir}: ${(err as Error).message}`;
    stderr(`pawpie: ${message}`);
    return 2;
  }
  if (!result.ok) {
    stderr(`pawpie: ${result.error.message}`);
    return result.error.kind === "invalid-title" ? 2 : 3;
  }
  stdout(`created ${path.join(adrDir, result.file)}`);
  return 0;
}

function renderVerdictText(
  id: string,
  verdict: Pick<RecheckResult, "outcome" | "raises" | "unchecked">,
  stdout: (s: string) => void,
): void {
  if (verdict.outcome === "clear") stdout(`${id}: clear`);
  else {
    stdout(`${id}: raised`);
    for (const raise of verdict.raises) {
      const label = raise.pass === 1 ? `pass 1, ${raise.claim.disposition} claim` : `pass 2, ${raise.question}`;
      stdout(`  [${label}] ${sanitizeForTerminal(raise.note)}`);
      stdout(`    ${sanitizeForTerminal(raise.evidence.source)} — "${sanitizeForTerminal(raise.evidence.quote)}"`);
    }
  }
  // Printed for "clear" too — a quiet run is never read as "everything is
  // current" when a pass-2 question went unchecked for lack of input.
  if (verdict.unchecked.length > 0) {
    stdout(`  unchecked: ${verdict.unchecked.join(", ")} (missing repo/agent context)`);
  }
}

function runRecheckCommand(
  args: string[],
  stdout: (s: string) => void,
  stderr: (s: string) => void,
): number {
  const { flags, positionals, unknownFlags } = splitFlags(args, new Set(["--json"]));
  const json = flags.has("--json");
  const id = positionals[0] ?? null;
  const repoPath = positionals[1] ?? ".";

  if (unknownFlags.length > 0 || positionals.length > 2) {
    const message =
      unknownFlags.length > 0
        ? `unknown flag "${unknownFlags[0]}"`
        : `unexpected argument "${positionals[2]}"`;
    const refusal = refuseRecheckUsage(id, message);
    if (json) stdout(JSON.stringify(refusal));
    else stderr(`pawpie: ${message}`);
    return refusal.exitCode;
  }

  if (id === null) {
    const refusal = refuseMissingId();
    if (json) stdout(JSON.stringify(refusal));
    else stderr(`pawpie: ${refusal.message}`);
    return refusal.exitCode;
  }

  let result: RecheckResult | RecheckRefusal;
  try {
    result = runRecheck(repoPath, id);
  } catch (err) {
    // runRecheck reports every expected failure (missing/unreadable ADR
    // directory included) as a RecheckRefusal; this only catches a genuine
    // race (e.g. the ADR file deleted between the scan and the read).
    const normalizedId = normalizeId(id);
    const message = `could not read ADR ${normalizedId}: ${(err as Error).message}`;
    if (json) {
      stdout(JSON.stringify({ schema: "pawpie-recheck@1", ok: false, reason: "adr-file-unreadable", id: normalizedId, message, exitCode: 2 }));
    } else stderr(`pawpie: ${message}`);
    return 2;
  }

  if (json) stdout(JSON.stringify(result));
  else if (!result.ok) {
    // judge-failed's message can embed the judge process's own stderr.
    stderr(`pawpie: ${sanitizeForTerminal(result.message)}`);
    // sidecar-unwritable still carries a completed, uncapped research run —
    // print it rather than dropping every raise on the floor.
    if (result.verdict) renderVerdictText(result.id ?? "?", result.verdict, stdout);
  } else {
    renderVerdictText(result.id, result, stdout);
  }
  return result.exitCode;
}

export function run(
  argv: string[],
  stdout: (s: string) => void = (s) => console.log(s),
  stderr: (s: string) => void = (s) => console.error(s),
): number {
  const [command, ...rest] = argv;

  if (!command || command === "--help" || command === "-h") {
    stdout(HELP);
    return 0;
  }

  switch (command) {
    case "list":
      return runList(rest, stdout, stderr);
    case "new":
      return runNew(rest, stdout, stderr);
    case "recheck":
    case "punch":
      return runRecheckCommand(rest, stdout, stderr);
    default:
      return usageError(`unknown command "${command}"`, "pawpie@1", argv.includes("--json"), stdout, stderr);
  }
}

function isMainModule(): boolean {
  if (process.argv[1] === undefined) return false;
  try {
    return fileURLToPath(import.meta.url) === fs.realpathSync(process.argv[1]);
  } catch {
    return false;
  }
}

// Not in --help, and not meant for a human to type: this is the MCP search
// server judge.ts spawns as a child of the judge command, over its own
// stdio. It returns immediately, but the readline listener it registers
// keeps the process alive until stdin closes.
function runMcpServeEntry(): void {
  const adapter = createSearchAdapterFromEnv(process.env);
  runMcpStdioServer(adapter, process.env.PAWPIE_MCP_COUNTS_FILE, process.env.PAWPIE_MCP_EVIDENCE_FILE);
}

if (isMainModule()) {
  if (process.argv[2] === "__mcp-serve") {
    runMcpServeEntry();
  } else {
    // Not process.exit(): stdout to a pipe can be asynchronous, and exiting
    // immediately after a large console.log can truncate it before it flushes.
    process.exitCode = run(process.argv.slice(2));
  }
}
