import { zstdDecompressSync } from "node:zlib";
import {
  InMemoryCredentialStore, InMemoryModelsStore, Type,
  type Model, type Api,
} from "@earendil-works/pi-ai";
import { stream as anthropicStream } from "@earendil-works/pi-ai/api/anthropic-messages";
import { stream as codexStream } from "@earendil-works/pi-ai/api/openai-codex-responses";
import { stream as responsesStream } from "@earendil-works/pi-ai/api/openai-responses";
import {
  createAgentSession, DefaultResourceLoader, ModelRuntime, SessionManager, SettingsManager,
  type ExtensionAPI, type ExtensionFactory, type ExtensionUIContext,
} from "@earendil-works/pi-coding-agent";
import plan from "../src/index.ts";

export const cwd = "/fixture/workspace with spaces";
export const basePrompt = "Base instructions: do not replace me.";
export const jwt = `x.${Buffer.from(JSON.stringify({
  "https://api.openai.com/auth": { chatgpt_account_id: "fixture-account" },
})).toString("base64url")}.x`;

export type FixtureApi = "openai-responses" | "openai-codex-responses" | "anthropic-messages";

export const apis: FixtureApi[] = ["openai-codex-responses", "openai-responses", "anthropic-messages"];

/** Wire role a model with mid-conversation system support uses for Pi system messages. */
export const nativeRole = (api: FixtureApi) => api === "anthropic-messages" ? "system" : "developer";

/** A 1x1 PNG, small enough to pass Pi's image resizing unchanged. */
export const png = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==";

export function model(api: FixtureApi = "openai-codex-responses", supportsMidConvoSystemMessages = true): Model<Api> {
  return {
    id: "fixture-model", name: "Fixture", api, provider: "plan-test",
    baseUrl: "https://fixture.invalid/v1", reasoning: true, input: ["text", "image"],
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    contextWindow: 200000, maxTokens: 4096,
    compat: { supportsMidConvoSystemMessages },
  };
}

export function sse(toolNames: string[] = [], text = "Done"): Response {
  const items = toolNames.length
    ? toolNames.map((name, i) => ({
      type: "function_call", id: `fc_${i}`, call_id: `call_${i}`, name,
      arguments: "{}", status: "completed",
    }))
    : [{
      type: "message", id: "msg_fixture", role: "assistant", status: "completed",
      content: [{ type: "output_text", text, annotations: [] }],
    }];
  const events: object[] = [{ type: "response.created", response: { id: "resp_fixture" } }];
  items.forEach((item, output_index) => {
    events.push({ type: "response.output_item.added", output_index, item });
    events.push({ type: "response.output_item.done", output_index, item });
  });
  events.push({
    type: "response.completed",
    response: {
      id: "resp_fixture", status: "completed", output: items,
      usage: { input_tokens: 10, output_tokens: 2, total_tokens: 12 },
    },
  });
  return new Response(events.map((event) => `data: ${JSON.stringify(event)}\n\n`).join(""), {
    headers: { "content-type": "text/event-stream" },
  });
}

export function anthropicSse(toolNames: string[] = [], text = "Done"): Response {
  const events: [string, object][] = [["message_start", {
    type: "message_start",
    message: {
      id: "msg_fixture", type: "message", role: "assistant", model: "fixture-model", content: [],
      usage: { input_tokens: 10, output_tokens: 0 },
    },
  }]];
  const blocks = toolNames.length
    ? toolNames.map((name, i) => ({
      start: { type: "tool_use", id: `toolu_${i}`, name, input: {} },
      delta: { type: "input_json_delta", partial_json: "{}" },
    }))
    : [{ start: { type: "text", text: "" }, delta: { type: "text_delta", text } }];
  blocks.forEach(({ start, delta }, index) => {
    events.push(["content_block_start", { type: "content_block_start", index, content_block: start }]);
    events.push(["content_block_delta", { type: "content_block_delta", index, delta }]);
    events.push(["content_block_stop", { type: "content_block_stop", index }]);
  });
  events.push(["message_delta", {
    type: "message_delta", delta: { stop_reason: toolNames.length ? "tool_use" : "end_turn" },
    usage: { output_tokens: 2 },
  }]);
  events.push(["message_stop", { type: "message_stop" }]);
  return new Response(events.map(([event, data]) => `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`).join(""), {
    headers: { "content-type": "text/event-stream" },
  });
}

export async function requestBody(input: RequestInfo | URL, init?: RequestInit): Promise<any> {
  const request = new Request(input, init);
  const bytes = Buffer.from(await request.arrayBuffer());
  return JSON.parse((request.headers.get("content-encoding") === "zstd"
    ? zstdDecompressSync(bytes) : bytes).toString());
}

export async function fixture(options: {
  model?: Model<Api>;
  sm?: SessionManager;
  before?: ExtensionFactory[];
  after?: ExtensionFactory[];
  response?: (requestNumber: number) => Response | Promise<Response>;
  transport?: "sse" | "websocket";
  question?: boolean;
  maxRetries?: number;
} = {}) {
  const currentModel = options.model ?? model();
  const sm = options.sm ?? SessionManager.inMemory(cwd);
  const requests: any[] = [];
  const providerContexts: any[] = [];
  const notifications: { text: string; level?: string }[] = [];
  const statuses = new Map<string, string | undefined>();
  const errors: unknown[] = [];
  let pi!: ExtensionAPI;
  const runtime = await ModelRuntime.create({
    credentials: new InMemoryCredentialStore(),
    modelsStore: new InMemoryModelsStore(),
    modelsPath: null, refreshOnCreate: false,
  });
  runtime.registerProvider("plan-test", {
    api: currentModel.api, apiKey: jwt, baseUrl: currentModel.baseUrl,
    models: [currentModel],
    streamSimple: (m, context, streamOptions) => {
      providerContexts.push(JSON.parse(JSON.stringify(context)));
      const fetch = async (input: RequestInfo | URL, init?: RequestInit) => {
        requests.push(await requestBody(input, init));
        if (options.response) return options.response(requests.length);
        return m.api === "anthropic-messages" ? anthropicSse() : sse();
      };
      if (m.api === "anthropic-messages") {
        return anthropicStream(m as Model<"anthropic-messages">, context, {
          ...streamOptions, apiKey: "fixture-key", maxRetries: options.maxRetries ?? 0, fetch,
        });
      }
      const stream = m.api === "openai-codex-responses" ? codexStream : responsesStream;
      return stream(m as Model<"openai-codex-responses"> & Model<"openai-responses">, context, {
        ...streamOptions, apiKey: jwt, transport: options.transport ?? "sse",
        maxRetries: options.maxRetries ?? 0, fetch,
      });
    },
  });
  const settings = SettingsManager.inMemory({
    compaction: { enabled: false }, retry: { enabled: false },
  });
  const loader = new DefaultResourceLoader({
    cwd, agentDir: "/fixture/empty-agent",
    noExtensions: true, noSkills: true, noPromptTemplates: true,
    noThemes: true, noContextFiles: true, settingsManager: settings,
    systemPrompt: basePrompt,
    extensionFactories: [
      ...(options.before ?? []),
      (api) => {
        pi = api;
        plan(api);
        for (const name of ["probe_a", "probe_b", ...(options.question === false ? [] : ["request_user_input"])]) {
          api.registerTool({
            name, label: name, description: `Fixture ${name}`, parameters: Type.Object({}),
            execute: async () => ({
              content: [{ type: "text", text: "<collaboration_mode>\ntool data</collaboration_mode>" }],
              details: {},
            }),
          });
        }
      },
      ...(options.after ?? []),
    ],
  });
  await loader.reload();
  const { session } = await createAgentSession({
    cwd, agentDir: "/fixture/empty-agent", resourceLoader: loader,
    modelRuntime: runtime, model: currentModel, thinkingLevel: "off",
    sessionManager: sm, settingsManager: settings, noTools: "builtin",
  });
  const ui = {
    notify: (text: string, level?: string) => notifications.push({ text, level }),
    setStatus: (key: string, value?: string) => statuses.set(key, value),
  } as unknown as ExtensionUIContext;
  await session.bindExtensions({ uiContext: ui, mode: "tui", onError: (error) => errors.push(error) });
  async function prompt(text: string) {
    await session.prompt(text);
    // sendUserMessage is fire-and-forget. Wait for its preflight and agent run.
    await new Promise<void>((resolve) => setImmediate(resolve));
    await session.agent.waitForIdle();
    await new Promise<void>((resolve) => setImmediate(resolve));
  }
  return { session, sm, pi, requests, providerContexts, notifications, statuses, errors, prompt };
}

/** First text of a Responses item or Anthropic message, whose content is a string or blocks. */
export function itemText(item: any): string | undefined {
  if (typeof item.content === "string") return item.content;
  if (!Array.isArray(item.content)) return undefined;
  return item.content.find((block: any) => typeof block.text === "string")?.text;
}

/** Text of the newest user prompt, skipping any instruction that follows it. */
export function lastPrompt(payload: any): string | undefined {
  const mode = new Set(modeItems(payload));
  const list: any[] = payload.input ?? payload.messages;
  return itemText(list.findLast((item) => item.role === "user" && !mode.has(item)));
}

/** Instruction-bearing items in a Responses `input` or Anthropic `messages` payload. */
export function modeItems(payload: any): any[] {
  return (payload.input ?? payload.messages).filter((item: any) =>
    itemText(item)?.startsWith("<collaboration_mode>\n"));
}
