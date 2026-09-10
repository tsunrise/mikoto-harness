import { z } from "zod";
import type { MikotoEventEmitter } from "mikoto-types";

export function typeFixtures(events: MikotoEventEmitter): void {
  events.emit("mikoto-garden:bind", {
    owner: "types", method: "POST", path: "/types",
    bodySchema: z.string().transform((value) => value.length),
    async handler({ body }) {
      const length: number = body;
      // @ts-expect-error Handler receives transformed number, not input string.
      body.toUpperCase();
      return { status: 200, body: String(length) };
    },
  });
  events.emit("mikoto-garden:bind", {
    owner: "types", method: "POST", path: "/types",
    bodySchema: z.strictObject({ count: z.number().default(1) }),
    async handler({ body }) {
      const count: number = body.count;
      return { status: 200, body: String(count) };
    },
  });
  // @ts-expect-error Unrelated contracts remain checked.
  events.emit("mikoto-sound:sound", { unknown: true });
}
