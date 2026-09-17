import { domainToASCII } from "node:url";
import { z } from "zod";

// Protocol reference: OpenAI Codex, codex-rs/codex-api/src/search.rs.
// We expose only the commands we support, not the endpoint's full request.
const text = z.string().min(1).max(4096).refine((value) => value.trim().length > 0);
const integer = z.number().int().min(0).max(Number.MAX_SAFE_INTEGER);
const reference = z.string().min(1).max(512).regex(/^[A-Za-z0-9_.-]+$/);
const url = z.string().min(1).max(4096).refine((value) => {
  if (!/^https?:\/\/[^/?#]/i.test(value) || /[\s\\\x00-\x1f\x7f]/u.test(value)) return false;
  try {
    const parsed = new URL(value);
    return !!parsed.hostname && !parsed.username && !parsed.password;
  } catch {
    return false;
  }
});
const refId = z.union([reference, url]);

const domain = z.string().min(1).max(253).transform((value, ctx) => {
  // domainToASCII accepts some URL-like input; reject those delimiters before
  // normalizing so a filter cannot quietly become a different hostname.
  const ascii = /[\s:/\\@?#%*\[\]\x00-\x1f\x7f]/u.test(value) ? "" : domainToASCII(value);
  const valid = ascii.length > 0 && ascii.length <= 253 &&
    ascii.split(".").every((label) =>
      label.length <= 63 && /^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?$/i.test(label));
  if (!valid) {
    ctx.addIssue({ code: "custom", message: "Expected a DNS domain name" });
    return z.NEVER;
  }
  return ascii.toLowerCase();
});

export const commandsSchema = z.strictObject({
  search_query: z.array(z.strictObject({
    q: text,
    recency: integer.optional(),
    domains: z.array(domain).min(1).max(32).optional(),
  })).min(1).max(16).optional(),
  open: z.array(z.strictObject({
    ref_id: refId,
    lineno: integer.optional(),
  })).min(1).max(16).optional(),
  click: z.array(z.strictObject({
    ref_id: reference,
    id: integer,
  })).min(1).max(16).optional(),
  find: z.array(z.strictObject({
    ref_id: refId,
    pattern: text,
  })).min(1).max(16).optional(),
  response_length: z.enum(["short", "medium", "long"]).default("medium"),
}).refine((body) => {
  const count = (body.search_query?.length ?? 0) + (body.open?.length ?? 0) +
    (body.click?.length ?? 0) + (body.find?.length ?? 0);
  return count >= 1 && count <= 16;
}, "Supply between one and sixteen operations");

export type Commands = z.output<typeof commandsSchema>;
