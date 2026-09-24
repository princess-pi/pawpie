import { spawnSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

export type Trigger = "new-option" | "driver-moved" | "reason-no-longer-holds";

export interface Raise {
  trigger: Trigger;
  note: string;
  evidence: { url: string; quote: string };
}

export interface JudgeVerdict {
  outcome: "raised" | "clear";
  raises: Raise[];
}

export interface JudgeUsage {
  searches: number;
  fetches: number;
  judgeCalls: number;
}

export interface JudgeResult {
  verdict: JudgeVerdict;
  usage: JudgeUsage;
}

export class JudgeError extends Error {}

export const DEFAULT_JUDGE_CMD = "claude -p --model opus --effort medium";

export function judgeCommand(env: NodeJS.ProcessEnv): string {
  return env.PAWPIE_JUDGE_CMD?.trim() || DEFAULT_JUDGE_CMD;
}

export function buildPrompt(adrId: string, adrContent: string): string {
  return `You are pawpie's judge. You re-triage ADR ${adrId} against today's world. \
Search fresh — your query is the problem stated below, never the option the ADR already chose. \
Work down a cost ladder: vendor/official sources, then free APIs, then a broader web search. \
Use the "search" and "fetch_url" tools as many times as you need; there is no cost cap.

Compare what you find against the ADR's prose: its alternatives, its drivers, and its reasons for \
setting options aside. The recorded alternatives are a floor, not a ceiling — an option that wins \
today may not have existed when the decision was made.

Raise on exactly three triggers, and only these three:
- "new-option": an option exists that the ADR does not record.
- "driver-moved": a driver's answer moved (price, availability, a supply shock, an EOL/PCN \
notice, a competitor shipping a feature).
- "reason-no-longer-holds": a recorded alternative's reason for being set aside no longer holds.

Never recommend a replacement decision — pawpie never re-decides. Every raise needs evidence: a \
URL and a direct quote backing it.

Reply with ONLY a JSON object (no prose, no markdown fence) matching exactly:
{"outcome": "raised" | "clear", "raises": [{"trigger": "new-option" | "driver-moved" | "reason-no-longer-holds", "note": "<one line>", "evidence": {"url": "<url>", "quote": "<direct quote>"}}]}
"raises" is empty when outcome is "clear".

--- ADR ${adrId} ---
${adrContent}
--- end ADR ---
`;
}

function extractJson(text: string): unknown {
  const start = text.indexOf("{");
  const end = text.lastIndexOf("}");
  if (start === -1 || end === -1 || end < start) {
    throw new JudgeError(`judge produced no JSON object: ${text.slice(0, 200)}`);
  }
  try {
    return JSON.parse(text.slice(start, end + 1));
  } catch (err) {
    throw new JudgeError(`judge produced unparseable JSON: ${(err as Error).message}`);
  }
}

const TRIGGERS: Trigger[] = ["new-option", "driver-moved", "reason-no-longer-holds"];

function validateVerdict(doc: unknown): JudgeVerdict {
  if (typeof doc !== "object" || doc === null) throw new JudgeError("judge verdict is not an object");
  const d = doc as Record<string, unknown>;
  if (d.outcome !== "raised" && d.outcome !== "clear") {
    throw new JudgeError(`judge verdict has invalid "outcome": ${JSON.stringify(d.outcome)}`);
  }
  const rawRaises = Array.isArray(d.raises) ? d.raises : [];
  const raises: Raise[] = rawRaises.map((r, i) => {
    if (typeof r !== "object" || r === null) throw new JudgeError(`raise[${i}] is not an object`);
    const raise = r as Record<string, unknown>;
    if (!TRIGGERS.includes(raise.trigger as Trigger)) {
      throw new JudgeError(`raise[${i}] has invalid "trigger": ${JSON.stringify(raise.trigger)}`);
    }
    const evidence = raise.evidence as Record<string, unknown> | undefined;
    if (!evidence || typeof evidence.url !== "string" || typeof evidence.quote !== "string") {
      throw new JudgeError(`raise[${i}] is missing evidence.url or evidence.quote`);
    }
    return {
      trigger: raise.trigger as Trigger,
      note: typeof raise.note === "string" ? raise.note : "",
      evidence: { url: evidence.url, quote: evidence.quote },
    };
  });
  if (d.outcome === "raised" && raises.length === 0) {
    throw new JudgeError('judge verdict says "raised" but carries no raises');
  }
  return { outcome: d.outcome, raises };
}

export interface JudgeOptions {
  env?: NodeJS.ProcessEnv;
  selfCommand?: string[]; // [execPath, scriptPath] used to spawn the MCP search server
  searchAdapterEnv?: Record<string, string>; // env for the spawned MCP server
}

export function runJudge(adrId: string, adrContent: string, opts: JudgeOptions = {}): JudgeResult {
  const env = opts.env ?? process.env;
  const cmd = judgeCommand(env);
  const [bin, ...cmdArgs] = cmd.split(/\s+/).filter(Boolean);
  if (!bin) throw new JudgeError("PAWPIE_JUDGE_CMD is empty");

  const selfCommand = opts.selfCommand ?? [process.execPath, process.argv[1] ?? ""];
  const workDir = fs.mkdtempSync(path.join(os.tmpdir(), "pawpie-judge-"));
  const countsFile = path.join(workDir, "counts.json");
  const mcpConfigFile = path.join(workDir, "mcp-config.json");

  fs.writeFileSync(
    mcpConfigFile,
    JSON.stringify({
      mcpServers: {
        pawpie: {
          command: selfCommand[0],
          args: [...selfCommand.slice(1), "__mcp-serve"],
          env: { ...(opts.searchAdapterEnv ?? {}), PAWPIE_MCP_COUNTS_FILE: countsFile },
        },
      },
    }),
  );

  const prompt = buildPrompt(adrId, adrContent);

  try {
    const child = spawnSync(bin, [...cmdArgs, "--mcp-config", mcpConfigFile, "--strict-mcp-config"], {
      env,
      input: prompt,
      encoding: "utf8",
      maxBuffer: 64 * 1024 * 1024,
    });
    if (child.error) throw new JudgeError(`judge command failed to start: ${child.error.message}`);
    if (child.status !== 0) {
      throw new JudgeError(`judge command exited ${child.status}: ${(child.stderr ?? "").slice(0, 500)}`);
    }
    const stdout = child.stdout ?? "";

    const verdict = validateVerdict(extractJson(stdout));

    let usage: JudgeUsage = { searches: 0, fetches: 0, judgeCalls: 1 };
    try {
      const counts = JSON.parse(fs.readFileSync(countsFile, "utf8")) as { searches: number; fetches: number };
      usage = { ...counts, judgeCalls: 1 };
    } catch {
      // The judge may have answered with no tool calls (or the MCP server
      // never started under a judge command with no MCP support) — usage
      // then honestly reports zero rather than failing the whole run over it.
    }

    return { verdict, usage };
  } finally {
    fs.rmSync(workDir, { recursive: true, force: true });
  }
}
