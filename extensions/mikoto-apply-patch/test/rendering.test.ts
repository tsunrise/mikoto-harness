import assert from "node:assert/strict";
import { before, describe, it } from "node:test";
import {
  initTheme,
  type Theme,
} from "@earendil-works/pi-coding-agent";
import { stripTerminalSequences } from "@earendil-works/pi-tui";

import {
  ApplyPatchChangeKind,
  type ApplyPatchOutcome,
} from "../src/native.ts";
import {
  renderApplyPatchCall,
  renderApplyPatchResult,
} from "../src/render.ts";

let theme: Theme;

before(() => {
  initTheme("dark");
  theme = (
    globalThis as typeof globalThis & {
      [key: symbol]: Theme;
    }
  )[Symbol.for("@earendil-works/pi-coding-agent:theme")];
});

function plain(component: {
  render(width: number): string[];
}): string {
  return component
    .render(1_000)
    .map((line) => stripTerminalSequences(line).trimEnd())
    .join("\n");
}

describe("apply_patch rendering", () => {
  it("renders a compact sanitized call roster without patch contents", () => {
    const component = renderApplyPatchCall(
      {
        patch: [
          "*** Begin Patch",
          "*** Add File: safe-\x1b]52;c;evil\x07.ts",
          "+secret body",
          "*** Update File: old.ts",
          "*** Move to: new.ts",
          "-old",
          "+new",
          "*** Delete File: obsolete.ts",
          "*** End Patch",
        ].join("\n"),
      },
      theme,
      false,
    );
    const output = plain(component);

    assert.match(output, /^apply_patch$/m);
    assert.match(output, /^A safe-.*\.ts \+1$/m);
    assert.match(output, /^M old\.ts -> new\.ts \+1 -1$/m);
    assert.match(output, /^D obsolete\.ts$/m);
    assert.doesNotMatch(output, /secret body/);
    assert.doesNotMatch(output, /\x1b/);
  });

  it("renders successful per-change diffs through Pi's renderer", () => {
    const outcome: ApplyPatchOutcome = {
      changes: [
        {
          kind: ApplyPatchChangeKind.Modified,
          path: "src/old.ts",
          movePath: "src/new.ts",
          additions: 1,
          deletions: 1,
          diff: " 1 context\n-2 old value\n+2 new value\n",
        },
        {
          kind: ApplyPatchChangeKind.Deleted,
          path: "obsolete.ts",
          additions: 0,
          deletions: 1,
          diff: "-1 gone\n",
        },
      ],
    };
    const component = renderApplyPatchResult(
      { content: [], details: outcome },
      false,
      theme,
      false,
    );
    const output = plain(component);

    assert.match(output, /M src\/old\.ts -> src\/new\.ts \+1 -1/);
    assert.match(output, /-2 old value/);
    assert.match(output, /\+2 new value/);
    assert.match(output, /D obsolete\.ts -1/);
  });

  it("does not repeat the call roster after a successful result", () => {
    const args = {
      patch: [
        "*** Begin Patch",
        "*** Add File: hello.txt",
        "+Hello World",
        "*** End Patch",
      ].join("\n"),
    };
    const outcome: ApplyPatchOutcome = {
      changes: [
        {
          kind: ApplyPatchChangeKind.Added,
          path: "hello.txt",
          additions: 1,
          deletions: 0,
          diff: "+1 Hello World\n",
        },
      ],
    };
    const output = [
      plain(renderApplyPatchCall(args, theme, false, false)),
      plain(
        renderApplyPatchResult(
          { content: [], details: outcome },
          false,
          theme,
          false,
        ),
      ),
    ].join("\n");

    assert.equal(output.match(/^A hello\.txt \+1$/gm)?.length, 1);
    assert.match(output, /^apply_patch$/m);
    assert.match(output, /^\+1 Hello World$/m);
  });

  it("keeps pure moves visible when their diff is empty", () => {
    const outcome: ApplyPatchOutcome = {
      changes: [
        {
          kind: ApplyPatchChangeKind.Modified,
          path: "before.ts",
          movePath: "after.ts",
          additions: 0,
          deletions: 0,
          diff: "",
        },
      ],
    };

    assert.match(
      plain(
        renderApplyPatchResult(
          { content: [], details: outcome },
          false,
          theme,
          false,
        ),
      ),
      /M before\.ts -> after\.ts/,
    );
  });

  it("bounds collapsed diff output and shows the expand hint", () => {
    const diff = Array.from(
      { length: 400 },
      (_, index) => `+${index + 1} added ${index}`,
    ).join("\n");
    const outcome: ApplyPatchOutcome = {
      changes: [
        {
          kind: ApplyPatchChangeKind.Added,
          path: "large.ts",
          additions: 400,
          deletions: 0,
          diff,
        },
      ],
    };
    const output = plain(
      renderApplyPatchResult(
        { content: [], details: outcome },
        false,
        theme,
        false,
      ),
    );

    const diffRows = output
      .split("\n")
      .filter((line) => /^[+ -]\d+\s/.test(line));
    assert.ok(diffRows.length <= 200);
    assert.match(output, /diff lines?.*hidden/);
    assert.match(output, /to expand/);
  });

  it("sanitizes and bounds error output", () => {
    const output = plain(
      renderApplyPatchResult(
        {
          content: [
            {
              type: "text",
              text: `unsafe \x1b]52;c;evil\x07${"\nline".repeat(300)}`,
            },
          ],
          details: undefined,
        },
        false,
        theme,
        true,
      ),
    );

    assert.doesNotMatch(output, /\x1b/);
    assert.ok(output.split("\n").length <= 200);
    assert.match(output, /error lines hidden/);
  });
});
