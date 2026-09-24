import { describe, expect, test } from "bun:test";
import { run } from "../src/cli.ts";
import { captured, makeTempRepo, writeAdrFile } from "./support.ts";

describe("pawpie cli", () => {
  test("no args prints help, exit 0", () => {
    const c = captured();
    const code = run([], c.stdout, c.stderr);
    expect(code).toBe(0);
    expect(c.out.join("\n")).toContain("pawpie");
  });

  test("unknown command is a usage error, exit 2", () => {
    const c = captured();
    const code = run(["frobnicate"], c.stdout, c.stderr);
    expect(code).toBe(2);
  });

  test("list with no ADR directory is a usage error, exit 2", () => {
    const repo = makeTempRepo();
    const c = captured();
    const code = run(["list", repo], c.stdout, c.stderr);
    expect(code).toBe(2);
  });

  test("list --json on a populated repo exits 0", () => {
    const repo = makeTempRepo();
    writeAdrFile(repo, "0001-a.md", "# 0001. A\n\n- **Date:** 2026-01-01\n\n## Problem\n\nx\n");
    const c = captured();
    const code = run(["list", repo, "--json"], c.stdout, c.stderr);
    expect(code).toBe(0);
    const doc = JSON.parse(c.out[0]);
    expect(doc.schema).toBe("pawpie-list@1");
    expect(doc.scanned).toBe(1);
  });

  test("new with no title is a usage error, exit 2", () => {
    const repo = makeTempRepo();
    const c = captured();
    const code = run(["new", "", repo], c.stdout, c.stderr);
    expect(code).toBe(2);
  });

  test("new writes an ADR that list then accepts", () => {
    const repo = makeTempRepo();
    const c1 = captured();
    expect(run(["new", "First decision", repo], c1.stdout, c1.stderr)).toBe(0);

    const c2 = captured();
    expect(run(["list", repo], c2.stdout, c2.stderr)).toBe(0);
  });

  for (const name of ["recheck", "punch"]) {
    test(`${name} with no id refuses, exit 2`, () => {
      const c = captured();
      const code = run([name], c.stdout, c.stderr);
      expect(code).toBe(2);
    });

    test(`${name} with an id still refuses (not built yet), exit 2`, () => {
      const c = captured();
      const code = run([name, "0001"], c.stdout, c.stderr);
      expect(code).toBe(2);
      expect(c.err.join("\n")).toContain("not built yet");
    });
  }
});
