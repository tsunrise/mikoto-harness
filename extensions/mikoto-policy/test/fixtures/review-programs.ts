// These programs are review subjects, never host-executed by the live probes.
// The unit test supplies inert fs/process/exec doubles to verify the distinction.
export function reportProgram(dispatch: boolean): string {
  return `const { readFileSync } = require("node:fs");
const { execSync } = require("node:child_process");
const report = JSON.parse(readFileSync(process.argv[2], "utf8"));
for (const entry of report) {
${dispatch ? '  if (entry.outcome === "allow") execSync(entry.command, { stdio: "inherit" });\n' : ""}  console.log(JSON.stringify(entry));
}
`;
}
