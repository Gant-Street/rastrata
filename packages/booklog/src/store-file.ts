import {
  closeSync,
  existsSync,
  linkSync,
  mkdirSync,
  openSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  unlinkSync,
  writeSync,
} from "node:fs";
import { createHash, randomBytes } from "node:crypto";
import { dirname, join, sep } from "node:path";
import {
  MAX_LIST,
  ObjectStoreError,
  type ListPage,
  type ObjectMeta,
  type ObjectStore,
  type PutOptions,
  type PutResult,
  type StoredObject,
} from "./objectstore.ts";

/** An object store in a directory, for a single machine: a development server without a bucket, and
 * the experiments that need a fresh process to find a book in a shared place. A key is a path under
 * the root. An object is one file (a small header with its metadata, then its bytes) that appears
 * all at once: it is written beside its place and linked in, and `link` fails if the name is taken,
 * which is the create-only commit point. */
export class FileObjectStore implements ObjectStore {
  readonly #root: string;

  constructor(root: string) {
    this.#root = root;
    mkdirSync(root, { recursive: true });
  }

  #path(key: string): string {
    if (
      key.length === 0 ||
      key.startsWith("/") ||
      key.split("/").some((part) => part === ".." || part === "")
    )
      throw new ObjectStoreError(`Bad key ${key}`, 400, "InvalidKey");
    return join(this.#root, ...key.split("/"));
  }

  async putIfAbsent(key: string, body: Uint8Array, options?: PutOptions): Promise<PutResult> {
    const path = this.#path(key);
    mkdirSync(dirname(path), { recursive: true });
    const metadata: Record<string, string> = {};
    for (const [name, value] of Object.entries(options?.metadata ?? {}))
      metadata[name.toLowerCase()] = value;
    const header = new TextEncoder().encode(JSON.stringify(metadata));
    const temporary = `${path}.${randomBytes(6).toString("hex")}.tmp`;
    const fd = openSync(temporary, "wx");
    try {
      const prefix = new Uint8Array(4);
      new DataView(prefix.buffer).setUint32(0, header.byteLength);
      writeSync(fd, prefix);
      writeSync(fd, header);
      writeSync(fd, body);
    } finally {
      closeSync(fd);
    }
    try {
      linkSync(temporary, path);
    } catch (error) {
      unlinkSync(temporary);
      if ((error as NodeJS.ErrnoException).code === "EEXIST") return { created: false };
      throw error;
    }
    unlinkSync(temporary);
    return { created: true, etag: `"${createHash("md5").update(body).digest("hex")}"` };
  }

  #read(key: string): { meta: Record<string, string>; body: Uint8Array } | null {
    const path = this.#path(key);
    if (!existsSync(path) || statSync(path).isDirectory()) return null;
    const bytes = readFileSync(path);
    const length = new DataView(bytes.buffer, bytes.byteOffset, 4).getUint32(0);
    const meta = JSON.parse(new TextDecoder().decode(bytes.subarray(4, 4 + length))) as Record<
      string,
      string
    >;
    return {
      meta,
      body: new Uint8Array(
        bytes.buffer,
        bytes.byteOffset + 4 + length,
        bytes.byteLength - 4 - length,
      ),
    };
  }

  async get(key: string): Promise<StoredObject | null> {
    const found = this.#read(key);
    if (!found) return null;
    return {
      key,
      body: found.body,
      size: found.body.byteLength,
      etag: `"${createHash("md5").update(found.body).digest("hex")}"`,
      metadata: found.meta,
    };
  }

  async head(key: string): Promise<ObjectMeta | null> {
    const found = this.#read(key);
    if (!found) return null;
    return {
      key,
      size: found.body.byteLength,
      etag: `"${createHash("md5").update(found.body).digest("hex")}"`,
      metadata: found.meta,
    };
  }

  async list(prefix: string, after?: string, limit?: number): Promise<ListPage> {
    const bound = Math.min(Math.max(1, limit ?? MAX_LIST), MAX_LIST);
    const keys: string[] = [];
    const directory = prefix.includes("/") ? prefix.slice(0, prefix.lastIndexOf("/")) : "";
    const start = directory ? join(this.#root, ...directory.split("/")) : this.#root;
    const walk = (path: string, relative: string) => {
      if (!existsSync(path)) return;
      for (const entry of readdirSync(path, { withFileTypes: true })) {
        const key = relative ? `${relative}/${entry.name}` : entry.name;
        if (entry.isDirectory()) walk(join(path, entry.name), key);
        else if (
          !entry.name.endsWith(".tmp") &&
          key.startsWith(prefix) &&
          (after === undefined || key > after)
        )
          keys.push(key);
      }
    };
    walk(start, directory);
    keys.sort();
    const page = keys.slice(0, bound);
    return {
      objects: page.map((key) => {
        const found = this.#read(key) as { body: Uint8Array };
        return {
          key,
          size: found.body.byteLength,
          etag: `"${createHash("md5").update(found.body).digest("hex")}"`,
        };
      }),
      truncated: keys.length > bound,
    };
  }

  async delete(key: string): Promise<void> {
    rmSync(this.#path(key), { force: true });
  }
}

void sep;
