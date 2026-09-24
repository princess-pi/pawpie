import { describe, expect, test } from "bun:test";
import { handleMcpRequest, type McpCounts } from "../src/mcp-server.ts";
import { createFixtureAdapter } from "../src/search-adapter.ts";

const FIXTURE = {
  results: [{ title: "Example", url: "https://example.com", text: "example text" }],
};

describe("mcp-server request handling", () => {
  test("tools/list advertises search and fetch_url", async () => {
    const adapter = createFixtureAdapter(FIXTURE);
    const counts: McpCounts = { searches: 0, fetches: 0 };
    const response = await handleMcpRequest(adapter, counts, { jsonrpc: "2.0", id: 1, method: "tools/list" });
    const names = (response as any).result.tools.map((t: any) => t.name);
    expect(names).toEqual(["search", "fetch_url"]);
  });

  test("tools/call search returns fixture hits and increments the count", async () => {
    const adapter = createFixtureAdapter(FIXTURE);
    const counts: McpCounts = { searches: 0, fetches: 0 };
    const response = await handleMcpRequest(adapter, counts, {
      jsonrpc: "2.0",
      id: 2,
      method: "tools/call",
      params: { name: "search", arguments: { query: "anything" } },
    });
    const text = (response as any).result.content[0].text;
    expect(JSON.parse(text)).toEqual(FIXTURE.results);
    expect(counts.searches).toBe(1);
    expect(counts.fetches).toBe(0);
  });

  test("tools/call fetch_url returns fixture text and increments the count", async () => {
    const adapter = createFixtureAdapter(FIXTURE);
    const counts: McpCounts = { searches: 0, fetches: 0 };
    const response = await handleMcpRequest(adapter, counts, {
      jsonrpc: "2.0",
      id: 3,
      method: "tools/call",
      params: { name: "fetch_url", arguments: { url: "https://example.com" } },
    });
    expect((response as any).result.content[0].text).toBe("example text");
    expect(counts.fetches).toBe(1);
  });

  test("an unknown tool name returns a JSON-RPC error, not a crash", async () => {
    const adapter = createFixtureAdapter(FIXTURE);
    const counts: McpCounts = { searches: 0, fetches: 0 };
    const response = await handleMcpRequest(adapter, counts, {
      jsonrpc: "2.0",
      id: 4,
      method: "tools/call",
      params: { name: "delete_everything", arguments: {} },
    });
    expect((response as any).error).toBeDefined();
  });

  test("a notification (no id) gets no response", async () => {
    const adapter = createFixtureAdapter(FIXTURE);
    const counts: McpCounts = { searches: 0, fetches: 0 };
    const response = await handleMcpRequest(adapter, counts, {
      jsonrpc: "2.0",
      method: "notifications/initialized",
    });
    expect(response).toBeNull();
  });
});
