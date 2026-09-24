#!/usr/bin/env node
import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { buildListResult, renderListText } from "./list.ts";
import { createAdr } from "./new.ts";
import { refuseRecheck } from "./recheck.ts";

const HELP = `pawpie — re-triage decision records (ADRs) when the world moves

Usage:
  pawpie                        print this help
  pawpie list [path] [--json]   every ADR, oldest check first, never-checked at the top
  pawpie new "<title>" [path]   next free number, a template with ## Problem and one date line
  pawpie recheck <id> [path]    not built yet (refuses, exit 2)
  pawpie punch <id> [path]      alias for recheck

Exit codes:
  0   ran; nothing raised (also help)
  1   sidecar unwritable
  2   usage error, no ADR directory, recheck with no id
  3   an ADR is present and checks nothing (no ## Problem, no date, unreadable, duplicate number)
  10  at least one ADR raised
`;

function splitFlags(args: string[]): { json: boolean; positionals: string[] } {
  const positionals: string[] = [];
  let json = false;
  for (const arg of args) {
    if (arg === "--json") json = true;
    else positionals.push(arg);
  }
  return { json, positionals };
}

function runList(args: string[], stdout: (s: string) => void, stderr: (s: string) => void): number {
  const { json, positionals } = splitFlags(args);
  const repoPath = positionals[0] ?? ".";
  const adrDir = path.join(repoPath, "docs", "adr");

  if (!fs.existsSync(adrDir) || !fs.statSync(adrDir).isDirectory()) {
    stderr(`pawpie: no ADR directory at ${adrDir}`);
    return 2;
  }

  const result = buildListResult(repoPath);
  if (json) {
    stdout(JSON.stringify(result));
  } else {
    stdout(renderListText(result));
  }
  return result.exitCode;
}

function runNew(args: string[], stdout: (s: string) => void, stderr: (s: string) => void): number {
  const { positionals } = splitFlags(args);
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
  const { json, positionals } = splitFlags(args);
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
