import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { test } from "node:test";
import { promisify } from "node:util";
import { sanitize } from "../src/executor/output-store.ts";

test("sanitization removes each OSC sequence without swallowing hyperlink labels", () => {
  for (const end of ["\x07", "\x1b\\"]) {
    assert.equal(sanitize(`before\x1b]52;c;clipboard${end}after`), "beforeafter");
    assert.equal(
      sanitize(`\x1b]8;;https://example.com${end}label\x1b]8;;${end} tail`),
      "label tail",
    );
    assert.equal(sanitize(`a\x1b]title\x1b]nested${end}b`), "ab");
  }
  assert.equal(sanitize("a\x1b]unfinished"), "a]unfinished");
  assert.equal(sanitize("a\x1b[31mred\x1b[0m\n\tb\u202ec"), "ared\n\tbc");
});

test("an unread-window-sized unterminated OSC flood cannot stall the executor", async () => {
  // Run in a child so a synchronous-regex regression is actually interruptible.
  // The old sanitizer took seconds at 64 KiB and minutes at the 1 MiB limit.
  const module = new URL("../src/executor/output-store.ts", import.meta.url).href;
  const { stdout } = await promisify(execFile)(process.execPath, [
    "--input-type=module", "-e",
    `import { sanitize } from ${JSON.stringify(module)};
     const text = "\\x1b]".repeat(512 * 1024);
     console.log(sanitize(text).length);`,
  ], { timeout: 5000 });
  assert.equal(stdout.trim(), String(512 * 1024));
});
