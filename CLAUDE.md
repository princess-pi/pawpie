# pawpie

Re-triage decision records (ADRs) when the world moves. Public, `@princess-pi/pawpie`, not on npm
yet. Origin: [duppypro/btw#106](https://github.com/duppypro/btw/issues/106).

This repo is **public**. No client names, no private-repo issue links, no internal repo details.
The only outside *project* links it carries are
[duppypro/btw#106](https://github.com/duppypro/btw/issues/106) (origin) and
[quoteinvestigator.com](https://quoteinvestigator.com/2017/11/18/planning/) (the quote source) —
this does not count Duppy's own GitHub profile or this repo's own issue tracker.

## Workflow

Load the `workflow` skill (also `~/.config/princess-pi/workflow.md`) at the start of any session
that will branch, commit, open a PR, or clean up after one — it carries the hard gates, branch and
worktree layout, the shipped scripts, TDD-to-merge flow, issue cadence, and git guardrails. Follow
it, not a restated copy here.

Tracking issue: [princess-pi/pawpie#3](https://github.com/princess-pi/pawpie/issues/3) — comment
there about as often as you commit.

## Hard gates

- **Never edit build output.** `bin/pawpie.mjs` is a gitignored bundle. Edit `src/*.ts`, then
  `bun run build`.
- **The bundle imports only `node:` builtins.** It must run on stock node (`node bin/pawpie.mjs`),
  since a published package ships prebuilt output and never requires bun at the consumer end. This
  includes `recheck`/`punch`'s judge and MCP-server wiring: no MCP SDK dependency, hand-rolled
  JSON-RPC over stdio in `src/mcp-server.ts` instead.
- **`recheck`/`punch` never edits an ADR and never re-decides.** It runs two passes (pass 1 iterates
  the `## Claims`, pass 2 asks four questions about `## Problem`), raises with evidence (a source
  and a quote) or stays quiet, and appends exactly one line to `docs/adr/recheck.tsv` per run that
  reaches a verdict — a refusal (`judge-failed`, `adr-invalid`, `search-not-configured`, ...)
  appends nothing.
  Tests must never call the real EXA search backend or the real judge model — set
  `PAWPIE_SEARCH_FIXTURE` (the parent process reads only this var; it derives
  `PAWPIE_SEARCH_ADAPTER` itself when forwarding env to the spawned `__mcp-serve` child) and a fake
  `PAWPIE_JUDGE_CMD` (see `tests/support.ts`'s `fakeJudgeEnv`).

## Stack

- Bun + TypeScript, bundled with `bun build` to a single `bin/pawpie.mjs` that runs on stock node.
- Typecheck with TypeScript 7's native compiler: `bun run typecheck` runs it twice, once over
  `src/` alone (`tsc --noEmit`, deliberately excluding `bun-types` so a stray `Bun.*` global fails
  here instead of at a consumer's `npx`) and once over `src/` + `tests/` together
  (`tsconfig.test.json`, which does allow `bun-types` for `bun:test`).
- Tests with `bun test`.

## Commands

| Purpose | Command |
|---|---|
| Install deps | `bun install` |
| Build | `bun run build` |
| Typecheck | `bun run typecheck` |
| Test | `bun run test` |
| Run the built CLI | `node bin/pawpie.mjs <command>` |

## Shape

- `src/cli.ts` — argument parsing and command dispatch; exports `run()` for tests.
- `src/adr.ts` — scans `docs/adr/`, parses dates in the three known shapes and the `## Claims`
  section (one line per claim, tagged `taken`/`not-taken` with its source), detects a missing
  `## Problem`, a missing date, and duplicate ADR numbers.
- `src/sidecar.ts` — reads `docs/adr/recheck.tsv`; `recheck.ts` is what writes it.
- `src/list.ts` — `pawpie list`: builds and sorts the `pawpie-list@1` record.
- `src/new.ts` — `pawpie new`: next free ADR number, writes the template; refuses a
  newline-containing title (exit 2) before touching the filesystem.
- `src/recheck.ts` — `pawpie recheck`/`pawpie punch`: looks up the ADR, runs the judge, appends
  the sidecar row, and shapes the `pawpie-recheck@1` result/refusal.
- `src/judge.ts` — builds the judge prompt, spawns `PAWPIE_JUDGE_CMD` (default `claude -p --model
  opus --effort medium`) with an MCP config pointed at `__mcp-serve`, and validates the verdict
  JSON it returns.
- `src/search-adapter.ts` — the `SearchAdapter` interface (`search`, `fetch`), an EXA-backed
  implementation, and the fixture adapter tests use.
- `src/mcp-server.ts` — the JSON-RPC/stdio MCP server exposing `search`/`fetch_url` to the judge;
  `handleMcpRequest` is the pure, unit-testable core, `runMcpStdioServer` the stdio wrapper the
  hidden `__mcp-serve` subcommand runs. Also logs every URL/text a call actually returned, so
  `judge.ts` can reject a raise whose evidence was never returned this run.
- `src/terminal.ts` — `sanitizeForTerminal`, shared by `list.ts` and `cli.ts` to strip control
  characters from any web-sourced or file-sourced text before it reaches a terminal.
- `src/errors.ts` — `ReadFailure` (wraps a read error with the path that failed) and
  `errorCode()`, used by `cli.ts`, `list.ts`, and `adr.ts` to tell an unreadable path from
  a missing one.
- `docs/adr/0001-standalone-public-repository.md` — this repo's own first ADR.

## Read first

- The issue that specifies this build: [princess-pi/pawpie#1](https://github.com/princess-pi/pawpie/issues/1).
