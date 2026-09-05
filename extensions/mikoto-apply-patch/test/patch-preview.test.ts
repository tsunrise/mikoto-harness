import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { scanPatchPreview } from "../src/patch-preview.ts";

describe("patch preview scanner", () => {
  it("tolerates partial input and aggregates repeated file hunks", () => {
    const preview = scanPatchPreview(
      [
        "*** Begin Patch",
        "*** Update File: src/index.ts",
        "@@ first",
        "-old",
        "+new",
        "*** Update File: src/index.ts",
        "@@ second",
        "+another",
      ].join("\n"),
    );

    assert.deepEqual(preview.files, [
      {
        kind: "update",
        path: "src/index.ts",
        additions: 2,
        deletions: 1,
      },
    ]);
    assert.equal(preview.truncated, false);
  });

  it("records moves, normalizes CRLF, and gives deletes no count", () => {
    const preview = scanPatchPreview(
      [
        "*** Begin Patch",
        "*** Update File: old.ts",
        "*** Move to: new.ts",
        "-old",
        "+new",
        "*** Delete File: obsolete.ts",
        "*** End Patch",
      ].join("\r\n"),
    );

    assert.deepEqual(preview.files, [
      {
        kind: "update",
        path: "old.ts",
        movePath: "new.ts",
        additions: 1,
        deletions: 1,
      },
      {
        kind: "delete",
        path: "obsolete.ts",
        additions: 0,
        deletions: 0,
      },
    ]);
  });

  it("ignores text after the end marker", () => {
    const preview = scanPatchPreview(
      [
        "*** Begin Patch",
        "*** Add File: real.ts",
        "+real",
        "*** End Patch",
        "*** Add File: phantom.ts",
        "+phantom",
      ].join("\n"),
    );

    assert.equal(preview.files.length, 1);
    assert.equal(preview.files[0]?.path, "real.ts");
  });

  it("bounds work for very large streaming input", () => {
    const preview = scanPatchPreview(
      `*** Begin Patch\n*** Add File: huge.txt\n+${"x".repeat(300 * 1024)}`,
    );

    assert.equal(preview.truncated, true);
    assert.equal(preview.files.length, 1);
    assert.equal(preview.files[0]?.additions, 1);
  });
});
