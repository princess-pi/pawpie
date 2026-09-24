import { describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { runRecheck } from "../src/recheck.ts";
import { adrDirOf, makeTempRepo, writeAdrFile } from "./support.ts";

// A real MCP client standing in for the judge CLI in a test: it spawns the
// search server named in its own --mcp-config, calls the
// "search" tool once, and raises exactly when a fixture hit's title carries
// the marker below — proving the fixture adapter's results actually reach a
// judge process through the real MCP wiring, not just the verdict validator.
const RAISE_MARKER = "PAWPIE-TEST-NEW-OPTION";

function writeMcpClientJudge(dir: string): string {
  const scriptPath = path.join(dir, "mcp-client-judge.mjs");
  fs.writeFileSync(
    scriptPath,
    `
import { spawnSync } from "node:child_process";
import * as fs from "node:fs";

const configPath = process.argv[process.argv.indexOf("--mcp-config") + 1];
const config = JSON.parse(fs.readFileSync(configPath, "utf8"));
const server = config.mcpServers.pawpie;

const requests =
  '{"jsonrpc":"2.0","id":1,"method":"initialize"}\\n' +
  '{"jsonrpc":"2.0","id":2,"method":"tools/call","params":{"name":"search","arguments":{"query":"anything"}}}\\n';

const result = spawnSync(server.command, server.args, {
  env: { ...process.env, ...server.env },
  input: requests,
  encoding: "utf8",
});

const lines = result.stdout.trim().split("\\n").filter(Boolean).map((l) => JSON.parse(l));
const searchResponse = lines.find((l) => l.id === 2);
const hits = JSON.parse(searchResponse.result.content[0].text);
const raised = hits.some((h) => h.title.includes("${RAISE_MARKER}"));

const checkedClaims = [{ text: "bun hardlinks packages from a global cache", disposition: "taken" }];

const verdict = raised
  ? {
      outcome: "raised",
      raises: [
        {
          pass: 2,
          question: "new-options",
          note: "found via the real search tool",
          evidence: { source: hits[0].url, quote: hits[0].text },
        },
      ],
      extractedClaims: [],
      checkedClaims,
      unchecked: [],
    }
  : { outcome: "clear", raises: [], extractedClaims: [], checkedClaims, unchecked: [] };

process.stdout.write(JSON.stringify(verdict));
`,
    "utf8",
  );
  return scriptPath;
}

// Same real MCP wiring as writeMcpClientJudge, but its raise cites a quote
// that never appeared in anything the search tool actually returned — proves
// validateVerdict rejects fabricated evidence rather than trusting the
// judge's self-report.
function writeMcpClientJudgeFabricatingEvidence(dir: string): string {
  const scriptPath = path.join(dir, "mcp-client-judge-fabricating.mjs");
  fs.writeFileSync(
    scriptPath,
    `
import { spawnSync } from "node:child_process";
import * as fs from "node:fs";

const configPath = process.argv[process.argv.indexOf("--mcp-config") + 1];
const config = JSON.parse(fs.readFileSync(configPath, "utf8"));
const server = config.mcpServers.pawpie;

const requests =
  '{"jsonrpc":"2.0","id":1,"method":"initialize"}\\n' +
  '{"jsonrpc":"2.0","id":2,"method":"tools/call","params":{"name":"search","arguments":{"query":"anything"}}}\\n';

spawnSync(server.command, server.args, { env: { ...process.env, ...server.env }, input: requests, encoding: "utf8" });

const verdict = {
  outcome: "raised",
  raises: [
    {
      pass: 2,
      question: "new-options",
      note: "invented",
      evidence: { source: "https://example.com/found", quote: "this exact sentence was never returned by any search hit" },
    },
  ],
  extractedClaims: [],
  checkedClaims: [{ text: "bun hardlinks packages from a global cache", disposition: "taken" }],
  unchecked: [],
};

process.stdout.write(JSON.stringify(verdict));
`,
    "utf8",
  );
  return scriptPath;
}

function fixtureFile(dir: string, title: string): string {
  const fixturePath = path.join(dir, "fixture.json");
  fs.writeFileSync(
    fixturePath,
    JSON.stringify({ results: [{ title, url: "https://example.com/found", text: "the actual search hit text" }] }),
    "utf8",
  );
  return fixturePath;
}

describe("integration: fixture adapter -> real MCP server -> a judge that actually calls it", () => {
  test("a fixture search hit carrying the marker drives a real raise, with one sidecar row appended", () => {
    const workDir = fs.mkdtempSync(path.join(os.tmpdir(), "pawpie-integration-"));
    const judgeScript = writeMcpClientJudge(workDir);
    const fixture = fixtureFile(workDir, `Deno 3.0 ships — ${RAISE_MARKER}`);

    const repo = makeTempRepo();
    writeAdrFile(
      repo,
      "0001-use-bun.md",
      "# 0001. Use bun for the toolchain\n\n- **Date:** 2026-01-01\n\n## Problem\n\nwhich javascript package manager to standardize on\n\n## Decision\n\n## Claims\n\n- [taken] bun hardlinks packages from a global cache — https://bun.sh/docs/install/cache\n",
    );

    const result = runRecheck(repo, "0001", {
      env: { ...process.env, PAWPIE_JUDGE_CMD: `node ${judgeScript}`, PAWPIE_SEARCH_FIXTURE: fixture },
      // Under `bun test` there's no built bundle to be argv[1] — point the
      // MCP config's spawned server at this repo's own cli.ts source instead
      // of judge.ts's default (which assumes this process itself was
      // launched as the pawpie CLI, true only under the built bundle).
      selfCommand: [process.execPath, path.resolve(import.meta.dirname, "..", "src", "cli.ts")],
    });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.outcome).toBe("raised");
    expect(result.raises).toHaveLength(1);
    expect(result.raises[0].evidence.source).toBe("https://example.com/found");

    const rows = fs
      .readFileSync(path.join(adrDirOf(repo), "recheck.tsv"), "utf8")
      .trim()
      .split("\n");
    expect(rows).toHaveLength(1);
  });

  test("a fixture search hit with no marker drives a real 'clear' verdict", () => {
    const workDir = fs.mkdtempSync(path.join(os.tmpdir(), "pawpie-integration-"));
    const judgeScript = writeMcpClientJudge(workDir);
    const fixture = fixtureFile(workDir, "nothing interesting here");

    const repo = makeTempRepo();
    writeAdrFile(
      repo,
      "0001-use-bun.md",
      "# 0001. Use bun for the toolchain\n\n- **Date:** 2026-01-01\n\n## Problem\n\nwhich javascript package manager to standardize on\n\n## Decision\n\n## Claims\n\n- [taken] bun hardlinks packages from a global cache — https://bun.sh/docs/install/cache\n",
    );

    const result = runRecheck(repo, "0001", {
      env: { ...process.env, PAWPIE_JUDGE_CMD: `node ${judgeScript}`, PAWPIE_SEARCH_FIXTURE: fixture },
      selfCommand: [process.execPath, path.resolve(import.meta.dirname, "..", "src", "cli.ts")],
    });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.outcome).toBe("clear");
  });

  test("a raise quoting text no search call actually returned is rejected as judge-failed", () => {
    const workDir = fs.mkdtempSync(path.join(os.tmpdir(), "pawpie-integration-"));
    const judgeScript = writeMcpClientJudgeFabricatingEvidence(workDir);
    const fixture = fixtureFile(workDir, "nothing interesting here");

    const repo = makeTempRepo();
    writeAdrFile(
      repo,
      "0001-use-bun.md",
      "# 0001. Use bun for the toolchain\n\n- **Date:** 2026-01-01\n\n## Problem\n\nwhich javascript package manager to standardize on\n\n## Decision\n\n## Claims\n\n- [taken] bun hardlinks packages from a global cache — https://bun.sh/docs/install/cache\n",
    );

    const result = runRecheck(repo, "0001", {
      env: { ...process.env, PAWPIE_JUDGE_CMD: `node ${judgeScript}`, PAWPIE_SEARCH_FIXTURE: fixture },
      selfCommand: [process.execPath, path.resolve(import.meta.dirname, "..", "src", "cli.ts")],
    });

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.reason).toBe("judge-failed");
  });

  const bundle = path.resolve(import.meta.dirname, "..", "bin", "pawpie.mjs");
  // `bun run build` produces this; reported as skipped (not silently passed)
  // when the suite runs without a build having been done first — same
  // convention as cli.test.ts's own bundle-dependent test.
  test.skipIf(!fs.existsSync(bundle))("the built CLI's --json output round-trips the same real pipeline", () => {
    const workDir = fs.mkdtempSync(path.join(os.tmpdir(), "pawpie-integration-"));
    const judgeScript = writeMcpClientJudge(workDir);
    const fixture = fixtureFile(workDir, `${RAISE_MARKER} everywhere`);

    const repo = makeTempRepo();
    writeAdrFile(
      repo,
      "0001-use-bun.md",
      "# 0001. Use bun for the toolchain\n\n- **Date:** 2026-01-01\n\n## Problem\n\nwhich javascript package manager to standardize on\n\n## Decision\n\n## Claims\n\n- [taken] bun hardlinks packages from a global cache — https://bun.sh/docs/install/cache\n",
    );

    const proc = spawnSync("node", [bundle, "punch", "0001", repo, "--json"], {
      env: { ...process.env, PAWPIE_JUDGE_CMD: `node ${judgeScript}`, PAWPIE_SEARCH_FIXTURE: fixture },
      encoding: "utf8",
    });

    expect(proc.status).toBe(10);
    const doc = JSON.parse(proc.stdout);
    expect(doc.schema).toBe("pawpie-recheck@1");
    expect(doc.outcome).toBe("raised");
  });
});
