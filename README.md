# pawpie

> "Plans are worthless, but planning is everything." — Dwight D. Eisenhower, November 1957
> ([Quote Investigator](https://quoteinvestigator.com/2017/11/18/planning/); he credited the idea
> to "a very successful soldier" in 1950)

Every recorded decision (an ADR: architecture, a part selection, a tool choice) was made against a
world that has since moved. pawpie keeps the **planning** alive after the **plan** is written. It
re-runs the problem each decision was solving against today's world, and **raises** the decision
for a human to triage when something may have changed. It never re-decides.

Modelled on the hardware-industry **BIT (Business Impact Triage)** meeting. A new fact arrives — a
new part, a supply shock, a new tool, a competitor shipping a feature — and the team triages its
business impact instead of re-litigating the original decision. Physical-world and supply-chain
change is in scope, not only software.

Origin and background: [duppypro/btw#106](https://github.com/duppypro/btw/issues/106).

## Status: v0

This is the scaffold plus `list` and `new`. `recheck` (alias `punch`) — going out to the internet
to see whether a decision survives first contact with today's world — is Step D, specified in its
own issue and not built yet. Both names exist today and refuse clearly instead of pretending to
work.

## Install

```
npx --yes @princess-pi/pawpie <command>
```

Or from a clone:

```
bun install
bun run build
node bin/pawpie.mjs <command>
```

## Commands

| Command | Does | Cost |
|---|---|---|
| `pawpie` | prints help, runs nothing | — |
| `pawpie list [path] [--json]` | every ADR with its date and last check, oldest check first, never-checked at the top | no network, no tokens |
| `pawpie new "<title>" [path]` | next free number, a template with `## Problem` and one date line | local |
| `pawpie recheck <id> [path]` (alias `pawpie punch <id>`) | not built yet — refuses, exit 2 | — |

`path` defaults to the current directory. ADRs live under `<path>/docs/adr/`.

## The one writing rule

An ADR needs a `## Problem` section that states the problem **without naming any of the options**:
the query you would type into a search two years later. `list` warns when the chosen option's name
appears inside its own `## Problem`. The check is a heuristic — it catches the common case, a title
word reused verbatim in the Problem section, and not every case.

## Recheck sidecar

`docs/adr/recheck.tsv`, committed, one line per check, because an accepted ADR is immutable:

```
<adr_id>	<YYYY-MM-DD>	<clear|raised|skipped>	<one-line note>
```

`list` reads it to show the last check per ADR; nothing writes it yet.

## Known input shapes

ADRs in the wild carry their date as `- **Date:** YYYY-MM-DD`, as
`**Status:** accepted — <who>, YYYY-MM-DD`, or as `**Status:** accepted (YYYY-MM-DD …`. `list`
reads all three. `new` writes only the first. An index file such as `docs/adr/README.md` is
skipped, not refused.

## Exit codes and `--json`

`list` emits one record per run on stdout under `--json`, on success and on refusal, schema
`pawpie-list@1`. `recheck`/`punch` emit schema `pawpie-recheck@1`. Callers dispatch on the record's
fields, never on the exit code alone.

| exit | meaning |
|---|---|
| 0 | ran; nothing raised (also help) |
| 1 | sidecar unwritable |
| 2 | usage error, no ADR directory, `recheck`/`punch` with no id |
| 3 | an ADR is present and checks nothing: no `## Problem`, no date in any known shape, unreadable, or a duplicate number |
| 10 | at least one ADR raised (Step D, not built yet) |

---

Built by the AI Princess Pi. Inspired by her human, Duppy ([github.com/duppypro](https://github.com/duppypro)).
