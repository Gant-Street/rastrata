import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { parseExportManifest } from "../safety/manifest.ts";
import type { Check, ExportManifest } from "../safety/types.ts";
import { hashFile } from "./files.ts";

export interface ExportCheck {
  readonly manifest: ExportManifest | null;
  readonly passed: boolean;
  readonly checks: readonly Check[];
}

/**
 * Check an export folder against its own manifest without Rastrata's ledger: the manifest's hash,
 * every listed file's size and SHA-256, that `SHA256SUMS` agrees with the manifest, and that
 * nothing unlisted is sitting in the folder. This is what a person who only has the folder can do,
 * and what an import does before it trusts a byte.
 */
export async function checkExportFiles(directory: string): Promise<ExportCheck> {
  const checks: Check[] = [];
  const add = (code: string, status: Check["status"], message: string) =>
    checks.push({ code, status, message });
  const manifestPath = join(directory, "manifest.json");
  if (!existsSync(manifestPath)) {
    add("manifest", "failed", `There is no manifest.json in ${directory}; this is not an export.`);
    return { manifest: null, passed: false, checks };
  }
  const parsed = await parseExportManifest(readFileSync(manifestPath, "utf8"));
  if (!parsed.ok) {
    add("manifest", "failed", parsed.problem);
    return { manifest: null, passed: false, checks };
  }
  const { manifest } = parsed;
  add(
    "manifest",
    "passed",
    `manifest.json is intact: ${manifest.files.length} files, ledger at outcome ${manifest.ledger.head.sequence}.`,
  );
  let bad = 0;
  for (const file of manifest.files) {
    const path = join(directory, file.path);
    if (!existsSync(path)) {
      add(`file:${file.path}`, "failed", `${file.path} is listed in the manifest but missing.`);
      bad += 1;
      continue;
    }
    const found = hashFile(path);
    if (found.bytes !== file.bytes || found.sha256 !== file.sha256) {
      add(
        `file:${file.path}`,
        "failed",
        `${file.path} does not match the manifest: it was altered or damaged.`,
      );
      bad += 1;
    }
  }
  if (bad === 0)
    add(
      "files",
      "passed",
      `All ${manifest.files.length} files match the manifest's sizes and SHA-256 hashes.`,
    );
  const sums = join(directory, "SHA256SUMS");
  if (existsSync(sums)) {
    const expected = new Map(manifest.files.map((file) => [file.path, file.sha256]));
    expected.set("manifest.json", hashFile(manifestPath).sha256);
    const listed = new Map(
      readFileSync(sums, "utf8")
        .split("\n")
        .filter(Boolean)
        .map((line) => {
          const [hash = "", ...rest] = line.split("  ");
          return [rest.join("  "), hash] as const;
        }),
    );
    const disagree = [...expected].filter(([path, hash]) => listed.get(path) !== hash);
    if (disagree.length === 0) add("sha256sums", "passed", "SHA256SUMS agrees with the manifest.");
    else
      add(
        "sha256sums",
        "failed",
        `SHA256SUMS disagrees with the manifest for ${disagree
          .map(([path]) => path)
          .slice(0, 3)
          .join(", ")}.`,
      );
  } else add("sha256sums", "failed", "SHA256SUMS is missing.");
  const known = new Set([
    ...manifest.files.map((file) => file.path),
    "manifest.json",
    "SHA256SUMS",
  ]);
  const extra = readdirSync(directory).filter(
    (name) => !known.has(name) && statSync(join(directory, name)).isFile(),
  );
  if (extra.length > 0)
    add(
      "extra_files",
      "failed",
      `The folder holds files the manifest does not list: ${extra.slice(0, 5).join(", ")}.`,
    );
  return { manifest, passed: checks.every((check) => check.status !== "failed"), checks };
}
