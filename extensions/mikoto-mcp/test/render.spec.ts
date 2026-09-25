import assert from "node:assert/strict";
import { test } from "node:test";
import type { Tool } from "@modelcontextprotocol/sdk/types.js";
import { line, renderSearch, signature, summarize, type SearchView } from "../src/render.ts";

const schema = (properties: Record<string, object>, required: string[] = []): Tool["inputSchema"] =>
  ({ type: "object", properties, required });
const t = (name: string, inputSchema: Tool["inputSchema"], description?: string) => ({ name, inputSchema, description });

test("signatures serialize required/optional parameters, literals, unions, arrays and shallow objects", () => {
  const sig = signature(t("find", schema({
    env: { type: "string", enum: ["prod", "staging"] },
    kind: { const: "fixed" },
    ids: { type: "array", items: { anyOf: [{ type: "string" }, { type: "integer" }] } },
    window: { type: "object", properties: { start: { type: "string" }, end: { type: ["string", "null"] } }, required: ["start"] },
    anything: {},
    "odd key": { type: "boolean" },
  }, ["env", "window"])));
  assert.equal(sig.text, 'find(env: "prod"|"staging", kind?: "fixed", ids?: (string|integer)[], '
    + 'window: {start: string, end?: string|null}, anything?: any, "odd key"?: boolean)');
  assert.equal(sig.lossy, false);
  assert.deepEqual(signature(t("none", { type: "object" })), { text: "none()", lossy: false });
});

test("signatures mark structural loss: deep nesting, long enums, refs, and overflow", () => {
  const deep = schema({ a: { type: "object", properties: { b: { type: "object", properties: { c: { type: "object", properties: { d: { type: "string" } } } } } } } });
  assert.deepEqual(signature(t("deep", deep)), { text: "deep(a?: {b?: {c?: object}})", lossy: true });
  const many = signature(t("many", schema({ v: { enum: [1, 2, 3, 4, 5, 6, 7, 8, 9] } })));
  assert.equal(many.text, "many(v?: 1|2|3|4|5|6|7|8|…)");
  assert.equal(many.lossy, true);
  assert.equal(signature(t("ref", schema({ r: { $ref: "#/defs/x" } }))).lossy, true);
  const wide = signature(t("wide", schema(Object.fromEntries(Array.from({ length: 80 }, (_, i) => [`parameter${i}`, { type: "string" }])))));
  assert.equal(wide.lossy, true);
  assert.ok(wide.text.length <= 400 && wide.text.endsWith("…)"));
});

test("untrusted metadata cannot inject lines or terminal controls", () => {
  const rendered = line(t("evil\nname", schema({ "p\u001b[31m\nq": { type: "string", enum: ["a\nb"] } }), "Line one\n# fake header\u0007. Rest."));
  assert.ok(!/[\n\u0007\u001b]/.test(rendered));
});

test("summaries keep the first sentence, skipping abbreviations, and are bounded", () => {
  assert.equal(summarize("Lists items (e.g. a, b) by name. Then more.").text, "Lists items (e.g. a, b) by name.");
  assert.equal(summarize("No terminal punctuation").text, "No terminal punctuation");
  assert.equal(summarize(undefined).text, "");
  assert.ok(summarize("x".repeat(500)).text.length <= 160);
  assert.equal(summarize("Short. " + "y".repeat(100)).remainder, 101);
});

test("lines flag long parameter notes or long omitted guidance, not plain tools", () => {
  const plain = t("plain", schema({ id: { type: "string", description: "Identifier." } }), "Gets one. Short rest.");
  assert.ok(!line(plain).endsWith("[+]"));
  const noted = t("noted", schema({ q: { type: "string", description: "n".repeat(151) } }), "Queries.");
  assert.ok(line(noted).endsWith("[+]"));
  assert.ok(line(t("guided", schema({}), "First. " + "g".repeat(700))).endsWith("[+]"));
});

test("search rendering preserves rank, labels server changes, dedupes, and surfaces unready servers", () => {
  const tool = (server: string, name: string) => ({ server, ...t(name, schema({})) });
  const view: SearchView = {
    callRouteBound: true,
    results: [
      { query: "one", tools: [tool("a", "x"), tool("b", "y"), tool("a", "z")],
        servers: [{ server: "a", state: "ready", catalog: "fresh" }, { server: "b", state: "pending", catalog: "cached" }] },
      { query: "two", tools: [tool("a", "x")], servers: [{ server: "a", state: "ready", catalog: "fresh" }] },
      { query: "three", tools: [], servers: [], error: { code: "unknown_server" } },
      { query: "four", tools: [], servers: [] },
    ],
  };
  const lines = renderSearch(view).split("\n");
  const at = (text: string) => lines.indexOf(text);
  assert.ok(lines.some(l => l.startsWith("! b:") && l.includes("pending")));
  assert.ok(!lines.some(l => l.startsWith("! a:")));
  assert.ok(at("a") < at("  x()") && at("  x()") < at("b") && at("b") < at("  y()") && at("  y()") < lines.lastIndexOf("a"));
  assert.equal(lines.filter(l => l === "  x()").length, 1);
  assert.ok(lines.some(l => l.startsWith("  x ") && l !== "  x()"));
  assert.ok(lines.includes("  unknown_server"));
  assert.ok(!renderSearch({ ...view, callRouteBound: true }).includes("[+]"));
  assert.notEqual(renderSearch({ ...view, callRouteBound: false }).split("\n").length, lines.length);
});
