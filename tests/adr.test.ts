import { describe, expect, test } from "bun:test";
import { UNFILLED_PROBLEM_PLACEHOLDER, nextFreeNumber, scanAdrDir } from "../src/adr.ts";
import { adrDirOf, makeTempRepo, writeAdrFile, writeSidecar } from "./support.ts";

describe("scanAdrDir", () => {
  test("an empty ## Problem section is treated the same as a missing one", () => {
    const repo = makeTempRepo();
    writeAdrFile(
      repo,
      "0001-empty.md",
      "# 0001. Empty\n\n- **Date:** 2026-01-01\n\n## Problem\n\n## Decision\n",
    );
    const { adrs } = scanAdrDir(adrDirOf(repo));
    expect(adrs[0].error?.kind).toBe("no-problem");
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

describe("nextFreeNumber", () => {
  test("does not reuse a number the sidecar still has recheck history for", () => {
    const repo = makeTempRepo();
    writeAdrFile(repo, "0001-a.md", "# 0001. A\n\n- **Date:** 2026-01-01\n\n## Problem\n\nx\n");
    // 0002 was deleted, but its recheck history remains (append-only sidecar).
    writeSidecar(repo, ["0002\t2026-01-01\tclear\told decision, now gone"]);

    expect(nextFreeNumber(adrDirOf(repo))).toBe(3);
  });
});
