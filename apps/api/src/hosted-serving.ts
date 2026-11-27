/** Who the hosted server answers to, and what a browser's `Origin` has to be.
 *
 * The experiment harness listened on 127.0.0.1 and answered only to the loopback names. The product
 * server also listens beyond this computer (`RASTRATA_BIND=0.0.0.0` in a pod) and is reached through a
 * tunnel, so three things are settings of the deployment and none is guessed from the request:
 *
 *   RASTRATA_BIND            the address to listen on (default 127.0.0.1)
 *   RASTRATA_ALLOWED_HOSTS   the hostnames the server answers to, comma separated (app.rastrata.com).
 *                            The loopback names stay allowed only when the server is bound to loopback.
 *   RASTRATA_PUBLIC_ORIGIN   the address people use (https://app.rastrata.com). Behind a tunnel the
 *                            browser sends `Origin: https://app.rastrata.com` while the pod sees a
 *                            plain-http request for the same host, so the scheme of an Origin is compared
 *                            with this one. Left out, with the request's own.
 *
 * Nothing here reads `X-Forwarded-*`: a header any client can send is not a statement about the
 * connection. The Host header is checked against the list (a name that is not on it is a DNS rebinding
 * attempt or a stray), and an Origin must be this server's own origin: the scheme the deployment says,
 * and exactly the host the request was sent to, so that a page on another name of the same site (a
 * sibling subdomain, whose requests carry a SameSite cookie) is not let in. */
import { isIP } from "node:net";

type Environment = Readonly<Record<string, string | undefined>>;

/** The names that mean this computer. */
export const LOOPBACK_NAMES: readonly string[] = ["127.0.0.1", "localhost", "[::1]"];

export interface ServingOptions {
  /** The address to listen on: an IP address or `localhost` (default `127.0.0.1`). */
  readonly bind?: string;
  /** The hostnames the server answers to, without ports or schemes. */
  readonly allowedHosts?: readonly string[];
  /** The address people use, such as `https://app.rastrata.com`. */
  readonly publicOrigin?: string;
}

/** The serving settings in the environment (`RASTRATA_BIND`, `RASTRATA_ALLOWED_HOSTS`,
 * `RASTRATA_PUBLIC_ORIGIN`); a variable that is set and empty counts as not set. */
export function servingFromEnvironment(env: Environment): ServingOptions {
  const hosts = (env.RASTRATA_ALLOWED_HOSTS ?? "")
    .split(",")
    .map((host) => host.trim())
    .filter(Boolean);
  return {
    ...(env.RASTRATA_BIND ? { bind: env.RASTRATA_BIND.trim() } : {}),
    ...(hosts.length > 0 ? { allowedHosts: hosts } : {}),
    ...(env.RASTRATA_PUBLIC_ORIGIN ? { publicOrigin: env.RASTRATA_PUBLIC_ORIGIN.trim() } : {}),
  };
}

const HOSTNAME = /^[a-z0-9]([a-z0-9._-]*[a-z0-9])?$/;
const HOST_HEADER = /^(\[[0-9a-f:.]+\]|[a-z0-9]([a-z0-9._-]*[a-z0-9])?)(?::([0-9]{1,5}))?$/i;

/** A Host header split into its name (lower case, an IPv6 address in brackets) and its port, or null when
 * it is not a host at all. */
function splitHost(value: string): { readonly name: string; readonly port: string } | null {
  const match = HOST_HEADER.exec(value);
  if (!match) return null;
  return { name: (match[1] as string).toLowerCase(), port: match[3] ?? "" };
}

const isLoopbackAddress = (bind: string): boolean =>
  bind === "localhost" || bind === "::1" || /^127\./.test(bind);

/** The serving policy of one server. Built once, from the settings, before anything listens: a setting
 * that cannot work (a public address that is not on the list of names, a pod that listens beyond
 * loopback and answers to nobody) stops the start with a message that names it. */
export class Serving {
  readonly bind: string;
  /** Listening on this computer only. */
  readonly loopback: boolean;
  /** The names (lower case) the server answers to, besides the loopback names of a loopback server. */
  readonly hosts: ReadonlySet<string>;
  /** The scheme and the host people use, or null: the request's own. */
  readonly publicOrigin: URL | null;
  #port = 0;

  constructor(options: ServingOptions = {}) {
    const bind = options.bind ?? "127.0.0.1";
    if (isIP(bind) === 0 && bind !== "localhost")
      throw new Error("RASTRATA_BIND must be an IP address such as 127.0.0.1, 0.0.0.0 or ::");
    this.bind = bind;
    this.loopback = isLoopbackAddress(bind);
    const hosts = new Set<string>();
    for (const given of options.allowedHosts ?? []) {
      const host = given.trim().toLowerCase();
      if (!HOSTNAME.test(host) && !/^\[[0-9a-f:.]+\]$/.test(host))
        throw new Error(
          "RASTRATA_ALLOWED_HOSTS lists host names such as app.rastrata.com, without a scheme, a port or a path",
        );
      hosts.add(host);
    }
    this.hosts = hosts;
    if (!this.loopback && hosts.size === 0)
      throw new Error(
        "RASTRATA_ALLOWED_HOSTS is needed when the server listens beyond this computer: it names the host the service answers to",
      );
    let publicOrigin: URL | null = null;
    if (options.publicOrigin) {
      try {
        publicOrigin = new URL(options.publicOrigin);
      } catch {
        throw new Error(
          "RASTRATA_PUBLIC_ORIGIN must be an address such as https://app.rastrata.com",
        );
      }
      if (
        (publicOrigin.protocol !== "https:" && publicOrigin.protocol !== "http:") ||
        publicOrigin.username ||
        publicOrigin.password ||
        publicOrigin.pathname !== "/" ||
        publicOrigin.search ||
        publicOrigin.hash
      )
        throw new Error(
          "RASTRATA_PUBLIC_ORIGIN must be a scheme and a host, such as https://app.rastrata.com, with no path",
        );
      const named = publicOrigin.hostname.toLowerCase();
      const loopbackName = this.loopback && LOOPBACK_NAMES.includes(named);
      if (!hosts.has(named) && !loopbackName)
        throw new Error("RASTRATA_PUBLIC_ORIGIN names a host that RASTRATA_ALLOWED_HOSTS does not");
    }
    this.publicOrigin = publicOrigin;
  }

  /** The port the server listens on, known once it does (it may have been asked for at random). */
  listening(port: number): void {
    this.#port = port;
  }

  /** Whether a Host header names this server. A loopback server answers to the loopback names with its
   * own port; the listed names are answered with no port, with the server's own, or with the port of the
   * public address. */
  hostAllowed(value: string | null): boolean {
    const host = splitHost(value ?? "");
    if (!host) return false;
    if (this.loopback && LOOPBACK_NAMES.includes(host.name) && host.port === String(this.#port))
      return true;
    if (!this.hosts.has(host.name)) return false;
    return host.port === "" || host.port === String(this.#port) || host.port === this.#publicPort();
  }

  /** The port of the public address, written out (a default port is the scheme's). */
  #publicPort(): string | null {
    if (!this.publicOrigin) return null;
    return this.publicOrigin.port || (this.publicOrigin.protocol === "https:" ? "443" : "80");
  }

  /** Whether an `Origin` header is this server's own: the scheme the deployment says (the public
   * address, or the request's own) and the very host the request was sent to. `null`, a path, another
   * scheme or another name, even one of this server's own, is not. */
  originAllowed(origin: string, host: string, requestUrl: URL): boolean {
    let parsed: URL;
    try {
      parsed = new URL(origin);
    } catch {
      return false;
    }
    if (parsed.origin !== origin) return false;
    const scheme = this.publicOrigin?.protocol ?? requestUrl.protocol;
    if (parsed.protocol !== scheme) return false;
    let sent: URL;
    try {
      sent = new URL(`${scheme}//${host}`);
    } catch {
      return false;
    }
    return parsed.host === sent.host;
  }

  /** The address of a request as people use it: behind a tunnel the pod sees plain http for a host the
   * browser reaches over https, and the application checks an Origin against the address of its request. */
  publicUrl(url: URL): URL {
    if (!this.publicOrigin || url.protocol === this.publicOrigin.protocol) return url;
    const next = new URL(url);
    next.protocol = this.publicOrigin.protocol;
    return next;
  }

  /** Whether people reach this server over https, so that a cookie may be `Secure` and a browser may be
   * told to keep to https. */
  get https(): boolean {
    return this.publicOrigin?.protocol === "https:";
  }
}
