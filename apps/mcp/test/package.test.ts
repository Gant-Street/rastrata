import { expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { strFromU8, unzipSync } from "fflate";
import { packagePlugin } from "../tooling/package-plugin.ts";

test("portable packages bind a real registration and preserve every bundled resource", () => {
  const root = mkdtempSync(join(tmpdir(), "rastrata-plugin-package-"));
  try {
    const local = packagePlugin({ directory: join(root, "local") });
    const localFiles = unzipSync(readFileSync(local.archive));
    expect(Object.keys(localFiles).sort()).toEqual([
      "mcp.json",
      "plugin.json",
      "skills/bookkeeping/SKILL.md",
    ]);
    expect(
      JSON.parse(strFromU8(localFiles["mcp.json"] ?? new Uint8Array())).mcpServers.rastrata.type,
    ).toBe("streamable-http");
    const appId = "plugin_asdk_app_fixture";
    const chatgpt = packagePlugin({ directory: join(root, "chatgpt"), appId });
    const files = unzipSync(readFileSync(chatgpt.archive));
    expect(Object.keys(files).sort()).toEqual([
      ".app.json",
      "plugin.json",
      "skills/bookkeeping/SKILL.md",
    ]);
    const manifest = JSON.parse(strFromU8(files["plugin.json"] ?? new Uint8Array()));
    expect(manifest.$schema).toBe("https://agent-plugins.org/schemas/1.0.0/plugin.schema.json");
    expect(manifest.extensions["com.openai"].apps).toBe("./.app.json");
    expect(JSON.parse(strFromU8(files[".app.json"] ?? new Uint8Array())).apps.rastrata.id).toBe(
      appId,
    );
    expect(strFromU8(files["skills/bookkeeping/SKILL.md"] ?? new Uint8Array())).toBe(
      readFileSync(join(chatgpt.directory, "skills/bookkeeping/SKILL.md"), "utf8"),
    );
    const repeat = packagePlugin({ directory: join(root, "repeat"), appId });
    expect(readFileSync(repeat.archive)).toEqual(readFileSync(chatgpt.archive));
    expect(() => packagePlugin({ directory: chatgpt.directory, appId })).toThrow("must be empty");
    expect(() => packagePlugin({ directory: join(root, "invalid"), appId: "made-up" })).toThrow(
      "technical ID",
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
