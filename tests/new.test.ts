import { describe, expect, test } from "bun:test";
import * as fs from "node:fs";
import * as path from "node:path";
import { createAdr } from "../src/new.ts";
import { buildListResult } from "../src/list.ts";
import { makeTempRepo, writeAdrFile } from "./support.ts";

describe("pawpie new", () => {
  test("writes the next number on a clean directory, and list accepts it with no warning", () => {
    const repo = makeTempRepo();

    const result = createAdr(repo, "Adopt a re-triage tool");

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.id).toBe("0001");
    expect(result.file).toBe("0001-adopt-a-re-triage-tool.md");

    const content = fs.readFileSync(path.join(repo, "docs", "adr", result.file), "utf8");
    expect(content).toContain("## Problem");
    expect(content).toMatch(/-\s*\*\*Date:\*\*\s*\d{4}-\d{2}-\d{2}/);

    const listed = buildListResult(repo);
    expect(listed.exitCode).toBe(0);
    expect(listed.adrs[0].problemWarning).toBe(false);
  });

  test("refuses rather than writing 0003 when a duplicate number is present", () => {
    const repo = makeTempRepo();
    writeAdrFile(repo, "0001-a.md", "# 0001. A\n\n- **Date:** 2026-01-01\n\n## Problem\n\nx\n");
    writeAdrFile(repo, "0002-b.md", "# 0002. B\n\n- **Date:** 2026-01-02\n\n## Problem\n\ny\n");
    writeAdrFile(repo, "0002-c.md", "# 0002. C\n\n- **Date:** 2026-01-03\n\n## Problem\n\nz\n");

    const result = createAdr(repo, "Should not be written");

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.kind).toBe("duplicate-number");

    const files = fs.readdirSync(path.join(repo, "docs", "adr"));
    expect(files.some((f) => f.startsWith("0003"))).toBe(false);
  });

  test("finds the next free number after existing ADRs", () => {
    const repo = makeTempRepo();
    writeAdrFile(repo, "0001-a.md", "# 0001. A\n\n- **Date:** 2026-01-01\n\n## Problem\n\nx\n");

    const result = createAdr(repo, "Second decision");

    expect(result.ok).toBe(true);
    if (result.ok) expect(result.id).toBe("0002");
  });
});
