import assert from "node:assert/strict";
import {
  mkdtemp,
  rm,
  symlink,
} from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, it } from "node:test";
import type {
  ExtensionAPI,
  ExtensionContext,
} from "@earendil-works/pi-coding-agent";
import type {
  MikotoPolicy,
  MikotoPolicyGetPolicyEvent,
} from "mikoto-types";
import {
  MikotoPolicyDocumentLoader,
  PERMISSION_PATH,
} from "../src/config.ts";
import { provideExtensionsApi } from "../src/extensions-api.ts";

type SessionStartHandler = (
  event: unknown,
  ctx: ExtensionContext,
) => Promise<void>;

describe("provideExtensionsApi", () => {
  it("provides an immutable session policy after initialization", async () => {
    const cwd = await mkdtemp(
      path.join(os.tmpdir(), "mikoto-policy-api-"),
    );
    try {
      const loader = new MikotoPolicyDocumentLoader(
        {
          filesystem: {
            denyRead: ["secret"],
            allowWrite: ["."],
            denyWrite: ["readonly"],
          },
        },
        path.join(cwd, "missing-global.json"),
      );
      let sessionStart: SessionStartHandler | undefined;
      let getPolicy:
        | ((data: MikotoPolicyGetPolicyEvent) => void)
        | undefined;
      const pi = {
        on(name: string, handler: SessionStartHandler) {
          assert.equal(name, "session_start");
          sessionStart = handler;
        },
        events: {
          on(
            name: string,
            handler: (data: MikotoPolicyGetPolicyEvent) => void,
          ) {
            assert.equal(name, "mikoto-policy:get-policy");
            getPolicy = handler;
          },
        },
      } as unknown as ExtensionAPI;

      provideExtensionsApi(loader, pi);
      assert.ok(sessionStart);
      assert.ok(getPolicy);

      const receivedPolicies: MikotoPolicy[] = [];
      getPolicy({
        callback(policy) {
          receivedPolicies.push(policy);
        },
      });
      assert.equal(receivedPolicies.length, 0);

      await sessionStart({}, {
        cwd,
        isProjectTrusted: () => true,
      } as ExtensionContext);
      let callbackCount = 0;
      getPolicy({
        callback(policy) {
          callbackCount++;
          receivedPolicies.push(policy);
        },
      });

      assert.equal(callbackCount, 1);
      const received = receivedPolicies[0];
      assert.ok(received);
      assert.ok(Object.isFrozen(received));
      assert.equal(received.permissionMdPath, PERMISSION_PATH);
      assert.equal(
        received.resolveToolPath("secret/file.txt"),
        path.join(cwd, "secret", "file.txt"),
      );
      const canonicalCwd = await received.canonicalizePath(cwd);
      assert.equal(
        await received.canonicalizePath(
          path.join(cwd, "missing", "file.txt"),
        ),
        path.join(canonicalCwd, "missing", "file.txt"),
      );
      const document = received.document();
      assert.ok(Object.isFrozen(document));
      assert.ok(Object.isFrozen(document.filesystem));
      assert.ok(Object.isFrozen(document.filesystem.denyRead));
      assert.deepEqual(structuredClone(document), document);
      assert.deepEqual(
        await received.evaluateRead(
          path.join(canonicalCwd, "secret", "file.txt"),
        ),
        {
          allowed: false,
          deniedPath: path.join(canonicalCwd, "secret"),
        },
      );
      assert.deepEqual(await received.evaluateReadTree(canonicalCwd), {
        allowed: false,
        deniedPath: path.join(canonicalCwd, "secret"),
      });
      assert.deepEqual(
        await received.evaluateWrite(
          path.join(canonicalCwd, "file.txt"),
        ),
        { allowed: true },
      );
      assert.deepEqual(
        await received.evaluateWrite(
          path.join(canonicalCwd, "readonly", "file.txt"),
        ),
        {
          allowed: false,
          deniedPath: path.join(canonicalCwd, "readonly"),
        },
      );
    } finally {
      await rm(cwd, { recursive: true, force: true });
    }
  });

  it("reports dropped policy rules during session initialization", async () => {
    const cwd = await mkdtemp(
      path.join(os.tmpdir(), "mikoto-policy-api-"),
    );
    try {
      const firstLink = path.join(cwd, "first");
      const secondLink = path.join(cwd, "second");
      await symlink(secondLink, firstLink);
      await symlink(firstLink, secondLink);

      let sessionStart: SessionStartHandler | undefined;
      const notifications: string[] = [];
      const pi = {
        on(_name: string, handler: SessionStartHandler) {
          sessionStart = handler;
        },
        events: {
          on() {},
        },
      } as unknown as ExtensionAPI;
      provideExtensionsApi(
        new MikotoPolicyDocumentLoader(
          { filesystem: { denyRead: [firstLink] } },
          path.join(cwd, "missing-global.json"),
        ),
        pi,
      );
      assert.ok(sessionStart);

      await sessionStart({}, {
        cwd,
        hasUI: true,
        isProjectTrusted: () => true,
        ui: {
          notify(message: string) {
            notifications.push(message);
          },
        },
      } as unknown as ExtensionContext);

      assert.deepEqual(notifications, [firstLink]);
    } finally {
      await rm(cwd, { recursive: true, force: true });
    }
  });

  it("logs synchronous and asynchronous callback failures", async () => {
    const cwd = await mkdtemp(
      path.join(os.tmpdir(), "mikoto-policy-api-"),
    );
    const errors: unknown[][] = [];
    const originalConsoleError = console.error;
    console.error = (...args: unknown[]) => {
      errors.push(args);
    };

    try {
      let sessionStart: SessionStartHandler | undefined;
      let getPolicy:
        | ((data: MikotoPolicyGetPolicyEvent) => void)
        | undefined;
      const pi = {
        on(_name: string, handler: SessionStartHandler) {
          sessionStart = handler;
        },
        events: {
          on(
            _name: string,
            handler: (data: MikotoPolicyGetPolicyEvent) => void,
          ) {
            getPolicy = handler;
          },
        },
      } as unknown as ExtensionAPI;
      provideExtensionsApi(
        new MikotoPolicyDocumentLoader(
          {},
          path.join(cwd, "missing-global.json"),
        ),
        pi,
      );
      assert.ok(sessionStart);
      assert.ok(getPolicy);
      await sessionStart({}, {
        cwd,
        isProjectTrusted: () => true,
      } as ExtensionContext);

      const synchronousError = new Error("synchronous failure");
      getPolicy({
        callback() {
          throw synchronousError;
        },
      });
      const asynchronousError = new Error("asynchronous failure");
      getPolicy({
        async callback() {
          throw asynchronousError;
        },
      });
      await new Promise<void>((resolve) => setImmediate(resolve));

      assert.deepEqual(errors, [
        ["Mikoto Policy consumer callback failed:", synchronousError],
        ["Mikoto Policy consumer callback failed:", asynchronousError],
      ]);
    } finally {
      console.error = originalConsoleError;
      await rm(cwd, { recursive: true, force: true });
    }
  });
});
