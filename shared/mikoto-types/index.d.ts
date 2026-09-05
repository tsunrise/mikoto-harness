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

/** Compile-time source of truth for Mikoto inter-extension event channels. */
export type MikotoEventMap = {
	readonly "mikoto-sound:sound": MikotoSoundEvent;
  readonly "mikoto-policy:get-policy": MikotoPolicyGetPolicyEvent;
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
	emit<Name extends MikotoEventName>(
		channel: Name,
		data: MikotoEventPayload<Name>,
	): void;
};
