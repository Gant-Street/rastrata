/** Two pods of one service serving the same books: the pod that is asked for a book that the other holds hands the request to the other, and neither waits for the book nor turns the person away.
 * A book has one holder at a time (its lease), so a person's requests all end up at one pod, and the other pod is a second way in. That is what lets the platform keep two pods on different
 * workers, stop one of them for an update or for a worker's upgrade, and have the people at work notice nothing: the pod that is left answers, and hands on what is the stopped pod's until the stopped
 * pod has given its books up. With one pod nothing here ever happens, because the one pod is always the holder.
 *
 * Whom it hands a request to. The name of a lease holder ends with the address of its pod (`host#pid#time.1@10.244.1.5:8080`), so the lease says who has the book and where. Before a request that
 * carries a person's credential is sent to an address, the pod asks that address who it is (`GET /_peer?nonce=...`, answered only to a Host that is an address, never to a name that comes through the
 * tunnel) and checks the answer: the name of the holder and a MAC over the nonce and that name, made with a key both pods derive from the owner key. So a credential goes to a process that has the key
 * and is the holder the lease names, and not to whatever has been given the address of a pod that is gone. The answer is kept for a second, and an address that does not answer is not asked again for a
 * moment: the request then waits for the lease, as it always did. A request that was handed on is marked, and the pod that gets it does not hand it on again. */
import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import { networkInterfaces } from "node:os";

/** The path a pod answers a peer's question on. */
export const PEER_PATH = "/_peer";
/** Set on a request that one pod handed to another, to the first one's name: the other does not hand it on. */
export const FORWARDED_HEADER = "x-rastrata-forwarded";

const OCTET = "(?:25[0-5]|2[0-4][0-9]|1[0-9]{2}|[1-9]?[0-9])";
const ADDRESS = new RegExp(`^(?:${OCTET}\\.){3}${OCTET}$`);
/** A holder's name: whatever names the process, the number of the time it opened the book, and `@address:port`. */
const HOLDER = new RegExp(`^(.+)\\.([0-9]+)@((?:${OCTET}\\.){3}${OCTET}):([0-9]{1,5})$`);
/** A Host that is an address and not a name: what a peer sends, and what Cloudflare's tunnel never does. */
const ADDRESS_HOST = new RegExp(`^(?:${OCTET}\\.){3}${OCTET}(?::[0-9]{1,5})?$`);

/** Whether an address is one a pod can have: a private one, or this computer's. A lease record that names a public address is not followed. */
export function isPodAddress(ip: string): boolean {
  if (!ADDRESS.test(ip)) return false;
  const [a, b] = ip.split(".").map(Number) as [number, number];
  return a === 10 || a === 127 || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168);
}

/** The address a pod tells the others to reach it on, `ip:port`, or null when it has none to give. A pod that listens on every address (`0.0.0.0`) is reached on the address of its network
 * interface; one that listens on a single address, on that; anything else (a name) on none. */
export function advertisedAddress(bind: string, port: number): string | null {
  if (!Number.isInteger(port) || port < 1 || port > 65535) return null;
  if (bind === "0.0.0.0" || bind === "::") {
    for (const list of Object.values(networkInterfaces()))
      for (const entry of list ?? [])
        if (entry.family === "IPv4" && !entry.internal && isPodAddress(entry.address))
          return `${entry.address}:${port}`;
    return `127.0.0.1:${port}`;
  }
  return isPodAddress(bind) ? `${bind}:${port}` : null;
}

export interface PeerTarget {
  /** The process and its address, the same for every book it holds: what is remembered about it. */
  readonly key: string;
  /** The name of the process: what its lease holder names begin with. */
  readonly base: string;
  readonly ip: string;
  readonly port: number;
}

/** Who holds a book and where, from the name of the holder in the lease. Null for a name that has no address, a public one, or a port that is not one. */
export function parsePeer(heldBy: string): PeerTarget | null {
  const found = HOLDER.exec(heldBy);
  if (!found) return null;
  const [, base, , ip, port] = found as unknown as [string, string, string, string, string];
  const number = Number(port);
  if (!isPodAddress(ip) || number < 1 || number > 65535) return null;
  return { key: `${base}@${ip}:${port}`, base, ip, port: number };
}

/** The key two pods of one service share, from the key the operator gave both. It proves a pod is a pod of the service, and opens nothing else. */
export function peerKeyFrom(ownerKey: string): Buffer {
  return createHmac("sha256", ownerKey).update("rastrata peer v1").digest();
}

export interface PeersOptions {
  /** See {@link peerKeyFrom}. */
  readonly key: Buffer;
  /** The name of this process, as its lease holders begin. */
  readonly holder: string;
  readonly fetch?: typeof fetch;
  readonly now?: () => number;
  /** How long a peer that has answered is trusted, in milliseconds (default 1,000). */
  readonly verifyMs?: number;
  /** How long a peer that has not answered is left alone, in milliseconds (default 2,000). */
  readonly downMs?: number;
  /** How long to wait for a peer to say who it is, in milliseconds (default 3,000: a pod on a busy node answers late, and a late peer is a peer, while a dead one is found
   * through its lapsed lease within the lease time whatever this is; at 1,000 the slow tier on the founder's runners, at a load of 7, saw a live peer as down and refused the book). */
  readonly pingMs?: number;
}

/** What a peer was asked and what came of it, for the owner's `/health`. */
export interface PeerStats {
  /** Requests handed to another pod and answered by it. */
  readonly forwarded: number;
  /** Requests that could not be handed on because the other pod could not be reached. */
  readonly unreachable: number;
  /** Addresses that answered, and were not the holder the lease named (or did not have the key). */
  readonly refused: number;
  /** Addresses that did not answer in time, or could not be reached, when asked who they were. */
  readonly unanswered: number;
  /** Why the last request could not be handed on, in words for the owner (a peer that did not answer, with the error's name; a lease holder with no address; this
   * process itself), or null while every hand-off has worked. */
  readonly lastFailure: string | null;
}

/** Error codes that say the request never reached the other pod, so that doing it here is not doing it twice. */
const NOT_DELIVERED = new Set(["ECONNREFUSED", "ENETUNREACH", "EHOSTUNREACH", "ConnectionRefused"]);

export class Peers {
  readonly #key: Buffer;
  readonly #own: string;
  readonly #fetch: typeof fetch;
  readonly #now: () => number;
  readonly #verifyMs: number;
  readonly #downMs: number;
  readonly #pingMs: number;
  /** When a peer that answered stops being trusted without asking again, by `PeerTarget.key`. */
  readonly #trusted = new Map<string, number>();
  /** Until when a peer that did not answer is left alone. */
  readonly #down = new Map<string, number>();
  readonly #asking = new Map<string, Promise<PeerTarget | null>>();
  /** The peer that was last found to hold a book, by the book's name. */
  readonly #holders = new Map<string, PeerTarget>();
  readonly #stats: {
    forwarded: number;
    unreachable: number;
    refused: number;
    unanswered: number;
    lastFailure: string | null;
  } = { forwarded: 0, unreachable: 0, refused: 0, unanswered: 0, lastFailure: null };

  constructor(options: PeersOptions) {
    this.#key = options.key;
    this.#own = options.holder;
    this.#fetch = options.fetch ?? fetch;
    this.#now = options.now ?? Date.now;
    this.#verifyMs = options.verifyMs ?? 1000;
    this.#downMs = options.downMs ?? 2000;
    this.#pingMs = options.pingMs ?? 3000;
  }

  stats(): PeerStats {
    return { ...this.#stats };
  }

  #mac(nonce: string, holder: string): string {
    return createHmac("sha256", this.#key).update(`peer\n${nonce}\n${holder}`).digest("base64url");
  }

  /** The answer to a peer's question, or null for a request that is not one. Only a Host that is an address is answered: a request through the tunnel names the service. */
  ping(request: Request): Response | null {
    if (request.method !== "GET") return null;
    let url: URL;
    try {
      url = new URL(request.url);
    } catch {
      return null;
    }
    if (url.pathname !== PEER_PATH || !ADDRESS_HOST.test(request.headers.get("host") ?? ""))
      return null;
    const nonce = url.searchParams.get("nonce") ?? "";
    if (!/^[A-Za-z0-9_-]{16,64}$/.test(nonce)) return new Response(null, { status: 400 });
    return Response.json(
      { holder: this.#own, mac: this.#mac(nonce, this.#own) },
      { headers: { "cache-control": "no-store" } },
    );
  }

  /** Remember that a book was found to be held by this peer, so that the next requests for it are handed on without asking the tail who holds it. */
  remember(book: string, target: PeerTarget): void {
    if (this.#holders.size >= 4096) {
      const now = this.#now();
      for (const [name, peer] of this.#holders)
        if ((this.#trusted.get(peer.key) ?? 0) <= now) this.#holders.delete(name);
    }
    this.#holders.set(book, target);
  }

  /** The peer that held a book when last asked, while it is still trusted (it answered a moment ago and has not failed since). */
  holderOf(book: string): PeerTarget | null {
    const target = this.#holders.get(book);
    if (target === undefined) return null;
    if ((this.#trusted.get(target.key) ?? 0) > this.#now()) return target;
    this.#holders.delete(book);
    return null;
  }

  /** This pod holds the book, or has no reason to think another does. */
  forget(book: string): void {
    this.#holders.delete(book);
  }

  /** The pod that holds a book, if it is another pod of the service and answers: the holder named in a lease. Null when the request is better kept and waited for (a name with no address, this
   * process itself, a process that does not answer or does not know the key). */
  async resolve(heldBy: string): Promise<PeerTarget | null> {
    const peer = parsePeer(heldBy);
    if (peer === null) {
      this.#stats.lastFailure = `the holder has no address: ${heldBy.slice(0, 80)}`;
      return null;
    }
    if (peer.base === this.#own) {
      this.#stats.lastFailure = "the holder is this process";
      return null;
    }
    const now = this.#now();
    if ((this.#down.get(peer.key) ?? 0) > now) return null;
    if ((this.#trusted.get(peer.key) ?? 0) > now) return peer;
    let asking = this.#asking.get(peer.key);
    if (asking === undefined) {
      asking = this.#ask(peer).finally(() => this.#asking.delete(peer.key));
      this.#asking.set(peer.key, asking);
    }
    return asking;
  }

  async #ask(peer: PeerTarget): Promise<PeerTarget | null> {
    const nonce = randomBytes(16).toString("base64url");
    try {
      const answer = await this.#fetch(
        `http://${peer.ip}:${peer.port}${PEER_PATH}?nonce=${nonce}`,
        {
          headers: { host: `${peer.ip}:${peer.port}` },
          signal: AbortSignal.timeout(this.#pingMs),
          redirect: "manual",
        },
      );
      if (answer.status === 200) {
        const body = (await answer.json()) as { holder?: unknown; mac?: unknown };
        const expected = Buffer.from(this.#mac(nonce, peer.base));
        const given = Buffer.from(typeof body.mac === "string" ? body.mac : "");
        if (
          body.holder === peer.base &&
          given.length === expected.length &&
          timingSafeEqual(given, expected)
        ) {
          this.#trusted.set(peer.key, this.#now() + this.#verifyMs);
          return peer;
        }
      }
      this.#stats.refused += 1;
      this.#stats.lastFailure = `${peer.key} answered ${answer.status} and was not believed`;
    } catch (error) {
      // It did not answer.
      this.#stats.unanswered += 1;
      const named = error as { name?: unknown; code?: unknown; message?: unknown } | null;
      this.#stats.lastFailure = `${peer.key} did not answer: ${String(named?.code ?? named?.name ?? named?.message ?? error).slice(0, 80)}`;
    }
    this.#down.set(peer.key, this.#now() + this.#downMs);
    return null;
  }

  /** Hand a request to the pod that holds its book, and return that pod's answer. Null when the pod could not be reached and the request was not delivered, so that it can be kept and waited for: a
   * failure after it was delivered is an error to the caller, which says "try again" (the same operation can be sent again) and does not do it a second time. */
  async forward(
    original: Request,
    body: Uint8Array | null,
    target: PeerTarget,
  ): Promise<Response | null> {
    const url = new URL(original.url);
    const headers = new Headers(original.headers);
    for (const name of ["connection", "keep-alive", "transfer-encoding", "content-length", "te"])
      headers.delete(name);
    // What comes back is passed on as it is, so it must not be compressed on the way.
    headers.set("accept-encoding", "identity");
    headers.set(FORWARDED_HEADER, this.#own);
    let answer: Response;
    try {
      answer = await this.#fetch(`http://${target.ip}:${target.port}${url.pathname}${url.search}`, {
        method: original.method,
        headers,
        ...(body !== null && original.method !== "GET" && original.method !== "HEAD"
          ? { body: body as BodyInit }
          : {}),
        signal: original.signal,
        redirect: "manual",
      });
    } catch (error) {
      if (original.signal.aborted) throw error;
      this.#trusted.delete(target.key);
      this.#down.set(target.key, this.#now() + this.#downMs);
      this.#stats.unreachable += 1;
      const code = (error as { code?: unknown } | null)?.code;
      this.#stats.lastFailure = `${target.key} could not be reached: ${String(code ?? (error as { name?: unknown } | null)?.name ?? error).slice(0, 80)}`;
      if (typeof code === "string" && NOT_DELIVERED.has(code)) return null;
      throw new PeerLost();
    }
    this.#stats.forwarded += 1;
    const reply = new Headers(answer.headers);
    for (const name of ["connection", "keep-alive", "transfer-encoding"]) reply.delete(name);
    return new Response(answer.body, {
      status: answer.status,
      statusText: answer.statusText,
      headers: reply,
    });
  }
}

/** The other pod was reached and went away before it answered: the request may or may not have been done there. */
export class PeerLost extends Error {
  constructor() {
    super("The pod that holds the book stopped answering");
    this.name = "PeerLost";
  }
}
