import assert from "node:assert/strict";
import { test } from "node:test";
import { SearchIndex, tokens } from "../src/search.ts";
import type { ServerSnapshot } from "../src/schema.ts";
import { tool } from "./helpers.ts";

test("BM25 indexes camelCase/Unicode/schema metadata, deduplicates query tokens, and excludes tasks", () => {
  const index = new SearchIndex();
  const snapshot: ServerSnapshot = {
    version: 1, server: "browser", configFingerprint: "a".repeat(64), refreshedAt: new Date().toISOString(),
    tools: [tool("takeScreenshot"), tool("navigate", { description: "Navigate a page", inputSchema: { type: "object",
      properties: { request: { items: { anyOf: [{ properties: { caféTitle: { description: "目的地" } } }] } } } } }),
    tool("task", { execution: { taskSupport: "required" } })],
  };
  index.update([snapshot]);
  assert.equal(index.search("screenshot", 5)[0].tool.name, "takeScreenshot");
  assert.equal(index.search("café 目的地", 5)[0].tool.name, "navigate");
  assert.equal(index.search("pageUrl", 5)[0].tool.name, "takeScreenshot");
  assert.deepEqual(index.search("screenshot screenshot", 5), index.search("screenshot", 5));
  assert.equal(index.search("browser", 1).length, 1);
  assert.equal(index.search("* noMatch", 5).length, 0);
  assert.equal(index.search("browser", 20).length, 2);
  assert.deepEqual(tokens("readHTTPResponse café_世界-522"), ["read", "http", "response", "café", "世界", "522"]);
  index.update([{ ...snapshot, tools: [] }]);
  assert.equal(index.search("screenshot", 5).length, 0);
});

test("ties use code-point server/tool ordering, not locale or catalog arrival order", () => {
  const index = new SearchIndex();
  index.update(["z", "A"].map(server => ({
    version: 1, server, configFingerprint: "", refreshedAt: "",
    tools: [tool("b", { description: "same" }), tool("a", { description: "same" })],
  })));
  assert.deepEqual(index.search("same", 20).map(d => [d.server, d.tool.name]), [["A", "a"], ["A", "b"], ["z", "a"], ["z", "b"]]);
});
