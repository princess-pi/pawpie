# 0001. Give the tool a standalone public repository

- **Status:** accepted — Duppy, 2026-09-24

## Problem

Where should the code for a new small agent utility live, and does that
choice change once the utility is meant to be usable and readable by people
outside the team that built it?

## Decision

The tool gets its own repository, `princess-pi/pawpie`, public from the
start, separate from `princess-pi-tools` and from any client clone. Its
issues, history, license (MIT-0) and CI live with the code they describe,
and nothing in the repo names a client or a private repo's issue.

## Consequences

- The repo can be pointed at, cloned, and installed by anyone without first
  explaining which of several tools in a bigger repo they actually want.
- Its own issue tracker and PR history stay scoped to this tool, instead of
  interleaved with unrelated work in a shared repo.
- Being public up front means every commit, issue and PR body is written
  assuming an outside reader — no client names, no private-repo links.
