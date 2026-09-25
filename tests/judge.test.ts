import { describe, expect, test } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { DEFAULT_JUDGE_TIMEOUT_MS, JudgeError, runJudge } from "../src/judge.ts";

describe("runJudge — a stalled judge process must not hang forever", () => {
  test("a judge command that never exits is killed and reported as a timeout, not an indefinite hang", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "pawpie-stalled-judge-"));
    const scriptPath = path.join(dir, "stall.mjs");
    fs.writeFileSync(scriptPath, "setInterval(() => {}, 1000);\n", "utf8");
    const env = { ...process.env, PAWPIE_JUDGE_CMD: `node ${scriptPath}` };

    let threw: unknown;
    try {
      runJudge("0001", "# 0001. Some ADR\n", { env, timeoutMs: 200 });
    } catch (err) {
      threw = err;
    }
    expect(threw).toBeInstanceOf(JudgeError);
    expect((threw as JudgeError).message).toMatch(/timeout/i);
  });
});

describe("runJudge — default timeout", () => {
  test("a judge is given 22 minutes before it is killed, long enough for a deep reasoning search", () => {
    expect(DEFAULT_JUDGE_TIMEOUT_MS).toBe(22 * 60 * 1000);
  });
});
