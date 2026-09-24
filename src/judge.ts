import { spawnSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import type { Claim } from "./adr.ts";
import type { EvidenceEntry } from "./mcp-server.ts";

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
  // Every claim pass 1 actually examined (recorded or extracted), whether or
  // not it raised — required to cover every claim in the iterated list, so a
  // "clear" verdict can't mean "pass 1 silently skipped some claims".
  checkedClaims: ClaimRef[];
  // Pass-2 questions the judge could not check because its input (repo spec
  // context, agent capability list) was unavailable — always exactly the set
  // of genuinely unavailable questions (see pass2QuestionAvailable), never
  // trusted from the judge's own report.
  unchecked: Question[];
}

export interface JudgeUsage {
  // null means unknown — the search server (__mcp-serve) never started at
  // all, so its counts file was never written, or the file came back
  // malformed. A server that started but was never called (initialize/
  // tools/list only) writes a verified {searches: 0, ...}, which IS reported
  // as 0 — only "never started" or "malformed" collapse to null.
  searches: number | null;
  fetches: number | null;
  // A failed search/fetch call, counted separately so an all-failing backend
  // is visibly distinct from a judge that simply made no calls.
  searchErrors: number | null;
  fetchErrors: number | null;
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

const MAX_CONTEXT_CHARS = 20_000;

function contextBlock(label: string, text: string | null): string {
  if (text === null) return `${label}: UNAVAILABLE.`;
  if (text.length <= MAX_CONTEXT_CHARS) return `${label}:\n${text}`;
  return `${label} (truncated to the first ${MAX_CONTEXT_CHARS} characters of a longer document):\n${text.slice(0, MAX_CONTEXT_CHARS)}`;
}

// Whether the input pass 2 needs for a given question is available at all —
// used both to phrase the prompt and, after the judge answers, to force that
// question into `unchecked` when it truly was, regardless of what the judge
// says (enforced in validateVerdict, not trusted from the judge's own report).
export function pass2QuestionAvailable(question: Question, pass2: Pass2Context): boolean {
  if (question === "changed-spec") return pass2.readme !== null || pass2.openIssues !== null;
  if (question === "new-make-abilities") return pass2.agentCapabilities !== null;
  return true;
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
prose — every claim behind the road taken and every road not taken — and report at least one \
under "extractedClaims" (never write them back into the ADR). Then run pass 1 against what you \
extracted.`
      : `Pass 1 works over exactly these recorded claims — do not invent more, and leave \
"extractedClaims" empty:\n${claims
          .map((c, i) => `${i + 1}. [${c.disposition}] ${c.text} (source: ${c.source})`)
          .join("\n")}`;

  const changedSpecAvailable = pass2QuestionAvailable("changed-spec", pass2);
  const abilitiesAvailable = pass2QuestionAvailable("new-make-abilities", pass2);

  return `You are pawpie's judge. You re-triage ADR ${adrId} against today's world, in two passes. \
You never recommend a replacement decision and never re-decide — pawpie's whole job is triage, not \
choice. Use the "search" and "fetch_url" tools as many times as you need. Both tools cost the same \
regardless of what they return, so there is no cheaper tier to prefer — but a targeted query \
against a vendor's own docs or changelog usually settles a claim in fewer calls than a broad web \
search does, so try the specific source first. There is no cost cap, so keep going until you are \
satisfied.

PASS 1 — iterate the claims. ${claimsSection}
For each claim, check whether it still holds or has changed since the ADR's date. This covers the \
road taken and every road not taken alike — a road-not-taken claim ("X was rejected because of Y") \
raises just as much as a road-taken one does. A pass-1 raise's "claim" must be one of the claims \
listed above verbatim (text and disposition) — never a claim you invented. List EVERY claim you \
examined, raised or not, under "checkedClaims" — its keys must exactly match the claim list above \
(or your own "extractedClaims" when you extracted them) so a caller can verify pass 1 covered all \
of them, not just the ones that raised.

PASS 2 — go back to the original question, independent of the claim list. Read the "## Problem" \
below and ask exactly these four questions:
1. "new-options": has any option to buy appeared since the ADR's date that it does not record?
2. "changed-capabilities": has any tool or option gained or lost a relevant ability?
3. "new-make-abilities": given today's agent skills and tools, can something now be MADE that had \
to be bought, or bought that had to be built, differently than when the ADR was researched? \
${abilitiesAvailable ? "" : 'No agent-capability input is available below — you cannot check this; report "new-make-abilities" in "unchecked".'}
4. "changed-spec": has our own requirement moved, so the original question should be asked \
differently? Judge this against the repo context below, never from general knowledge. \
${changedSpecAvailable ? "" : 'Neither the README nor open issues are available below — you cannot check this; report "changed-spec" in "unchecked".'}

${contextBlock("Repo README", pass2.readme)}

${contextBlock("Open issues", pass2.openIssues)}

${contextBlock("Installed agent skills/tools", pass2.agentCapabilities)}

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
 "checkedClaims": [{"text": "<claim text>", "disposition": "taken" | "not-taken"}, ...every claim iterated],
 "unchecked": ["new-options" | "changed-capabilities" | "new-make-abilities" | "changed-spec", ...]}
"raises" is empty when outcome is "clear". "extractedClaims" is empty when the ADR already had a \
usable "## Claims" section. "unchecked" lists only questions 3/4 you could not check because their \
input above was UNAVAILABLE — never a question whose input was provided above.

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

function claimKey(c: ClaimRef): string {
  return `${c.disposition}\u0000${c.text}`;
}

// A source naming a repo artifact pawpie itself supplied — never web-sourced,
// so it is checked against that artifact's own text instead of evidenceLog.
// Anything not a URL and not one of these three is not a source pawpie ever
// told the judge to use, and is rejected outright.
function pass2ArtifactText(source: string, pass2: Pass2Context): string | null {
  if (source === "README.md") return pass2.readme;
  if (/^issue #\d+$/.test(source)) return pass2.openIssues;
  if (source === "agent skills list") return pass2.agentCapabilities;
  return null;
}

// `recordedClaims` is the parsed `## Claims` list, or null when the judge
// was told to extract its own. `evidenceLog` is every URL/text the search
// tools actually returned this run (see runJudge for why it's always an
// array, never null).
function validateVerdict(
  doc: unknown,
  recordedClaims: Claim[] | null,
  pass2: Pass2Context,
  evidenceLog: EvidenceEntry[],
): JudgeVerdict {
  if (typeof doc !== "object" || doc === null) throw new JudgeError("judge verdict is not an object");
  const d = doc as Record<string, unknown>;
  if (d.outcome !== "raised" && d.outcome !== "clear") {
    throw new JudgeError(`judge verdict has invalid "outcome": ${JSON.stringify(d.outcome)}`);
  }

  const extractedClaims = Array.isArray(d.extractedClaims)
    ? d.extractedClaims.map((c, i) => validateClaimRef(c, `extractedClaims[${i}]`))
    : [];
  if (recordedClaims !== null && extractedClaims.length > 0) {
    throw new JudgeError('"extractedClaims" must be empty — this ADR already had a recorded ## Claims list');
  }
  if (recordedClaims === null && extractedClaims.length === 0) {
    throw new JudgeError('"extractedClaims" is empty, but this ADR had no recorded ## Claims — the judge must extract at least one');
  }

  // Pass 1's membership set: the recorded ## Claims when there were any,
  // otherwise exactly what the judge itself claims to have extracted — a
  // prose-only ADR's pass-1 raises are checked against that, not left
  // unconstrained just because there was no recorded list to check against.
  const claimsIterated = recordedClaims
    ? recordedClaims.map((c) => ({ text: c.text, disposition: c.disposition }))
    : extractedClaims;
  const iteratedKeys = new Set(claimsIterated.map(claimKey));

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
    if (/^https?:\/\//i.test(evidence.source)) {
      const fromThatUrl = evidenceLog.filter((e) => e.url === evidence.source);
      if (fromThatUrl.length === 0) {
        throw new JudgeError(`raise[${i}].evidence.source (${evidence.source}) was never returned by search/fetch_url this run`);
      }
      if (!fromThatUrl.some((e) => e.text.includes(evidence.quote as string))) {
        throw new JudgeError(`raise[${i}].evidence.quote does not appear in what ${evidence.source} actually returned`);
      }
    } else {
      const artifactText = pass2ArtifactText(evidence.source, pass2);
      if (artifactText === null) {
        throw new JudgeError(
          `raise[${i}].evidence.source (${JSON.stringify(evidence.source)}) is neither a URL nor a recognized repo artifact ("README.md", "issue #<n>", "agent skills list")`,
        );
      }
      if (!artifactText.includes(evidence.quote as string)) {
        throw new JudgeError(`raise[${i}].evidence.quote does not appear in ${evidence.source}`);
      }
    }
    const note = typeof raise.note === "string" ? raise.note : "";
    if (raise.pass === 1) {
      const claim = validateClaimRef(raise.claim, `raise[${i}].claim`);
      if (!iteratedKeys.has(claimKey(claim))) {
        throw new JudgeError(`raise[${i}].claim is not one of the claims pass 1 iterated: ${JSON.stringify(claim)}`);
      }
      return { pass: 1, claim, note, evidence: { source: evidence.source, quote: evidence.quote } };
    }
    if (!QUESTIONS.includes(raise.question as Question)) {
      throw new JudgeError(`raise[${i}] has invalid "question": ${JSON.stringify(raise.question)}`);
    }
    const question = raise.question as Question;
    if (!pass2QuestionAvailable(question, pass2)) {
      throw new JudgeError(`raise[${i}] answers "${question}", but its input was UNAVAILABLE — no honest evidence was possible`);
    }
    return { pass: 2, question, note, evidence: { source: evidence.source, quote: evidence.quote } };
  });
  if (d.outcome === "raised" && raises.length === 0) {
    throw new JudgeError('judge verdict says "raised" but carries no raises');
  }
  if (d.outcome === "clear" && raises.length > 0) {
    throw new JudgeError('judge verdict says "clear" but carries raises — a contradiction');
  }

  const checkedClaims = Array.isArray(d.checkedClaims)
    ? d.checkedClaims.map((c, i) => validateClaimRef(c, `checkedClaims[${i}]`))
    : [];
  const checkedKeys = new Set(checkedClaims.map(claimKey));
  for (const key of iteratedKeys) {
    if (!checkedKeys.has(key)) {
      throw new JudgeError(`"checkedClaims" is missing a claim pass 1 was supposed to iterate: ${key}`);
    }
  }
  for (const key of checkedKeys) {
    if (!iteratedKeys.has(key)) {
      throw new JudgeError(`"checkedClaims" names a claim that was never on the iterated list: ${key}`);
    }
  }

  const reportedUnchecked = Array.isArray(d.unchecked)
    ? d.unchecked.filter((q): q is Question => QUESTIONS.includes(q as Question))
    : [];
  // Strict both ways: a question the judge reports unchecked must actually
  // have been unavailable (never a dishonest "I didn't bother" for an
  // available question), and "unchecked" itself is always exactly the
  // genuinely-unavailable set, never trusted from the judge's own report.
  for (const q of reportedUnchecked) {
    if (pass2QuestionAvailable(q, pass2)) {
      throw new JudgeError(`judge reported "${q}" as unchecked, but its input was available`);
    }
  }
  const unchecked = QUESTIONS.filter((q) => !pass2QuestionAvailable(q, pass2));

  return { outcome: d.outcome, raises, extractedClaims, checkedClaims, unchecked };
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
  try {
    const countsFile = path.join(workDir, "counts.json");
    const evidenceFile = path.join(workDir, "evidence.json");
    const mcpConfigFile = path.join(workDir, "mcp-config.json");

    fs.writeFileSync(
      mcpConfigFile,
      JSON.stringify({
        mcpServers: {
          pawpie: {
            command: selfCommand[0],
            args: [...selfCommand.slice(1), "__mcp-serve"],
            env: {
              ...(opts.searchAdapterEnv ?? {}),
              PAWPIE_MCP_COUNTS_FILE: countsFile,
              PAWPIE_MCP_EVIDENCE_FILE: evidenceFile,
            },
          },
        },
      }),
    );

    const pass2: Pass2Context = opts.pass2 ?? { readme: null, openIssues: null, agentCapabilities: null };
    const prompt = buildPrompt(adrId, adrContent, opts.claims ?? null, pass2);

    // Test-only seam: a fake judge never spawns __mcp-serve, so this seeds
    // the evidence file it would otherwise have written. Gated on
    // PAWPIE_SEARCH_FIXTURE too, so a leaked PAWPIE_TEST_PRESET_EVIDENCE
    // cannot disable evidence checking on a real, EXA-backed run.
    if (env.PAWPIE_TEST_PRESET_EVIDENCE && env.PAWPIE_SEARCH_FIXTURE) {
      fs.writeFileSync(evidenceFile, env.PAWPIE_TEST_PRESET_EVIDENCE);
    }

    // In non-interactive print mode, Claude Code (and harnesses that share its
    // CLI shape) denies any tool not explicitly allowed — with neither an
    // interactive prompt nor a permission mode granting it, a bare
    // --mcp-config would let the judge start the server and then never
    // actually call "search"/"fetch_url", answering from its own knowledge
    // while still producing a well-formed (and wrong) "clear" verdict.
    const ALLOWED_TOOLS = "mcp__pawpie__search,mcp__pawpie__fetch_url";

    const child = spawnSync(
      bin,
      [...cmdArgs, "--mcp-config", mcpConfigFile, "--strict-mcp-config", "--allowedTools", ALLOWED_TOOLS],
      {
        env,
        input: prompt,
        encoding: "utf8",
        maxBuffer: 64 * 1024 * 1024,
      },
    );
    if (child.error) throw new JudgeError(`judge command failed to start: ${child.error.message}`);
    if (child.status !== 0) {
      throw new JudgeError(`judge command exited ${child.status}: ${(child.stderr ?? "").slice(0, 500)}`);
    }
    const stdout = child.stdout ?? "";

    // A missing/malformed file collapses to `[]`, same as a server that
    // started and returned nothing — either way a URL-sourced raise has
    // nothing to check against and must be rejected, not waved through.
    let evidenceLog: EvidenceEntry[] = [];
    try {
      const parsed: unknown = JSON.parse(fs.readFileSync(evidenceFile, "utf8"));
      if (Array.isArray(parsed) && parsed.every((e) => typeof e?.url === "string" && typeof e?.text === "string")) {
        evidenceLog = parsed as EvidenceEntry[];
      }
    } catch {
      // See above.
    }

    const verdict = validateVerdict(extractJson(stdout), opts.claims ?? null, pass2, evidenceLog);

    let usage: JudgeUsage = { searches: null, fetches: null, searchErrors: null, fetchErrors: null, judgeCalls: 1 };
    try {
      const counts: unknown = JSON.parse(fs.readFileSync(countsFile, "utf8"));
      const c = counts as Record<string, unknown>;
      if (
        typeof counts === "object" &&
        counts !== null &&
        Number.isInteger(c.searches) &&
        Number.isInteger(c.fetches) &&
        Number.isInteger(c.searchErrors) &&
        Number.isInteger(c.fetchErrors)
      ) {
        usage = {
          searches: c.searches as number,
          fetches: c.fetches as number,
          searchErrors: c.searchErrors as number,
          fetchErrors: c.fetchErrors as number,
          judgeCalls: 1,
        };
      }
      // A malformed counts file is treated the same as a missing one.
    } catch {
      // Missing/malformed — see JudgeUsage's null semantics above.
    }

    return { verdict, usage };
  } finally {
    fs.rmSync(workDir, { recursive: true, force: true });
  }
}
