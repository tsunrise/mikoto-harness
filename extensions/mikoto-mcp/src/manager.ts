import { CallToolResultSchema, ErrorCode as SdkErrorCode, McpError as SdkError } from "@modelcontextprotocol/sdk/types.js";
import { ArtifactStore, type defaultLimits } from "./artifacts.ts";
import { Cache } from "./cache.ts";
import { createAdapter, type Adapter, type AdapterFactory } from "./client.ts";
import { defaultCacheDir, defaultConfigPath, loadConfig, type ConfigEntry } from "./config.ts";
import { budget, McpError, wait } from "./errors.ts";
import { callable, callSchema, compare, encodeJson, freeze, MiB, validateTools, type CallRequest, type Query, type ServerSnapshot } from "./schema.ts";
import { SearchIndex } from "./search.ts";

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>(r => { resolve = r; });
  return { promise, resolve };
}
export type ServerStatus = {
  server: string; state: "pending" | "ready" | "disabled" | "skipped";
  catalog: "none" | "cached" | "fresh"; refreshedAt?: string; reason?: string;
};
export type Server = ConfigEntry & {
  state: ServerStatus["state"]; snapshot?: ServerSnapshot; fresh: boolean;
  connection: ReturnType<typeof deferred>; discovery: ReturnType<typeof deferred>;
  adapter?: Adapter;
};
export type ManagerOptions = {
  configPath?: string; cacheDir?: string; adapter?: AdapterFactory;
  discoveryMs?: number; callMs?: number; searchMs?: number; now?: () => number;
  artifactLimits?: Partial<typeof defaultLimits>;
};

export class Manager {
  readonly lifetime = new AbortController();
  operations = new AbortController();
  readonly artifacts: ArtifactStore;
  readonly bootstrap: Promise<void>;
  readonly servers = new Map<string, Server>();
  readonly cache: Cache;
  callRouteBound = false;
  unavailable = false;
  private active = 0;
  private background = new Set<Promise<unknown>>();
  private calls = new Set<Promise<unknown>>();
  private closing?: Promise<void>;
  private indices = new Map<string, SearchIndex>();
  private now: () => number;
  private notify: (server: string | undefined, reason: string) => void;
  readonly options: ManagerOptions;
  constructor(
    cwd: string, notify: (server: string | undefined, reason: string) => void,
    options: ManagerOptions = {},
  ) {
    this.notify = notify; this.options = options;
    this.now = options.now ?? Date.now;
    this.cache = new Cache(options.cacheDir ?? defaultCacheDir(), (s, r) => this.warn(s, r));
    this.artifacts = new ArtifactStore(this.lifetime.signal, r => this.notify(undefined, r), options.artifactLimits);
    this.bootstrap = this.start(cwd).catch(() => {
      if (this.lifetime.signal.aborted) return;
      this.unavailable = true;
      this.warn(undefined, "config_unavailable");
    });
  }
  private warn(server: string | undefined, reason: string) {
    if (!this.lifetime.signal.aborted) this.notify(server, reason);
  }
  private track(promise: Promise<unknown>) {
    this.background.add(promise);
    void promise.then(() => this.background.delete(promise), () => this.background.delete(promise));
  }
  private async start(cwd: string) {
    const config = await loadConfig(this.options.configPath ?? defaultConfigPath(), cwd);
    if (this.lifetime.signal.aborted) return;
    this.unavailable = config.unavailable;
    if (config.unavailable) { this.warn(undefined, "config_unavailable"); return; }
    await Promise.all(config.entries.map(async entry => {
      const server: Server = { ...entry, state: entry.config ? "pending" : "skipped",
        fresh: false, connection: deferred(), discovery: deferred() };
      this.servers.set(entry.server, server);
      if (!entry.config) {
        server.connection.resolve(); server.discovery.resolve();
        if (entry.reason === "invalid_config") this.warn(entry.server, entry.reason);
        return;
      }
      server.snapshot = await this.cache.read(entry.server, entry.fingerprint!);
    }));
    if (this.lifetime.signal.aborted) return;
    for (const server of this.servers.values()) {
      if (server.config) this.track(this.discover(server));
    }
  }
  private disable(server: Server, error: unknown) {
    if (this.lifetime.signal.aborted || server.state === "disabled") return;
    server.state = "disabled";
    server.reason = error instanceof McpError ? error.code : "discovery_failed";
    server.connection.resolve(); server.discovery.resolve();
    this.warn(server.server, server.reason);
    if (server.adapter) this.track(server.adapter.close());
  }
  private async discover(server: Server) {
    const ms = this.options.discoveryMs ?? 30_000;
    const deadline = this.now() + ms;
    const timer = budget([this.lifetime.signal], ms);
    const { signal } = timer;
    try {
      server.adapter = (this.options.adapter ?? createAdapter)(server.config!, e => this.disable(server, e));
      const toolsSupported = await wait(server.adapter.connect(signal, deadline), signal);
      this.assertServer(server);
      server.connection.resolve();
      const tools: unknown[] = [];
      const cursors = new Set<string>();
      let cursor: string | undefined;
      if (toolsSupported) for (let page = 0; ; page++) {
        if (page >= 100) throw new McpError("invalid_result");
        const result = await wait(server.adapter.list(cursor, signal, deadline), signal);
        signal.throwIfAborted();
        if (!Array.isArray(result.tools)) throw new McpError("invalid_result");
        tools.push(...validateTools(result.tools));
        if (tools.length > 5000) throw new McpError("result_too_large");
        encodeJson(tools, 16 * MiB);
        cursor = result.nextCursor;
        if (cursor === undefined) break;
        if (typeof cursor !== "string" || cursors.has(cursor)) throw new McpError("invalid_result");
        cursors.add(cursor);
      }
      const snapshot: ServerSnapshot = {
        version: 1, server: server.server, configFingerprint: server.fingerprint!,
        refreshedAt: new Date(this.now()).toISOString(), tools: validateTools(tools),
      };
      encodeJson(snapshot, 16 * MiB);
      signal.throwIfAborted();
      this.assertServer(server);
      server.snapshot = freeze(snapshot);
      server.fresh = true; server.state = "ready";
      server.discovery.resolve();
      timer.dispose();
      // Disk delivery is not discovery: a write failure leaves the fresh catalog usable.
      try { await this.cache.write(snapshot, this.lifetime.signal); }
      catch { this.warn(server.server, "cache_write_failed"); }
    } catch (error) { this.disable(server, error); }
    finally {
      timer.dispose();
      server.connection.resolve(); server.discovery.resolve();
      if ((signal.aborted || server.state === "disabled") && server.adapter) await server.adapter.close();
    }
  }
  private assertServer(server: Server) {
    this.lifetime.signal.throwIfAborted();
    if (server.state === "disabled" || server.state === "skipped")
      throw new McpError(server.reason === "unsupported_auth" ? "unsupported_auth" : "server_disabled");
  }
  private assertAvailable() {
    this.lifetime.signal.throwIfAborted();
    if (this.unavailable) throw new McpError("config_unavailable");
  }
  status(server: Server): ServerStatus {
    return {
      server: server.server, state: server.state, catalog: !server.snapshot ? "none" : server.fresh ? "fresh" : "cached",
      ...(server.snapshot ? { refreshedAt: server.snapshot.refreshedAt } : {}),
      ...(server.reason ? { reason: server.reason } : {}),
    };
  }
  async inspect() {
    await this.bootstrap;
    this.assertAvailable();
    return [...this.servers.values()].sort((a, b) => compare(a.server, b.server));
  }
  private select(server?: string) {
    return [...this.servers.values()].filter(s => server === undefined || s.server === server)
      .sort((a, b) => compare(a.server, b.server));
  }
  async search(queries: Query[], caller?: AbortSignal) {
    const timer = budget([this.lifetime.signal, this.operations.signal, ...(caller ? [caller] : [])], this.options.searchMs ?? 55_000);
    const signal = timer.signal;
    try {
      await wait(this.bootstrap, signal);
      this.assertAvailable();
      const selected = new Set(queries.flatMap(q => this.select(q.server)));
      try {
        await wait(Promise.all([...selected].filter(s => !s.snapshot).map(s => s.discovery.promise)), signal);
      } catch {
        // Deadline returns a partial point-in-time result; caller/navigation abort
        // is still a normal Pi cancellation, not a fabricated successful search.
        if (!(signal.reason instanceof McpError && signal.reason.code === "call_timeout")) throw signal.reason;
      }
      this.assertAvailable();
      const results = queries.map((query, index) => {
        const servers = this.select(query.server);
        const snapshots = servers.filter(s => s.state !== "disabled" && s.state !== "skipped" && s.snapshot).map(s => s.snapshot!);
        const key = query.server === undefined ? "all" : `server:${query.server}`;
        const search = this.indices.get(key) ?? new SearchIndex();
        if (servers.length || query.server === undefined) this.indices.set(key, search);
        search.update(snapshots);
        return {
          index, query: query.query,
          tools: search.search(query.query, query.limit).map(({ server, tool, snapshot }) => ({
            server, name: tool.name, ...(tool.title === undefined ? {} : { title: tool.title }),
            ...(tool.description === undefined ? {} : { description: tool.description }),
            inputSchema: tool.inputSchema,
            ...(tool.outputSchema === undefined ? {} : { outputSchema: tool.outputSchema }),
            ...(tool.annotations === undefined ? {} : { annotations: tool.annotations }),
            catalog: this.servers.get(server)!.fresh ? "fresh" as const : "cached" as const, refreshedAt: snapshot.refreshedAt,
          })),
          servers: servers.map(s => this.status(s)),
          partial: servers.some(s => s.state !== "ready"),
          ...(query.server !== undefined && !servers.length
            ? { error: { code: "unknown_server" as const, message: "No configured server has that name." } } : {}),
        };
      });
      return { results, callRouteBound: this.callRouteBound };
    } finally { timer.dispose(); }
  }

  call(input: CallRequest, caller: AbortSignal) {
    const promise = this.performCall(input, caller);
    this.calls.add(promise);
    void promise.then(() => this.calls.delete(promise), () => this.calls.delete(promise));
    return promise;
  }
  private async performCall(input: CallRequest, caller: AbortSignal) {
    const ms = this.options.callMs ?? 55_000;
    const deadline = this.now() + ms;
    const timer = budget([caller, this.lifetime.signal, this.operations.signal], ms);
    const signal = timer.signal;
    let dispatched = false, completed = false;
    let reservation: ReturnType<ArtifactStore["reserve"]> | undefined;
    if (this.active >= 4) { timer.dispose(); throw new McpError("busy"); }
    this.active++;
    try {
      const parsed = callSchema.safeParse(input);
      if (!parsed.success) throw new McpError("invalid_input");
      const request = parsed.data;
      await wait(this.bootstrap, signal);
      this.assertAvailable();
      const server = this.servers.get(request.server);
      if (!server) throw new McpError("unknown_server");
      this.assertServer(server);
      if (!server.snapshot || (!server.snapshot.tools.some(t => t.name === request.name) && server.state === "pending"))
        await wait(server.discovery.promise, signal);
      this.assertServer(server);
      await wait(server.connection.promise, signal);
      signal.throwIfAborted();
      this.assertServer(server);
      const tool = server.snapshot?.tools.find(t => t.name === request.name);
      if (!tool) throw new McpError("unknown_tool");
      if (!callable(tool)) throw new McpError("unsupported_tool");
      if (this.now() >= deadline) throw new McpError("call_timeout");
      reservation = this.artifacts.reserve();
      const catalog = server.fresh ? "fresh" as const : "cached" as const;
      dispatched = true;
      let raw: unknown;
      try { raw = await wait(server.adapter!.call(request.name, request.arguments, signal, deadline), signal); }
      catch (error) {
        if (signal.aborted) throw signal.reason;
        if (server.state === "disabled") throw new McpError(server.reason === "unsupported_auth" ? "unsupported_auth"
          : server.reason === "result_too_large" ? "result_too_large" : "transport_error");
        // SDK schema failures are invalid results; JSON-RPC errors are ordinary
        // per-call failures and must not disable a healthy transport.
        if (error instanceof Error && error.name === "ZodError") throw new McpError("invalid_result");
        if (error instanceof SdkError && error.code === SdkErrorCode.RequestTimeout) throw new McpError("call_timeout");
        throw error instanceof McpError ? error : new McpError("mcp_error");
      }
      encodeJson(raw, this.artifacts.limits.wire);
      const result = CallToolResultSchema.safeParse(raw);
      if (!result.success) throw new McpError("invalid_result");
      const prepared = this.artifacts.prepare(result.data);
      completed = true;
      if (this.now() >= deadline) throw new McpError("call_timeout");
      const projected = await this.artifacts.project(result.data, reservation, signal, prepared);
      signal.throwIfAborted();
      if (this.now() >= deadline) throw new McpError("call_timeout");
      return { server: request.server, name: request.name, catalog, ...projected };
    } catch (error) {
      const e = signal.aborted ? (signal.reason instanceof McpError ? signal.reason : new McpError("call_timeout"))
        : error instanceof McpError ? error : new McpError("mcp_error");
      if (completed) e.executionCompleted = true;
      else if (dispatched) e.outcomeUnknown = true;
      throw e;
    } finally { reservation?.finish(); this.active--; timer.dispose(); }
  }
  navigate() { this.operations.abort(); this.operations = new AbortController(); }
  close(): Promise<void> {
    return this.closing ??= (async () => {
      this.lifetime.abort(); this.operations.abort();
      for (const s of this.servers.values()) { s.connection.resolve(); s.discovery.resolve(); }
      await this.bootstrap;
      await Promise.allSettled([...this.servers.values()].map(s => s.adapter?.close()));
      await Promise.allSettled(this.background);
      await Promise.allSettled(this.calls);
      await this.cache.settled();
      await this.artifacts.close();
    })();
  }
}
