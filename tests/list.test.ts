import { describe, expect, test } from "bun:test";
import { buildListResult } from "../src/list.ts";
import { makeTempRepo, writeAdrFile, writeSidecar } from "./support.ts";

const ADR_DATE_SHAPE_1 = `# 0001. Use bun for the toolchain

- **Date:** 2026-01-05

## Problem

which javascript package manager and bundler to standardize on for internal tools

## Decision

## Consequences
`;

const ADR_DATE_SHAPE_2 = `# 0002. Ship as a single bundled binary

**Status:** accepted — Duppy, 2026-02-10

## Problem

how should a published cli run on a machine with no matching runtime installed

## Decision
`;

const ADR_DATE_SHAPE_3 = `# 0003. Record decisions per repo

**Status:** accepted (2026-03-01, revisited 2026-04-01)

## Problem

where should a re-triage record for a repo-scoped decision live

## Decision
`;

describe("pawpie list", () => {
  test("emits one record per ADR with each date shape parsed, README skipped", () => {
    const repo = makeTempRepo();
    writeAdrFile(repo, "0001-bun-toolchain.md", ADR_DATE_SHAPE_1);
    writeAdrFile(repo, "0002-single-binary.md", ADR_DATE_SHAPE_2);
    writeAdrFile(repo, "0003-per-repo.md", ADR_DATE_SHAPE_3);
    writeAdrFile(repo, "README.md", "# ADR index\n\nSee individual files.\n");

    const result = buildListResult(repo);

    expect(result.schema).toBe("pawpie-list@1");
    expect(result.scanned).toBe(3);
    expect(result.adrs).toHaveLength(3);
    expect(result.exitCode).toBe(0);

    const byId = Object.fromEntries(result.adrs.map((a) => [a.id, a]));
    expect(byId["0001"].date).toBe("2026-01-05");
    expect(byId["0002"].date).toBe("2026-02-10");
    expect(byId["0003"].date).toBe("2026-03-01");
  });

  test("an ADR with no ## Problem section gives exit 3, naming the file", () => {
    const repo = makeTempRepo();
    writeAdrFile(repo, "0001-no-problem.md", "# 0001. Missing a problem\n\n- **Date:** 2026-01-01\n\n## Decision\n");

    const result = buildListResult(repo);

    expect(result.exitCode).toBe(3);
    const adr = result.adrs[0];
    expect(adr.error?.kind).toBe("no-problem");
    expect(adr.error?.message).toContain("0001-no-problem.md");
  });

  test("an ADR with no date in any known shape gives exit 3", () => {
    const repo = makeTempRepo();
    writeAdrFile(
      repo,
      "0001-no-date.md",
      "# 0001. Missing a date\n\n## Problem\n\nsome problem\n\n## Decision\n",
    );

    const result = buildListResult(repo);

    expect(result.exitCode).toBe(3);
    expect(result.adrs[0].error?.kind).toBe("no-date");
  });

  test("a duplicate ADR number gives exit 3", () => {
    const repo = makeTempRepo();
    writeAdrFile(repo, "0001-first.md", ADR_DATE_SHAPE_1);
    writeAdrFile(repo, "0001-second.md", ADR_DATE_SHAPE_1);

    const result = buildListResult(repo);

    expect(result.exitCode).toBe(3);
    expect(result.adrs.every((a) => a.error?.kind === "duplicate-number")).toBe(true);
  });

  test("the chosen option inside ## Problem warns and leaves the exit code unchanged", () => {
    const repo = makeTempRepo();
    writeAdrFile(
      repo,
      "0001-use-bun.md",
      "# 0001. Use bun for the toolchain\n\n- **Date:** 2026-01-01\n\n## Problem\n\nshould we use bun for the toolchain\n\n## Decision\n",
    );

    const result = buildListResult(repo);

    expect(result.exitCode).toBe(0);
    expect(result.adrs[0].problemWarning).toBe(true);
  });

  test("order: never-checked sorts above checked, older check sorts above newer", () => {
    const repo = makeTempRepo();
    writeAdrFile(repo, "0001-a.md", ADR_DATE_SHAPE_1);
    writeAdrFile(repo, "0002-b.md", ADR_DATE_SHAPE_2);
    writeAdrFile(repo, "0003-c.md", ADR_DATE_SHAPE_3);
    writeSidecar(repo, [
      "0002\t2026-05-01\tclear\tstill holds",
      "0003\t2026-01-01\tclear\tstill holds",
    ]);

    const result = buildListResult(repo);
    const order = result.adrs.map((a) => a.id);

    expect(order).toEqual(["0001", "0003", "0002"]);
  });
});
