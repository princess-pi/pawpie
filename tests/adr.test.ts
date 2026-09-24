import { describe, expect, test } from "bun:test";
import * as path from "node:path";
import { UNFILLED_PROBLEM_PLACEHOLDER, extractDate, nextFreeNumber, scanAdrDir } from "../src/adr.ts";
import { ReadFailure, errorCode } from "../src/errors.ts";
import { adrDirOf, makeTempRepo, writeAdrFile, writeSidecar } from "./support.ts";

describe("scanAdrDir", () => {
  test("an empty ## Problem section is treated the same as a missing one, with a distinct message", () => {
    const repo = makeTempRepo();
    writeAdrFile(
      repo,
      "0001-empty.md",
      "# 0001. Empty\n\n- **Date:** 2026-01-01\n\n## Problem\n\n## Decision\n",
    );
    const { adrs } = scanAdrDir(adrDirOf(repo));
    expect(adrs[0].error?.kind).toBe("no-problem");
    expect(adrs[0].error?.message).toContain("empty");
  });

  test("a missing ## Problem heading gets a different message than an empty one", () => {
    const repo = makeTempRepo();
    writeAdrFile(repo, "0001-none.md", "# 0001. None\n\n- **Date:** 2026-01-01\n\n## Decision\n");
    const { adrs } = scanAdrDir(adrDirOf(repo));
    expect(adrs[0].error?.message).not.toContain("empty");
  });

  test("propagates a missing directory instead of silently reporting an empty scan", () => {
    const repo = makeTempRepo();
    expect(() => scanAdrDir(path.join(repo, "docs", "adr"))).toThrow();
  });

  test("the unfilled template placeholder does not trigger the chosen-option warning", () => {
    const repo = makeTempRepo();
    writeAdrFile(
      repo,
      "0001-search.md",
      `# 0001. Search providers\n\n- **Date:** 2026-01-01\n\n## Problem\n\n${UNFILLED_PROBLEM_PLACEHOLDER}\n\n## Decision\n`,
    );
    const { adrs } = scanAdrDir(adrDirOf(repo));
    expect(adrs[0].problemWarning).toBe(false);
  });

  test("a non-numbered .md file (not README) is skipped, not scanned as a broken ADR", () => {
    const repo = makeTempRepo();
    writeAdrFile(repo, "template.md", "not an ADR at all");
    const { adrs, scanned } = scanAdrDir(adrDirOf(repo));
    expect(scanned).toBe(0);
    expect(adrs).toHaveLength(0);
  });
});

describe("extractDate — Status shape 2", () => {
  test("matches even when <who> itself contains a comma", () => {
    const date = extractDate("**Status:** accepted — Duppy, Princess Pi, 2026-09-24\n");
    expect(date).toBe("2026-09-24");
  });

  test("matches an en dash, not just an em dash or hyphen", () => {
    expect(extractDate("**Status:** accepted – Duppy, 2026-09-24\n")).toBe("2026-09-24");
  });
});

describe("nextFreeNumber", () => {
  test("does not reuse a number the sidecar still has recheck history for", () => {
    const repo = makeTempRepo();
    writeAdrFile(repo, "0001-a.md", "# 0001. A\n\n- **Date:** 2026-01-01\n\n## Problem\n\nx\n");
    // 0002 was deleted, but its recheck history remains (append-only sidecar).
    writeSidecar(repo, ["0002\t2026-01-01\tclear\told decision, now gone"]);

    expect(nextFreeNumber(adrDirOf(repo))).toBe(3);
  });

  test("propagates a missing directory as a ReadFailure naming that path", () => {
    const repo = makeTempRepo();
    const adrDir = adrDirOf(repo);
    try {
      nextFreeNumber(adrDir);
      throw new Error("expected nextFreeNumber to throw");
    } catch (err) {
      expect(err).toBeInstanceOf(ReadFailure);
      expect((err as ReadFailure).failedPath).toBe(adrDir);
      expect(errorCode(err)).toBe("ENOENT");
    }
  });
});
