import { createHash, randomBytes } from "node:crypto";
import {
  closeSync,
  existsSync,
  fsyncSync,
  mkdirSync,
  openSync,
  renameSync,
  rmSync,
  writeSync,
} from "node:fs";
import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import type { ExportSink, ExportWriter } from "../safety/host.ts";
import { parseExportManifest } from "../safety/manifest.ts";
import type { StoredExport } from "../safety/types.ts";
import { ensurePrivateDirectory, fsyncDirectory } from "./files.ts";

const FILE_NAME = /^[A-Za-z0-9][A-Za-z0-9._-]{0,100}$/;

class FileWriter implements ExportWriter {
  private readonly hash = createHash("sha256");
  private bytes = 0;
  private lines = 0;
  private closed = false;
  constructor(private readonly handle: number) {}

  async write(text: string): Promise<void> {
    if (this.closed) throw new Error("The export file is already closed");
    const buffer = Buffer.from(text, "utf8");
    this.hash.update(buffer);
    this.bytes += buffer.length;
    for (const byte of buffer) if (byte === 0x0a) this.lines += 1;
    let written = 0;
    while (written < buffer.length)
      written += writeSync(this.handle, buffer, written, buffer.length - written);
  }

  async close() {
    if (!this.closed) {
      this.closed = true;
      fsyncSync(this.handle);
      closeSync(this.handle);
    }
    return { bytes: this.bytes, sha256: this.hash.digest("hex"), lines: this.lines };
  }

  /** Release the handle without claiming the file is complete. */
  discard(): void {
    if (this.closed) return;
    this.closed = true;
    try {
      closeSync(this.handle);
    } catch {
      // Already closed.
    }
  }
}

/** An export written into a directory: files are made inside a hidden working directory and the
 * whole thing is renamed to `<root>/<id>` only when every file is complete, so an export that
 * exists is a whole export and an interrupted one leaves nothing under its name. */
export class DirectoryExportSink implements ExportSink {
  private readonly working: string;
  private readonly names = new Set<string>();
  private readonly writers: FileWriter[] = [];
  private created = false;

  constructor(
    private readonly root: string,
    private readonly id: string,
  ) {
    this.working = join(root, `.partial-${id}-${randomBytes(4).toString("hex")}`);
  }

  async file(path: string): Promise<ExportWriter> {
    if (!FILE_NAME.test(path)) throw new Error(`Not a file name an export may use: ${path}`);
    if (this.names.has(path)) throw new Error(`The export already has a file named ${path}`);
    if (!this.created) {
      ensurePrivateDirectory(this.root);
      mkdirSync(this.working, { mode: 0o700 });
      this.created = true;
    }
    this.names.add(path);
    const writer = new FileWriter(openSync(join(this.working, path), "wx", 0o600));
    this.writers.push(writer);
    return writer;
  }

  async finish(): Promise<{ readonly location: string }> {
    if (!this.created) throw new Error("The export has no files");
    const location = join(this.root, this.id);
    if (existsSync(location)) {
      await this.abort();
      throw new Error(`An export named ${this.id} already exists`);
    }
    fsyncDirectory(this.working);
    renameSync(this.working, location);
    fsyncDirectory(this.root);
    return { location };
  }

  async abort(): Promise<void> {
    for (const writer of this.writers) writer.discard();
    rmSync(this.working, { recursive: true, force: true });
  }
}

/** The exports in a folder, newest first. A folder whose manifest is missing or does not match its
 * own hash is not an export and is skipped. */
export async function listExportFolders(root: string): Promise<StoredExport[]> {
  let names: string[];
  try {
    names = await readdir(root);
  } catch {
    return [];
  }
  const found: StoredExport[] = [];
  for (const name of names
    .filter((item) => !item.startsWith("."))
    .sort()
    .reverse()) {
    try {
      const parsed = await parseExportManifest(
        await readFile(join(root, name, "manifest.json"), "utf8"),
      );
      if (!parsed.ok || parsed.manifest.id !== name) continue;
      found.push({
        id: name,
        location: join(root, name),
        manifest: parsed.manifest,
        bytes: parsed.manifest.files.reduce((total, file) => total + file.bytes, 0),
      });
    } catch {
      // Not an export.
    }
    if (found.length >= 1000) break;
  }
  return found;
}
