import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type {
  ExtensionAPI,
  ExtensionContext,
} from "@earendil-works/pi-coding-agent";
import type {
  MikotoPolicy,
  MikotoPolicyDecision,
  MikotoPolicyGetPolicyEvent,
} from "mikoto-types";

import { installApplyPatchPolicy } from "../src/policy.ts";
import { installApplyPatchToolState } from "../src/tool-state.ts";

type Handler = (
  event: unknown,
  ctx: ExtensionContext,
) => unknown | Promise<unknown>;

function policyWith(
  evaluateWrite: (
    path: string,
  ) => Promise<MikotoPolicyDecision>,
): MikotoPolicy {
  return {
    document: () => ({
      filesystem: {
        denyRead: [],
        allowRead: [],
        allowWrite: [],
        denyWrite: [],
      },
    }),
    permissionMdPath: "/policy/PERMISSION.md",
    resolveToolPath: (path) => path,
    canonicalizePath: async (path) => path,
    evaluateRead: async () => ({ allowed: true }),
    evaluateReadTree: async () => ({ allowed: true }),
    evaluateWrite,
  };
}

function policyHarness(
  providers: readonly MikotoPolicy[],
): {
  guard: ReturnType<typeof installApplyPatchPolicy>;
  start(): Promise<void>;
} {
  const handlers = new Map<string, Handler[]>();
  const pi = {
    on(name: string, handler: Handler) {
      const current = handlers.get(name) ?? [];
      current.push(handler);
      handlers.set(name, current);
    },
    events: {
      emit(name: string, data: unknown) {
        assert.equal(name, "mikoto-policy:get-policy");
        const request = data as MikotoPolicyGetPolicyEvent;
        for (const policy of providers) request.callback(policy);
      },
    },
  } as unknown as ExtensionAPI;
  const guard = installApplyPatchPolicy(pi);

  return {
    guard,
    async start() {
      for (const handler of handlers.get("session_start") ?? []) {
        await handler({}, {} as ExtensionContext);
      }
    },
  };
}

describe("Mikoto Policy integration", () => {
  it("allows execution when no policy provider responds", async () => {
    const harness = policyHarness([]);
    await harness.start();
    await harness.guard.assertCanWrite(["/outside"]);
  });

  it("uses only the first policy callback and deduplicates targets", async () => {
    const evaluated: string[] = [];
    const first = policyWith(async (path) => {
      evaluated.push(path);
      return { allowed: true };
    });
    const second = policyWith(async (path) => ({
      allowed: false,
      deniedPath: path,
    }));
    const harness = policyHarness([first, second]);

    await harness.start();
    await harness.guard.assertCanWrite([
      "/project/a",
      "/project/a",
      "/project/b",
    ]);

    assert.deepEqual(evaluated, ["/project/a", "/project/b"]);
  });

  it("rejects the whole call with the denied path and policy help", async () => {
    const harness = policyHarness([
      policyWith(async (path) => ({
        allowed: false,
        deniedPath: path,
      })),
    ]);
    await harness.start();

    await assert.rejects(
      harness.guard.assertCanWrite(["/denied"]),
      /denied write access to \/denied.*\/policy\/PERMISSION\.md/,
    );
  });

  it("fails closed when policy evaluation throws", async () => {
    const harness = policyHarness([
      policyWith(async () => {
        throw new Error("policy failure");
      }),
    ]);
    await harness.start();

    await assert.rejects(
      harness.guard.assertCanWrite(["/target"]),
      /could not evaluate write access to \/target; access denied/,
    );
  });
});

describe("active tool replacement", () => {
  it("restores exactly the native tools that were previously active", async () => {
    const handlers = new Map<string, Handler[]>();
    let active = ["read", "write", "edit", "bash"];
    const pi = {
      on(name: string, handler: Handler) {
        const current = handlers.get(name) ?? [];
        current.push(handler);
        handlers.set(name, current);
      },
      getActiveTools: () => [...active],
      setActiveTools(names: string[]) {
        active = [...names];
      },
    } as unknown as ExtensionAPI;
    installApplyPatchToolState(pi);

    const compatible = {
      model: {
        provider: "openai",
        api: "openai-responses",
        id: "gpt-5.6",
        compat: { supportsOpenAIGrammarTools: true },
      },
    } as unknown as ExtensionContext;
    const incompatible = {
      model: {
        provider: "anthropic",
        api: "anthropic-messages",
        id: "claude",
      },
    } as unknown as ExtensionContext;

    await handlers.get("session_start")?.[0]?.({}, compatible);
    assert.deepEqual(active, ["read", "bash", "apply_patch"]);

    await handlers.get("model_select")?.[0]?.({}, incompatible);
    assert.deepEqual(active, ["read", "write", "edit", "bash"]);
  });

  it("does not restore a native tool that was initially inactive", async () => {
    const handlers = new Map<string, Handler[]>();
    let active = ["read", "edit", "bash"];
    const pi = {
      on(name: string, handler: Handler) {
        const current = handlers.get(name) ?? [];
        current.push(handler);
        handlers.set(name, current);
      },
      getActiveTools: () => [...active],
      setActiveTools(names: string[]) {
        active = [...names];
      },
    } as unknown as ExtensionAPI;
    installApplyPatchToolState(pi);
    const compatible = {
      model: {
        api: "openai-completions",
        compat: { supportsOpenAIGrammarTools: true },
      },
    } as unknown as ExtensionContext;
    const incompatible = {
      model: undefined,
    } as unknown as ExtensionContext;

    await handlers.get("session_start")?.[0]?.({}, compatible);
    await handlers.get("model_select")?.[0]?.({}, incompatible);

    assert.deepEqual(active, ["read", "edit", "bash"]);
  });
});
