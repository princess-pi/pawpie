#!/usr/bin/env node
import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { ReadFailure, errorCode } from "./errors.ts";
import { buildListResult, refuseList, renderListText } from "./list.ts";
import { createAdr } from "./new.ts";
import { refuseRecheck, refuseRecheckUsage } from "./recheck.ts";

const HELP = `pawpie — re-triage decision records (ADRs) when the world moves

Usage:
  pawpie                          print this help (also --help / -h)
  pawpie list [path] [--json]     every ADR, oldest check first, never-checked at the top
  pawpie new "<title>" [path]     next free number, a template with ## Problem and one date line
  pawpie recheck <id> [path] [--json]   not built yet (refuses, exit 2)
  pawpie punch <id> [path] [--json]     alias for recheck

'path' defaults to the current directory. ADRs live under <path>/docs/adr/.
'list' refuses when that directory is missing; 'new' creates it.

Exit codes:
  0   ran; nothing raised (also help)
  1   sidecar unwritable (reserved for recheck/punch — not reachable yet)
  2   usage error: unknown command, unknown flag (any '-' or '--' token
      the command doesn't take), an unexpected extra argument, a missing
      title for 'new', no ADR directory or an unreadable ADR
      directory/sidecar for 'list', an unwritable ADR directory for 'new'
      (or an unreadable ADR directory/sidecar, naming that path instead),
      or recheck/punch (always, id or not)
  3   an ADR is present and checks nothing: no ## Problem, no date in any
      known shape, unreadable, or a duplicate number — also returned by
      'new' when the directory already has a duplicate number
  10  at least one ADR raised (Step D, not built yet)
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
    return 3;
  }
  stdout(`created ${path.join(adrDir, result.file)}`);
  return 0;
}

function runRecheck(
  args: string[],
  stdout: (s: string) => void,
  stderr: (s: string) => void,
): number {
  const { flags, positionals, unknownFlags } = splitFlags(args, new Set(["--json"]));
  const json = flags.has("--json");
  const id = positionals[0] ?? null;

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

  const refusal = refuseRecheck(id);
  if (json) {
    stdout(JSON.stringify(refusal));
  } else {
    stderr(`pawpie: ${refusal.message}`);
  }
  return refusal.exitCode;
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
      return runRecheck(rest, stdout, stderr);
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

if (isMainModule()) {
  // Not process.exit(): stdout to a pipe can be asynchronous, and exiting
  // immediately after a large console.log can truncate it before it flushes.
  process.exitCode = run(process.argv.slice(2));
}
