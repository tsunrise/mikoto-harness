const errors = {
  auth_unavailable: "Web authentication unavailable. Check Pi login.",
  upstream_auth_error: "OpenAI rejected web access. Check Pi login and endpoint access.",
  rate_limited: "Web search is busy or rate limited. Try again later.",
  upstream_timeout: "OpenAI web search timed out.",
  upstream_error: "OpenAI web search request failed.",
  invalid_upstream_response: "OpenAI returned an invalid web response.",
  response_too_large: "Web response exceeds the 100 MiB limit.",
} as const;

export class WebError extends Error {
  readonly code: keyof typeof errors;
  readonly upstreamStatus?: number;

  constructor(code: keyof typeof errors, upstreamStatus?: number) {
    super(errors[code]);
    this.code = code;
    this.upstreamStatus = upstreamStatus;
  }
}
