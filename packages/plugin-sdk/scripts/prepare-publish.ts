#!/usr/bin/env bun
/** Build a clean, standalone npm publish directory at `packages/plugin-sdk/.publish/`
 * with compiled ESM `.js` + `.d.ts` in `dist/` and resolved `exports` that work in both
 * Node 22+ and Bun — compatible with `npm publish --provenance` (OIDC Trusted Publishing)
 * and `bun publish`. */
import { cpSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";

const pkgDir = resolve(import.meta.dir, "..");
const outDir = resolve(pkgDir, ".publish");

const build = Bun.spawnSync(["bun", "run", "build"], {
  cwd: pkgDir,
  stdout: "inherit",
  stderr: "inherit",
});
if (build.exitCode !== 0) {
  process.exit(build.exitCode ?? 1);
}

const raw = JSON.parse(readFileSync(resolve(pkgDir, "package.json"), "utf8")) as Record<
  string,
  unknown
>;
const publishConfig = (raw.publishConfig ?? {}) as {
  access?: string;
  exports?: Record<string, unknown>;
};

const publishedPkg: Record<string, unknown> = {
  name: raw.name,
  version: raw.version,
  license: raw.license,
  type: raw.type,
  description: raw.description,
  homepage: raw.homepage,
  repository: raw.repository,
  bugs: raw.bugs,
  keywords: raw.keywords,
  engines: raw.engines,
  files: ["dist", "LICENSE", "README.md"],
  exports: publishConfig.exports ?? raw.exports,
  publishConfig: { access: publishConfig.access ?? "public" },
};

rmSync(outDir, { recursive: true, force: true });
mkdirSync(outDir, { recursive: true });
cpSync(resolve(pkgDir, "dist"), resolve(outDir, "dist"), { recursive: true });
cpSync(resolve(pkgDir, "LICENSE"), resolve(outDir, "LICENSE"));
cpSync(resolve(pkgDir, "README.md"), resolve(outDir, "README.md"));
writeFileSync(resolve(outDir, "package.json"), `${JSON.stringify(publishedPkg, null, 2)}\n`);

console.log(`Prepared ${String(raw.name)}@${String(raw.version)} for npm publish in ${outDir}`);
