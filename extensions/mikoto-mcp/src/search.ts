import type { Tool } from "@modelcontextprotocol/sdk/types.js";
import { callable, compare, type ServerSnapshot } from "./schema.ts";

export function tokens(text: string): string[] {
  return text.replace(/(\p{Ll}|\p{N})(\p{Lu})/gu, "$1 $2")
    .replace(/(\p{Lu})(\p{Lu}\p{Ll})/gu, "$1 $2").toLowerCase().split(/[^\p{L}\p{N}]+/u).filter(Boolean);
}

function metadata(server: string, tool: Tool): string {
  const parts = [server, tool.name, tool.title ?? "", tool.description ?? ""];
  const stack: { value: unknown; depth: number }[] = [{ value: tool.inputSchema, depth: 0 }];
  while (stack.length) {
    const { value, depth } = stack.pop()!;
    if (depth > 32 || !value || typeof value !== "object") continue;
    if (Array.isArray(value)) {
      for (const v of value) stack.push({ value: v, depth: depth + 1 });
      continue;
    }
    const schema = value as Record<string, unknown>;
    if (typeof schema.description === "string") parts.push(schema.description);
    if (schema.properties && typeof schema.properties === "object") {
      for (const [name, v] of Object.entries(schema.properties)) {
        parts.push(name); stack.push({ value: v, depth: depth + 1 });
      }
    }
    for (const key of ["items", "prefixItems", "allOf", "anyOf", "oneOf", "not", "if", "then", "else", "additionalProperties"])
      if (schema[key]) stack.push({ value: schema[key], depth: depth + 1 });
  }
  return parts.join(" ");
}
type Document = { server: string; tool: Tool; snapshot: ServerSnapshot; terms: Map<string, number>; length: number };

export class SearchIndex {
  private snapshots: ServerSnapshot[] = [];
  private documents: Document[] = [];
  private frequencies = new Map<string, number>();
  private average = 0;
  update(snapshots: ServerSnapshot[]) {
    if (snapshots.length === this.snapshots.length && snapshots.every((s, i) => s === this.snapshots[i])) return;
    this.snapshots = snapshots;
    this.frequencies.clear();
    this.documents = snapshots.flatMap(snapshot => snapshot.tools.filter(callable).map(tool => {
      const words = tokens(metadata(snapshot.server, tool));
      const terms = new Map<string, number>();
      for (const word of words) terms.set(word, (terms.get(word) ?? 0) + 1);
      for (const term of terms.keys()) this.frequencies.set(term, (this.frequencies.get(term) ?? 0) + 1);
      return { server: snapshot.server, tool, snapshot, terms, length: words.length };
    }));
    this.average = this.documents.reduce((n, d) => n + d.length, 0) / (this.documents.length || 1);
  }
  search(query: string, limit: number) {
    const terms = [...new Set(tokens(query))];
    const N = this.documents.length;
    return this.documents.map(document => {
      let score = 0;
      for (const term of terms) {
        const tf = document.terms.get(term) ?? 0;
        if (!tf) continue;
        const df = this.frequencies.get(term)!;
        score += Math.log(1 + (N - df + 0.5) / (df + 0.5)) * tf * 2.2
          / (tf + 1.2 * (0.25 + 0.75 * document.length / this.average));
      }
      return { document, score };
    }).filter(d => d.score > 0)
      .sort((a, b) => b.score - a.score || compare(a.document.server, b.document.server)
        || compare(a.document.tool.name, b.document.tool.name))
      .slice(0, limit).map(d => d.document);
  }
}
