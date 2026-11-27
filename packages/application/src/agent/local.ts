/** The owner key file, for the local runtimes that need the filesystem: the API service creates and
 * reads it, and the processes that act for the owner (the web server, the MCP server) read it.
 * Portable code does not import this file; reach it through `@rastrata/application/agent/local`. */
import { existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { isOwnerKey, issueOwnerKey } from "./token.ts";

function check(path: string): string {
  const info = statSync(path);
  if (!info.isFile()) throw new Error(`The owner key path ${path} is not a file`);
  if ((info.mode & 0o077) !== 0)
    throw new Error(`The owner key file ${path} must be private to you (chmod 600)`);
  const key = readFileSync(path, "utf8").trim();
  if (!isOwnerKey(key)) throw new Error(`${path} does not contain a Rastrata owner key`);
  return key;
}

/** Read an existing owner key file. A file other users can read, or one that holds anything but an
 * owner key, is refused. The key is never printed or logged. */
export function readOwnerKey(path: string): string {
  if (!existsSync(path)) throw new Error(`The owner key file ${path} does not exist`);
  return check(path);
}

/** Read the owner key at `path`, creating the file (mode 0600, never overwriting) when it does not
 * exist. */
export function loadOrCreateOwnerKey(path: string): string {
  if (!existsSync(path)) {
    mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
    try {
      writeFileSync(path, `${issueOwnerKey()}\n`, { mode: 0o600, flag: "wx" });
    } catch (error) {
      // Another process created it first: use theirs.
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
    }
  }
  return check(path);
}
