import { spawnSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import type { Claim } from "./adr.ts";

export type Disposition = "taken" | "not-taken";

// The four questions pass 2 asks about the ADR's original ## Problem,
// independent of the recorded claim list.
export type Question = "new-options" | "changed-capabilities" | "new-make-abilities" | "changed-spec";

export const QUESTIONS: Question[] = [
  "new-options",
  "changed-capabilities",
  "new-make-abilities",
  "changed-spec",
];

export interface ClaimRef {
  text: string;
  disposition: Disposition;
}

// A raise belongs to exactly one pass: pass 1 names the claim it is about,
// pass 2 names which of the four questions triggered it.
export type Raise =
  | { pass: 1; claim: ClaimRef; note: string; evidence: { source: string; quote: string } }
  | { pass: 2; question: Question; note: string; evidence: { source: string; quote: string } };

export interface JudgeVerdict {
  outcome: "raised" | "clear";
  raises: Raise[];
  // Only populated when the ADR carried no ## Claims section (or none of its
  // lines parsed) — the judge extracted them itself from the prose instead
  // of pass 1 iterating a recorded list. Never written back to the ADR.
  extractedClaims: ClaimRef[];
  // Pass-2 questions the judge could not check because its input (repo spec
  // context, agent capability list) was unavailable — reported honestly
  // rather than folded into "clear".
  unchecked: Question[];
}

export interface JudgeUsage {
  // null means unknown — the counts file was never written (the search
  // server never started or never got a request) or came back malformed —
  // never reported as 0, which would misrepresent an unknown count as a
  // verified "no tool calls happened".
  searches: number | null;
  fetches: number | null;
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

export interface Pass2Context {
  readme: string | null;
  openIssues: string | null;
  agentCapabilities: string | null;
}

function contextBlock(label: string, text: string | null, question: Question): string {
  if (text === null) {
    return `${label}: UNAVAILABLE. Report question "${question}" in "unchecked" — never guess "no change".`;
  }
  return `${label}:\n${text}`;
}

export function buildPrompt(
  adrId: string,
  adrContent: string,
  claims: Claim[] | null,
  pass2: Pass2Context,
): string {
  const claimsSection =
    claims === null
      ? `This ADR carries no usable "## Claims" section. Extract the claims yourself from its \
prose — every claim behind the road taken and every road not taken — and report them under \
"extractedClaims" (never write them back into the ADR). Then run pass 1 against what you extracted.`
      : `Pass 1 works over exactly these recorded claims — do not invent more:\n${claims
          .map((c, i) => `${i + 1}. [${c.disposition}] ${c.text} (source: ${c.source})`)
          .join("\n")}`;

  return `You are pawpie's judge. You re-triage ADR ${adrId} against today's world, in two passes. \
You never recommend a replacement decision and never re-decide — pawpie's whole job is triage, not \
choice. Use the "search" and "fetch_url" tools as many times as you need; there is no cost cap.

PASS 1 — iterate the claims. ${claimsSection}
For each claim, check whether it still holds or has changed since the ADR's date. This covers the \
road taken and every road not taken alike — a road-not-taken claim ("X was rejected because of Y") \
raises just as much as a road-taken one does.

PASS 2 — go back to the original question, independent of the claim list. Read the "## Problem" \
below and ask exactly these four questions:
1. "new-options": has any option to buy appeared since the ADR's date that it does not record?
2. "changed-capabilities": has any tool or option gained or lost a relevant ability?
3. "new-make-abilities": given today's agent skills and tools, can something now be MADE that had \
to be bought, or bought that had to be built, differently than when the ADR was researched?
4. "changed-spec": has our own requirement moved, so the original question should be asked \
differently? Judge this against the repo context below, never from general knowledge.

${contextBlock("Repo README", pass2.readme, "changed-spec")}

${contextBlock("Open issues", pass2.openIssues, "changed-spec")}

${contextBlock("Installed agent skills/tools", pass2.agentCapabilities, "new-make-abilities")}

Raise on either pass. Every raise names its pass, plus the claim (pass 1) or the question (pass 2) \
it is about, and carries evidence: a source (a URL, or the repo artifact you read — "README.md", \
"issue #12", "agent skills list") and a direct quote from it. Never invent evidence.

Reply with ONLY a JSON object (no prose, no markdown fence) matching exactly:
{"outcome": "raised" | "clear",
 "raises": [{"pass": 1 | 2,
             "claim": {"text": "<claim text>", "disposition": "taken" | "not-taken"} | omit for pass 2,
             "question": "new-options" | "changed-capabilities" | "new-make-abilities" | "changed-spec" | omit for pass 1,
             "note": "<one line>",
             "evidence": {"source": "<url or repo artifact>", "quote": "<direct quote>"}}],
 "extractedClaims": [{"text": "<claim text>", "disposition": "taken" | "not-taken"}],
 "unchecked": ["new-options" | "changed-capabilities" | "new-make-abilities" | "changed-spec", ...]}
"raises" is empty when outcome is "clear". "extractedClaims" is empty when the ADR already had a \
usable "## Claims" section. "unchecked" lists only questions 3/4 you could not check because their \
input above was UNAVAILABLE.

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

function isDisposition(v: unknown): v is Disposition {
  return v === "taken" || v === "not-taken";
}

function validateClaimRef(v: unknown, where: string): ClaimRef {
  if (typeof v !== "object" || v === null) throw new JudgeError(`${where} is not an object`);
  const c = v as Record<string, unknown>;
  if (typeof c.text !== "string" || c.text.length === 0) throw new JudgeError(`${where}.text is missing`);
  if (!isDisposition(c.disposition)) throw new JudgeError(`${where}.disposition is invalid: ${JSON.stringify(c.disposition)}`);
  return { text: c.text, disposition: c.disposition };
}

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
    if (raise.pass !== 1 && raise.pass !== 2) {
      throw new JudgeError(`raise[${i}] has invalid "pass": ${JSON.stringify(raise.pass)}`);
    }
    const evidence = raise.evidence as Record<string, unknown> | undefined;
    if (
      !evidence ||
      typeof evidence.source !== "string" ||
      evidence.source.trim().length === 0 ||
      typeof evidence.quote !== "string" ||
      evidence.quote.trim().length === 0
    ) {
      throw new JudgeError(`raise[${i}] is missing a non-empty evidence.source or evidence.quote`);
    }
    const note = typeof raise.note === "string" ? raise.note : "";
    if (raise.pass === 1) {
      const claim = validateClaimRef(raise.claim, `raise[${i}].claim`);
      return { pass: 1, claim, note, evidence: { source: evidence.source, quote: evidence.quote } };
    }
    if (!QUESTIONS.includes(raise.question as Question)) {
      throw new JudgeError(`raise[${i}] has invalid "question": ${JSON.stringify(raise.question)}`);
    }
    return {
      pass: 2,
      question: raise.question as Question,
      note,
      evidence: { source: evidence.source, quote: evidence.quote },
    };
  });
  if (d.outcome === "raised" && raises.length === 0) {
    throw new JudgeError('judge verdict says "raised" but carries no raises');
  }
  if (d.outcome === "clear" && raises.length > 0) {
    throw new JudgeError('judge verdict says "clear" but carries raises — a contradiction');
  }

  const extractedClaims = Array.isArray(d.extractedClaims)
    ? d.extractedClaims.map((c, i) => validateClaimRef(c, `extractedClaims[${i}]`))
    : [];

  const unchecked = Array.isArray(d.unchecked)
    ? d.unchecked.filter((q): q is Question => QUESTIONS.includes(q as Question))
    : [];

  return { outcome: d.outcome, raises, extractedClaims, unchecked };
}

export interface JudgeOptions {
  env?: NodeJS.ProcessEnv;
  selfCommand?: string[]; // [execPath, scriptPath] used to spawn the MCP search server
  searchAdapterEnv?: Record<string, string>; // env for the spawned MCP server
  claims?: Claim[] | null;
  pass2?: Pass2Context;
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

  const pass2: Pass2Context = opts.pass2 ?? { readme: null, openIssues: null, agentCapabilities: null };
  const prompt = buildPrompt(adrId, adrContent, opts.claims ?? null, pass2);

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

    let usage: JudgeUsage = { searches: null, fetches: null, judgeCalls: 1 };
    try {
      const counts: unknown = JSON.parse(fs.readFileSync(countsFile, "utf8"));
      if (
        typeof counts === "object" &&
        counts !== null &&
        Number.isInteger((counts as Record<string, unknown>).searches) &&
        Number.isInteger((counts as Record<string, unknown>).fetches)
      ) {
        const c = counts as { searches: number; fetches: number };
        usage = { searches: c.searches, fetches: c.fetches, judgeCalls: 1 };
      }
      // A present-but-malformed counts file is treated the same as a
      // missing one — null, unknown — rather than trusting a partial shape.
    } catch {
      // The judge may have answered with no tool calls, or with a judge
      // command that never started the MCP search server — usage then
      // honestly reports unknown (null) rather than a verified zero.
    }

    return { verdict, usage };
  } finally {
    fs.rmSync(workDir, { recursive: true, force: true });
  }
}
