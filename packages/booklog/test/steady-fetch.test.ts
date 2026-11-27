import { expect, test } from "bun:test";
import { DurableObjectLogTier } from "../src/tier-durable.ts";
import { HttpObjectStore } from "../src/store-http.ts";
import { ObjectStoreUncertain } from "../src/objectstore.ts";
import { keepWarm, steadyFetch } from "../src/steady-fetch.ts";

/** A service whose first answers never come: what a connection that died while nothing was asked of it looks like to the caller. Each call is written down with whether it went on a connection of its own. */
function service(options: { dead: number; answer?: () => Response; answerAfterMs?: number }) {
  const seen: { url: string; own: boolean; method: string }[] = [];
  let dead = options.dead;
  const fetcher = (url: string, init: RequestInit): Promise<Response> => {
    seen.push({ url, own: init.keepalive === false, method: init.method ?? "GET" });
    const signal = init.signal as AbortSignal;
    if (dead > 0) {
      dead -= 1;
      return new Promise((_, reject) => {
        signal.addEventListener("abort", () => reject(signal.reason), { once: true });
      });
    }
    return new Promise((resolve, reject) => {
      const timer = setTimeout(
        () => resolve(options.answer?.() ?? Response.json({ ok: true })),
        options.answerAfterMs ?? 0,
      );
      signal.addEventListener(
        "abort",
        () => {
          clearTimeout(timer);
          reject(signal.reason);
        },
        { once: true },
      );
    });
  };
  return { seen, fetcher };
}

test("a call that can be made twice and does not answer is sent again at once on a connection of its own, and the caller waits the short time and not the whole one", async () => {
  const lines: string[] = [];
  const { seen, fetcher } = service({ dead: 1 });
  const steady = steadyFetch({ fetch: fetcher, firstTryMs: 60, log: (line) => lines.push(line) });
  const began = performance.now();
  const answer = await steady(
    "https://tail.test/v1/books/b/head",
    { method: "POST" },
    { what: "tail head", repeatable: true, timeoutMs: 3000 },
  );
  const took = performance.now() - began;
  expect(answer.status).toBe(200);
  // The short time, and not the three seconds the call is allowed.
  expect(took).toBeGreaterThanOrEqual(55);
  expect(took).toBeLessThan(600);
  expect(seen.map((call) => call.own)).toEqual([false, true]);
  expect(steady.stats()).toMatchObject({ calls: 1, repeated: 1, failed: 0 });
  // It is written down: what it was and how long it took, and nothing of the address.
  expect(lines).toHaveLength(1);
  expect(lines[0]).toMatch(
    /^store: tail head did not answer in 60 ms and was sent again on a new connection, answered in \d+ ms in all$/,
  );
});

test("a write is sent once: when it does not answer, the caller is told so after the whole time, and it is written down", async () => {
  const lines: string[] = [];
  const { seen, fetcher } = service({ dead: 1 });
  const steady = steadyFetch({ fetch: fetcher, firstTryMs: 30, log: (line) => lines.push(line) });
  const began = performance.now();
  await expect(
    steady(
      "https://tail.test/v1/books/b/append",
      { method: "POST" },
      { what: "tail append", repeatable: false, timeoutMs: 150 },
    ),
  ).rejects.toMatchObject({ name: "TimeoutError" });
  expect(performance.now() - began).toBeGreaterThanOrEqual(140);
  expect(seen).toHaveLength(1);
  expect(steady.stats()).toMatchObject({ calls: 1, repeated: 0, failed: 1 });
  expect(lines).toEqual([
    expect.stringMatching(/^store: tail append failed after \d+ ms \(no answer in time\)$/),
  ]);
});

test("a call that fails twice fails, within the whole time it was allowed", async () => {
  const lines: string[] = [];
  const { seen, fetcher } = service({ dead: 2 });
  const steady = steadyFetch({ fetch: fetcher, firstTryMs: 40, log: (line) => lines.push(line) });
  const began = performance.now();
  await expect(
    steady(
      "https://tail.test/x",
      { method: "POST" },
      { what: "tail renew", repeatable: true, timeoutMs: 200 },
    ),
  ).rejects.toBeDefined();
  const took = performance.now() - began;
  expect(took).toBeGreaterThanOrEqual(190);
  expect(took).toBeLessThan(700);
  expect(seen).toHaveLength(2);
  expect(lines[0]).toMatch(/^store: tail renew failed twice, after \d+ ms/);
});

test("the short time is for the answer to begin: an answer that began in time and is long in coming is not sent again", async () => {
  const { seen, fetcher } = service({
    dead: 0,
    answer: () =>
      new Response(
        new ReadableStream({
          async start(controller) {
            await Bun.sleep(120);
            controller.enqueue(new TextEncoder().encode("whole"));
            controller.close();
          },
        }),
      ),
  });
  const steady = steadyFetch({ fetch: fetcher, firstTryMs: 40 });
  const answer = await steady(
    "https://bulk.test/v1/bulk/k",
    { method: "GET" },
    { what: "bucket get", repeatable: true, timeoutMs: 3000 },
  );
  expect(await answer.text()).toBe("whole");
  expect(seen).toHaveLength(1);
});

test("after the stores were asked for nothing for a while, a call goes on a connection of its own from the start; a moment later the kept ones are used again", async () => {
  let at = 0;
  const { seen, fetcher } = service({ dead: 0 });
  const steady = steadyFetch({ fetch: fetcher, quietMs: 30_000, now: () => at });
  const ask = () =>
    steady(
      "https://tail.test/x",
      { method: "POST" },
      { what: "tail head", repeatable: true, timeoutMs: 3000 },
    );
  await ask();
  at += 10_000;
  await ask();
  at += 30_001;
  await ask();
  at += 5;
  await ask();
  expect(seen.map((call) => call.own)).toEqual([false, false, true, false]);
  expect(steady.stats().afterQuiet).toBe(1);
});

test("a call that answered slowly is written down, and a store that is down is not said three hundred times a minute", async () => {
  let at = 0;
  const lines: string[] = [];
  const slow = steadyFetch({
    fetch: async () => {
      at += 900;
      return Response.json({});
    },
    now: () => at,
    log: (line) => lines.push(line),
  });
  await slow(
    "https://tail.test/x",
    { method: "POST" },
    { what: "tail acquire", repeatable: false, timeoutMs: 3000 },
  );
  expect(lines).toEqual(["store: tail acquire answered in 900 ms"]);
  expect(slow.stats()).toMatchObject({ slowestMs: 900, slowest: "tail acquire" });

  lines.length = 0;
  at = 60_000 * 7;
  const down = steadyFetch({
    fetch: async () => {
      throw Object.assign(new Error("connect ECONNREFUSED 203.0.113.9:443"), {
        code: "ECONNREFUSED",
      });
    },
    now: () => at,
    log: (line) => lines.push(line),
  });
  for (let i = 0; i < 50; i += 1)
    await down(
      "https://tail.test/x",
      { method: "POST" },
      { what: "tail append", repeatable: false, timeoutMs: 3000 },
    ).catch(() => {});
  expect(lines).toHaveLength(20);
  // The kind of failure, never the message: a message can name an address.
  expect(lines.join("\n")).not.toContain("203.0.113.9");
  expect(lines[0]).toBe("store: tail append failed after 0 ms (ECONNREFUSED)");
  at += 60_000;
  await down(
    "https://tail.test/x",
    { method: "POST" },
    { what: "tail append", repeatable: false, timeoutMs: 3000 },
  ).catch(() => {});
  expect(lines[20]).toBe("store: 30 more slow or failed calls in that minute");
});

test("the tail's reads and its lease are sent again when they do not answer, and an append is not: the caller is told its fate is unknown", async () => {
  const { seen, fetcher } = service({
    dead: 1,
    answer: () => Response.json({ seq: 0, hash: "", fence: 0, leaseHolder: null, sealedUpTo: 0 }),
  });
  const tier = new DurableObjectLogTier({
    baseUrl: "https://tail.test",
    token: "t",
    timeoutMs: 200,
    steady: steadyFetch({ fetch: fetcher, firstTryMs: 30 }),
  });
  await tier.head("book-1");
  expect(seen.map((call) => [new URL(call.url).pathname, call.own])).toEqual([
    ["/v1/books/book-1/head", false],
    ["/v1/books/book-1/head", true],
  ]);

  const appends = service({ dead: 1 });
  const once = new DurableObjectLogTier({
    baseUrl: "https://tail.test",
    token: "t",
    timeoutMs: 100,
    steady: steadyFetch({ fetch: appends.fetcher, firstTryMs: 30 }),
  });
  await expect(
    once.append("book-1", {
      seq: 1,
      prevHash: "",
      hash: "h",
      fence: 1,
      body: new Uint8Array([1]),
    } as never),
  ).rejects.toBeInstanceOf(ObjectStoreUncertain);
  expect(appends.seen).toHaveLength(1);
});

test("the bucket's reads are sent again when they do not answer, and a write is not", async () => {
  const marked = () =>
    new Response(JSON.stringify({ objects: [], truncated: false }), {
      headers: { "x-rastrata-bulk": "1", "content-type": "application/json" },
    });
  const reads = service({ dead: 1, answer: marked });
  const store = new HttpObjectStore({
    baseUrl: "https://bulk.test",
    token: "t",
    timeoutMs: 200,
    steady: steadyFetch({ fetch: reads.fetcher, firstTryMs: 30 }),
  });
  expect((await store.list("books/b/")).objects).toEqual([]);
  expect(reads.seen.map((call) => call.own)).toEqual([false, true]);

  const writes = service({ dead: 1 });
  const once = new HttpObjectStore({
    baseUrl: "https://bulk.test",
    token: "t",
    timeoutMs: 100,
    steady: steadyFetch({ fetch: writes.fetcher, firstTryMs: 30 }),
  });
  await expect(once.putIfAbsent("books/b/x", new Uint8Array([1]))).rejects.toBeInstanceOf(
    ObjectStoreUncertain,
  );
  expect(writes.seen).toHaveLength(1);
});

test("the stores are asked a question that costs nothing every few seconds until stopped, and a question that fails stops nothing", async () => {
  const asked: string[] = [];
  let fail = true;
  const steady = steadyFetch({
    fetch: async (url) => {
      asked.push(url);
      if (fail) throw new Error("down");
      return new Response("ok");
    },
  });
  // The two stores are one service in production: it is asked once.
  const stop = keepWarm({
    steady,
    urls: ["https://tail.test/health", "https://tail.test/health"],
    everyMs: 1000,
  });
  await Bun.sleep(1150);
  fail = false;
  await Bun.sleep(1000);
  stop();
  const said = asked.length;
  expect(said).toBeGreaterThanOrEqual(3);
  expect(new Set(asked)).toEqual(new Set(["https://tail.test/health"]));
  await Bun.sleep(1100);
  expect(asked.length).toBe(said);
});
