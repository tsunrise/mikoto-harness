import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import {
  createAssistantMessageEventStream, getCurrentTools,
  type AssistantMessage, type TranscriptContext,
} from "@earendil-works/pi-ai";
import {
  createAgentSession, createCodemodeExtension, DefaultResourceLoader,
  ModelRuntime, SessionManager, SettingsManager, type ToolCallEvent,
} from "@earendil-works/pi-coding-agent";
import { registerWeb } from "../src/index.ts";

// These are local model stubs, not claims of live provider/cache measurements.
// Both use JSON code arguments, so this exercises the path without raw input
// or mid-conversation tool declarations.
for (const [provider, api, id] of [
  ["anthropic", "anthropic-messages", "claude-opus-5-5"],
  ["cloudflare-workers-ai", "openai-completions", "@zai-org/glm-5.3"],
] as const) {
  test(`real codemode discovery/execution keeps declarations stable for ${provider}`, { timeout: 30000 }, async () => {
    const fixtureProvider = `fixture-${provider}`;
    const cwd = await mkdtemp(join(tmpdir(), "web-codemode-"));
    const settings = SettingsManager.inMemory({ defaultTools: ["codemode"], retry: { enabled: false } });
    const runtime = await ModelRuntime.create({
      authPath: join(cwd, "auth.json"), modelsPath: null,
      modelsStorePath: join(cwd, "models.json"), allowModelNetwork: false,
    });
    await runtime.setRuntimeApiKey("openai", "fixture-openai-key");
    const requests: TranscriptContext[] = [];
    const nested: ToolCallEvent[] = [];
    const sent: any[] = [];
    const scripts = [
      `const ns = await describeNamespace("web");
       if (!ns || !ns.instructions || !ns.tools.includes("web_run")) throw Error("namespace missing");
       const found = await searchTools("search public web", { namespace: "web" });
       if (!found.some(t => t.name === "web_run")) throw Error("discovery missing");
       text(await describeTool("web_run"));`,
      `const r = await tools.web_run({ search_query: [{ q: "fixture" }] });
       if (r.output !== "redacted-fixture" || r.results[0].ref_id !== "fixture-ref") throw Error("structured result lost");
       store("source", r.results[0].ref_id);
       text(r.output);`,
      `if (load("source") !== "fixture-ref") throw Error("store lost");
       const results = await Promise.allSettled([
         tools.web_run({ search_query: [{ q: "blocked" }] }),
         tools.web_run({ unsupported: true })
       ]);
       if (!results.every(r => r.status === "rejected")) throw Error("pipeline bypass");
       text("checked-fixture");`,
    ];
    let round = 0;
    const loader = new DefaultResourceLoader({
      cwd, agentDir: cwd, settingsManager: settings,
      noExtensions: true, noSkills: true, noContextFiles: true, noPromptTemplates: true, noThemes: true,
      extensionFactories: [
        createCodemodeExtension({ mode: "on" }),
        (pi) => {
          pi.registerProvider(fixtureProvider, {
            api, apiKey: "fixture-model-key", baseUrl: "https://unused.invalid",
            models: [{
              id, name: id, reasoning: false, input: ["text"],
              cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
              contextWindow: 200000, maxTokens: 8192,
            }],
            streamSimple(model, context) {
              requests.push(structuredClone(context));
              const code = scripts[round++];
              const message: AssistantMessage = {
                role: "assistant", api: model.api, provider: model.provider, model: model.id,
                content: code
                  ? [{ type: "toolCall", name: "codemode", id: `script-${round}`, arguments: { code } }]
                  : [{ type: "text", text: "fixture-done" }],
                stopReason: code ? "toolUse" : "stop", timestamp: Date.now(),
                usage: { input: 1, output: 1, totalTokens: 2, cacheRead: 0, cacheWrite: 0,
                  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
              };
              const stream = createAssistantMessageEventStream();
              queueMicrotask(() => {
                stream.push({ type: "start", partial: message });
                stream.push({ type: "done", reason: code ? "toolUse" : "stop", message });
                stream.end();
              });
              return stream;
            },
          });
          registerWeb(pi, { fetch: async (_url, init) => {
            sent.push(JSON.parse(init!.body as string));
            return Response.json({ output: "private-fixture", results: [{ ref_id: "fixture-ref" }] });
          } });
          pi.on("tool_call", (event) => {
            if (event.toolName !== "web_run") return;
            nested.push(event);
            const commands = event.input as { search_query?: { q: string }[] };
            if (commands.search_query?.[0]?.q === "blocked") return { block: true, reason: "fixture denied" };
            commands.search_query![0].q = "hook-edited-fixture";
          });
          pi.on("tool_result", (event) => {
            if (event.toolName !== "web_run" || event.isError) return;
            return {
              content: [{ type: "text", text: "redacted-fixture" }],
              structuredContent: { output: "redacted-fixture", results: [{ ref_id: "fixture-ref" }], truncated: false },
            };
          });
        },
      ],
    });
    let session: Awaited<ReturnType<typeof createAgentSession>>["session"] | undefined;
    try {
      await loader.reload();
      const created = await createAgentSession({
        cwd, agentDir: cwd, modelRuntime: runtime,
        resourceLoader: loader, settingsManager: settings, sessionManager: SessionManager.inMemory(cwd),
      });
      session = created.session;
      assert.deepEqual(created.extensionsResult.errors, []);
      const model = runtime.getModel(fixtureProvider, id);
      assert.ok(model);
      await runtime.setRuntimeApiKey(fixtureProvider, "fixture-model-key");
      await session.setModel(model);
      await session.bindExtensions({});
      await session.prompt("fixture");
      assert.equal(requests.length, scripts.length + 1, JSON.stringify(
        session.messages.filter((message) => message.role === "assistant"),
      ));
      const initialTools = getCurrentTools(requests[0].messages);
      assert.deepEqual(initialTools.map((tool) => tool.name), ["codemode"]);
      for (const request of requests) {
        assert.deepEqual(getCurrentTools(request.messages), initialTools);
      }
      assert.deepEqual(session.getActiveToolNames(), ["codemode"]);
      const results = session.messages.filter((message) => message.role === "toolResult");
      assert.equal(results.length, scripts.length);
      assert.ok(results.every((result) => !result.isError), JSON.stringify(results));
      assert.equal(sent.length, 1);
      assert.equal(sent[0].model, "gpt-5.4");
      assert.equal(sent[0].commands.search_query[0].q, "hook-edited-fixture");
      assert.ok(nested.length >= 2);
      assert.ok(nested.every((event) => event.parentToolCallId?.startsWith("script-")));
    } finally {
      if (session) {
        await session.extensionRunner.emit({ type: "session_shutdown", reason: "quit" });
        session.dispose();
      }
      await rm(cwd, { recursive: true, force: true });
    }
  });
}
