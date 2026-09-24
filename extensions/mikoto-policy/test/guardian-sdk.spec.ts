import assert from "node:assert/strict";
import { mkdtemp, mkdir, writeFile, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { it } from "node:test";
import {
  createAssistantMessageEventStream, getCurrentTools, type AssistantMessage, type TranscriptContext,
} from "@earendil-works/pi-ai";
import {
  createAgentSession, DefaultResourceLoader, ModelRuntime, SessionManager, SettingsManager,
} from "@earendil-works/pi-coding-agent";

it("real Pi 0.87.1 registry and Apply Patch execute only the reviewed operation, with no parent entries", async () => {
  const cwd = await mkdtemp(join(tmpdir(), "guardian-sdk-"));
  const agentDir = join(cwd, "agent");
  await mkdir(agentDir);
  const previous = process.env.PI_CODING_AGENT_DIR;
  process.env.PI_CODING_AGENT_DIR = agentDir;
  try {
    await writeFile(join(agentDir, "mikoto-policy.json"), JSON.stringify({
      escalation: "auto-review",
      filesystem: { allowWrite: [], denyWrite: [] },
      autoReview: { agent: { provider: "guardian-test", model: "review", thinkingLevel: "low" },
        policy: ["SDK custom rule"] },
    }));
    await writeFile(join(cwd, "evidence"), "read-only investigation");
    const runtime = await ModelRuntime.create({
      authPath: join(agentDir, "auth.json"), modelsPath: join(agentDir, "models.json"),
      modelsStorePath: join(agentDir, "models-store.json"), allowModelNetwork: false,
    });
    const parentModel = runtime.getModel("openai", "gpt-5.4")!;
    const settingsManager = SettingsManager.inMemory();
    const requests: TranscriptContext[] = [];
    let allow = true;
    let round = 0;
    let renderers = 0;
    const resources = new DefaultResourceLoader({
      cwd, agentDir, settingsManager,
      noExtensions: true, noSkills: true, noPromptTemplates: true, noThemes: true,
      additionalExtensionPaths: [
        fileURLToPath(new URL("../index.ts", import.meta.url)),
        fileURLToPath(new URL("../../mikoto-apply-patch/index.ts", import.meta.url)),
      ],
      extensionFactories: [(pi) => {
        pi.registerProvider("guardian-test", {
          api: "guardian-test-api", apiKey: "fake-local-key", baseUrl: "https://unused.invalid",
          models: [{ id: "review", name: "Review", reasoning: true, input: ["text"],
            cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, contextWindow: 200000, maxTokens: 8192 }],
          streamSimple(model, context, options) {
            requests.push(structuredClone(context));
            assert.equal(options?.reasoning, "low");
            const investigate = round++ === 0;
            const message: AssistantMessage = {
              role: "assistant", api: model.api, provider: model.provider, model: model.id,
              content: investigate
                ? [{ type: "toolCall", id: "inspect", name: "review_read", arguments: { path: join(cwd, "evidence") } }]
                : [{ type: "text", text: JSON.stringify({ outcome: allow ? "allow" : "deny", rationale: "Keep original\u001b[31m" }) }],
              stopReason: investigate ? "toolUse" : "stop", timestamp: Date.now(),
              usage: { input: 1, output: 1, totalTokens: 2, cacheRead: 0, cacheWrite: 0,
                cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
            };
            const stream = createAssistantMessageEventStream();
            queueMicrotask(() => {
              stream.push({ type: "start", partial: message });
              stream.push({ type: "done", reason: investigate ? "toolUse" : "stop", message });
              stream.end();
            });
            return stream;
          },
        });
      }],
    });
    await resources.reload();
    const manager = SessionManager.inMemory(cwd);
    manager.appendCustomEntry("mikoto-policy:escalation-decision", {
      version: 1, requestId: "old", result: { decision: "approve" },
    });
    manager.appendMessage({ role: "user", content: "Create result containing exact value", timestamp: 1 });
    const { session, extensionsResult } = await createAgentSession({
      cwd, agentDir, resourceLoader: resources, modelRuntime: runtime,
      model: { ...parentModel, compat: { ...parentModel.compat, supportsOpenAIGrammarTools: true } },
      settingsManager, sessionManager: manager,
    });
    try {
      assert.deepEqual(extensionsResult.errors, []);
      const errors: unknown[] = [];
      await session.bindExtensions({ mode: "print", onError: (error) => errors.push(error) });
      assert.deepEqual(errors, []);
      const before = structuredClone(manager.getEntries());
      const parentPrompt = session.systemPrompt;
      const tool = session.agent.state.tools.find((tool) => tool.name === "apply_patch")!;
      assert.ok(tool);
      const patch = "*** Begin Patch\n*** Add File: result\n+exact value\n*** End Patch";
      await tool.execute("patch", { patch });
      assert.equal(await readFile(join(cwd, "result"), "utf8"), "exact value\n");
      assert.equal(requests.length, 2);
      assert.deepEqual(getCurrentTools(requests[0]!.messages).map((tool) => tool.name),
        ["review_stat", "review_read", "review_list", "review_search"]);
      const returned = requests[1]!.messages.find((m) => m.role === "toolResult");
      assert.equal(returned?.role === "toolResult" && returned.toolCallId, "inspect");
      assert.ok(JSON.stringify(returned).includes("read-only investigation"));
      const evidence = requests[0]!.messages.find((m) => m.role === "user")!;
      const evidenceText = typeof evidence.content === "string" ? evidence.content :
        evidence.content.filter((block) => block.type === "text").map((block) => block.text).join("\n");
      assert.deepEqual(JSON.parse(evidenceText).action.input, { patch });
      allow = false;
      await assert.rejects(tool.execute("denied", {
        patch: "*** Begin Patch\n*** Delete File: result\n*** End Patch",
      }), /Keep original\\u\{1b\}\[31m/);
      assert.equal(requests.length, 3);
      assert.equal(await readFile(join(cwd, "result"), "utf8"), "exact value\n");
      assert.deepEqual(manager.getEntries(), before);
      assert.equal(session.systemPrompt, parentPrompt);
      for (const extension of extensionsResult.extensions) {
        renderers += extension.entryRenderers?.has("mikoto-policy:escalation-decision") ? 1 : 0;
      }
      assert.equal(renderers, 0);
    } finally {
      await session.extensionRunner.emit({ type: "session_shutdown", reason: "quit" });
      session.dispose();
    }
  } finally {
    if (previous === undefined) delete process.env.PI_CODING_AGENT_DIR;
    else process.env.PI_CODING_AGENT_DIR = previous;
    await rm(cwd, { recursive: true, force: true });
  }
});
