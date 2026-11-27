import { expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { DurableObjectLogTier, ObjectStoreError, ObjectStoreUncertain } from "../src/index.ts";
import { HttpObjectStore } from "../src/store-http.ts";
import { assertSecureRemote } from "../src/secure-url.ts";

const TOKEN = "rtt_a-token-that-must-never-appear-anywhere";
const bytes = (text: string) => new TextEncoder().encode(text);
const KEY = "books/b/sealed/000000000001-000000000002";

interface Seen {
  url: string;
  init: RequestInit;
}

/** A store whose transport answers as scripted and remembers what it was sent. */
function store(answer: (seen: Seen) => Response | Promise<Response>) {
  const seen: Seen[] = [];
  const fetch = async (url: string, init: RequestInit) => {
    const entry = { url, init };
    seen.push(entry);
    return answer(entry);
  };
  return {
    seen,
    store: new HttpObjectStore({ baseUrl: "https://tail.test/", token: TOKEN, fetch }),
  };
}

const worker = (status: number, body: unknown = {}, headers: Record<string, string> = {}) =>
  new Response(
    typeof body === "string" || body instanceof Uint8Array
      ? (body as BodyInit)
      : JSON.stringify(body),
    {
      status,
      headers: { "x-rastrata-bulk": "1", "content-type": "application/json", ...headers },
    },
  );
const stranger = (status: number, text = "<html>an error page</html>") =>
  new Response(text, { status, headers: { "content-type": "text/html" } });

test("a put carries the token, the digest, the metadata in lower case, and never follows a redirect", async () => {
  const { seen, store: s } = store(() => worker(201, { etag: '"e1"', size: 3 }));
  const result = await s.putIfAbsent(KEY, bytes("abc"), {
    metadata: { Hash: "H", Prev: "P" },
    contentType: "application/x-seg",
  });
  expect(result).toEqual({ created: true, etag: '"e1"' });
  const { url, init } = seen[0]!;
  expect(url).toBe(`https://tail.test/v1/bulk/${KEY}`);
  expect(init.method).toBe("PUT");
  expect(init.redirect).toBe("error");
  const headers = init.headers as Record<string, string>;
  expect(headers.authorization).toBe(`Bearer ${TOKEN}`);
  expect(headers["x-content-sha256"]).toBe(createHash("sha256").update("abc").digest("hex"));
  expect(headers["x-meta-hash"]).toBe("H");
  expect(headers["x-meta-prev"]).toBe("P");
  expect(headers["content-type"]).toBe("application/x-seg");
  expect(init.body).toEqual(bytes("abc"));
});

test("an existing key is 'not created', and only the Worker can say so", async () => {
  expect(
    await store(() => worker(412, { error: "the key already exists" })).store.putIfAbsent(
      KEY,
      bytes("x"),
    ),
  ).toEqual({ created: false });
  const impostor = store(() => stranger(412));
  await expect(impostor.store.putIfAbsent(KEY, bytes("x"))).rejects.toBeInstanceOf(
    ObjectStoreUncertain,
  );
  const fake201 = store(() => stranger(201));
  await expect(fake201.store.putIfAbsent(KEY, bytes("x"))).rejects.toBeInstanceOf(
    ObjectStoreUncertain,
  );
});

test("'not found' is believed only from the Worker: an error page is a failure to ask, never an absent object", async () => {
  const absent = store(() => worker(404, { error: "not found" }));
  expect(await absent.store.get(KEY)).toBeNull();
  expect(await absent.store.head(KEY)).toBeNull();
  const page = store(() => stranger(404));
  await expect(page.store.get(KEY)).rejects.toBeInstanceOf(ObjectStoreUncertain);
  await expect(page.store.head(KEY)).rejects.toBeInstanceOf(ObjectStoreUncertain);
});

test("a read gives back the bytes, the etag and the metadata, and a body cut short is uncertain", async () => {
  const whole = store(() =>
    worker(200, bytes("sealed"), {
      etag: '"x"',
      "content-length": "6",
      "x-meta-sha256": "abc",
      "content-type": "application/octet-stream",
    }),
  );
  const got = (await whole.store.get(KEY))!;
  expect(new TextDecoder().decode(got.body)).toBe("sealed");
  expect(got.etag).toBe('"x"');
  expect(got.metadata).toEqual({ sha256: "abc" });
  const cut = store(() =>
    worker(200, bytes("seal"), {
      "content-length": "6",
      "content-type": "application/octet-stream",
    }),
  );
  await expect(cut.store.get(KEY)).rejects.toBeInstanceOf(ObjectStoreUncertain);
  const head = store(
    () =>
      new Response(null, {
        status: 200,
        headers: { "x-rastrata-bulk": "1", "content-length": "42", etag: '"h"', "x-meta-seq": "9" },
      }),
  );
  expect(await head.store.head(KEY)).toEqual({
    key: KEY,
    size: 42,
    etag: '"h"',
    metadata: { seq: "9" },
  });
});

test("a listing asks for a prefix, a start and a limit, and says whether more follow", async () => {
  const { seen, store: s } = store(() =>
    worker(200, {
      objects: [{ key: "books/b/log/000000000001", size: 3, etag: '"a"' }],
      truncated: true,
    }),
  );
  const page = await s.list("books/b/log/", "books/b/log/000000000000", 5);
  expect(page).toEqual({
    objects: [{ key: "books/b/log/000000000001", size: 3, etag: '"a"' }],
    truncated: true,
  });
  const query = new URL(seen[0]!.url).searchParams;
  expect(query.get("prefix")).toBe("books/b/log/");
  expect(query.get("after")).toBe("books/b/log/000000000000");
  expect(query.get("limit")).toBe("5");
  const bad = store(() => worker(200, { nothing: true }));
  await expect(bad.store.list("books/")).rejects.toBeInstanceOf(ObjectStoreUncertain);
});

test("a failure that leaves a write's fate unknown is uncertain; a refusal of the Worker is not", async () => {
  for (const status of [500, 502, 503, 429, 408]) {
    await expect(
      store(() => worker(status, { error: "x" })).store.putIfAbsent(KEY, bytes("x")),
      String(status),
    ).rejects.toBeInstanceOf(ObjectStoreUncertain);
  }
  await expect(
    store(() => stranger(403)).store.putIfAbsent(KEY, bytes("x")),
  ).rejects.toBeInstanceOf(ObjectStoreUncertain);
  const limited = await store(() => stranger(429, "<html>error code: 1027</html>"))
    .store.get(KEY)
    .catch((e: unknown) => e);
  expect(limited).toBeInstanceOf(ObjectStoreUncertain);
  expect((limited as Error).message).toContain("1027");
  const refused = await store(() => worker(401, { error: "unauthorized" }))
    .store.putIfAbsent(KEY, bytes("x"))
    .catch((e: unknown) => e);
  expect(refused).toBeInstanceOf(ObjectStoreError);
  expect(refused).not.toBeInstanceOf(ObjectStoreUncertain);
  expect((refused as ObjectStoreError).status).toBe(401);
  const dropped = new HttpObjectStore({
    baseUrl: "https://tail.test",
    token: TOKEN,
    fetch: async () => {
      throw new Error("connection reset");
    },
  });
  await expect(dropped.putIfAbsent(KEY, bytes("x"))).rejects.toBeInstanceOf(ObjectStoreUncertain);
  const slow = new HttpObjectStore({
    baseUrl: "https://tail.test",
    token: TOKEN,
    timeoutMs: 30,
    fetch: (_url, init) =>
      new Promise((_resolve, reject) =>
        init.signal?.addEventListener("abort", () => reject(init.signal!.reason)),
      ),
  });
  await expect(slow.get(KEY)).rejects.toBeInstanceOf(ObjectStoreUncertain);
});

test("the token is in no error message", async () => {
  const messages: string[] = [];
  const cases: (() => Promise<unknown>)[] = [
    () => store(() => stranger(500)).store.get(KEY),
    () => store(() => worker(401, { error: "unauthorized" })).store.putIfAbsent(KEY, bytes("x")),
    () =>
      new HttpObjectStore({
        baseUrl: "https://tail.test",
        token: TOKEN,
        fetch: async () => {
          throw new Error("boom");
        },
      }).head(KEY),
    () => store(() => worker(500, { error: "internal error" })).store.list("books/"),
    () => store(() => worker(200, bytes("x"))).store.delete(KEY),
  ];
  for (const run of cases)
    messages.push(String(await run().catch((e: unknown) => (e as Error).message)));
  expect(messages.join("\n")).not.toContain(TOKEN);
  expect(messages).toHaveLength(5);
});

test("it cannot delete, and says so", async () => {
  const { seen, store: s } = store(() => worker(200));
  const error = await s.delete(KEY).catch((e: unknown) => e);
  expect(error).toBeInstanceOf(ObjectStoreError);
  expect((error as ObjectStoreError).status).toBe(405);
  expect(seen).toHaveLength(0);
});

test("a token goes only to https, or to this computer", () => {
  for (const ok of [
    "https://tail.rastrata.com",
    "https://tail.rastrata.com/",
    "http://127.0.0.1:8787",
    "http://localhost:8787",
    "http://[::1]:8787",
    "http://x.localhost",
  ]) {
    expect(() => assertSecureRemote(ok, "The address"), ok).not.toThrow();
  }
  for (const bad of [
    "http://tail.rastrata.com",
    "http://10.0.0.5",
    "http://127.0.0.1.evil.com",
    "ftp://x",
    "tail.rastrata.com",
    "https://user:secret@tail.rastrata.com",
  ]) {
    const error = (() => {
      try {
        assertSecureRemote(bad, "The address");
      } catch (e) {
        return e as Error;
      }
      return null;
    })();
    expect(error, bad).not.toBeNull();
    expect(error!.message, bad).not.toContain("secret");
  }
  expect(() => new HttpObjectStore({ baseUrl: "http://tail.rastrata.com", token: TOKEN })).toThrow(
    /https/,
  );
  expect(
    () => new DurableObjectLogTier({ baseUrl: "http://tail.rastrata.com", token: TOKEN }),
  ).toThrow(/https/);
  expect(() => new HttpObjectStore({ baseUrl: "https://tail.rastrata.com", token: "" })).toThrow();
  // A caller that brings its own transport owns it (the tests).
  expect(
    () =>
      new HttpObjectStore({
        baseUrl: "http://tail.test",
        token: TOKEN,
        fetch: async () => worker(200),
      }),
  ).not.toThrow();
});

test("the tail client never follows a redirect either", async () => {
  const seen: RequestInit[] = [];
  const tier = new DurableObjectLogTier({
    baseUrl: "http://tail.test",
    token: TOKEN,
    fetch: async (_url, init) => {
      seen.push(init);
      return new Response(
        JSON.stringify({
          seq: 0,
          hash: "0".repeat(64),
          sealedThrough: 0,
          sealedHash: "0".repeat(64),
          fence: 0,
          leaseHolder: null,
          leaseExpiresAt: null,
          now: 1,
        }),
        { headers: { "content-type": "application/json" } },
      );
    },
  });
  await tier.head("b");
  expect(seen[0]!.redirect).toBe("error");
});
