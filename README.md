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

Not on npm yet — install from a clone:

```
bun install
bun run build
node bin/pawpie.mjs <command>
```

Once published:

```
npx --yes @princess-pi/pawpie <command>
```

## Commands

| Command | Does | Cost |
|---|---|---|
| `pawpie` (also `--help` / `-h`) | prints help, runs nothing | — |
| `pawpie list [path] [--json]` | every ADR with its date and last check, oldest check first, never-checked at the top | no network, no tokens |
| `pawpie new "<title>" [path]` | next free number, a template with `## Problem` and one date line | local |
| `pawpie recheck <id> [path] [--json]` (alias `pawpie punch <id> [path] [--json]`) | not built yet — refuses, exit 2 | — |

`path` defaults to the current directory. ADRs live under `<path>/docs/adr/`. `list` refuses when
that directory is missing; `new` creates it. An unrecognized flag — any `-` or `--` token the
command doesn't take, including a bare `-h`/`-v` after the subcommand — or an unexpected extra
argument, is a usage error (exit 2) rather than being read as a positional argument.

## v0 known limits

- **"Next free number" fills gaps, including gaps the sidecar still remembers.** It is the lowest
  unused ADR number, not one past the highest — deleting `0002` and running `new` again reuses
  `0002`, unless `recheck.tsv` still has a line for `0002`, in which case that number stays
  excluded too (so a new decision never inherits an old one's recheck history) and `new` writes
  the next number after that instead.
- **The written template** has `## Problem` and a `- **Date:**` line, plus empty `## Decision` and
  `## Consequences` headings and a `- **Status:** proposed` line.
- **Scanning `docs/adr/` is flat, not recursive.** An ADR in a subdirectory is invisible to both
  `list` and `new`'s numbering.
- **`accepted` is matched case-sensitively** in the `**Status:** accepted …` date shapes below —
  `Accepted` (capital A) does not match and is treated as no date found.
- **Error precedence, when more than one applies to the same file:** a duplicate ADR number wins
  over any content error; between a missing `## Problem` and a missing date, the missing-`##
  Problem` error is reported.
- **A title with no letters or digits** (e.g. `"???"`) writes `NNNN-untitled.md` rather than
  refusing.
- **A malformed line in `recheck.tsv`** — fewer than four tab-separated columns, or an `outcome`
  outside `clear`/`raised`/`skipped` — is skipped rather than refused. Extra columns past the
  fourth are folded into the note, and the date column itself is not validated. A skipped line is
  invisible to the gap-filling exclusion above too: a malformed history line for `0002` does not
  keep `0002` excluded.
- **A sidecar `<adr_id>` is normalized** the same way a scanned file's id is: `4` and `00004` both
  match ADR `0004`.
- **`new` is not safe to run concurrently.** Two overlapping `pawpie new` calls can both compute
  the same free number and each write a distinct file under it, leaving a duplicate — `pawpie` does
  no file locking or atomic reservation in v0. `list` catches the result on its next run (a
  duplicate number is exit 3, naming both files), so the failure mode is a loud refusal on the next
  scan, not silent data loss. Fixing the race itself is out of scope for a tool meant to be run
  interactively, one command at a time.
- **An ADR number is a JS `Number`,** so a filename numbered above
  `Number.MAX_SAFE_INTEGER` (2^53 − 1) can collide with a different absurdly large number instead
  of being told apart. Not a concern at any number of ADRs a human writes by hand.

## The one writing rule

An ADR needs a `## Problem` section that states the problem **without naming any of the options**:
the query you would type into a search two years later. `list` warns when the chosen option's name
appears inside its own `## Problem`. The check is a heuristic, and a blunt one: it compares every
run of 4+ alphanumeric characters in the title (skipping a short stopword list; a year like `2026`
counts) against the Problem text — not specifically the chosen option's name. So it can both **miss**
a short option name (`bun`, `npm`, most tool names, all under 4 letters) reused verbatim, and
**warn** on an unrelated shared word (a generic domain term repeated from the title). It catches the
common case and not every case, in either direction.

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
fields, never on the exit code alone. A success record carries `problemWarningCaveat`, the same
heuristic caveat from *The one writing rule* above, so a `--json` caller sees per-ADR
`problemWarning: false` is not a guarantee.

| exit | meaning |
|---|---|
| 0 | ran; nothing raised (also help) |
| 1 | sidecar unwritable (reserved for `recheck`/`punch` — not reachable until Step D) |
| 2 | usage error: an unknown command, an unknown flag, an unexpected extra argument, a missing title for `new`, no ADR directory or an unreadable ADR directory/sidecar for `list`, an unwritable ADR directory for `new` (or an unreadable ADR directory/sidecar, reported by naming that path instead), or `recheck`/`punch` (always — id or not) |
| 3 | an ADR is present and checks nothing: no `## Problem`, no date in any known shape, unreadable, or a duplicate number — also returned by `new` when the directory already has a duplicate number |
| 10 | at least one ADR raised (Step D, not built yet) |

---

Built by the AI Princess Pi. Inspired by her human, Duppy ([github.com/duppypro](https://github.com/duppypro)).
