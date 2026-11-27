// The pieces of the hosted server's serving policy and of the owner's sign-in, one at a time: what the
// request-level tests in hosted-product.test.ts rest on.
import { expect, test } from "bun:test";
import {
  clearedCookie,
  clientAddress,
  cookiesOf,
  madeByOwnPage,
  MAX_SESSIONS,
  ownerSessions,
  SESSION_COOKIE,
  SessionStore,
  SignInLimiter,
  sameSecret,
  sessionCookie,
} from "../src/hosted-session.ts";
import { Serving, servingFromEnvironment } from "../src/hosted-serving.ts";

const request = (headers: Record<string, string> = {}, method = "GET") =>
  new Request("http://pod.local/v1/x", { method, headers });

test("sessions end by idleness and by age, are forgotten past a limit, and are never kept as the cookie", () => {
  let now = 1000;
  const store = new SessionStore({ now: () => now, idleMs: 100, lifetimeMs: 250 });
  const id = store.begin();
  expect(id).toMatch(/^[A-Za-z0-9_-]{43}$/);
  expect(store.valid(id)).toBe(true);
  now += 90;
  expect(store.valid(id)).toBe(true);
  now += 90;
  expect(store.valid(id)).toBe(true);
  now += 90;
  // 270 ms since it began: past its life, though it was used a moment ago.
  expect(store.valid(id)).toBe(false);
  expect(store.valid(id)).toBe(false);
  // Not a session: wrong shape, unknown, ended.
  for (const bad of ["", "x", "a".repeat(43), "a".repeat(44), `${id}x`, "../../etc/passwd"])
    expect(store.valid(bad)).toBe(false);
  const other = store.begin();
  store.end(other);
  expect(store.valid(other)).toBe(false);
  expect(store.maxAgeSeconds).toBe(0);

  const many = new SessionStore();
  const first = many.begin();
  for (let n = 0; n < MAX_SESSIONS; n += 1) many.begin();
  expect(many.size).toBe(MAX_SESSIONS);
  expect(many.valid(first)).toBe(false);
  expect(many.maxAgeSeconds).toBe(7 * 24 * 60 * 60);
});

test("a client may try a few times a minute; the count is per client, and the table of clients does not grow without bound", () => {
  let now = 0;
  const limiter = new SignInLimiter({ now: () => now, attempts: 3, windowMs: 60_000, clients: 50 });
  expect([1, 2, 3, 4].map(() => limiter.take("a").allowed)).toEqual([true, true, true, false]);
  const refused = limiter.take("a");
  expect(refused.retryAfterSeconds).toBe(60);
  now += 30_000;
  expect(limiter.take("a").retryAfterSeconds).toBe(30);
  expect(limiter.take("b").allowed).toBe(true);
  now += 31_000;
  expect(limiter.take("a").allowed).toBe(true);
  // A flood of clients that never come back is forgotten, the oldest first.
  for (let n = 0; n < 500; n += 1) expect(limiter.take(`client-${n}`).allowed).toBe(true);
  expect(limiter.take("client-499").allowed).toBe(true);
  // client-0 was forgotten, so it is counted from nothing: its three attempts are all allowed.
  expect([1, 2, 3].map(() => limiter.take("client-0").allowed)).toEqual([true, true, true]);
});

test("cookies are read by exact name, the first one wins, and a malformed one is ignored", () => {
  expect([...cookiesOf(null)]).toEqual([]);
  expect(cookiesOf("a=1; b=2;c=3").get("c")).toBe("3");
  expect(cookiesOf(`x=1; ${SESSION_COOKIE}=one; ${SESSION_COOKIE}=two`).get(SESSION_COOKIE)).toBe(
    "one",
  );
  expect(cookiesOf("novalue; =empty; ok=1").get("ok")).toBe("1");
  expect(cookiesOf("evil__Host-rastrata_session=x").has(SESSION_COOKIE)).toBe(false);
  expect(sessionCookie("abc", 10)).toBe(
    `${SESSION_COOKIE}=abc; Path=/; Secure; HttpOnly; SameSite=Strict; Max-Age=10`,
  );
  expect(clearedCookie()).toBe(
    `${SESSION_COOKIE}=; Path=/; Secure; HttpOnly; SameSite=Strict; Max-Age=0`,
  );
});

test("the client is the address Cloudflare saw when that is an address, else the connection's", () => {
  expect(clientAddress(request({ "cf-connecting-ip": "203.0.113.9" }), "10.0.0.1")).toBe(
    "203.0.113.9",
  );
  expect(clientAddress(request({ "cf-connecting-ip": " 2001:DB8::1 " }), "10.0.0.1")).toBe(
    "2001:db8::1",
  );
  expect(clientAddress(request({ "cf-connecting-ip": "evil, 1.2.3.4" }), "10.0.0.1")).toBe(
    "10.0.0.1",
  );
  expect(
    clientAddress(
      request({ "x-forwarded-for": "1.2.3.4", "true-client-ip": "1.2.3.5" }),
      "10.0.0.1",
    ),
  ).toBe("10.0.0.1");
  expect(clientAddress(request(), undefined)).toBe("unknown");
});

test("a request is made by the service's own page when the browser says so, and a change has to say where it came from", () => {
  for (const method of ["GET", "HEAD"]) {
    expect(madeByOwnPage(request({}, method))).toBe(true);
    expect(madeByOwnPage(request({ "sec-fetch-site": "same-origin" }, method))).toBe(true);
    expect(madeByOwnPage(request({ "sec-fetch-site": "none" }, method))).toBe(true);
    expect(madeByOwnPage(request({ "sec-fetch-site": "same-site" }, method))).toBe(false);
    expect(madeByOwnPage(request({ "sec-fetch-site": "cross-site" }, method))).toBe(false);
  }
  expect(madeByOwnPage(request({}, "POST"))).toBe(false);
  expect(madeByOwnPage(request({ origin: "https://a.example" }, "POST"))).toBe(true);
  expect(madeByOwnPage(request({ "sec-fetch-site": "same-origin" }, "DELETE"))).toBe(true);
  expect(madeByOwnPage(request({ "sec-fetch-site": "none" }, "POST"))).toBe(false);
  expect(
    madeByOwnPage(request({ origin: "https://a.example", "sec-fetch-site": "cross-site" }, "POST")),
  ).toBe(false);
});

test("secrets are compared by digest, and the credential step is the only thing the rest of the server asks of a session", async () => {
  expect(sameSecret("abc", "abc")).toBe(true);
  expect(sameSecret("abc", "abd")).toBe(false);
  expect(sameSecret("abc", "abcd")).toBe(false);
  expect(sameSecret("", "abc")).toBe(false);

  const key = `rso_${"A".repeat(43)}`;
  const sessions = ownerSessions(key);
  const none = request({ origin: "https://a.example", "sec-fetch-site": "same-origin" }, "POST");
  expect(sessions.credential(none)).toBeNull();
  expect(sessions.refuses(none)).toBe(false);
  // Sign in through the routes, then the cookie is the credential.
  const answer = await sessions.handle(
    new Request("http://pod.local/session/owner", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        origin: "https://a.example",
        "sec-fetch-site": "same-origin",
      },
      body: JSON.stringify({ key }),
    }),
    new URL("http://pod.local/session/owner"),
    "203.0.113.1",
  );
  expect(answer?.status).toBe(200);
  const cookie = (answer?.headers.get("set-cookie") ?? "").split(";")[0] as string;
  const withCookie = request(
    { cookie, origin: "https://a.example", "sec-fetch-site": "same-origin" },
    "POST",
  );
  expect(sessions.credential(withCookie)).toBe(`Bearer ${key}`);
  expect(sessions.refuses(withCookie)).toBe(false);
  // The same cookie from another site is refused, not merely unauthenticated.
  expect(sessions.refuses(request({ cookie, "sec-fetch-site": "cross-site" }, "POST"))).toBe(true);
  // A request for another path is not the sign-in's.
  expect(
    await sessions.handle(request(), new URL("http://pod.local/v1/x"), "203.0.113.1"),
  ).toBeNull();
});

test("the serving settings are read from the environment's names, and a setting that cannot work stops the start", () => {
  expect(servingFromEnvironment({})).toEqual({});
  expect(
    servingFromEnvironment({
      RASTRATA_BIND: " 0.0.0.0 ",
      RASTRATA_ALLOWED_HOSTS: "app.rastrata.com, status.rastrata.com ,,",
      RASTRATA_PUBLIC_ORIGIN: "https://app.rastrata.com",
    }),
  ).toEqual({
    bind: "0.0.0.0",
    allowedHosts: ["app.rastrata.com", "status.rastrata.com"],
    publicOrigin: "https://app.rastrata.com",
  });
  expect(servingFromEnvironment({ RASTRATA_BIND: "", RASTRATA_ALLOWED_HOSTS: " , " })).toEqual({});

  const pod = new Serving({
    bind: "0.0.0.0",
    allowedHosts: ["App.Rastrata.com"],
    publicOrigin: "https://app.rastrata.com",
  });
  pod.listening(8080);
  expect(pod.loopback).toBe(false);
  expect(pod.https).toBe(true);
  for (const host of [
    "app.rastrata.com",
    "APP.rastrata.com",
    "app.rastrata.com:443",
    "app.rastrata.com:8080",
  ])
    expect(pod.hostAllowed(host), host).toBe(true);
  for (const host of [
    null,
    "",
    "app.rastrata.com:80",
    "x.app.rastrata.com",
    "127.0.0.1:8080",
    "localhost:8080",
    "app.rastrata.com ",
    "a b",
    "app.rastrata.com/x",
  ])
    expect(pod.hostAllowed(host), String(host)).toBe(false);
  const url = new URL("http://app.rastrata.com/v1/x");
  expect(pod.publicUrl(url).href).toBe("https://app.rastrata.com/v1/x");
  expect(pod.originAllowed("https://app.rastrata.com", "app.rastrata.com", url)).toBe(true);
  expect(pod.originAllowed("https://app.rastrata.com", "APP.rastrata.com:443", url)).toBe(true);
  expect(pod.originAllowed("http://app.rastrata.com", "app.rastrata.com", url)).toBe(false);

  const local = new Serving();
  local.listening(4010);
  expect(local.loopback).toBe(true);
  expect(local.https).toBe(false);
  expect(local.hostAllowed("127.0.0.1:4010")).toBe(true);
  expect(local.hostAllowed("127.0.0.1")).toBe(false);
  expect(local.publicUrl(new URL("http://127.0.0.1:4010/x")).href).toBe("http://127.0.0.1:4010/x");
  expect(new Serving({ bind: "localhost" }).loopback).toBe(true);
  expect(new Serving({ bind: "::1" }).loopback).toBe(true);
  expect(new Serving({ bind: "127.0.0.2" }).loopback).toBe(true);
  expect(new Serving({ bind: "::", allowedHosts: ["a.example"] }).loopback).toBe(false);
});
