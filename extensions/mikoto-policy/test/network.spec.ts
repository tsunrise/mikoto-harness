import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { MikotoPolicyConfig, MikotoPolicyDocumentLoader, normalizeNetworkRule } from "../src/config.ts";

test("network syntax is canonical, narrow, and deny-all is deny-only", () => {
  for (const value of ["EXAMPLE.COM", "*.Example.com:443", "127.0.0.1:1234", "xn--bcher-kva.example"]) {
    assert.equal(normalizeNetworkRule(value, false), value.toLowerCase());
  }
  for (const value of ["*", "*:443", "https://example.com", "example.com.", "127.1", "0177.0.0.1",
    "0x7f000001", "[::1]", "a/b", "user@example.com", "a:0", "a:65536", "a:080", "a.*", "bücher.example", "xn--"]) {
    assert.equal(normalizeNetworkRule(value, false), undefined, value);
  }
  assert.equal(normalizeNetworkRule("*:443", true), "*:443");
  assert.equal(MikotoPolicyConfig.safeParse({ capabilities: { enabled: true } }).success, false);
});
test("network deltas normalize before merging and diagnostics distinguish load failures", async () => {
  const dir = await mkdtemp(join(tmpdir(), "garden-network-policy-"));
  try {
    const global = join(dir, "global.json");
    await writeFile(global, JSON.stringify({ network: {
      allowedDomains: { "+": ["API.EXAMPLE.COM", "other.example"], "-": ["api.example.com"] },
      deniedDomains: ["*"],
    } }));
    const loaded = await new MikotoPolicyDocumentLoader({
      network: { allowedDomains: ["api.example.com"] },
    }, global).load(dir, true);
    assert.deepEqual(loaded.document.network, { allowedDomains: ["other.example"], deniedDomains: ["*"] });
    assert.ok(Object.isFrozen(loaded.document.network.allowedDomains));
    assert.ok(loaded.diagnostics.some((d) => d.kind === "optional_absence"));
    assert.ok(Object.isFrozen(loaded.diagnostics));
    await writeFile(global, "{");
    const bad = await new MikotoPolicyDocumentLoader({}, global).load(dir, true);
    assert.deepEqual(bad.diagnostics, [{ kind: "invalid_layer", path: global }]);
    const skipped = await new MikotoPolicyDocumentLoader({}, join(dir, "missing")).load(dir, false);
    assert.ok(skipped.diagnostics.some((d) => d.kind === "untrusted_workspace"));
    const cyclic = join(dir, "cycle");
    await symlink(cyclic, cyclic);
    const dropped = await new MikotoPolicyDocumentLoader({
      filesystem: { denyRead: [cyclic] },
    }, join(dir, "missing")).load(dir, true);
    assert.ok(dropped.diagnostics.some((d) => d.kind === "canonical_rule" && d.rule === "denyRead" && d.path === cyclic));
  } finally { await rm(dir, { recursive: true, force: true }); }
});
