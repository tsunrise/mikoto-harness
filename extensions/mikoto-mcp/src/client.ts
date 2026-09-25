import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { SSEClientTransport } from "@modelcontextprotocol/sdk/client/sse.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { CallToolResultSchema, ListToolsResultSchema, type CallToolResult, type ListToolsResult } from "@modelcontextprotocol/sdk/types.js";
import type { Transport } from "@modelcontextprotocol/sdk/shared/transport.js";
import type { TransportConfig } from "./config.ts";
import { McpError, wait } from "./errors.ts";
import { MiB } from "./schema.ts";

export interface Adapter {
  connect(signal: AbortSignal, deadline: number): Promise<boolean>;
  list(cursor: string | undefined, signal: AbortSignal, deadline: number): Promise<ListToolsResult>;
  call(name: string, args: Record<string, unknown>, signal: AbortSignal, deadline: number): Promise<CallToolResult>;
  close(): Promise<void>;
}
export type AdapterFactory = (config: TransportConfig, fatal: (error: McpError) => void) => Adapter;

// Count bytes before the SDK's JSON/SSE parsers accumulate them. For SSE the
// bound resets at each empty line, not at each network chunk or HTTP response.
export function boundedBody(body: ReadableStream<Uint8Array>, sse: boolean, max: number): ReadableStream<Uint8Array> {
  let bytes = 0, line = 0, cr = false;
  return body.pipeThrough(new TransformStream<Uint8Array, Uint8Array>({
    transform(chunk, controller) {
      if (!sse) {
        bytes += chunk.byteLength;
        if (bytes > max) throw new McpError("result_too_large");
      } else for (const byte of chunk) {
        if (cr && byte === 10) { cr = false; continue; }
        cr = false;
        if (++bytes > max) throw new McpError("result_too_large");
        if (byte === 10 || byte === 13) {
          if (!line) bytes = 0;
          line = 0;
          cr = byte === 13;
        } else line++;
      }
      controller.enqueue(chunk);
    },
  }));
}

export function createAdapter(
  config: TransportConfig, fatal: (error: McpError) => void,
  options: { fetch?: typeof fetch; maxMessageBytes?: number; now?: () => number } = {},
): Adapter {
  const client = new Client({ name: "mikoto-mcp", version: "0.1.0" }, { capabilities: {} });
  const lifetime = new AbortController();
  const max = options.maxMessageBytes ?? 64 * MiB;
  const now = options.now ?? Date.now;
  let closing: Promise<void> | undefined;
  const readers = new Set<ReadableStreamDefaultReader<Uint8Array>>();
  let transport: Transport;
  let failure: McpError | undefined;
  const fail = (error: unknown) => {
    if (lifetime.signal.aborted || failure) return;
    failure = error instanceof McpError ? error : new McpError("transport_error");
    fatal(failure);
    void close();
  };
  const hostFetch: typeof fetch = async (input, init) => {
    try {
      const url = new URL(input instanceof Request ? input.url : String(input));
      if (config.type === "stdio" || url.origin !== new URL(config.url).origin) throw new McpError("transport_error");
      // Streamable HTTP's standalone GET stream only carries server-initiated
      // messages, which this client never consumes. Servers and proxies end it
      // on idle/response deadlines, and the SDK reports every such end as a
      // transport error, which would disable a healthy server mid-session.
      // Decline it the way servers without that stream do (405, per spec).
      const method = (init?.method ?? (input instanceof Request ? input.method : "GET")).toUpperCase();
      if (config.type === "http" && method === "GET") return new Response(null, { status: 405 });
      const response = await (options.fetch ?? fetch)(input, {
        ...init, redirect: "error",
        signal: AbortSignal.any([lifetime.signal, ...(init?.signal ? [init.signal] : [])]),
      });
      if (response.status === 401 || response.status === 403) {
        await response.body?.cancel();
        throw new McpError("unsupported_auth");
      }
      if (!response.body) return response;
      const sse = response.headers.get("content-type")?.split(";")[0].trim().toLowerCase() === "text/event-stream";
      const reader = boundedBody(response.body, sse, max).getReader();
      readers.add(reader);
      let canceled = false;
      const stream = new ReadableStream<Uint8Array>({
        async pull(controller) {
          try {
            const { done, value } = await reader.read();
            // The SDK discards HTTP 202 bodies after sending notifications.
            // Canceling our reader settles a pending read, but the outer stream
            // is already closed by then. Closing/enqueuing again would turn an
            // ordinary discard into a fatal connection error.
            if (canceled) return;
            if (done) { readers.delete(reader); controller.close(); }
            else controller.enqueue(value);
          } catch (error) {
            readers.delete(reader);
            if (canceled) return;
            controller.error(error);
            fail(error);
          }
        },
        async cancel() { canceled = true; readers.delete(reader); await reader.cancel().catch(() => {}); },
      });
      return new Response(stream, { status: response.status, statusText: response.statusText, headers: response.headers });
    } catch (error) {
      fail(error);
      throw failure ?? new McpError("transport_error");
    }
  };
  if (config.type === "stdio") {
    const stdio = new StdioClientTransport({ ...config, stderr: "pipe", maxBufferSize: max });
    stdio.stderr?.on("data", () => {});
    transport = stdio;
  } else {
    const opts = { fetch: hostFetch, requestInit: { headers: config.headers, redirect: "error" as const } };
    transport = config.type === "sse" ? new SSEClientTransport(new URL(config.url), opts)
      : new StreamableHTTPClientTransport(new URL(config.url), {
        ...opts, reconnectionOptions: { maxRetries: 0, initialReconnectionDelay: 1000, maxReconnectionDelay: 1000, reconnectionDelayGrowFactor: 1 },
      });
  }
  client.onerror = fail;
  client.onclose = () => fail(new McpError("transport_error"));
  function close(): Promise<void> {
    if (closing) return closing;
    lifetime.abort(failure ?? new McpError("transport_error"));
    // Own the transport directly too: SSE can be awaiting its first endpoint
    // before Client.connect has completed. Abandoning that promise leaks a stream.
    closing = Promise.allSettled([transport.close(), ...[...readers].map(reader => reader.cancel())]).then(() => {
      readers.clear();
    });
    return closing;
  }
  const requestOptions = (signal: AbortSignal, deadline: number) => {
    signal.throwIfAborted();
    const timeout = deadline - now();
    if (timeout <= 0) throw new McpError("call_timeout");
    return { signal, timeout, resetTimeoutOnProgress: false };
  };
  return {
    async connect(signal, deadline) {
      const abort = () => { void close(); };
      signal.addEventListener("abort", abort, { once: true });
      try {
        await wait(client.connect(transport, requestOptions(signal, deadline)), AbortSignal.any([signal, lifetime.signal]));
        signal.throwIfAborted();
        if (failure) throw failure;
        return !!client.getServerCapabilities()?.tools;
      } finally { signal.removeEventListener("abort", abort); }
    },
    async list(cursor, signal, deadline) {
      return client.request({ method: "tools/list", params: cursor === undefined ? {} : { cursor } },
        ListToolsResultSchema, requestOptions(signal, deadline));
    },
    async call(name, args, signal, deadline) {
      // listTools()/callTool() maintain SDK-private per-page metadata and compile
      // output schemas. Our immutable complete catalog owns both decisions.
      return client.request({ method: "tools/call", params: { name, arguments: args } },
        CallToolResultSchema, requestOptions(signal, deadline));
    },
    close,
  };
}
