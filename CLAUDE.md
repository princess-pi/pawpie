# pawpie

Re-triage decision records (ADRs) when the world moves. Public, `@princess-pi/pawpie`, not on npm
yet. Origin: [duppypro/btw#106](https://github.com/duppypro/btw/issues/106).

This repo is **public**. No client names, no private-repo issue links, no internal repo details —
[duppypro/btw#106](https://github.com/duppypro/btw/issues/106) and
[quoteinvestigator.com](https://quoteinvestigator.com/2017/11/18/planning/) are the only outside
links this repo carries.

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
  since a published package ships prebuilt output and never requires bun at the consumer end.
- **Step D (`recheck`/`punch`) is out of scope for v0.** Both names exist and refuse, exit 2 —
  "requires an ADR id" with none given, "not built yet" once one is — see `src/recheck.ts`. It is
  specified in its own issue.

## Stack

- Bun + TypeScript, bundled with `bun build` to a single `bin/pawpie.mjs` that runs on stock node.
- Typecheck with TypeScript 7's native compiler (`tsc --noEmit`).
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
- `src/adr.ts` — scans `docs/adr/`, parses dates in the three known shapes, detects a missing
  `## Problem`, a missing date, and duplicate ADR numbers.
- `src/sidecar.ts` — reads `docs/adr/recheck.tsv` (nothing writes it yet).
- `src/list.ts` — `pawpie list`: builds and sorts the `pawpie-list@1` record.
- `src/new.ts` — `pawpie new`: next free ADR number, writes the template.
- `src/recheck.ts` — `pawpie recheck`/`pawpie punch`: refusal only (Step D).
- `docs/adr/0001-standalone-public-repository.md` — this repo's own first ADR.

## Read first

- The issue that specifies this build: [princess-pi/pawpie#1](https://github.com/princess-pi/pawpie/issues/1).
