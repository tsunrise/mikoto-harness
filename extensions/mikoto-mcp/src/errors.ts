const failures = {
  unknown_server: [404, "No configured server has that name."],
  unknown_tool: [404, "The current catalog does not contain that tool."],
  unsupported_tool: [422, "This tool requires MCP tasks, which are not supported."],
  busy: [429, "Four MCP calls are already active."],
  mcp_error: [502, "The MCP protocol request failed. Calls are never automatically retried."],
  invalid_result: [502, "The server returned an invalid MCP result."],
  result_too_large: [502, "The MCP result exceeded its size limit."],
  transport_error: [502, "The MCP connection failed. Reload to reconnect."],
  config_unavailable: [503, "MCP configuration is unavailable. Check configuration and reload."],
  server_disabled: [503, "This MCP server is disabled until reload."],
  unsupported_auth: [503, "This server requires unsupported authentication. Use static credentials and reload."],
  call_timeout: [504, "The MCP operation exceeded its total deadline. Do not automatically retry."],
  artifact_capacity: [507, "Runtime artifact capacity is exhausted. No tool was dispatched."],
  artifact_write_failed: [507, "Output delivery failed. Do not repeat the call to recover its output."],
  search_result_too_large: [502, "Search output is too large. Use smaller limits or separate batches."],
  invalid_input: [400, "Invalid MCP request."],
} as const;

export type ErrorCode = keyof typeof failures;
export class McpError extends Error {
  readonly code: ErrorCode;
  readonly status: number;
  outcomeUnknown?: boolean;
  executionCompleted?: boolean;
  constructor(code: ErrorCode) {
    super(failures[code][1]);
    this.code = code;
    this.status = failures[code][0];
  }
}

export function safeName(value: string, bound = 128): string {
  return value.replace(/\x1b(?:\][^\x07]*(?:\x07|\x1b\\)|\[[0-?]*[ -/]*[@-~])/g, "")
    .replace(/[\p{Cc}\p{Cf}\p{Zl}\p{Zp}]/gu, "").slice(0, bound);
}

export function errorResponse(error: unknown, server?: string, name?: string) {
  const e = error instanceof McpError ? error : new McpError("mcp_error");
  return jsonResponse({
    error: {
      code: e.code, message: e.message,
      ...(server === undefined ? {} : { server }),
      ...(name === undefined ? {} : { name }),
      ...(e.outcomeUnknown ? { outcomeUnknown: true } : {}),
      ...(e.executionCompleted ? { executionCompleted: true } : {}),
    },
  }, e.status);
}

export function jsonResponse(value: unknown, status = 200) {
  return {
    status,
    headers: { "content-type": "application/json", "cache-control": "no-store" },
    body: JSON.stringify(value),
  };
}

// A waiter owns only its abort listener, never the shared discovery promise.
export function wait<T>(promise: Promise<T>, signal: AbortSignal): Promise<T> {
  signal.throwIfAborted();
  return new Promise((resolve, reject) => {
    const abort = () => { cleanup(); reject(signal.reason); };
    const cleanup = () => signal.removeEventListener("abort", abort);
    signal.addEventListener("abort", abort, { once: true });
    promise.then(value => { cleanup(); resolve(value); }, error => { cleanup(); reject(error); });
  });
}

export function budget(signals: AbortSignal[], ms: number) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(new McpError("call_timeout")), ms);
  return { signal: AbortSignal.any([...signals, controller.signal]), dispose: () => clearTimeout(timer) };
}
