import type { MikotoPolicyDocument } from "mikoto-types";

function destination(host: string, port: number): { host: string; port: number } | undefined {
  if (!Number.isInteger(port) || port < 1 || port > 65535 || host.length > 253) return;
  if (!/^[a-zA-Z0-9.-]+$/.test(host)) return;
  host = host.toLowerCase();
  const labels = host.split(".");
  if (/^[\d.]+$/.test(host)) {
    // Only dotted-decimal IPv4 is accepted here, not short or octal aliases.
    const dottedDecimal = /^(0|[1-9]\d{0,2})(\.(0|[1-9]\d{0,2})){3}$/.test(host);
    if (!dottedDecimal || labels.some((octet) => Number(octet) > 255)) return;
  } else {
    const validLabels = labels.every((label) =>
      /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/.test(label),
    );
    const numericTopLevel = /^\d+$/.test(labels.at(-1)!);
    if (!validLabels || numericTopLevel) return;
  }
  return { host, port };
}
export function matchesDestination(rule: string, host: string, port: number): boolean {
  const [pattern, atPort] = rule.split(":");
  if (atPort !== undefined && Number(atPort) !== port) return false;
  return (
    pattern === "*" ||
    pattern === host ||
    (pattern.startsWith("*.") && host.endsWith(pattern.slice(1)) && host !== pattern.slice(2))
  );
}
export function evaluateDestination(
  network: MikotoPolicyDocument["network"],
  endpoint: { port: number } | undefined,
  host: string,
  port: number,
  alive = true,
): boolean {
  try {
    const target = destination(host, port);
    if (!alive || !target) return false;
    if (target.host === "127.0.0.1" && target.port === endpoint?.port) return true;
    if (network.deniedDomains.some((rule) => matchesDestination(rule, target.host, port)))
      return false;
    return network.allowedDomains.some((rule) => matchesDestination(rule, target.host, port));
  } catch {
    return false;
  }
}
