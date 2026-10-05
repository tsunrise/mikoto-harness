import { rm } from "node:fs/promises";

// tsc does not remove output for deleted source files. A clean output tree
// keeps npm packs from shipping code left over from an earlier checkout.
await rm(new URL("../dist/", import.meta.url), { recursive: true, force: true });
