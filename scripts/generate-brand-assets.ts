// Writes the logo files from the design system's geometry (packages/ui/src/brand) into the design
// system's brand kit and into the apps that carry their own copies. `--check` writes nothing and
// fails if any file is out of date; packages/ui/unit/logo.test.ts runs the same comparison.
import { brandFiles } from "../packages/ui/src/brand/brand-files.ts";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";

const root = resolve(import.meta.dir, "..");
const check = process.argv.includes("--check");
const files = brandFiles().filter((file) =>
  existsSync(resolve(root, file.path.split("/").slice(0, 2).join("/"))),
);
const stale: string[] = [];

for (const file of files) {
  const path = resolve(root, file.path);
  const wanted = Buffer.from(file.content);
  if (check) {
    if (!existsSync(path) || !readFileSync(path).equals(wanted)) stale.push(file.path);
    continue;
  }
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, wanted);
}

if (check && stale.length > 0) {
  console.error(
    `Brand files are out of date:\n  ${stale.join("\n  ")}\nRun: bun scripts/generate-brand-assets.ts`,
  );
  process.exit(1);
}
console.log(
  check ? `${files.length} brand files are up to date` : `Wrote ${files.length} brand files`,
);
