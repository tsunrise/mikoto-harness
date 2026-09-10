import { readFile } from "node:fs/promises";
import { Theme } from "@earendil-works/pi-coding-agent";

export async function builtInTheme(name: "dark" | "light"): Promise<Theme> {
  const file = new URL(`./modes/interactive/theme/${name}.json`, import.meta.resolve("@earendil-works/pi-coding-agent"));
  const raw = JSON.parse(await readFile(file, "utf8"));
  const resolve = (value: string | number): string | number =>
    typeof value === "string" && value !== "" && !value.startsWith("#") ? resolve(raw.vars[value]) : value;
  const colors = Object.fromEntries(Object.entries(raw.colors).map(([key, value]) => [key, resolve(value as string | number)]));
  return new Theme(colors as ConstructorParameters<typeof Theme>[0], colors as ConstructorParameters<typeof Theme>[1], "truecolor");
}
