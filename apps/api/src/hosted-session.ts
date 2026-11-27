/** Signing in to the hosted server as its owner, for a browser.
 *
 * A request to `/v1` carries `Authorization: Bearer <owner key or agent token>`. A browser on a public
 * host cannot keep a key in JavaScript, so the owner signs in once, and the server keeps the key:
 *
 *   POST   /session/owner   {"key": "rso_..."}  compares the key in constant time, and answers with an
 *                           HttpOnly, Secure, SameSite=Strict cookie (`__Host-` prefixed) that names a
 *                           session this server holds. At most a few attempts a minute for each client.
 *   DELETE /session         signs out: the session is forgotten and the cookie is cleared.
 *
 * `/auth/*` is the later control Worker's, and nothing here is under it. What the rest of the server
 * depends on is one step, `credential(request)`: from the request to the `Authorization` value the
 * application is to see, or nothing. The sign-in of accounts (a signed token the server verifies) will
 * be another `CredentialSource`; the routes, the limit on attempts, the checks against forged
 * cross-site requests and the sign-in screen stay as they are.
 *
 * A session is an unguessable random id (256 bits) in the cookie; the server keeps only its SHA-256, so
 * a copy of the server's memory holds no cookie that works. Sessions end after a time of no use and
 * after a longest life, and are kept in memory: a restarted pod asks the owner to sign in again, which
 * is the price of holding no state outside the log. Nothing here logs, echoes or stores the key beyond
 * the process's memory, and a cookie never reaches the application.
 *
 * What stops another website from using the cookie: SameSite=Strict, the `__Host-` prefix (a sibling
 * subdomain cannot set it), and a check of the request itself (see `CredentialSource.refuses`). */
import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import { isIP } from "node:net";

/** The name of the session cookie. `__Host-` makes a browser accept it only from a secure connection,
 * for this host alone (no Domain), for the whole site (Path=/). */
export const SESSION_COOKIE = "__Host-rastrata_session";

export const SESSION_IDLE_MS = 12 * 60 * 60 * 1000;
export const SESSION_LIFETIME_MS = 7 * 24 * 60 * 60 * 1000;
/** Sessions kept at once: signing in again past this forgets the oldest. */
export const MAX_SESSIONS = 64;
/** A sign-in request is a key and nothing else. */
const MAX_SIGN_IN_BYTES = 1024;

export interface SessionOptions {
  /** A session nobody has used for this long ends (default 12 hours). */
  readonly idleMs?: number;
  /** A session ends this long after it began, however it is used (default 7 days). */
  readonly lifetimeMs?: number;
  /** How many attempts to sign in one client may make in `windowMs` (default 5). */
  readonly attempts?: number;
  /** (default one minute) */
  readonly windowMs?: number;
  /** The clock, in milliseconds. Tests. */
  readonly now?: () => number;
  /** Told what happened, in words and without a key (a sign-in, a refusal, a sign-out). */
  readonly log?: (line: string) => void;
}

/** The step from a request to the credential the application is to see. */
export interface CredentialSource {
  /** The `Authorization` header value to present (`Bearer ...`), or null when the request has no
   * session of this kind. */
  credential(request: Request): string | null;
  /** Whether the request must be refused instead: it carries a session but was not made by this
   * server's own page (a request from another site, or a state-changing one that does not say where it
   * came from). The application would answer a refused request as one with no credentials. */
  refuses(request: Request): boolean;
}

const sha256 = (text: string): string => createHash("sha256").update(text).digest("hex");

/** Compare two secrets without stopping at the first difference: over their digests, which are of one
 * length whatever was sent. */
export function sameSecret(sent: string, expected: string): boolean {
  return timingSafeEqual(
    createHash("sha256").update(sent).digest(),
    createHash("sha256").update(expected).digest(),
  );
}

/** The sessions of one server, in memory. */
export class SessionStore {
  readonly #sessions = new Map<string, { readonly began: number; seen: number }>();
  readonly #now: () => number;
  readonly #idleMs: number;
  readonly #lifetimeMs: number;

  constructor(options: Pick<SessionOptions, "idleMs" | "lifetimeMs" | "now"> = {}) {
    this.#now = options.now ?? Date.now;
    this.#idleMs = options.idleMs ?? SESSION_IDLE_MS;
    this.#lifetimeMs = options.lifetimeMs ?? SESSION_LIFETIME_MS;
  }

  /** How long a cookie for a session made now may live, in seconds. */
  get maxAgeSeconds(): number {
    return Math.floor(this.#lifetimeMs / 1000);
  }

  get size(): number {
    return this.#sessions.size;
  }

  /** Begin a session and return the id for its cookie. */
  begin(): string {
    this.#prune();
    while (this.#sessions.size >= MAX_SESSIONS) {
      const oldest = this.#sessions.keys().next().value;
      if (oldest === undefined) break;
      this.#sessions.delete(oldest);
    }
    const id = randomBytes(32).toString("base64url");
    const now = this.#now();
    this.#sessions.set(sha256(id), { began: now, seen: now });
    return id;
  }

  /** Whether `id` is a live session; using it keeps it alive. */
  valid(id: string): boolean {
    if (!/^[A-Za-z0-9_-]{43}$/.test(id)) return false;
    const key = sha256(id);
    const session = this.#sessions.get(key);
    if (!session) return false;
    const now = this.#now();
    if (now - session.seen > this.#idleMs || now - session.began > this.#lifetimeMs) {
      this.#sessions.delete(key);
      return false;
    }
    session.seen = now;
    return true;
  }

  end(id: string): void {
    this.#sessions.delete(sha256(id));
  }

  #prune(): void {
    const now = this.#now();
    for (const [key, session] of this.#sessions)
      if (now - session.seen > this.#idleMs || now - session.began > this.#lifetimeMs)
        this.#sessions.delete(key);
  }
}

/** How often each client may try to sign in: `attempts` in any `windowMs`, counting every attempt. */
export class SignInLimiter {
  readonly #tries = new Map<string, number[]>();
  readonly #attempts: number;
  readonly #windowMs: number;
  readonly #now: () => number;
  readonly #clients: number;

  constructor(
    options: Pick<SessionOptions, "attempts" | "windowMs" | "now"> & { clients?: number } = {},
  ) {
    this.#attempts = options.attempts ?? 5;
    this.#windowMs = options.windowMs ?? 60_000;
    this.#now = options.now ?? Date.now;
    this.#clients = options.clients ?? 4096;
  }

  /** Count an attempt by `client`. `retryAfterSeconds` is set when it is not allowed. */
  take(client: string): { readonly allowed: boolean; readonly retryAfterSeconds?: number } {
    const now = this.#now();
    const recent = (this.#tries.get(client) ?? []).filter((at) => now - at < this.#windowMs);
    if (recent.length >= this.#attempts) {
      this.#tries.set(client, recent);
      const first = recent[0] as number;
      return {
        allowed: false,
        retryAfterSeconds: Math.max(1, Math.ceil((first + this.#windowMs - now) / 1000)),
      };
    }
    recent.push(now);
    // Re-insert, so that the clients tried longest ago are first in line to be forgotten.
    this.#tries.delete(client);
    this.#tries.set(client, recent);
    if (this.#tries.size > this.#clients) this.#forget(now);
    return { allowed: true };
  }

  #forget(now: number): void {
    for (const [client, tries] of this.#tries)
      if (tries.every((at) => now - at >= this.#windowMs)) this.#tries.delete(client);
    while (this.#tries.size > this.#clients) {
      const oldest = this.#tries.keys().next().value;
      if (oldest === undefined) break;
      this.#tries.delete(oldest);
    }
  }
}

/** The cookies of a request. */
export function cookiesOf(header: string | null): Map<string, string> {
  const cookies = new Map<string, string>();
  for (const part of (header ?? "").split(";")) {
    const at = part.indexOf("=");
    if (at <= 0) continue;
    const name = part.slice(0, at).trim();
    if (!cookies.has(name)) cookies.set(name, part.slice(at + 1).trim());
  }
  return cookies;
}

const COOKIE_ATTRIBUTES = "Path=/; Secure; HttpOnly; SameSite=Strict";
export const sessionCookie = (id: string, maxAgeSeconds: number): string =>
  `${SESSION_COOKIE}=${id}; ${COOKIE_ATTRIBUTES}; Max-Age=${maxAgeSeconds}`;
export const clearedCookie = (): string => `${SESSION_COOKIE}=; ${COOKIE_ATTRIBUTES}; Max-Age=0`;

/** Who is asking, for the limit on attempts: the address Cloudflare saw (`CF-Connecting-IP`, when it is
 * an address), else the address of the connection. Only a limit rests on it, never a decision about
 * access, so a header a client can forge costs nothing more than a better chance of not being counted. */
export function clientAddress(request: Request, socketAddress: string | undefined): string {
  const seen = request.headers.get("cf-connecting-ip")?.trim();
  if (seen && isIP(seen) !== 0) return seen.toLowerCase();
  return socketAddress ?? "unknown";
}

const SAFE_METHODS = new Set(["GET", "HEAD", "OPTIONS"]);

/** What a browser says about where a request came from. A request made by this server's own page is
 * `same-origin`; one the person typed or followed from outside is `none`; anything else (`same-site`
 * is a sibling subdomain, `cross-site` another website) never gets the cookie's authority. A request
 * that changes something has to say where it came from: an `Origin` (the caller has already checked it
 * is this server's own) or `Sec-Fetch-Site: same-origin`. */
export function madeByOwnPage(request: Request): boolean {
  const site = request.headers.get("sec-fetch-site");
  if (site !== null && site !== "same-origin" && site !== "none") return false;
  if (SAFE_METHODS.has(request.method)) return true;
  return request.headers.has("origin") || site === "same-origin";
}

export interface OwnerSessions extends CredentialSource {
  /** The routes of the sign-in; null when the request is not for them. The caller has checked the Host
   * and the Origin already. */
  handle(request: Request, url: URL, client: string): Promise<Response | null>;
}

const json = (body: unknown, status = 200, headers: Record<string, string> = {}): Response =>
  Response.json(body, { status, headers: { "cache-control": "no-store", ...headers } });

const refusal = (
  status: number,
  code: string,
  message: string,
  headers: Record<string, string> = {},
): Response =>
  json({ ok: false, error: { code, message, retryable: status === 429 } }, status, headers);

/** Read a request body that may not be longer than `limit`, or null when it is. */
async function readSmall(request: Request, limit: number): Promise<string | null> {
  const declared = Number(request.headers.get("content-length") ?? "0");
  if (declared > limit || !request.body) return declared > limit ? null : "";
  const reader = request.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.byteLength;
    if (size > limit) {
      void reader.cancel().catch(() => {});
      return null;
    }
    chunks.push(value);
  }
  return Buffer.concat(chunks).toString("utf8");
}

/** The owner's sessions. `ownerKey` is the one credential a session stands for. */
export function ownerSessions(ownerKey: string, options: SessionOptions = {}): OwnerSessions {
  const sessions = new SessionStore(options);
  const limiter = new SignInLimiter(options);
  const log = options.log ?? (() => {});
  /** The live session of a request, by its cookie. */
  const sessionOf = (request: Request): string | null => {
    const id = cookiesOf(request.headers.get("cookie")).get(SESSION_COOKIE);
    return id !== undefined && sessions.valid(id) ? id : null;
  };
  // Clients already told once in this process that they are being limited: one line each, not a flood.
  const told = new Set<string>();

  return {
    credential: (request) => (sessionOf(request) ? `Bearer ${ownerKey}` : null),

    refuses: (request) =>
      cookiesOf(request.headers.get("cookie")).has(SESSION_COOKIE) && !madeByOwnPage(request),

    async handle(request, url, client) {
      const path = url.pathname;
      if (path !== "/session" && path !== "/session/owner") return null;
      if (url.search)
        return refusal(400, "bad_request", "The sign-in takes no query: send the key in the body.");
      const own = madeByOwnPage(request);

      if (path === "/session") {
        if (request.method === "DELETE") {
          if (!own)
            return refusal(
              403,
              "origin_denied",
              "Signing out has to come from the service's own page.",
            );
          const id = cookiesOf(request.headers.get("cookie")).get(SESSION_COOKIE);
          if (id !== undefined) sessions.end(id);
          log("session: signed out");
          return json({ ok: true, signedIn: false }, 200, { "set-cookie": clearedCookie() });
        }
        return refusal(405, "method_not_allowed", "Use DELETE.", { allow: "DELETE" });
      }

      // POST /session/owner
      if (request.method !== "POST")
        return refusal(405, "method_not_allowed", "Use POST.", { allow: "POST" });
      if (!own)
        return refusal(403, "origin_denied", "Signing in has to come from the service's own page.");
      // Counted before anything is read or compared, so that a flood costs a lookup and nothing more.
      const turn = limiter.take(client);
      if (!turn.allowed) {
        if (!told.has(client)) {
          told.add(client);
          if (told.size > 1024) told.clear();
          log(`session: sign-in attempts limited for ${client}`);
        }
        return refusal(
          429,
          "too_many_attempts",
          "Too many sign-in attempts. Wait a minute and try again.",
          {
            "retry-after": String(turn.retryAfterSeconds ?? 60),
          },
        );
      }
      told.delete(client);
      if (
        !/^application\/json(?:;\s*charset=utf-8)?$/i.test(
          request.headers.get("content-type") ?? "",
        )
      )
        return refusal(415, "media_type_unsupported", "Send the key as JSON.");
      const text = await readSmall(request, MAX_SIGN_IN_BYTES).catch(() => null);
      // (The rest of such a body is not read, so the connection does not go on.)
      if (text === null)
        return refusal(413, "request_too_large", "That request is too large.", {
          connection: "close",
        });
      let key: unknown;
      try {
        const body = JSON.parse(text) as unknown;
        const keys =
          body && typeof body === "object" && !Array.isArray(body) ? Object.keys(body) : [];
        key = keys.length === 1 && keys[0] === "key" ? (body as { key?: unknown }).key : undefined;
      } catch {
        key = undefined;
      }
      if (typeof key !== "string" || key.length === 0 || key.length > 256)
        return refusal(400, "bad_request", 'Send {"key": "..."}.');
      if (!sameSecret(key, ownerKey)) {
        log(`session: sign-in refused for ${client}`);
        return refusal(401, "invalid_key", "That key was not accepted.");
      }
      // A fresh session each time, and the one this browser had is gone.
      const previous = cookiesOf(request.headers.get("cookie")).get(SESSION_COOKIE);
      if (previous !== undefined) sessions.end(previous);
      const id = sessions.begin();
      log(`session: signed in from ${client}`);
      return json({ ok: true, signedIn: true }, 200, {
        "set-cookie": sessionCookie(id, sessions.maxAgeSeconds),
      });
    },
  };
}
