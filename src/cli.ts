#!/usr/bin/env node
import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { buildListResult, refuseList, renderListText } from "./list.ts";
import { createAdr } from "./new.ts";
import { refuseRecheck } from "./recheck.ts";

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
  2   usage error: unknown command or flag, a missing title for 'new',
      no ADR directory for 'list', or recheck/punch (always, id or not)
  3   an ADR is present and checks nothing: no ## Problem, no date in any
      known shape, unreadable, or a duplicate number — also returned by
      'new' when the directory already has a duplicate number
  10  at least one ADR raised (Step D, not built yet)
`;

function splitFlags(args: string[]): { json: boolean; positionals: string[]; unknownFlags: string[] } {
  const positionals: string[] = [];
  const unknownFlags: string[] = [];
  let json = false;
  for (const arg of args) {
    if (arg === "--json") json = true;
    else if (arg.startsWith("--")) unknownFlags.push(arg);
    else positionals.push(arg);
  }
  return { json, positionals, unknownFlags };
}

function usageError(flag: string, stderr: (s: string) => void): number {
  stderr(`pawpie: unknown flag "${flag}"`);
  return 2;
}

function runList(args: string[], stdout: (s: string) => void, stderr: (s: string) => void): number {
  const { json, positionals, unknownFlags } = splitFlags(args);
  if (unknownFlags.length > 0) return usageError(unknownFlags[0], stderr);

  const repoPath = positionals[0] ?? ".";
  const adrDir = path.join(repoPath, "docs", "adr");

  if (!fs.existsSync(adrDir) || !fs.statSync(adrDir).isDirectory()) {
    const refusal = refuseList(repoPath, "no-adr-directory", `no ADR directory at ${adrDir}`);
    if (json) stdout(JSON.stringify(refusal));
    else stderr(`pawpie: ${refusal.message}`);
    return refusal.exitCode;
  }

  let result;
  try {
    result = buildListResult(repoPath);
  } catch (err) {
    const message = `could not read ${adrDir}: ${(err as Error).message}`;
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
  const { positionals, unknownFlags } = splitFlags(args);
  if (unknownFlags.length > 0) return usageError(unknownFlags[0], stderr);

  const title = positionals[0];
  if (!title) {
    stderr("pawpie: new requires a title, e.g. pawpie new \"<title>\"");
    return 2;
  }
  const repoPath = positionals[1] ?? ".";

  const result = createAdr(repoPath, title);
  if (!result.ok) {
    stderr(`pawpie: ${result.error.message}`);
    return 3;
  }
  stdout(`created docs/adr/${result.file}`);
  return 0;
}

function runRecheck(
  args: string[],
  stdout: (s: string) => void,
  stderr: (s: string) => void,
): number {
  const { json, positionals, unknownFlags } = splitFlags(args);
  if (unknownFlags.length > 0) return usageError(unknownFlags[0], stderr);

  const id = positionals[0] ?? null;
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
      stderr(`pawpie: unknown command "${command}"`);
      return 2;
  }
}

const isMain = process.argv[1] !== undefined && fileURLToPath(import.meta.url) === path.resolve(process.argv[1]);
if (isMain) {
  process.exit(run(process.argv.slice(2)));
}
