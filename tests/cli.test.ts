import { describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { run } from "../src/cli.ts";
import { captured, makeTempRepo, writeAdrFile, writeSidecar } from "./support.ts";

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

  test("an unknown command with --json still emits a JSON record on stdout", () => {
    const c = captured();
    const code = run(["frobnicate", "--json"], c.stdout, c.stderr);
    expect(code).toBe(2);
    const doc = JSON.parse(c.out[0]);
    expect(doc.schema).toBe("pawpie@1");
    expect(doc.ok).toBe(false);
    expect(doc.reason).toBe("usage-error");
  });

  test("an unexpected extra argument is a usage error, exit 2, for list/new/recheck", () => {
    const repo = makeTempRepo();
    writeAdrFile(repo, "0001-a.md", "# 0001. A\n\n- **Date:** 2026-01-01\n\n## Problem\n\nx\n");

    for (const args of [
      ["list", repo, "extra"],
      ["new", "title", repo, "extra"],
      ["recheck", "0001", repo, "extra"],
    ]) {
      const c = captured();
      expect(run(args, c.stdout, c.stderr)).toBe(2);
    }
  });

  test("list with no ADR directory is a usage error, exit 2", () => {
    const repo = makeTempRepo();
    const c = captured();
    const code = run(["list", repo], c.stdout, c.stderr);
    expect(code).toBe(2);
  });

  test("list --json with no ADR directory emits a JSON refusal record, not just stderr", () => {
    const repo = makeTempRepo();
    const c = captured();
    const code = run(["list", repo, "--json"], c.stdout, c.stderr);
    expect(code).toBe(2);
    expect(c.out).toHaveLength(1);
    const doc = JSON.parse(c.out[0]);
    expect(doc.schema).toBe("pawpie-list@1");
    expect(doc.ok).toBe(false);
    expect(doc.reason).toBe("no-adr-directory");
  });

  test("an unknown flag is a usage error, exit 2, for list/new/recheck", () => {
    const repo = makeTempRepo();
    writeAdrFile(repo, "0001-a.md", "# 0001. A\n\n- **Date:** 2026-01-01\n\n## Problem\n\nx\n");

    for (const args of [["list", repo, "--bogus"], ["new", "title", repo, "--bogus"], ["recheck", "0001", "--bogus"]]) {
      const c = captured();
      expect(run(args, c.stdout, c.stderr)).toBe(2);
    }
  });

  // root bypasses permission bits.
  const isRoot = process.getuid !== undefined && process.getuid() === 0;

  test.skipIf(isRoot)("an unreadable ADR directory is a distinct refusal, not a silent empty list", () => {
    const repo = makeTempRepo();
    writeAdrFile(repo, "0001-a.md", "# 0001. A\n\n- **Date:** 2026-01-01\n\n## Problem\n\nx\n");
    const adrDir = path.join(repo, "docs", "adr");
    fs.chmodSync(adrDir, 0o000);

    const c = captured();
    const code = run(["list", repo, "--json"], c.stdout, c.stderr);

    fs.chmodSync(adrDir, 0o755);

    expect(code).toBe(2);
    const doc = JSON.parse(c.out[0]);
    expect(doc.reason).toBe("unreadable");
  });

  test("list --json --bogus emits a JSON usage-error record on stdout", () => {
    const c = captured();
    const code = run(["list", ".", "--bogus", "--json"], c.stdout, c.stderr);
    expect(code).toBe(2);
    const doc = JSON.parse(c.out[0]);
    expect(doc.schema).toBe("pawpie-list@1");
    expect(doc.ok).toBe(false);
    expect(doc.reason).toBe("usage-error");
  });

  test("recheck --json --bogus emits a JSON usage-error record on stdout", () => {
    const c = captured();
    const code = run(["recheck", "0001", "--bogus", "--json"], c.stdout, c.stderr);
    expect(code).toBe(2);
    const doc = JSON.parse(c.out[0]);
    expect(doc.schema).toBe("pawpie-recheck@1");
    expect(doc.reason).toBe("usage-error");
  });

  test.skipIf(isRoot)("a sidecar read failure names recheck.tsv, not the ADR directory", () => {
    const repo = makeTempRepo();
    writeAdrFile(repo, "0001-a.md", "# 0001. A\n\n- **Date:** 2026-01-01\n\n## Problem\n\nx\n");
    writeSidecar(repo, ["0001\t2026-01-01\tclear\tok"]);
    const sidecarPath = path.join(repo, "docs", "adr", "recheck.tsv");
    fs.chmodSync(sidecarPath, 0o000);

    const c = captured();
    const code = run(["list", repo, "--json"], c.stdout, c.stderr);

    fs.chmodSync(sidecarPath, 0o644);

    expect(code).toBe(2);
    const doc = JSON.parse(c.out[0]);
    expect(doc.message).toContain("recheck.tsv");
  });

  test.skipIf(isRoot)("an inaccessible parent directory is 'unreadable', not 'no ADR directory'", () => {
    const repo = makeTempRepo();
    writeAdrFile(repo, "0001-a.md", "# 0001. A\n\n- **Date:** 2026-01-01\n\n## Problem\n\nx\n");
    const docsDir = path.join(repo, "docs");
    fs.chmodSync(docsDir, 0o000);

    const c = captured();
    const code = run(["list", repo, "--json"], c.stdout, c.stderr);

    fs.chmodSync(docsDir, 0o755);

    expect(code).toBe(2);
    const doc = JSON.parse(c.out[0]);
    expect(doc.reason).toBe("unreadable");
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

  test("new with a newline-containing title is a usage error, exit 2", () => {
    const repo = makeTempRepo();
    const c = captured();
    const code = run(["new", "Title\n## Problem\n\ninjected", repo], c.stdout, c.stderr);
    expect(code).toBe(2);
  });

  test("new writes an ADR that list then accepts", () => {
    const repo = makeTempRepo();
    const c1 = captured();
    expect(run(["new", "First decision", repo], c1.stdout, c1.stderr)).toBe(0);

    const c2 = captured();
    expect(run(["list", repo], c2.stdout, c2.stderr)).toBe(0);
  });

  test("new reports the path it actually wrote to, not a hardcoded docs/adr/", () => {
    const repo = makeTempRepo();
    const c = captured();
    run(["new", "A title", repo], c.stdout, c.stderr);
    expect(c.out[0]).toBe(`created ${path.join(repo, "docs", "adr", "0001-a-title.md")}`);
  });

  test("new rejects --json as an unknown flag rather than silently accepting it", () => {
    const repo = makeTempRepo();
    const c = captured();
    const code = run(["new", "A title", repo, "--json"], c.stdout, c.stderr);
    expect(code).toBe(2);
  });

  test("new's filesystem errors are caught, not thrown as a crash", () => {
    const repo = makeTempRepo();
    // Put a plain FILE where docs/adr needs to be a directory, so mkdir fails.
    fs.mkdirSync(path.join(repo, "docs"));
    fs.writeFileSync(path.join(repo, "docs", "adr"), "not a directory");

    const c = captured();
    const code = run(["new", "A title", repo], c.stdout, c.stderr);
    expect(code).toBe(2);
    expect(c.err.join("\n")).toContain("could not write");
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

  const bundle = path.resolve(import.meta.dirname, "..", "bin", "pawpie.mjs");
  // `bun run build` produces this; reported as skipped (not silently passed)
  // when the suite runs without a build having been done first.
  test.skipIf(!fs.existsSync(bundle))(
    "running the built bundle through a symlink (npm's bin layout) still runs the CLI",
    () => {
      const linkDir = fs.mkdtempSync(path.join(os.tmpdir(), "pawpie-symlink-"));
      const link = path.join(linkDir, "pawpie");
      fs.symlinkSync(bundle, link);

      // `process.execPath` under `bun test` is bun itself, so it would not
      // reproduce a Node-specific argv[1]-vs-import.meta.url symlink defect.
      const result = spawnSync("node", [link, "--help"], { encoding: "utf8" });

      expect(result.status).toBe(0);
      expect(result.stdout).toContain("pawpie");
    },
  );
});
