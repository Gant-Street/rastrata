import {
  chmodSync,
  closeSync,
  constants,
  fstatSync,
  lstatSync,
  openSync,
  readSync,
  rmSync,
  statSync,
} from "node:fs";
import { join } from "node:path";
import {
  CREDENTIAL_FILE_NAME,
  type CredentialResult,
  type CredentialStore,
} from "../bankfeed/credentials.ts";
import { writeFileAtomic } from "./files.ts";

/** The local runtime's place for the SimpleFIN access URL: a private file named `simplefin.access` in
 * the data directory, beside the book, readable and writable only by its owner.
 *
 * It is a file and not a row in the book on purpose. The book is backed up, exported and copied; an
 * access URL is a credential for someone's bank data, and putting it in any of those would put a live
 * secret in places with more readers than the book has. A backup is made from the database file
 * alone, and the open export is built from the ledger, so a file beside the database is in neither
 * (`test/bankfeed/credential-file.test.ts` checks both, byte for byte). Restoring a backup on another
 * computer therefore does not bring the connection with it: connect again with a new setup token.
 *
 * Reading follows the Stripe key's rules: a regular file (not a link) that no other user can read,
 * small, opened without following a link, and checked again once open. A file that others can read
 * is refused with the command that fixes it, never used. Messages name the path, which is not secret,
 * and never the contents. */

const MAX_BYTES = 2048;

export function localCredentialStore(dataDirectory: string): CredentialStore {
  const path = join(dataDirectory, CREDENTIAL_FILE_NAME);
  return {
    read(): CredentialResult {
      let before: ReturnType<typeof lstatSync>;
      try {
        before = lstatSync(path);
      } catch {
        return null;
      }
      if (before.isSymbolicLink() || !before.isFile())
        return { problem: `${path} must be a regular file, not a link or a directory.` };
      if ((before.mode & 0o077) !== 0)
        return { problem: `${path} can be read by other users. Run: chmod 600 ${path}` };
      if (before.size > MAX_BYTES)
        return { problem: `${path} is too large to be a SimpleFIN access URL.` };
      let descriptor: number;
      try {
        // O_NOFOLLOW closes the gap between the check above and the read.
        descriptor = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW);
      } catch {
        return { problem: `${path} could not be opened.` };
      }
      try {
        const after = fstatSync(descriptor);
        if (!after.isFile() || (after.mode & 0o077) !== 0)
          return { problem: `${path} changed while it was being read.` };
        const buffer = Buffer.alloc(Math.min(after.size, MAX_BYTES));
        const read = readSync(descriptor, buffer, 0, buffer.length, 0);
        const text = buffer.subarray(0, read).toString("utf8").trim();
        return text === "" ? { problem: `${path} is empty.` } : { accessUrl: text };
      } catch {
        return { problem: `${path} could not be read.` };
      } finally {
        closeSync(descriptor);
      }
    },

    probe(): string | null {
      // A setup token can be claimed only once, so before claiming one make sure the access URL it
      // returns can be kept: create and remove a private file in the same place.
      const probe = `${path}.probe-${process.pid}-${Date.now()}`;
      try {
        if (!statSync(dataDirectory).isDirectory())
          return `${dataDirectory} is not a folder, so Rastrata has nowhere private to keep the connection.`;
        writeFileAtomic(probe, "probe", 0o600);
        rmSync(probe, { force: true });
        return null;
      } catch {
        rmSync(probe, { force: true });
        return `Rastrata cannot write to ${dataDirectory}, so it has nowhere private to keep the connection. Nothing was claimed. Fix the folder's permissions and try again.`;
      }
    },

    write(accessUrl: string): void {
      writeFileAtomic(path, `${accessUrl}\n`, 0o600);
      // The file is created private, but a process umask must never be what decides that.
      chmodSync(path, 0o600);
    },

    remove(): void {
      rmSync(path, { force: true });
    },
  };
}

/** The address of a stand-in Bridge on this machine, from `RASTRATA_SIMPLEFIN_STANDIN`, for a browser
 * test: only an `http` address on 127.0.0.1, localhost or [::1] with no path or credentials, and the
 * bank feed then speaks `http` to that one origin and to nothing else. Unset means the Bridge's own
 * hosts only. The access URL is sent with every request, so an environment variable can never point
 * it at another host. */
export const SIMPLEFIN_STANDIN_VARIABLE = "RASTRATA_SIMPLEFIN_STANDIN";

export function localSimplefinStandIn(
  env: Readonly<Record<string, string | undefined>> = process.env,
): string | undefined {
  const raw = env[SIMPLEFIN_STANDIN_VARIABLE];
  if (raw === undefined || raw.trim() === "") return undefined;
  const refusal = new Error(
    `${SIMPLEFIN_STANDIN_VARIABLE} must be an http address on this machine (127.0.0.1, localhost or [::1]). The access URL is never sent anywhere else.`,
  );
  let url: URL;
  try {
    url = new URL(raw.trim());
  } catch {
    throw refusal;
  }
  const loopback = ["127.0.0.1", "localhost", "[::1]"].includes(url.hostname);
  if (url.protocol !== "http:" || !loopback || url.username !== "" || url.password !== "")
    throw refusal;
  if (url.pathname !== "/" || url.search !== "" || url.hash !== "") throw refusal;
  return url.origin;
}
