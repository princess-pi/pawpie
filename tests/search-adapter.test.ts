import { describe, expect, test } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { createFixtureAdapter, loadFixtureAdapter } from "../src/search-adapter.ts";

describe("fixture search adapter", () => {
  test("search returns the canned results regardless of query", async () => {
    const adapter = createFixtureAdapter({ results: [{ title: "A", url: "https://a", text: "ta" }] });
    expect(await adapter.search("anything at all")).toEqual([{ title: "A", url: "https://a", text: "ta" }]);
  });

  test("fetch prefers an explicit fetchText override for the URL", async () => {
    const adapter = createFixtureAdapter({
      results: [{ title: "A", url: "https://a", text: "from-result" }],
      fetchText: { "https://a": "from-override" },
    });
    expect(await adapter.fetch("https://a")).toBe("from-override");
  });

  test("fetch falls back to the matching result's text with no override", async () => {
    const adapter = createFixtureAdapter({ results: [{ title: "A", url: "https://a", text: "from-result" }] });
    expect(await adapter.fetch("https://a")).toBe("from-result");
  });

  test("fetch of an unknown URL returns empty text rather than throwing", async () => {
    const adapter = createFixtureAdapter({ results: [] });
    expect(await adapter.fetch("https://unknown")).toBe("");
  });

  test("loadFixtureAdapter reads the same shape from a JSON file on disk", async () => {
    const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "pawpie-fixture-")), "fixture.json");
    fs.writeFileSync(file, JSON.stringify({ results: [{ title: "A", url: "https://a", text: "ta" }] }));
    const adapter = loadFixtureAdapter(file);
    expect(await adapter.search("q")).toEqual([{ title: "A", url: "https://a", text: "ta" }]);
  });
});
