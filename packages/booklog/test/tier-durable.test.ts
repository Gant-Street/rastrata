import { expect, test } from "bun:test";
import { ObjectStoreError, ObjectStoreUncertain } from "../src/objectstore.ts";
import { DurableObjectLogTier } from "../src/tier-durable.ts";

const TOKEN = "t0ken-that-must-never-be-echoed-0123456789";

const client = (respond: (init: RequestInit) => Response | Promise<Response>) =>
  new DurableObjectLogTier({
    baseUrl: "https://tail.invalid/",
    token: TOKEN,
    fetch: async (_url, init) => respond(init),
  });

const html = (status: number, body: string) =>
  new Response(body, { status, headers: { "content-type": "text/html; charset=UTF-8" } });
const json = (status: number, value: unknown) =>
  new Response(JSON.stringify(value), { status, headers: { "content-type": "application/json" } });

const settle = (call: Promise<unknown>) =>
  call.then(
    () => null,
    (error: unknown) => error,
  );

test("what is not the Worker's JSON is the tail being down, whatever the status, and the page is not repeated", async () => {
  const limit = `<!DOCTYPE html><html><head><title>Error 1027</title></head><body>
    <h1>Error 1027</h1><p>You've exceeded the daily request limit of this account.</p></body></html>`;
  for (const [what, response] of [
    ["the daily limit, as Cloudflare answers it", html(429, limit)],
    ["the same page with another status", html(403, limit)],
    ["a 200 that is an error page", html(200, limit)],
    ["a proxy's gateway page", html(502, "<html>Bad gateway</html>")],
    ["a login wall", html(401, "<html>Sign in</html>")],
    ["no content type at all", new Response("ok", { status: 200 })],
    [
      "plain text",
      new Response("error code: 1027", { status: 429, headers: { "content-type": "text/plain" } }),
    ],
    [
      "JSON that is cut off",
      new Response('{"seq":', { status: 200, headers: { "content-type": "application/json" } }),
    ],
    ["a 500", json(500, { error: "internal error" })],
    ["a 503", json(503, { error: "the tail is not configured" })],
    ["a 408", json(408, {})],
  ] as const) {
    const error = await settle(client(() => response.clone()).head("b"));
    expect(error, what).toBeInstanceOf(ObjectStoreUncertain);
    expect((error as Error).message, what).not.toContain("<html");
    expect((error as Error).message, what).not.toContain(TOKEN);
  }
  const named = await settle(client(() => html(429, limit)).head("b"));
  expect((named as Error).message).toContain("1027");
});

test("what the Worker refuses on purpose is certain and is not retried as if the tail were down", async () => {
  for (const [status, body] of [
    [400, { error: "seq must be an integer from 0 to 999999999999" }],
    [401, { error: "unauthorized" }],
    [404, { error: "not found" }],
    [409, { error: "manifest.lastHash is not the hash of entry 2 of the tail" }],
    [413, { error: "body is larger than 1048576 bytes" }],
  ] as const) {
    const error = await settle(client(() => json(status, body)).head("b"));
    expect(error, String(status)).toBeInstanceOf(ObjectStoreError);
    expect(error, String(status)).not.toBeInstanceOf(ObjectStoreUncertain);
    expect((error as ObjectStoreError).status).toBe(status);
    expect((error as Error).message).not.toContain(TOKEN);
  }
});

test("a network error and a timeout are uncertain, and say nothing of the token", async () => {
  const refused = await settle(
    client(() => {
      throw new TypeError("fetch failed: connect ECONNREFUSED 127.0.0.1:1");
    }).head("b"),
  );
  expect(refused).toBeInstanceOf(ObjectStoreUncertain);
  expect((refused as Error).message).not.toContain(TOKEN);
  const slow = new DurableObjectLogTier({
    baseUrl: "https://tail.invalid",
    token: TOKEN,
    timeoutMs: 20,
    fetch: (_url, init) =>
      new Promise((_resolve, reject) => {
        init.signal?.addEventListener("abort", () =>
          reject(new DOMException("timed out", "TimeoutError")),
        );
      }),
  });
  const error = await settle(slow.head("b"));
  expect(error).toBeInstanceOf(ObjectStoreUncertain);
  expect((error as Error).message).not.toContain(TOKEN);
});

test("an answer is read when it is the Worker's, and the token is sent as a bearer and nowhere else", async () => {
  let seen: RequestInit | undefined;
  const head = {
    seq: 3,
    hash: "a".repeat(64),
    sealedThrough: 0,
    sealedHash: "0".repeat(64),
    fence: 1,
    leaseHolder: null,
    leaseExpiresAt: null,
    now: 5,
  };
  const tier = client((init) => {
    seen = init;
    return json(200, head);
  });
  expect(await tier.head("book-1")).toEqual(head);
  const headers = seen?.headers as Record<string, string>;
  expect(headers.authorization).toBe(`Bearer ${TOKEN}`);
  expect(seen?.body).toBe("{}");
  expect(JSON.stringify(tier)).not.toContain(TOKEN);
  // Without a token there is no header (a loopback test Worker).
  let bare: RequestInit | undefined;
  await new DurableObjectLogTier({
    baseUrl: "http://127.0.0.1:9",
    fetch: async (_url, init) => {
      bare = init;
      return json(200, head);
    },
  }).head("b");
  expect((bare?.headers as Record<string, string> | undefined)?.authorization).toBeUndefined();
});
