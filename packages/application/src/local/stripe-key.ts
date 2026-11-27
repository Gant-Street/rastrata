import { closeSync, constants, fstatSync, lstatSync, openSync, readSync } from "node:fs";
import { join } from "node:path";
import {
  ENVIRONMENT_VARIABLE,
  KEY_FILE_NAME,
  type KeySource,
  inspectKey,
} from "../stripe/credentials.ts";

/** The local runtime's Stripe key source: `RASTRATA_STRIPE_KEY` first, then a private file named
 * `stripe.key` in the data directory.
 *
 * The file must be a regular file (not a link) that only its owner can read or write. A key kept
 * where other users can read it is refused with the command that fixes it, never used. The message
 * names the path, which is not secret, and never the contents. */

const MAX_BYTES = 1024;

export function localStripeKeySource(
  dataDirectory: string,
  env: Readonly<Record<string, string | undefined>> = process.env,
): KeySource {
  const path = join(dataDirectory, KEY_FILE_NAME);
  return {
    read() {
      const fromEnvironment = env[ENVIRONMENT_VARIABLE];
      if (fromEnvironment !== undefined && fromEnvironment.trim() !== "")
        return inspectKey(fromEnvironment, "environment");
      let before: ReturnType<typeof lstatSync>;
      try {
        before = lstatSync(path);
      } catch {
        return null;
      }
      if (before.isSymbolicLink() || !before.isFile())
        return { problem: `${path} must be a regular file, not a link or a directory.` };
      if ((before.mode & 0o077) !== 0)
        return {
          problem: `${path} can be read by other users. Run: chmod 600 ${path}`,
        };
      if (before.size > MAX_BYTES) return { problem: `${path} is too large to be a Stripe key.` };
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
        return inspectKey(buffer.subarray(0, read).toString("utf8"), "file");
      } catch {
        return { problem: `${path} could not be read.` };
      } finally {
        closeSync(descriptor);
      }
    },
  };
}

/** The address Stripe is reached at when `RASTRATA_STRIPE_API_URL` is set: only ever a loopback
 * address, so a stand-in server on this machine can take Stripe's place for a browser test, and the
 * key (which is sent with every request) can never be pointed at another host by an environment
 * variable. Unset means Stripe's own address. */
export const STRIPE_API_URL_VARIABLE = "RASTRATA_STRIPE_API_URL";

export function localStripeApiUrl(
  env: Readonly<Record<string, string | undefined>> = process.env,
): string | undefined {
  const raw = env[STRIPE_API_URL_VARIABLE];
  if (raw === undefined || raw.trim() === "") return undefined;
  const refusal = new Error(
    `${STRIPE_API_URL_VARIABLE} must be an http address on this machine (127.0.0.1, localhost or [::1]). The Stripe key is never sent anywhere else.`,
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
