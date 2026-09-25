import { describe, expect, test } from "bun:test";
import * as path from "node:path";
import {
  UNFILLED_CLAIMS_PLACEHOLDER,
  UNFILLED_PROBLEM_PLACEHOLDER,
  extractClaimsSection,
  extractDate,
  nextFreeNumber,
  parseClaims,
  scanAdrDir,
} from "../src/adr.ts";
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

describe("## Claims parsing", () => {
  test("parses a taken and a not-taken claim, each with its source", () => {
    const claims = parseClaims(
      "- [taken] bun hardlinks packages from a global cache — https://bun.sh/docs/install/cache\n" +
        "- [not-taken] npm re-copies every package on install — https://docs.npmjs.com/cli/v10/commands/npm-install",
    );
    expect(claims).toEqual([
      { disposition: "taken", text: "bun hardlinks packages from a global cache", source: "https://bun.sh/docs/install/cache" },
      { disposition: "not-taken", text: "npm re-copies every package on install", source: "https://docs.npmjs.com/cli/v10/commands/npm-install" },
    ]);
  });

  test("a line that doesn't match the shape is skipped, not refused", () => {
    const claims = parseClaims("not a claim line at all\n- [taken] real claim — https://a\n");
    expect(claims).toHaveLength(1);
    expect(claims[0].text).toBe("real claim");
  });

  test("the unfilled placeholder line does not parse as a claim", () => {
    expect(parseClaims(UNFILLED_CLAIMS_PLACEHOLDER)).toHaveLength(0);
  });

  test("scanAdrDir marks claimsMissing when there is no ## Claims section", () => {
    const repo = makeTempRepo();
    writeAdrFile(repo, "0001-a.md", "# 0001. A\n\n- **Date:** 2026-01-01\n\n## Problem\n\nx\n");
    const { adrs } = scanAdrDir(adrDirOf(repo));
    expect(adrs[0].claimsMissing).toBe(true);
    expect(adrs[0].claims).toHaveLength(0);
  });

  test("scanAdrDir reads a populated ## Claims section and marks claimsMissing false", () => {
    const repo = makeTempRepo();
    writeAdrFile(
      repo,
      "0001-a.md",
      "# 0001. A\n\n- **Date:** 2026-01-01\n\n## Problem\n\nx\n\n## Claims\n\n- [taken] a claim — https://a\n",
    );
    const { adrs } = scanAdrDir(adrDirOf(repo));
    expect(adrs[0].claimsMissing).toBe(false);
    expect(adrs[0].claims).toEqual([{ disposition: "taken", text: "a claim", source: "https://a" }]);
  });

  test("extractClaimsSection stops at the next ## heading", () => {
    const text = extractClaimsSection("## Claims\n\n- [taken] x — y\n\n## Next\n\nunrelated\n");
    expect(text).toBe("- [taken] x — y");
  });
});
