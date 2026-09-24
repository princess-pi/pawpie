import * as fs from "node:fs";
import * as readline from "node:readline";
import type { SearchAdapter } from "./search-adapter.ts";

export interface McpCounts {
  searches: number;
  fetches: number;
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

// Pure request handler — no stdio — so it is unit-testable without spawning
// a subprocess. `request.id === undefined` marks a notification, which gets
// no response (returning null tells the caller not to write anything).
export async function handleMcpRequest(
  adapter: SearchAdapter,
  counts: McpCounts,
  request: JsonRpcRequest,
): Promise<Record<string, unknown> | null> {
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
    case "notifications/initialized":
      return null;
    case "tools/list":
      return respond({ tools: TOOLS });
    case "tools/call": {
      const name = request.params?.name as string | undefined;
      const args = (request.params?.arguments ?? {}) as Record<string, unknown>;
      if (name === "search") {
        const query = String(args.query ?? "");
        const hits = await adapter.search(query);
        counts.searches += 1;
        return respond(toolResult(JSON.stringify(hits)));
      }
      if (name === "fetch_url") {
        const url = String(args.url ?? "");
        const text = await adapter.fetch(url);
        counts.fetches += 1;
        return respond(toolResult(text));
      }
      return fail(`unknown tool "${name}"`);
    }
    default:
      return fail(`unknown method "${request.method}"`);
  }
}

// The real entry point: newline-delimited JSON-RPC over stdio, per MCP's
// stdio transport. Writes `counts` to `countsFile` after every tool call so
// the parent process (which only sees this server's PID via the judge's own
// MCP config, not its stdio) can read usage back after the judge exits.
export function runMcpStdioServer(adapter: SearchAdapter, countsFile?: string): void {
  const counts: McpCounts = { searches: 0, fetches: 0 };
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
    void handleMcpRequest(adapter, counts, request).then((response) => {
      if (countsFile) {
        try {
          fs.writeFileSync(countsFile, JSON.stringify(counts));
        } catch {
          // Best-effort usage reporting only — never fail the tool call over it.
        }
      }
      if (response) process.stdout.write(`${JSON.stringify(response)}\n`);
    });
  });
}
