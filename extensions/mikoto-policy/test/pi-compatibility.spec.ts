import assert from "node:assert/strict";
import { mkdtemp, mkdir, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { it } from "node:test";
import {
  createAgentSession, createReadToolDefinition, DefaultResourceLoader,
  ModelRuntime, SessionManager, SettingsManager,
  type CreateAgentSessionOptions,
} from "@earendil-works/pi-coding-agent";

it("Pi 0.87.1: built-in interception preserves tool state and schemas; SDK conflicts fail closed", async () => {
  const cwd = await mkdtemp(join(tmpdir(), "mikoto-pi-compat-"));
  const agentDir = join(cwd, "agent");
  await mkdir(agentDir);
  const previousAgentDir = process.env.PI_CODING_AGENT_DIR;
  process.env.PI_CODING_AGENT_DIR = agentDir;
  try {
    await writeFile(join(cwd, "file"), "allowed");
    const modelRuntime = await ModelRuntime.create({
      authPath: join(agentDir, "auth.json"), modelsPath: join(agentDir, "models.json"),
      modelsStorePath: join(agentDir, "models-store.json"), allowModelNetwork: false,
    });
    const model = modelRuntime.getModel("openai", "gpt-5.4");
    assert.ok(model);
    for (const options of [
      { tools: ["read", "bash"] },
      { noTools: "builtin" },
      { excludeTools: ["write"] },
      {},
      { customTools: [createReadToolDefinition(cwd) as unknown as NonNullable<CreateAgentSessionOptions["customTools"]>[number]] },
    ] satisfies Partial<CreateAgentSessionOptions>[]) {
      const settingsManager = SettingsManager.inMemory({ defaultTools: ["read", "bash", "edit"] });
      const resourceLoader = new DefaultResourceLoader({
        cwd, agentDir, settingsManager,
        noExtensions: true, noSkills: true, noPromptTemplates: true, noThemes: true,
        additionalExtensionPaths: [
          fileURLToPath(new URL("../index.ts", import.meta.url)),
          fileURLToPath(new URL("../../mikoto-apply-patch/index.ts", import.meta.url)),
        ],
      });
      await resourceLoader.reload();
      const { session, extensionsResult } = await createAgentSession({
        cwd, agentDir, modelRuntime, model: { ...model, compat: { supportsOpenAIGrammarTools: false } },
        settingsManager, resourceLoader, sessionManager: SessionManager.inMemory(cwd), ...options,
      });
      try {
        assert.deepEqual(extensionsResult.errors, []);
        const errors: string[] = [];
        await session.bindExtensions({ mode: "print", onError: (error) => errors.push(JSON.stringify(error)) });
        const initial = session.getActiveToolNames();
        assert.ok(!initial.includes("write"), JSON.stringify(initial));
        if (options.noTools === "builtin") assert.deepEqual(initial, []);
        const compatible = { ...model, compat: { supportsOpenAIGrammarTools: true } };
        session.agent.state.model = compatible;
        await session.extensionRunner.emit({ type: "model_select", model: compatible, previousModel: model, source: "set" });
        assert.ok(!session.getActiveToolNames().includes("edit"));
        await session.reload();
        assert.deepEqual(errors, []);
        const incompatible = { ...model, compat: { supportsOpenAIGrammarTools: false } };
        session.agent.state.model = incompatible;
        await session.extensionRunner.emit({ type: "model_select", model: incompatible, previousModel: compatible, source: "set" });
        assert.deepEqual(session.getActiveToolNames(), initial);
        if (initial.includes("read")) {
          const result = await session.extensionRunner.emitToolCall({
            type: "tool_call", toolName: "read", toolCallId: "1", input: { path: "file" },
          });
          if (options.customTools) {
            assert.equal(result?.block, true);
            assert.match(result?.reason ?? "", /conflicting read ownership/);
          } else {
            assert.equal(result, undefined);
            const tool = session.agent.state.tools.find((tool) => tool.name === "read")!;
            assert.equal(
              "sandbox_permissions" in (
                tool.parameters as { properties: Record<string, unknown> }
              ).properties,
              false,
            );
            assert.deepEqual(await tool.execute("1", { path: "file" }), {
              content: [{ type: "text", text: "allowed" }], details: undefined,
            });
          }
        }
      } finally {
        await session.extensionRunner.emit({ type: "session_shutdown", reason: "quit" });
        session.dispose();
      }
    }
  } finally {
    if (previousAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
    else process.env.PI_CODING_AGENT_DIR = previousAgentDir;
    await rm(cwd, { recursive: true, force: true });
  }
});
