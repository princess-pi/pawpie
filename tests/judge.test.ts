import { describe, expect, test } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { DEFAULT_JUDGE_TIMEOUT_MS, JudgeError, runJudge } from "../src/judge.ts";

// True once `pid` has exited (a zombie awaiting reaping counts as exited),
// polling briefly since a SIGKILLed process can take a moment to go.
function isGone(pid: number): boolean {
  const deadline = Date.now() + 2000;
  while (Date.now() < deadline) {
    try {
      process.kill(pid, 0);
    } catch {
      return true;
    }
    try {
      if (/^\d+ \(.*\) Z/.test(fs.readFileSync(`/proc/${pid}/stat`, "utf8"))) return true;
    } catch {
      return true;
    }
    Bun.sleepSync(50);
  }
  return false;
}

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

  test("a judge that ignores SIGTERM is escalated to SIGKILL after the grace period", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "pawpie-stubborn-judge-"));
    const scriptPath = path.join(dir, "stubborn.mjs");
    fs.writeFileSync(scriptPath, 'process.on("SIGTERM", () => {});\nsetInterval(() => {}, 1000);\n', "utf8");
    const env = { ...process.env, PAWPIE_JUDGE_CMD: `node ${scriptPath}` };

    const started = Date.now();
    let threw: unknown;
    try {
      runJudge("0001", "# 0001. Some ADR\n", { env, timeoutMs: 300, killGraceMs: 300 });
    } catch (err) {
      threw = err;
    }
    expect(Date.now() - started).toBeLessThan(10_000);
    expect(threw).toBeInstanceOf(JudgeError);
    expect((threw as JudgeError).message).toMatch(/timeout/i);
    expect((threw as JudgeError).message).toMatch(/SIGKILL/);
  });

  test("a judge that overflows its output buffer is killed, not left running after runJudge fails", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "pawpie-flooding-judge-"));
    const scriptPath = path.join(dir, "flood.cjs");
    const pidFile = path.join(dir, "judge.pid");
    fs.writeFileSync(
      scriptPath,
      `require("node:fs").writeFileSync(${JSON.stringify(pidFile)}, String(process.pid));\n` +
        'process.stdout.write("x".repeat(4096));\nsetInterval(() => {}, 1000);\n',
      "utf8",
    );
    const env = { ...process.env, PAWPIE_JUDGE_CMD: `node ${scriptPath}` };

    let threw: unknown;
    try {
      runJudge("0001", "# 0001. Some ADR\n", { env, timeoutMs: 60_000, maxBuffer: 1024 });
    } catch (err) {
      threw = err;
    }
    expect(threw).toBeInstanceOf(JudgeError);
    const pid = Number(fs.readFileSync(pidFile, "utf8"));
    expect(isGone(pid)).toBe(true);
  });

  test("a judge killed by a signal before its timeout is not reported as a timeout", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "pawpie-signalled-judge-"));
    const scriptPath = path.join(dir, "signalled.mjs");
    fs.writeFileSync(scriptPath, 'process.kill(process.pid, "SIGKILL");\n', "utf8");
    const env = { ...process.env, PAWPIE_JUDGE_CMD: `node ${scriptPath}` };

    let threw: unknown;
    try {
      runJudge("0001", "# 0001. Some ADR\n", { env, timeoutMs: 60_000 });
    } catch (err) {
      threw = err;
    }
    expect(threw).toBeInstanceOf(JudgeError);
    expect((threw as JudgeError).message).toMatch(/SIGKILL/);
    expect((threw as JudgeError).message).not.toMatch(/timeout/i);
  });

  test("a judge command that cannot start is reported as failing to start", () => {
    const env = { ...process.env, PAWPIE_JUDGE_CMD: "pawpie-no-such-judge-binary" };
    let threw: unknown;
    try {
      runJudge("0001", "# 0001. Some ADR\n", { env, timeoutMs: 60_000 });
    } catch (err) {
      threw = err;
    }
    expect(threw).toBeInstanceOf(JudgeError);
    expect((threw as JudgeError).message).toMatch(/failed to start/);
  });

  test("a judge that exits non-zero is reported with its exit code and stderr", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "pawpie-failing-judge-"));
    const scriptPath = path.join(dir, "fail.mjs");
    fs.writeFileSync(scriptPath, 'process.stderr.write("boom");\nprocess.exit(3);\n', "utf8");
    const env = { ...process.env, PAWPIE_JUDGE_CMD: `node ${scriptPath}` };
    let threw: unknown;
    try {
      runJudge("0001", "# 0001. Some ADR\n", { env, timeoutMs: 60_000 });
    } catch (err) {
      threw = err;
    }
    expect(threw).toBeInstanceOf(JudgeError);
    expect((threw as JudgeError).message).toBe("judge command exited 3: boom");
  });
});

describe("runJudge — default timeout", () => {
  test("a judge is given 22 minutes before it is killed, long enough for a deep reasoning search", () => {
    expect(DEFAULT_JUDGE_TIMEOUT_MS).toBe(22 * 60 * 1000);
  });
});
