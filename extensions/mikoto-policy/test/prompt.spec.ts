import assert from "node:assert/strict";
import { mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { it, type TestContext } from "node:test";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { MikotoPolicyDocument } from "mikoto-types";
import { MikotoPolicyDocumentLoader } from "../src/config.ts";
import { installPolicyPrompt } from "../src/prompt.ts";

function capturePrompt(loader: MikotoPolicyDocumentLoader) {
  let active: string[] = [];
  let handler!: (event: { systemPrompt: string }, ctx: ExtensionContext) => Promise<{ systemPrompt: string } | undefined>;
  installPolicyPrompt(loader, {
    getActiveTools: () => active,
    on(event: string, fn: typeof handler) {
      assert.equal(event, "before_agent_start");
      handler = fn;
    },
  } as unknown as ExtensionAPI);
  return {
    render: handler,
    setActiveTools(tools: string[]) { active = tools; },
  };
}

async function workspace(t: TestContext) {
  const cwd = await mkdtemp(join(tmpdir(), "mikoto-policy-prompt-"));
  t.after(() => rm(cwd, { recursive: true, force: true }));
  return {
    cwd,
    canonicalCwd: await realpath(cwd),
    globalConfigPath: join(cwd, "global.json"),
    ctx: { cwd, mode: "tui", hasUI: true, isProjectTrusted: () => true } as ExtensionContext,
  };
}

function snapshot(result: { systemPrompt: string } | undefined): MikotoPolicyDocument {
  assert.ok(result);
  const match = result.systemPrompt.match(/```json\n([\s\S]*?)\n```/);
  assert.ok(match);
  return JSON.parse(match[1]) as MikotoPolicyDocument;
}

it("chains the policy snapshot once, unchanged across modes and active tools", async (t) => {
  const { cwd, globalConfigPath, ctx } = await workspace(t);
  const config = {
    filesystem: {
      denyRead: ["z-private", "a-private", 'line\n"break'],
      allowRead: ["z-private/public", "a-private/public"],
      allowWrite: ["z-output", "a-output"],
      denyWrite: ["z-output/locked", "a-output/locked"],
    },
    network: {
      allowedDomains: ["z.example", "a.example"],
      deniedDomains: ["z.blocked.example", "a.blocked.example"],
    },
  };
  const loader = new MikotoPolicyDocumentLoader(config, globalConfigPath);
  const h = capturePrompt(loader);
  // An unrelated Permissions heading must not suppress this extension's block.
  const previous = "Chained previous instructions.\n\n## Permissions\nExisting provider guidance.";
  const result = (await h.render({ systemPrompt: previous }, ctx))!;
  assert.ok(result.systemPrompt.startsWith(`${previous}\n\n`));
  assert.equal(await h.render(result, ctx), undefined);

  const { document } = await loader.load(cwd, true);
  const before = structuredClone(document);
  const rendered = snapshot(result);
  for (const key of ["denyRead", "allowRead", "allowWrite", "denyWrite"] as const) {
    assert.deepEqual(rendered.filesystem[key], [...document.filesystem[key]].sort());
  }
  for (const key of ["allowedDomains", "deniedDomains"] as const) {
    assert.deepEqual(rendered.network[key], [...document.network[key]].sort());
  }
  // Unusual path characters must remain JSON data, not new prompt lines.
  assert.ok(!result.systemPrompt.includes('line\n"break'));
  for (const tools of [[], ["read", "apply_patch"], ["write"], ["bash"]]) {
    h.setActiveTools(tools);
    for (const mode of ["tui", "rpc", "print", "json"] as const) {
      for (const hasUI of [false, true]) {
        assert.deepEqual(await h.render({ systemPrompt: previous }, { ...ctx, mode, hasUI }), result);
      }
    }
  }
  assert.deepEqual(document, before);

  // Reordering otherwise equivalent configuration must not invalidate caching.
  const reordered = new MikotoPolicyDocumentLoader({
    filesystem: Object.fromEntries(
      Object.entries(config.filesystem).map(([key, paths]) => [key, [...paths].reverse()]),
    ),
    network: Object.fromEntries(
      Object.entries(config.network).map(([key, domains]) => [key, [...domains].reverse()]),
    ),
  }, globalConfigPath);
  assert.deepEqual(await capturePrompt(reordered).render({ systemPrompt: previous }, ctx), result);
});

it("shows merged, trust-scoped effective rules and keeps them pinned until reload", async (t) => {
  const { cwd, canonicalCwd, globalConfigPath, ctx } = await workspace(t);
  const workspaceConfigPath = join(cwd, "mikoto-policy.json");
  await writeFile(globalConfigPath, JSON.stringify({
    filesystem: {
      denyRead: ["global-secret"],
      allowRead: ["global-secret/public"],
      allowWrite: ["global-output"],
      denyWrite: ["global-output/locked"],
    },
    network: { allowedDomains: ["global.example"], deniedDomains: ["blocked.example"] },
  }));
  await writeFile(workspaceConfigPath, JSON.stringify({
    filesystem: {
      denyRead: { "+": ["workspace-secret"] },
      allowWrite: ["workspace-output"],
    },
    network: { allowedDomains: ["workspace.example"] },
  }));
  const createLoader = () => new MikotoPolicyDocumentLoader({
    filesystem: { allowWrite: ["bundled-output"] },
  }, globalConfigPath);
  const h = capturePrompt(createLoader());
  const event = { systemPrompt: "" };
  const trusted = await h.render(event, ctx);
  const expected = {
    filesystem: {
      denyRead: [join(canonicalCwd, "global-secret"), join(canonicalCwd, "workspace-secret")],
      allowRead: [join(canonicalCwd, "global-secret/public")],
      allowWrite: [join(canonicalCwd, "workspace-output")],
      denyWrite: [join(canonicalCwd, "global-output/locked")],
    },
    network: { allowedDomains: ["workspace.example"], deniedDomains: ["blocked.example"] },
  };
  assert.deepEqual(snapshot(trusted), expected);
  const untrusted = await h.render(event, { ...ctx, isProjectTrusted: () => false });
  assert.deepEqual(snapshot(untrusted), {
    filesystem: {
      ...expected.filesystem,
      denyRead: [join(canonicalCwd, "global-secret")],
      allowWrite: [join(canonicalCwd, "global-output")],
    },
    network: { allowedDomains: ["global.example"], deniedDomains: ["blocked.example"] },
  });

  await writeFile(workspaceConfigPath, JSON.stringify({
    filesystem: { allowWrite: ["new-output"] },
    network: { allowedDomains: ["new.example"] },
  }));
  assert.deepEqual(await h.render(event, ctx), trusted);
  const reloaded = await capturePrompt(createLoader()).render(event, ctx);
  assert.deepEqual(snapshot(reloaded).filesystem.allowWrite, [join(canonicalCwd, "new-output")]);
  assert.deepEqual(snapshot(reloaded).network, { allowedDomains: ["new.example"], deniedDomains: ["blocked.example"] });
  assert.notDeepEqual(reloaded, trusted);
});
