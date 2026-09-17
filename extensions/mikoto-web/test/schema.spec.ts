import assert from "node:assert/strict";
import { test } from "node:test";
import { commandsSchema } from "../src/schema.ts";

test("parses bounded mixed commands, numeric zero, domain normalization and defaults", () => {
  const result = commandsSchema.parse({
    search_query: [{ q: " query ", recency: 0, domains: ["OPENAI.COM", "bücher.de"] }],
    open: [{ ref_id: "https://example.com/a?q=1", lineno: 0 }],
    click: [{ ref_id: "turn0view0", id: 0 }],
    find: [{ ref_id: "turn0view0", pattern: "[literal]" }],
  });
  assert.equal(result.response_length, "medium");
  assert.equal(result.search_query![0].q, " query ");
  assert.deepEqual(result.search_query![0].domains, ["openai.com", "xn--bcher-kva.de"]);
  assert.equal(result.click![0].id, 0);
  assert.ok(commandsSchema.safeParse({ open: Array(16).fill({ ref_id: "r" }) }).success);
  assert.ok(commandsSchema.safeParse({ find: [{ ref_id: "https://example.com", pattern: "x" }] }).success);
});

test("rejects invalid commands and each untrusted boundary", () => {
  const invalid: unknown[] = [
    {}, null, [], { response_length: "long" }, { search_query: [] },
    { search_query: [{ q: "   " }] }, { search_query: [{ q: "x".repeat(4097) }] },
    { search_query: [{ q: "x", extra: true }] },
    { search_query: [{ q: "x" }], screenshot: [{ ref_id: "r", pageno: 0 }] },
    { image_query: [{ q: "x" }] }, { input: "x" }, { commands: { open: [{ ref_id: "r" }] } },
    { open: Array(17).fill({ ref_id: "r" }) },
    { open: Array(16).fill({ ref_id: "r" }), find: [{ ref_id: "r", pattern: "x" }] },
    { open: [{ ref_id: "r" }], response_length: null },
    { click: [{ ref_id: "https://example.com", id: 1 }] },
    { find: [{ ref_id: "r", pattern: "" }] },
  ];
  for (const value of [-1, 0.5, Number.MAX_SAFE_INTEGER + 1, NaN, Infinity, "1", null]) {
    invalid.push({ click: [{ ref_id: "r", id: value }] });
    invalid.push({ open: [{ ref_id: "r", lineno: value }] });
    invalid.push({ search_query: [{ q: "x", recency: value }] });
  }
  for (const ref_id of [
    "", "x".repeat(513), "file:///etc/passwd", "ftp://example.com", "https://u:p@example.com",
    "https:///example.com", "https://example.com\n", "https://example.com\\@other.com", "two words",
  ]) invalid.push({ open: [{ ref_id }] });
  for (const domain of [
    "https://example.com", "x:80", "*.com", "x/y", "a..com", "a.", ".a", "-a.com",
    "a-.com", "a_b.com", "a b.com", "x@host", "a".repeat(64) + ".com", "a%2ecom",
  ]) invalid.push({ search_query: [{ q: "x", domains: [domain] }] });
  invalid.push({ search_query: [{ q: "x", domains: Array(33).fill("example.com") }] });
  for (const input of invalid) {
    assert.equal(commandsSchema.safeParse(input).success, false, JSON.stringify(input));
  }
});
