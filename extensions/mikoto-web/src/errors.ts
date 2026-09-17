const errors = {
  auth_unavailable: [503, "Web authentication unavailable. Check Pi login and reload."],
  upstream_auth_error: [502, "OpenAI rejected web access. Check Pi login and endpoint access."],
  rate_limited: [429, "Web search is busy or rate limited. Try again later."],
  upstream_timeout: [504, "OpenAI web search timed out."],
  upstream_error: [502, "OpenAI web search request failed."],
  invalid_upstream_response: [502, "OpenAI returned an invalid web response."],
  response_too_large: [502, "Web response exceeds the 100 MiB limit."],
} as const;

export class WebError extends Error {
  readonly code: keyof typeof errors;
  readonly status: number;
  readonly upstreamStatus?: number;

  constructor(code: keyof typeof errors, upstreamStatus?: number) {
    super(errors[code][1]);
    this.code = code;
    this.status = errors[code][0];
    this.upstreamStatus = upstreamStatus;
  }
}

export function errorResponse(error: unknown) {
  const safe = error instanceof WebError ? error : new WebError("upstream_error");
  return {
    status: safe.status,
    headers: { "content-type": "application/json", "cache-control": "no-store" },
    body: JSON.stringify({
      error: {
        code: safe.code,
        message: safe.message,
        ...(safe.upstreamStatus === undefined ? {} : { upstream_status: safe.upstreamStatus }),
      },
    }),
  };
}
