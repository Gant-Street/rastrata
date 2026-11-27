/** A bearer token must never travel in clear text to another computer. The tail and the bulk gateway are
 * reached over the internet with one, so their clients take an address only if it is `https://`, or `http://`
 * for a server on this very computer (the tests and a local `wrangler dev`).
 *
 * The message names the kind of address and its host, never the whole URL: an address can carry a name and a
 * password, and neither belongs in an error. */
const LOOPBACK = /^(?:localhost|[^.]+\.localhost|127(?:\.\d{1,3}){3}|\[::1\])$/;

export const isLoopbackHost = (hostname: string): boolean => LOOPBACK.test(hostname.toLowerCase());

/** The address as a URL, or an Error saying why it may not carry a token. `what` starts the message ("The tail
 * address"). */
export function assertSecureRemote(address: string, what: string): URL {
  let url: URL;
  try {
    url = new URL(address);
  } catch {
    throw new Error(`${what} is not a web address`);
  }
  if (url.username || url.password)
    throw new Error(
      `${what} must not carry a name or a password: the token is a setting of its own`,
    );
  if (url.protocol === "https:") return url;
  if (url.protocol === "http:" && isLoopbackHost(url.hostname)) return url;
  throw new Error(
    `${what} must be an https:// address: plain http is only for this computer, and ${url.protocol}//${url.hostname} is not`,
  );
}
