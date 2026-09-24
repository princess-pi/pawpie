import * as fs from "node:fs";

export interface SearchHit {
  title: string;
  url: string;
  text: string;
}

export interface SearchAdapter {
  search(query: string): Promise<SearchHit[]>;
  fetch(url: string): Promise<string>;
}

export interface FixtureData {
  results: SearchHit[];
  fetchText?: Record<string, string>;
}

// Returns the same canned results for any query, and the same canned text
// for any fetched URL (or a per-URL override) — enough to drive the three
// trigger fixtures without a real search backend.
export function createFixtureAdapter(fixture: FixtureData): SearchAdapter {
  return {
    async search(_query: string): Promise<SearchHit[]> {
      return fixture.results;
    },
    async fetch(url: string): Promise<string> {
      return fixture.fetchText?.[url] ?? fixture.results.find((r) => r.url === url)?.text ?? "";
    },
  };
}

export function loadFixtureAdapter(path: string): SearchAdapter {
  const raw = fs.readFileSync(path, "utf8");
  return createFixtureAdapter(JSON.parse(raw) as FixtureData);
}

const EXA_API_BASE = "https://api.exa.ai";

export function createExaAdapter(apiKey: string): SearchAdapter {
  return {
    async search(query: string): Promise<SearchHit[]> {
      const res = await fetch(`${EXA_API_BASE}/search`, {
        method: "POST",
        headers: { "content-type": "application/json", "x-api-key": apiKey },
        body: JSON.stringify({ query, numResults: 5, contents: { text: true } }),
      });
      if (!res.ok) {
        throw new Error(`EXA search failed: ${res.status} ${res.statusText}`);
      }
      const doc = (await res.json()) as { results?: Array<{ title?: string; url: string; text?: string }> };
      return (doc.results ?? []).map((r) => ({ title: r.title ?? r.url, url: r.url, text: r.text ?? "" }));
    },
    async fetch(url: string): Promise<string> {
      const res = await fetch(`${EXA_API_BASE}/contents`, {
        method: "POST",
        headers: { "content-type": "application/json", "x-api-key": apiKey },
        body: JSON.stringify({ urls: [url], text: true }),
      });
      if (!res.ok) {
        throw new Error(`EXA fetch failed: ${res.status} ${res.statusText}`);
      }
      const doc = (await res.json()) as { results?: Array<{ text?: string }> };
      return doc.results?.[0]?.text ?? "";
    },
  };
}
