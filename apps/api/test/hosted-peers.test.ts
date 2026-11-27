// How two pods of one service find each other and hand a request on (hosted-peers.ts): the address a pod advertises, the name of a holder, the check of who answers at an address, and the
// request that is sent. The pods themselves, two of them serving one book, are in hosted-many.test.ts and hosted-main.test.ts.
import { expect, test } from "bun:test";
import { issueOwnerKey } from "@rastrata/application/agent";
import {
  advertisedAddress,
  FORWARDED_HEADER,
  isPodAddress,
  PEER_PATH,
  Peers,
  parsePeer,
  peerKeyFrom,
} from "../src/hosted-peers.ts";

const KEY = peerKeyFrom(issueOwnerKey());
const HERE = "host-a#100#abc";
const THERE = "host-b#200#def";
const heldBy = (base: string, ip = "10.244.1.5", port = 8080, n = 1) =>
  `${base}.${n}@${ip}:${port}`;

test("an address is a pod's when it is private or this computer's, and a public one, a name or a malformed one is not", () => {
  for (const ip of [
    "10.244.1.5",
    "10.0.0.1",
    "172.16.0.9",
    "172.31.255.1",
    "192.168.1.20",
    "127.0.0.1",
  ])
    expect(isPodAddress(ip), ip).toBe(true);
  for (const ip of [
    "8.8.8.8",
    "172.32.0.1",
    "172.15.0.1",
    "192.169.0.1",
    "169.254.1.1",
    "localhost",
    "10.0.0",
    "10.0.0.256",
    "10.0.0.1.1",
    "::1",
    "",
  ])
    expect(isPodAddress(ip), ip).toBe(false);
});

test("a pod advertises the address of its network interface when it listens everywhere, the one it listens on when it listens on one, and none when it has a name", () => {
  expect(advertisedAddress("127.0.0.1", 8080)).toBe("127.0.0.1:8080");
  expect(advertisedAddress("10.244.1.5", 8080)).toBe("10.244.1.5:8080");
  expect(advertisedAddress("localhost", 8080)).toBeNull();
  expect(advertisedAddress("8.8.8.8", 8080)).toBeNull();
  expect(advertisedAddress("0.0.0.0", 0)).toBeNull();
  expect(advertisedAddress("0.0.0.0", 70000)).toBeNull();
  // Listening everywhere: some private address of this computer, or its own.
  expect(advertisedAddress("0.0.0.0", 8080)).toMatch(/^[0-9.]+:8080$/);
  const found = advertisedAddress("0.0.0.0", 8080) as string;
  expect(isPodAddress(found.split(":")[0] as string)).toBe(true);
});

test("the holder of a lease is a peer when its name ends with a pod's address, and the name is not followed otherwise", () => {
  expect(parsePeer(heldBy(THERE))).toEqual({
    key: `${THERE}@10.244.1.5:8080`,
    base: THERE,
    ip: "10.244.1.5",
    port: 8080,
  });
  // The number of the time the book was opened does not change who the process is.
  expect(parsePeer(heldBy(THERE, "10.244.1.5", 8080, 7))?.key).toBe(parsePeer(heldBy(THERE))?.key);
  // A process whose name has dots in it.
  expect(parsePeer(heldBy("pod-1.example.internal#9#x"))?.base).toBe("pod-1.example.internal#9#x");
  for (const bad of [
    `${THERE}.1`, // no address (a name from before pods advertised, or an experiment)
    heldBy(THERE, "8.8.8.8"), // a public address
    heldBy(THERE, "10.244.1.5", 0),
    heldBy(THERE, "10.244.1.5", 65536),
    `${THERE}@10.244.1.5:8080`, // no number of the time
    `${THERE}.1@host:8080`,
    "",
  ])
    expect(parsePeer(bad), bad).toBeNull();
});

/** A pod's answer to a peer's question, as the other pod's code makes it, and nothing else of that pod. */
function pod(base: string, key = KEY) {
  const peers = new Peers({ key, holder: base });
  return { peers, ask: (request: Request) => peers.ping(request) };
}

const ask = (host: string, nonce = "n".repeat(22), method = "GET") =>
  new Request(`http://${host}${PEER_PATH}?nonce=${nonce}`, { method, headers: { host } });

test("a pod answers a peer's question only to a Host that is an address, only to a GET, and only with a nonce it can use", async () => {
  const { ask: answer } = pod(THERE);
  const good = answer(ask("10.244.1.5:8080"));
  expect(good?.status).toBe(200);
  const body = (await good?.json()) as { holder: string; mac: string };
  expect(body.holder).toBe(THERE);
  expect(body.mac.length).toBeGreaterThan(20);
  // Through the tunnel the Host is the service's name: not answered, and falls through to the application's own routes.
  expect(answer(ask("app.rastrata.com"))).toBeNull();
  expect(answer(ask("localhost:8080"))).toBeNull();
  expect(answer(ask("10.244.1.5:8080", "n".repeat(22), "POST"))).toBeNull();
  expect(answer(ask("10.244.1.5:8080", "short"))?.status).toBe(400);
  expect(answer(ask("10.244.1.5:8080", "bad nonce with spaces!!"))?.status).toBe(400);
  expect(
    answer(
      new Request("http://10.244.1.5:8080/v1/other", { headers: { host: "10.244.1.5:8080" } }),
    ),
  ).toBeNull();
});

/** A fetch that is the other pod: it answers the question as the pod `base` with `key` would, and says what it was asked. */
function fakeNetwork(
  pods: Record<string, { base: string; key: Buffer } | "silent" | "wrong-holder">,
) {
  const seen: string[] = [];
  const impl = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = new URL(
      typeof input === "string" ? input : input instanceof URL ? input.href : input.url,
    );
    seen.push(`${url.host}${url.pathname}`);
    const entry = pods[url.host];
    if (entry === undefined || entry === "silent")
      throw Object.assign(new Error("no answer"), { code: "ECONNREFUSED" });
    const target = entry === "wrong-holder" ? { base: "somebody-else", key: KEY } : entry;
    const answered = new Peers({ key: target.key, holder: target.base }).ping(
      new Request(url, {
        headers: { host: url.host, ...(init?.headers as Record<string, string> | undefined) },
      }),
    );
    return answered ?? new Response("no", { status: 404 });
  }) as unknown as typeof fetch;
  return { impl, seen };
}

test("a pod is trusted to hold a book only when it answers as the holder the lease names, with the key of the service", async () => {
  const net = fakeNetwork({
    "10.244.1.5:8080": { base: THERE, key: KEY },
    "10.244.1.6:8080": { base: THERE, key: peerKeyFrom(issueOwnerKey()) }, // another service's key
    "10.244.1.7:8080": "wrong-holder",
    "10.244.1.8:8080": "silent",
  });
  const peers = new Peers({ key: KEY, holder: HERE, fetch: net.impl });
  expect((await peers.resolve(heldBy(THERE)))?.key).toBe(`${THERE}@10.244.1.5:8080`);
  expect(await peers.resolve(heldBy(THERE, "10.244.1.6"))).toBeNull();
  expect(await peers.resolve(heldBy(THERE, "10.244.1.7"))).toBeNull();
  expect(await peers.resolve(heldBy(THERE, "10.244.1.8"))).toBeNull();
  // A name with no address, a public one, and this process itself are never asked.
  const before = net.seen.length;
  expect(await peers.resolve(`${THERE}.1`)).toBeNull();
  expect(await peers.resolve(heldBy(THERE, "8.8.8.8"))).toBeNull();
  expect(await peers.resolve(heldBy(HERE))).toBeNull();
  expect(net.seen.length).toBe(before);
  // Two answered, wrongly (another service's key, and not the holder named), and the question was asked of each once.
  expect(peers.stats().refused).toBe(2);
});

test("what a pod learns of a peer is kept for a moment: it is asked once for a burst of requests, and an address that did not answer is left alone, then asked again", async () => {
  let now = 1_000_000;
  const net = fakeNetwork({ "10.244.1.5:8080": { base: THERE, key: KEY } });
  const peers = new Peers({
    key: KEY,
    holder: HERE,
    fetch: net.impl,
    now: () => now,
    verifyMs: 1000,
    downMs: 2000,
  });
  // A burst asks once.
  await Promise.all([1, 2, 3, 4].map(() => peers.resolve(heldBy(THERE))));
  expect(net.seen.filter((s) => s.endsWith(PEER_PATH))).toHaveLength(1);
  await peers.resolve(heldBy(THERE));
  expect(net.seen).toHaveLength(1);
  // Trust runs out after the time it was given, and the pod is asked again.
  now += 1500;
  await peers.resolve(heldBy(THERE));
  expect(net.seen).toHaveLength(2);

  // An address that does not answer is not asked again for the time it is left alone.
  const silent = heldBy(THERE, "10.244.1.9");
  expect(await peers.resolve(silent)).toBeNull();
  const asked = net.seen.length;
  now += 1500;
  expect(await peers.resolve(silent)).toBeNull();
  expect(net.seen.length).toBe(asked);
  now += 1000;
  expect(await peers.resolve(silent)).toBeNull();
  expect(net.seen.length).toBe(asked + 1);
});

test("a request is handed on as it was sent, marked, without what must not cross, and its answer comes back as it was given", async () => {
  const sent: { url: string; method: string; headers: Headers; body: string }[] = [];
  const impl = (async (input: string | URL | Request, init?: RequestInit) => {
    sent.push({
      url: String(input),
      method: init?.method ?? "GET",
      headers: new Headers(init?.headers),
      body: init?.body ? new TextDecoder().decode(init.body as Uint8Array) : "",
    });
    return new Response('{"ok":true}', {
      status: 201,
      statusText: "Created",
      headers: { "content-type": "application/json", connection: "keep-alive", "x-kept": "yes" },
    });
  }) as unknown as typeof fetch;
  const peers = new Peers({ key: KEY, holder: HERE, fetch: impl });
  const target = parsePeer(heldBy(THERE)) as NonNullable<ReturnType<typeof parsePeer>>;
  const original = new Request("https://app.rastrata.com/v1/drafts.create?x=1", {
    method: "POST",
    headers: {
      authorization: "Bearer token-1",
      "content-type": "application/json",
      "content-length": "17",
      connection: "keep-alive",
      "accept-encoding": "gzip",
      "cf-connecting-ip": "203.0.113.9",
    },
    body: '{"input":"hello"}',
  });
  const answer = await peers.forward(
    original,
    new TextEncoder().encode('{"input":"hello"}'),
    target,
  );
  expect(answer?.status).toBe(201);
  expect(answer?.statusText).toBe("Created");
  expect(answer?.headers.get("x-kept")).toBe("yes");
  expect(answer?.headers.get("connection")).toBeNull();
  expect(await answer?.json()).toEqual({ ok: true });
  const [request] = sent as [(typeof sent)[number]];
  expect(request.url).toBe("http://10.244.1.5:8080/v1/drafts.create?x=1");
  expect(request.method).toBe("POST");
  expect(request.body).toBe('{"input":"hello"}');
  // The caller's own headers go with it, so the other pod checks the credential itself; the hop's headers do not.
  expect(request.headers.get("authorization")).toBe("Bearer token-1");
  expect(request.headers.get("cf-connecting-ip")).toBe("203.0.113.9");
  expect(request.headers.get(FORWARDED_HEADER)).toBe(HERE);
  expect(request.headers.get("accept-encoding")).toBe("identity");
  expect(request.headers.get("connection")).toBeNull();
  expect(request.headers.get("content-length")).toBeNull();
  expect(peers.stats().forwarded).toBe(1);
});

test("a request that could not be delivered is the caller's to keep and wait for, one that was lost on the way is the person's to send again, and the pod is left alone for a moment", async () => {
  const refused = (async () => {
    throw Object.assign(new Error("refused"), { code: "ECONNREFUSED" });
  }) as unknown as typeof fetch;
  const reset = (async () => {
    throw Object.assign(new Error("reset"), { code: "ECONNRESET" });
  }) as unknown as typeof fetch;
  const target = parsePeer(heldBy(THERE)) as NonNullable<ReturnType<typeof parsePeer>>;
  const original = () => new Request("https://app.rastrata.com/v1/x", { method: "GET" });

  const a = new Peers({ key: KEY, holder: HERE, fetch: refused });
  expect(await a.forward(original(), null, target)).toBeNull();
  expect(a.stats()).toMatchObject({ forwarded: 0, unreachable: 1, refused: 0, unanswered: 0 });
  expect(a.stats().lastFailure).toContain("could not be reached");

  const b = new Peers({ key: KEY, holder: HERE, fetch: reset });
  await expect(b.forward(original(), null, target)).rejects.toThrow("stopped answering");
  expect(b.stats().unreachable).toBe(1);
  // Neither is asked of again at once: the pod is left alone for the time it is.
  expect(await b.resolve(heldBy(THERE))).toBeNull();
});

test("a pod remembers which peer held a book for as long as it trusts that peer, and no longer once the peer has failed or been forgotten", async () => {
  let now = 1_000_000;
  const net = fakeNetwork({ "10.244.1.5:8080": { base: THERE, key: KEY } });
  const peers = new Peers({
    key: KEY,
    holder: HERE,
    fetch: net.impl,
    now: () => now,
    verifyMs: 1000,
  });
  expect(peers.holderOf("book-1")).toBeNull();
  const target = (await peers.resolve(heldBy(THERE))) as NonNullable<ReturnType<typeof parsePeer>>;
  peers.remember("book-1", target);
  expect(peers.holderOf("book-1")?.key).toBe(target.key);
  expect(peers.holderOf("book-2")).toBeNull();
  // Only as long as the peer is trusted: after that it has to be asked again.
  now += 1500;
  expect(peers.holderOf("book-1")).toBeNull();
  // A book that this pod holds after all is forgotten.
  await peers.resolve(heldBy(THERE));
  peers.remember("book-1", target);
  peers.forget("book-1");
  expect(peers.holderOf("book-1")).toBeNull();
  // A request that could not be delivered ends the trust, and the memory with it.
  await peers.resolve(heldBy(THERE));
  peers.remember("book-1", target);
  const refused = (async () => {
    throw Object.assign(new Error("refused"), { code: "ECONNREFUSED" });
  }) as unknown as typeof fetch;
  const failing = new Peers({ key: KEY, holder: HERE, fetch: refused, now: () => now });
  failing.remember("book-1", target);
  expect(
    await failing.forward(new Request("https://app.rastrata.com/v1/x"), null, target),
  ).toBeNull();
  expect(failing.holderOf("book-1")).toBeNull();
});
