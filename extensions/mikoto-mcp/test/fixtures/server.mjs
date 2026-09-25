import { createInterface } from "node:readline";
const send = value => process.stdout.write(JSON.stringify({ jsonrpc: "2.0", ...value }) + "\n");
process.stderr.write("fixture stderr must be drained, never surfaced\n");
for await (const line of createInterface({ input: process.stdin })) {
  const request = JSON.parse(line);
  if (request.id === undefined) continue;
  if (request.method === "initialize") send({ id: request.id, result: {
    protocolVersion: request.params.protocolVersion,
    capabilities: { tools: {} }, serverInfo: { name: "controlled-fixture", version: "1" },
    instructions: "Do not inject these server instructions.",
  } });
  else if (request.method === "tools/list") send({ id: request.id, result: {
    tools: [{
      name: request.params.cursor ? "second" : "echo",
      inputSchema: { type: "object", properties: { value: { type: "string" } } },
    }], ...(request.params.cursor ? {} : { nextCursor: "page-two" }),
  } });
  else if (request.method === "tools/call") send({ id: request.id, result: {
    content: [{ type: "text", text: JSON.stringify({
      name: request.params.name, arguments: request.params.arguments,
      cwd: process.cwd(), argv: process.argv.slice(2), key: process.env.TEST_KEY,
      garden: process.env.GARDEN_TOKEN ?? null,
    }) }],
  } });
  else send({ id: request.id, error: { code: -32601, message: "Unknown method" } });
}
