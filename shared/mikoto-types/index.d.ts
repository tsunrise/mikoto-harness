/**
 * Payload accepted by the `mikoto-sound:sound` inter-extension event.
 *
 * An omitted effect selects `require-attention`.
 */
export type MikotoSoundEvent = {
	readonly effect?: string;
};

/**
 * Structured-cloneable effective Mikoto filesystem policy.
 *
 * Paths are normalized absolute canonical paths resolved and pinned when the
 * policy is loaded. This document contains data only; evaluation methods are
 * exposed by the policy service that owns it.
 */
export type MikotoPolicyDocument = {
  readonly filesystem: {
    readonly denyRead: readonly string[];
    readonly allowRead: readonly string[];
    readonly allowWrite: readonly string[];
    readonly denyWrite: readonly string[];
  };
  /**
   * Lowercase ASCII DNS names, *.subdomain patterns (not the apex), or
   * canonical dotted-decimal IPv4, with optional :port (1–65535).
   * Only denies may use * or *:port. No URLs, IPv6, CIDR, or other globs.
   */
  readonly network: {
    readonly allowedDomains: readonly string[];
    readonly deniedDomains: readonly string[];
    /**
     * Permit direct loopback TCP from sandboxed commands: connecting to any
     * localhost port plus binding/listening locally. Domain rules do not apply
     * to these direct connections.
     */
    readonly allowLocalBinding: boolean;
    /**
     * Normalized absolute canonical Unix socket paths (and descendants) that
     * sandboxed commands may bind or connect to.
     */
    readonly allowUnixSockets: readonly string[];
  };
};

export type MikotoPolicyLoadDiagnostic =
  | {
      readonly kind: "invalid_layer" | "unreadable_layer" | "optional_absence" | "untrusted_workspace";
      readonly path: string;
    }
  | {
      readonly kind: "canonical_rule";
      readonly rule: keyof MikotoPolicyDocument["filesystem"] | "allowUnixSockets";
      readonly path: string;
    };

export type MikotoPolicyDecision =
  | {
      readonly allowed: true;
    }
  | {
      readonly allowed: false;
      /** Canonical path responsible for the denial. */
      readonly deniedPath: string;
    };

export type MikotoPolicy = {
  /** Returns the immutable canonical policy document. */
  document(): MikotoPolicyDocument;
  /** Immutable load facts; native file fallback semantics are unchanged. */
  diagnostics(): readonly MikotoPolicyLoadDiagnostic[];
  readonly permissionMdPath: string;
  /**
   * Converts a possibly relative Pi tool path to an absolute lexical path
   * accepted by canonicalizePath().
   *
   * Relative paths are resolved against the policy's session working
   * directory.
   */
  resolveToolPath(path: string): string;
  /**
   * Resolves symlinks in an absolute lexical path and appends missing suffixes
   * to their deepest canonical ancestor.
   */
  canonicalizePath(lexicalPath: string): Promise<string>;
  /**
   * Evaluates without inspecting the filesystem or checking for symlinks.
   * @param path Normalized absolute canonical path.
   */
  evaluateRead(canonicalPath: string): Promise<MikotoPolicyDecision>;
  /**
   * Evaluates without inspecting the filesystem or checking for symlinks.
   * @param path Normalized absolute canonical path.
   */
  evaluateReadTree(canonicalPath: string): Promise<MikotoPolicyDecision>;
  /**
   * Evaluates without inspecting the filesystem or checking for symlinks.
   * @param path Normalized absolute canonical path.
   */
  evaluateWrite(canonicalPath: string): Promise<MikotoPolicyDecision>;
};

export type MikotoPolicyGetPolicyEvent = {
  readonly callback: (
    policy: MikotoPolicy,
  ) => void | Promise<void>;
};

export type MikotoEscalationResult =
  | { readonly decision: "approve" }
  | {
      readonly decision: "reject";
      /** "user" also includes the user's delegated reviewer or always-deny setting. */
      readonly cause:
        | "user"
        | "interrupted"
        | "cancelled"
        | "non_interactive"
        | "unavailable"
        | "busy"
        | "shutdown"
        | "error";
      /** User, delegated reviewer, or configured always-deny rejection reason. */
      readonly reason?: string;
    };

/** JSON-only data; numbers must be finite. Disclose all authorization-relevant inputs. */
export type MikotoReviewValue =
  | null | boolean | number | string
  | readonly MikotoReviewValue[]
  | { readonly [key: string]: MikotoReviewValue };

export type MikotoEscalationAction = Readonly<{
  toolName: string;
  input: MikotoReviewValue;
  context?: MikotoReviewValue;
}>;

/** Trusted in-process decision service, not an executor or reusable grant. */
export type MikotoPolicyEscalateEvent = {
  readonly requestId: string;
  readonly source: string;
  readonly action: MikotoEscalationAction;
  readonly why: string;
  readonly signal: AbortSignal;
  /**
   * Reserve synchronously before any await. Only the first receiver in dispatch
   * order wins; this is not agreement among multiple policies.
   */
  readonly claim: () => boolean;
  /** The claimant completes once; it catches/logs callback throws/rejections. */
  readonly callback: (result: MikotoEscalationResult) => void | Promise<void>;
};

/** Structural public Zod 4 slice; producers supply a live Zod schema. */
export type MikotoGardenBodySchema<Body = unknown> = {
  safeParseAsync(input: unknown): Promise<
    | { readonly success: true; readonly data: Body }
    | { readonly success: false; readonly error: unknown }
  >;
};

export type MikotoGardenCapabilityRequest<Body = unknown> = {
  readonly method: "GET" | "POST";
  readonly path: `/${string}`;
  readonly headers: Readonly<Record<string, string>>;
  readonly body: Body;
  readonly signal: AbortSignal;
};

export type MikotoGardenCapabilityResponse = {
  readonly status: number;
  readonly body?: string;
  readonly headers?: Readonly<Record<string, string>>;
};

export type MikotoGardenBindResult =
  | { readonly ok: true; readonly bindingId: string; readonly dispose: () => void }
  | { readonly ok: false; readonly reason: string };

export type MikotoGardenBindEvent<Body = unknown> = {
  readonly owner: string;
  readonly method: "GET" | "POST";
  readonly path: `/${string}`;
  /** POST defaults to JSON. GET accepts no body. */
  readonly bodyFormat?: "json" | "text";
  readonly bodySchema: MikotoGardenBodySchema<Body>;
  readonly handler: (
    request: MikotoGardenCapabilityRequest<NoInfer<Body>>,
  ) => Promise<MikotoGardenCapabilityResponse>;
  /** One healthy receiver acknowledges once; callbacks may throw. */
  readonly callback?: (result: MikotoGardenBindResult) => void;
};

/** Compile-time source of truth for Mikoto inter-extension event channels. */
export type MikotoEventMap = {
	readonly "mikoto-sound:sound": MikotoSoundEvent;
  readonly "mikoto-policy:get-policy": MikotoPolicyGetPolicyEvent;
  readonly "mikoto-policy:escalate": MikotoPolicyEscalateEvent;
  readonly "mikoto-garden:bind": MikotoGardenBindEvent;
};

export type MikotoEventName = keyof MikotoEventMap;

export type MikotoEventPayload<Name extends MikotoEventName> =
	MikotoEventMap[Name];

/**
 * Producer-only typed view of Pi's event bus.
 *
 * A receiver may trust an event only when its producer uses MikotoEventEmitter
 * from the same exact mikoto-types commit. Raw emitters and different commits
 * produce undefined behavior. package.json versions are not compatibility
 * signals.
 */
export type MikotoEventEmitter = {
  emit<Body>(channel: "mikoto-garden:bind", data: MikotoGardenBindEvent<Body>): void;
	emit<Name extends Exclude<MikotoEventName, "mikoto-garden:bind">>(
		channel: Name,
		data: MikotoEventPayload<Name>,
	): void;
};
