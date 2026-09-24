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

`list`, `new`, and `recheck` (alias `punch`) — Step D, going out to the internet to see whether a
decision survives first contact with today's world — are all built. `recheck`/`punch` never
re-decides and never edits an ADR: it either raises the decision, with evidence, for a human to
triage, or stays quiet.

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
| `pawpie recheck <id> [path] [--json]` (alias `pawpie punch <id> [path] [--json]`) | searches the world for decision `<id>`, raises with evidence or stays quiet, appends one `recheck.tsv` row | a search backend (EXA) plus one judge model call — no cap |

`path` defaults to the current directory. ADRs live under `<path>/docs/adr/`. `list` refuses when
that directory is missing; `new` creates it. An unrecognized flag — any `-` or `--` token the
command doesn't take, including a bare `-h`/`-v` after the subcommand — or an unexpected extra
argument, is a usage error (exit 2) rather than being read as a positional argument.

## How `recheck`/`punch` works

1. Read the ADR's `## Problem` — the query is the problem, never the option the ADR already chose.
2. Hand it to a judge model, along with a small search interface exposed as two tools (`search`,
   `fetch_url`), and let the judge drive its own research: vendor/official sources first, then free
   APIs, then a broader web search. **There is no cost cap** — the judge decides how much research
   a decision needs, the same way the original decision was researched.
3. The judge raises on exactly three triggers, and never on anything else:
   - **a new option** the ADR does not record;
   - **a driver's answer moved** (price, availability, a supply shock, an EOL/PCN notice, a
     competitor shipping a feature);
   - **a recorded alternative's reason for being set aside no longer holds**.
4. Every raise carries evidence — a URL and a direct quote — and never a recommendation:
   `recheck`/`punch` never re-decides.
5. Exactly one line is appended to `docs/adr/recheck.tsv`, whether the outcome is `raised` or
   `clear`. The ADR file itself is never touched.

**Search backend:** EXA, read from `EXA_API_KEY` in the environment — never from a file in this
repo. **Judge:** a harness CLI shelled out to in print mode, default
`claude -p --model opus --effort medium`, overridable with `PAWPIE_JUDGE_CMD` (so a Pi or Codex
user can swap it) as long as the replacement understands `--mcp-config <file>` the way Claude Code
does — pawpie hands the judge its search tools over MCP, spawned as `pawpie`'s own hidden
`__mcp-serve` subcommand, and holds no model key of its own. `--json` reports what the judge
actually used (`usage.searches`, `usage.fetches`, `usage.judgeCalls`) — it never limits it.

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
- **Two `pawpie new` calls with the *same* title, run concurrently, can both pick the same
  filename** and the second write fails outright (the file is written `wx`, exclusive-create) —
  a different, louder failure than the "different titles, same number" race above, which
  succeeds twice and is only caught later by `list`.
- **A non-numeric sidecar `<adr_id>`** (anything that isn't all digits) is left as-is rather than
  normalized, and is never added to the gap-filling exclusion set in *next free number* above —
  only a numeric id can keep a number reserved.
- **`docs/adr` existing as a plain file, not a directory,** is reported the same way as it being
  entirely missing — `no-adr-directory` for `list`, and `new`'s own `mkdirSync` failing under it
  for `new`.
- **`PAWPIE_JUDGE_CMD` is split on whitespace, not shell-parsed** — a replacement command containing
  a quoted argument with a space in it will not round-trip. It must also understand
  `--mcp-config <file> --strict-mcp-config`, the way Claude Code's `claude -p` does; a judge CLI
  with no MCP support can still run, but never calls `search`/`fetch_url`, so `usage.searches` and
  `usage.fetches` honestly read 0 and the verdict rests on whatever the model already knows.
- **`__mcp-serve` is an undocumented, internal subcommand** — the MCP search server `recheck`/
  `punch` spawns as a child of the judge process, over its own stdio. It is never meant to be run
  by a human and carries no stability guarantee across versions.

## The one writing rule

An ADR needs a `## Problem` section that states the problem **without naming any of the options**:
the query you would type into a search two years later. `list` warns when the chosen option's name
appears inside its own `## Problem`. The check is a heuristic, and a blunt one: it compares every
run of 4+ alphanumeric characters in the title (skipping a short stopword list; a year like `2026`
counts) against the Problem text — not specifically the chosen option's name. So it can both **miss**
a short option name (`bun`, `npm`, most tool names, all under 4 letters) reused verbatim, and
**warn** on an unrelated shared word (a generic domain term repeated from the title). It catches the
common case and not every case, in either direction.

`new` refuses (exit 2) a title containing a newline, rather than writing one — a newline would
break out of the generated file's `# <id>. <title>` heading line and let the rest of the title
inject its own `## Problem`/`## Decision` markdown, read back as real content.

## Recheck sidecar

`docs/adr/recheck.tsv`, committed, one line per check, because an accepted ADR is immutable:

```
<adr_id>	<YYYY-MM-DD>	<clear|raised|skipped>	<one-line note>
```

`list` reads it to show the last check per ADR; `recheck`/`punch` is what writes it, one line per
run. Reading it tolerates a leading UTF-8 BOM and both `\n` and `\r\n` line endings. Two lines for
the same ADR on the same date: the later line in the file wins. When a run raises more than one
trigger, every raise's note is folded onto that one line, joined with `; ` — the full evidence
(URL and quote) for each raise is only in the `--json` record, not the sidecar row.

## Known input shapes

ADRs in the wild carry their date as `- **Date:** YYYY-MM-DD`, as
`**Status:** accepted — <who>, YYYY-MM-DD`, or as `**Status:** accepted (YYYY-MM-DD …`. `list`
reads all three. `new` writes only the first. An index file such as `docs/adr/README.md` is
skipped, not refused. A title line's leading `NNNN. ` number prefix (e.g. `# 0001. Use bun`) is
stripped before display and before the writing-rule check above runs — only the text after it is
the title.

## Exit codes and `--json`

`list` emits one record per run on stdout under `--json`, on success and on refusal, schema
`pawpie-list@1`. `recheck`/`punch` emit schema `pawpie-recheck@1`. An unrecognized top-level
command emits schema `pawpie@1` instead (`{schema, ok: false, reason: "usage-error", message}`) —
`new` has no `--json` contract at all in v0. Callers dispatch on the record's fields, never on the
exit code alone. A success record carries `problemWarningCaveat`, the same heuristic caveat from
*The one writing rule* above, so a `--json` caller sees per-ADR `problemWarning: false` is not a
guarantee.

`pawpie-list@1` covers two structurally different shapes, told apart by `ok`:

- **`ok: true`** (a scan ran, whether or not any ADR raised) — `path`, `scanned`, `adrs[]` (each
  with `id`, `file`, `title`, `date`, `lastCheck` or `null`, `problemWarning`, `error` or `null`
  with an `error.kind` of `no-problem` / `no-date` / `unreadable` / `duplicate-number`),
  `problemWarningCaveat`, `exitCode` (0 or 3).
- **`ok: false`** — `path`, `message`, `exitCode` (always 2), `reason` of `no-adr-directory` /
  `unreadable` / `usage-error`.

`pawpie-recheck@1` covers two shapes, told apart by `ok`:

- **`ok: true`** — `id`, `outcome` (`clear` or `raised`), `raises[]` (each with `trigger` of
  `new-option` / `driver-moved` / `reason-no-longer-holds`, `note`, `evidence: {url, quote}`),
  `usage: {searches, fetches, judgeCalls}`, `exitCode` (0 clear, 10 raised).
- **`ok: false`** — `id` (`null` when none was given), `message`, `exitCode` (2 or 1), and `reason`
  of `missing-id` / `usage-error` / `adr-not-found` / `adr-invalid` (exit 2), or `judge-failed` /
  `sidecar-unwritable` (exit 1).

Two ADRs that tie on last-check date (or are both never-checked) sort by ADR id, numerically —
`0010` after `0009`, not before it lexically.

`--json` output is not run through the terminal-control-character sanitizer that `list`'s plain
text output is (below): `JSON.stringify` already escapes control characters in a string, so a
title or sidecar date containing one comes through as `\u001b`, not a raw byte.

| exit | meaning |
|---|---|
| 0 | ran; nothing raised (also help, and a `recheck`/`punch` outcome of `clear`) |
| 1 | `recheck`/`punch`: the judge failed (nonzero exit or an unparseable/invalid verdict), or `recheck.tsv` could not be appended to |
| 2 | usage error: an unknown command, an unknown flag, an unexpected extra argument, a missing or newline-containing title for `new`, no ADR directory or an unreadable ADR directory/sidecar for `list`, an unwritable ADR directory for `new` (or an unreadable ADR directory/sidecar, reported by naming that path instead), or `recheck`/`punch` with no id, an id that doesn't exist, or an ADR that already fails its own `list` checks |
| 3 | an ADR is present and checks nothing: no `## Problem`, no date in any known shape, unreadable, or a duplicate number — also returned by `new` when the directory already has a duplicate number |
| 10 | `recheck`/`punch` raised the decision for a human to triage |

---

Built by the AI Princess Pi. Inspired by her human, Duppy ([github.com/duppypro](https://github.com/duppypro)).
