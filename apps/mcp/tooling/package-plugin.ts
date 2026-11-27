import { mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { strToU8, zipSync } from "fflate";
import { z } from "zod";
import { loadBookkeepingSkill } from "../src/skill.ts";

const manifestSchema = z
  .object({
    $schema: z.literal("https://agent-plugins.org/schemas/1.0.0/plugin.schema.json"),
    name: z.literal("rastrata"),
    version: z.string().regex(/^[0-9]+\.[0-9]+\.[0-9]+$/),
    description: z.string().min(1),
    extensions: z.object({
      "com.openai": z.object({
        interface: z.record(z.string(), z.unknown()),
        apps: z.string().optional(),
      }),
    }),
  })
  .passthrough();

/** Produce a portable plugin, binding only a real ChatGPT registration supplied
 * by its owner. Never put a fake technical ID or a credential in the package. */
export function packagePlugin(options: { directory: string; appId?: string }) {
  if (
    options.appId &&
    !/^(?:plugin_asdk_app_|asdk_app_|connector_)[A-Za-z0-9_-]+$/.test(options.appId)
  )
    throw new Error("Use the technical ID from the registered ChatGPT MCP connection");
  const root = resolve(import.meta.dir, "../../../plugins/rastrata");
  const manifest = manifestSchema.parse(
    JSON.parse(readFileSync(join(root, "plugin.json"), "utf8")),
  );
  const skill = loadBookkeepingSkill();
  const files: Record<string, string> = { "skills/bookkeeping/SKILL.md": skill.text };
  if (options.appId) {
    manifest.extensions["com.openai"].apps = "./.app.json";
    files[".app.json"] =
      `${JSON.stringify({ apps: { rastrata: { id: options.appId } } }, null, 2)}\n`;
  } else {
    files["mcp.json"] = readFileSync(join(root, "mcp.json"), "utf8");
  }
  files["plugin.json"] = `${JSON.stringify(manifest, null, 2)}\n`;
  const directory = resolve(options.directory);
  mkdirSync(directory, { recursive: true });
  if (readdirSync(directory).length) throw new Error("Plugin output directory must be empty");
  for (const [name, text] of Object.entries(files)) {
    const path = join(directory, name);
    mkdirSync(resolve(path, ".."), { recursive: true });
    writeFileSync(path, text);
  }
  const archive = join(directory, "rastrata.zip");
  const entries = Object.fromEntries(
    Object.keys(files)
      .sort()
      .map((name) => [name, strToU8(files[name] ?? "")]),
  );
  writeFileSync(archive, zipSync(entries, { level: 9, mtime: new Date(1980, 0, 1) }));
  return { directory, archive, connection: options.appId ? "registered-chatgpt" : "local-mcp" };
}

if (import.meta.main) {
  const args = process.argv.slice(2);
  const values = new Map<string, string>();
  for (let i = 0; i < args.length; i += 2) {
    const key = args[i],
      value = args[i + 1];
    if (
      !key ||
      !["--out", "--app-id"].includes(key) ||
      !value ||
      value.startsWith("--") ||
      values.has(key)
    )
      throw new Error(
        "Usage: bun tooling/package-plugin.ts --out EMPTY_DIRECTORY [--app-id REGISTERED_ID]",
      );
    values.set(key, value);
  }
  const directory = values.get("--out"),
    appId = values.get("--app-id");
  if (!directory) throw new Error("--out is required");
  console.info(JSON.stringify(packagePlugin({ directory, ...(appId ? { appId } : {}) }), null, 2));
}
