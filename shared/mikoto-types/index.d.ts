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
 * Paths are normalized absolute paths. This document contains data only;
 * evaluation methods are exposed by the policy service that owns it.
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
      readonly deniedPath: string;
    };

export type MikotoPolicy = {
  document(): MikotoPolicyDocument;
  readonly permissionMdPath: string;
  /**
   * Converts a possibly relative Pi tool path to the absolute lexical path
   * accepted by the evaluation methods.
   *
   * Relative paths are resolved against the policy's session working
   * directory.
   */
  resolveToolPath(path: string): string;
  /**
   * @param path **Absolute** lexical path (could contain symlink).
   */
  evaluateRead(path: string): Promise<MikotoPolicyDecision>;
  /**
   * @param path **Absolute** lexical path (could contain symlink).
   */
  evaluateReadTree(path: string): Promise<MikotoPolicyDecision>;
  /**
   * @param path **Absolute** lexical path (could contain symlink).
   */
  evaluateWrite(path: string): Promise<MikotoPolicyDecision>;
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
