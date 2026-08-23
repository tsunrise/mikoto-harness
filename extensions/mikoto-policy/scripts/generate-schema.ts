import { readFile, writeFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { z } from "zod";
import { MikotoPolicyConfig } from "../src/config.ts";

const schemaPath = fileURLToPath(
  new URL("../mikoto-policy.schema.json", import.meta.url),
);
const generated = `${JSON.stringify(z.toJSONSchema(MikotoPolicyConfig), null, 2)}\n`;

if (process.argv.includes("--check")) {
  let current: string;
  try {
    current = await readFile(schemaPath, "utf8");
  } catch {
    current = "";
  }

  if (current !== generated) {
    console.error(
      "mikoto-policy.schema.json is stale; run npm run generate:schema.",
    );
    process.exitCode = 1;
  }
} else {
  await writeFile(schemaPath, generated, "utf8");
}
