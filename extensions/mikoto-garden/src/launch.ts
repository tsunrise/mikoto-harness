import { access, realpath, stat } from "node:fs/promises";
import { constants } from "node:fs";
import { userInfo } from "node:os";
import { basename, isAbsolute, resolve } from "node:path";
import type { Endpoint } from "./capability-server.ts";

export type SandboxMode = "sandboxed" | "unsandboxed";
export type ShellKind = "bash" | "zsh" | "sh";
export const HOST_PATH = "/usr/bin:/bin:/usr/sbin:/sbin";
export type Launch = Readonly<{
  cmd: string;
  cwd: string;
  shell: string;
  login: boolean;
  stdin: boolean;
  mode: SandboxMode;
  env: Readonly<Record<string, string>>;
  cwdIdentity: string;
  shellIdentity: string;
  capabilities: boolean;
}>;
export function withScratchEnvironment(launch: Launch, scratch: string): Launch {
  return Object.freeze({
    ...launch,
    env: Object.freeze({ ...launch.env, TMPDIR: scratch }),
  });
}
export function shellQuote(text: string): string {
  return `'${text.replaceAll("'", "'\\''")}'`;
}
export function safeEnvironment(
  inherited: NodeJS.ProcessEnv = process.env,
  metadata: Readonly<Record<string, string | undefined>> = {},
  endpoint?: Endpoint,
): Record<string, string> {
  const account = userInfo();
  const env: Record<string, string> = {
    HOME: account.homedir,
    USER: account.username,
    LOGNAME: account.username,
    PATH: (inherited.PATH ?? "/usr/bin:/bin:/usr/sbin:/sbin")
      .split(":")
      .filter((part) => isAbsolute(part) && !/[\x00-\x1f\x7f]/.test(part))
      .join(":"),
    LANG: "en_US.UTF-8",
    TERM: "dumb",
  };
  // A positive inheritance list is easier to audit than an ever-growing list
  // of loaders, provider keys, sockets, and proxy variables to strip.
  for (const key of ["LANG", "LC_ALL", "LC_CTYPE", "LC_MESSAGES", "TZ", "TERM", "COLORTERM"]) {
    const value = inherited[key];
    if (value && value.length <= 1024 && !/[\x00-\x1f\x7f]/.test(value)) env[key] = value;
  }
  for (const key of [
    "PI_SESSION_ID",
    "PI_SESSION_FILE",
    "PI_PROVIDER",
    "PI_MODEL",
    "PI_REASONING_LEVEL",
  ]) {
    const value = metadata[key];
    if (value && value.length <= 4096 && !value.includes("\0")) env[key] = value;
  }
  env.AI_AGENT = "pi";
  env.PI_CODING_AGENT = "true";
  if (endpoint) {
    env.GARDEN_SERVER = endpoint.url;
    env.GARDEN_TOKEN = endpoint.token;
  }
  return env;
}
async function identity(path: string): Promise<string> {
  const info = await stat(path);
  return `${info.dev}:${info.ino}`;
}
export async function prepareLaunch(
  args: {
    cmd: string;
    workdir?: string;
    shell?: ShellKind;
    login?: boolean;
    stdin?: boolean;
    sandbox_permissions?: string;
  },
  cwd: string,
  metadata: Readonly<Record<string, string | undefined>>,
  endpoint?: Endpoint,
): Promise<Launch> {
  const workdir = await realpath(resolve(cwd, args.workdir ?? "."));
  if (!(await stat(workdir)).isDirectory()) throw new Error("workdir must be a directory");
  const accountShell = userInfo().shell;
  const supported = ["/bin/zsh", "/bin/bash", "/bin/sh"];
  const supportedAccount =
    accountShell &&
    isAbsolute(accountShell) &&
    ["zsh", "bash", "sh"].includes(basename(accountShell))
      ? accountShell
      : undefined;
  let candidates: string[];
  if (args.shell) {
    candidates = [];
    if (supportedAccount && basename(supportedAccount) === args.shell) {
      candidates.push(supportedAccount);
    }
    candidates.push(`/bin/${args.shell}`);
  } else {
    candidates = [...new Set([...(supportedAccount ? [supportedAccount] : []), ...supported])];
  }
  let shell: string | undefined;
  for (const candidate of candidates) {
    try {
      await access(candidate, constants.X_OK);
      shell = await realpath(candidate);
      break;
    } catch {
      /* Try the next supported host shell. */
    }
  }
  if (!shell) throw new Error("No supported executable shell");
  return Object.freeze({
    cmd: args.cmd,
    cwd: workdir,
    shell,
    login: args.login ?? true,
    stdin: args.stdin ?? false,
    mode: args.sandbox_permissions === "require_escalated" ? "unsandboxed" : "sandboxed",
    env: Object.freeze(safeEnvironment(process.env, metadata, endpoint)),
    cwdIdentity: await identity(workdir),
    shellIdentity: await identity(shell),
    capabilities: !!endpoint,
  });
}
export async function assertLaunchIdentity(launch: Launch): Promise<void> {
  for (const [path, pinned] of [
    [launch.cwd, launch.cwdIdentity],
    [launch.shell, launch.shellIdentity],
  ]) {
    if ((await realpath(path)) !== path || (await identity(path)) !== pinned) {
      throw new Error("Prepared launch path identity changed");
    }
  }
}
export function innerPayload(launch: Launch, scratch: string): string {
  return `export NO_PROXY='' no_proxy='' PATH=${shellQuote(launch.env.PATH)} TMPDIR=${shellQuote(scratch)}; exec ${shellQuote(launch.shell)} ${launch.login ? "-lc" : "-c"} ${shellQuote(launch.cmd)}`;
}
