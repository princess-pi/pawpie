import * as fs from "node:fs";
import * as readline from "node:readline";
import type { SearchAdapter } from "./search-adapter.ts";

export interface McpCounts {
  searches: number;
  fetches: number;
  // A failed call still counts as an attempt: without this, a backend that
  // rejects every call (a bad key, every request 429/401) is indistinguishable
  // from a judge that simply chose not to search.
  searchErrors: number;
  fetchErrors: number;
}

interface JsonRpcRequest {
  jsonrpc: "2.0";
  id?: number | string;
  method: string;
  params?: Record<string, unknown>;
}

const TOOLS = [
  {
    name: "search",
    description: "Search the web for the given query. Returns title/url/text hits.",
    inputSchema: {
      type: "object",
      properties: { query: { type: "string" } },
      required: ["query"],
    },
  },
  {
    name: "fetch_url",
    description: "Fetch the text content of a URL.",
    inputSchema: {
      type: "object",
      properties: { url: { type: "string" } },
      required: ["url"],
    },
  },
];

function toolResult(text: string) {
  return { content: [{ type: "text", text }] };
}

function toolError(message: string) {
  return { content: [{ type: "text", text: message }], isError: true };
}

// Pure request handler — no stdio — so it is unit-testable without spawning
// a subprocess. Any request with no "id" is a JSON-RPC notification, which
// gets no response at all (null tells the caller to write nothing) —
// notifications/initialized included, and any other notification method a
// real MCP client sends (notifications/cancelled, roots/list_changed, …).
export async function handleMcpRequest(
  adapter: SearchAdapter,
  counts: McpCounts,
  request: JsonRpcRequest,
): Promise<Record<string, unknown> | null> {
  if (request.id === undefined) return null;

  const respond = (result: unknown) => ({ jsonrpc: "2.0", id: request.id, result });
  const fail = (message: string) => ({
    jsonrpc: "2.0",
    id: request.id,
    error: { code: -32000, message },
  });

  switch (request.method) {
    case "initialize":
      return respond({
        protocolVersion: "2024-11-05",
        capabilities: { tools: {} },
        serverInfo: { name: "pawpie-search", version: "1" },
      });
    case "tools/list":
      return respond({ tools: TOOLS });
    case "tools/call": {
      const name = request.params?.name as string | undefined;
      const args = (request.params?.arguments ?? {}) as Record<string, unknown>;
      if (name === "search") {
        const query = String(args.query ?? "");
        try {
          const hits = await adapter.search(query);
          counts.searches += 1;
          return respond(toolResult(JSON.stringify(hits)));
        } catch (err) {
          // A transient backend failure (a rate limit, a timeout) must never
          // crash this server — an unhandled rejection here would take down
          // the judge's only search tool for the rest of the run, with no
          // JSON-RPC error reaching the caller for this call.
          counts.searchErrors += 1;
          return respond(toolError(`search failed: ${(err as Error).message}`));
        }
      }
      if (name === "fetch_url") {
        const url = String(args.url ?? "");
        try {
          const text = await adapter.fetch(url);
          counts.fetches += 1;
          return respond(toolResult(text));
        } catch (err) {
          counts.fetchErrors += 1;
          return respond(toolError(`fetch failed: ${(err as Error).message}`));
        }
      }
      return fail(`unknown tool "${name}"`);
    }
    default:
      return fail(`unknown method "${request.method}"`);
  }
}

// The real entry point: newline-delimited JSON-RPC over stdio, per MCP's
// stdio transport. Writes `counts` to `countsFile` after every handled
// request (initialize and tools/list included, not just a tool call) so
// `judge.ts`, which only configured this server's command/env and never
// talks to it directly, can read usage back after the judge process exits.
// A client that starts this server but calls no tool therefore produces a
// verified {searches: 0, ...} — `judge.ts` only reads `null` (unknown) when
// the counts file was never written at all, i.e. this server never started.
export function runMcpStdioServer(adapter: SearchAdapter, countsFile?: string): void {
  const counts: McpCounts = { searches: 0, fetches: 0, searchErrors: 0, fetchErrors: 0 };
  const rl = readline.createInterface({ input: process.stdin, terminal: false });

  rl.on("line", (line) => {
    const trimmed = line.trim();
    if (trimmed === "") return;
    let request: JsonRpcRequest;
    try {
      request = JSON.parse(trimmed);
    } catch {
      return;
    }
    handleMcpRequest(adapter, counts, request)
      .then((response) => {
        if (countsFile) {
          try {
            fs.writeFileSync(countsFile, JSON.stringify(counts));
          } catch {
            // Best-effort usage reporting only — never fail the tool call over it.
          }
        }
        if (response) process.stdout.write(`${JSON.stringify(response)}\n`);
      })
      .catch((err: unknown) => {
        // handleMcpRequest itself catches every adapter failure — this is a
        // last-resort guard against a bug in the handler, so the server
        // stays up (an unhandled rejection would otherwise kill the process
        // node ≥15) instead of a request going unanswered.
        process.stderr.write(`pawpie __mcp-serve: unexpected error: ${(err as Error).message}\n`);
      });
  });
}
