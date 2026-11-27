import { afterEach, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { issueOwnerKey } from "@rastrata/application/agent";
import { APPLICATION_API_VERSION } from "@rastrata/application/schema";
import { startLocalApplicationServer } from "../src/server.ts";
import { contentSecurityPolicy, inlineScriptHashes, loadWebApp } from "../src/web.ts";

const cleanup: (() => Promise<void> | void)[] = [];
afterEach(async () => {
  for (const work of cleanup.splice(0)) await work();
});

const THEME = `let theme = "system"; document.documentElement.dataset.theme = theme;`;
const INDEX = `<!doctype html><html><head><script>${THEME}</script>
<link rel="stylesheet" href="/assets/app-1a2b3c.css"><script type="module" src="/assets/app-1a2b3c.js"></script></head>
<body><div id="root"></div></body></html>`;
const SIGN_IN = `<!doctype html><html><head><script>${THEME}</script>
<link rel="stylesheet" href="/assets/app-1a2b3c.css"><script type="module" src="/assets/signin-4d5e6f.js"></script></head>
<body><div id="root"></div></body></html>`;
const SECRET = "the-secret-outside-the-build";

/** A build of a web app in a scratch directory, with a file outside it that must stay unreachable. With
 * `signIn` it has the sign-in page a locked hosted service sends to a browser that is not signed in. */
function build(options: { signIn?: boolean } = {}): string {
  const parent = mkdtempSync(join(tmpdir(), "rastrata-web-"));
  cleanup.push(() => rmSync(parent, { recursive: true, force: true }));
  const web = join(parent, "web");
  mkdirSync(join(web, "assets"), { recursive: true });
  mkdirSync(join(web, "licenses"));
  writeFileSync(join(web, "index.html"), INDEX);
  if (options.signIn) {
    writeFileSync(join(web, "signin.html"), SIGN_IN);
    writeFileSync(join(web, "assets", "signin-4d5e6f.js"), "console.log('sign-in');");
  }
  writeFileSync(join(web, "assets", "app-1a2b3c.js"), "console.log('app');");
  writeFileSync(join(web, "assets", "app-1a2b3c.css"), "body{margin:0}");
  writeFileSync(join(web, "licenses", "inter.txt"), "SIL Open Font License");
  mkdirSync(join(web, "help-content", "hosted"), { recursive: true });
  writeFileSync(join(web, "help-content", "hosted", "a-topic.json"), '{"id":"a-topic"}');
  writeFileSync(join(web, ".env"), "HIDDEN=1");
  writeFileSync(join(parent, "secret.txt"), SECRET);
  writeFileSync(join(parent, "web-secret.txt"), SECRET);
  return web;
}

async function installed(options: { ownerKey?: string; withWeb?: boolean } = {}) {
  const directory = mkdtempSync(join(tmpdir(), "rastrata-web-runtime-"));
  const ownerKey = options.ownerKey ?? issueOwnerKey();
  const web = options.withWeb === false ? null : await loadWebApp(build());
  const runtime = await startLocalApplicationServer({
    path: join(directory, "book.sqlite"),
    port: 0,
    ownerKey,
    web,
    health: { service: "rastrata", version: "9.9.9" },
  });
  cleanup.push(async () => {
    await runtime.server.stop(true);
    await runtime.stop();
    rmSync(directory, { recursive: true, force: true });
  });
  const port = runtime.server.port as number;
  return { base: `http://127.0.0.1:${port}`, port, ownerKey, runtime };
}

const call = (base: string, name: string, headers: Record<string, string> = {}, input = {}) =>
  fetch(`${base}/v1/${name}`, {
    method: "POST",
    headers: { "content-type": "application/json", ...headers },
    body: JSON.stringify({ version: APPLICATION_API_VERSION, bookId: "local-book", input }),
  });

/** A request written by hand, for the paths a URL parser would tidy before they were sent. */
async function raw(port: number, request: string): Promise<{ status: number; text: string }> {
  let received = "";
  const done = Promise.withResolvers<void>();
  const socket = await Bun.connect({
    hostname: "127.0.0.1",
    port,
    socket: {
      data(_socket, data) {
        received += Buffer.from(data).toString("latin1");
      },
      close() {
        done.resolve();
      },
      error() {
        done.resolve();
      },
    },
  });
  socket.write(request);
  setTimeout(() => socket.end(), 1500).unref?.();
  await Promise.race([done.promise, Bun.sleep(1500)]);
  const status = Number(/^HTTP\/1\.[01] (\d{3})/.exec(received)?.[1] ?? 0);
  return { status, text: received };
}

const get = (port: number, path: string, accept = "*/*", host = `127.0.0.1:${port}`) =>
  raw(
    port,
    `GET ${path} HTTP/1.1\r\nHost: ${host}\r\nAccept: ${accept}\r\nConnection: close\r\n\r\n`,
  );

test("the web app: the index, the files of the build, and the index again for any page a browser asks for", async () => {
  const { base } = await installed();
  const page = await fetch(`${base}/`, { headers: { accept: "text/html" } });
  expect(page.status).toBe(200);
  expect(page.headers.get("content-type")).toBe("text/html; charset=utf-8");
  expect(page.headers.get("cache-control")).toBe("no-store");
  expect(await page.text()).toBe(INDEX);

  const script = await fetch(`${base}/assets/app-1a2b3c.js`);
  expect(script.status).toBe(200);
  expect(script.headers.get("content-type")).toBe("text/javascript; charset=utf-8");
  expect(script.headers.get("cache-control")).toBe("public, max-age=31536000, immutable");
  expect(await script.text()).toBe("console.log('app');");
  expect((await fetch(`${base}/assets/app-1a2b3c.css`)).headers.get("content-type")).toBe(
    "text/css; charset=utf-8",
  );
  expect(await (await fetch(`${base}/licenses/inter.txt`)).text()).toBe("SIL Open Font License");

  // A deep link or a reload: the browser asks for a page, the app answers and routes by itself.
  for (const path of [
    "/journal/new",
    "/reports?from=2026-01-01",
    "/inbox/item.with.dots",
    "/a/b/c",
  ]) {
    const deep = await fetch(`${base}${path}`, { headers: { accept: "text/html,*/*;q=0.8" } });
    expect(deep.status, path).toBe(200);
    expect(await deep.text(), path).toBe(INDEX);
  }
  // A request that is not for a page does not get one: a missing script is a 404, not HTML.
  for (const path of ["/journal/new", "/assets/missing.js", "/robots.txt"]) {
    const missing = await fetch(`${base}${path}`);
    expect(missing.status, path).toBe(404);
    expect(missing.headers.get("cache-control"), path).toBe("no-store");
    expect(await missing.text()).toBe("Not found");
  }
  // HEAD says how big, and sends nothing.
  const head = await fetch(`${base}/`, { method: "HEAD", headers: { accept: "text/html" } });
  expect(head.status).toBe(200);
  expect(head.headers.get("content-length")).toBe(String(INDEX.length));
  expect(await head.text()).toBe("");
  // Only reading is the app's; a write to a page is not found.
  expect((await fetch(`${base}/journal/new`, { method: "POST", body: "x" })).status).toBe(404);
  expect((await fetch(`${base}/`, { method: "DELETE" })).status).toBe(404);
});

test("nothing outside the build can be reached, whatever the path says", async () => {
  const { port } = await installed();
  const paths = [
    "/../secret.txt",
    "/%2e%2e/secret.txt",
    "/%2E%2E/secret.txt",
    "/assets/../../secret.txt",
    "/assets/%2e%2e/%2e%2e/secret.txt",
    "/..%2fsecret.txt",
    "/assets/..%2f..%2fsecret.txt",
    "/..%5csecret.txt",
    "/assets/..%5c..%5csecret.txt",
    "/....//secret.txt",
    "/../web-secret.txt",
    "//secret.txt",
    "/web/../../secret.txt",
    "/%00secret.txt",
    "/index.html%00.js",
    "/.env",
    "/assets/",
    "/licenses/",
    "/assets",
    "/%252e%252e/secret.txt",
    "/etc/passwd",
    "/..;/secret.txt",
  ];
  for (const path of paths) {
    for (const accept of ["*/*", "text/html"]) {
      const answer = await get(port, path, accept);
      // Never the file; and for something that is not a page, never a success either.
      expect(answer.text.includes(SECRET), `${path} (${accept})`).toBe(false);
      expect(answer.text.includes("HIDDEN=1"), `${path} (${accept})`).toBe(false);
      if (accept === "*/*") expect([400, 404], `${path} (${accept})`).toContain(answer.status);
    }
  }
});

test("the Host header must name this machine and this port, on every route", async () => {
  const { base, port } = await installed();
  const wrong = [
    "evil.example",
    `evil.example:${port}`,
    "127.0.0.1",
    `127.0.0.1:${port + 1}`,
    `localhost:${port + 1}`,
    `127.0.0.1.evil.example:${port}`,
    `evil.example:${port}@127.0.0.1`,
    `localhost.evil.example:${port}`,
    `[::1]:${port + 1}`,
    `0.0.0.0:${port}`,
    `127.0.0.2:${port}`,
    "",
  ];
  for (const host of wrong) {
    for (const [method, path] of [
      ["GET", "/health"],
      ["GET", "/"],
      ["GET", "/journal/new"],
      ["POST", "/v1/book.get"],
      ["GET", "/api/book"],
      ["GET", "/assets/app-1a2b3c.js"],
    ] as const) {
      const body = method === "POST" ? "{}" : "";
      const answer = await raw(
        port,
        `${method} ${path} HTTP/1.1\r\n${host === "" ? "" : `Host: ${host}\r\n`}Accept: text/html\r\nSec-Fetch-Site: same-origin\r\nContent-Type: application/json\r\nContent-Length: ${body.length}\r\nConnection: close\r\n\r\n${body}`,
      );
      // With no Host at all the server itself may refuse the request as malformed (400).
      if (host === "") expect([400, 421]).toContain(answer.status);
      else {
        expect(answer.status, `${method} ${path} with Host "${host}"`).toBe(421);
        expect(answer.text).toContain("host_denied");
      }
      expect(answer.text.includes('id="root"')).toBe(false);
    }
  }
  // The same request through fetch, with the Host forged as a hostile page's own name would be.
  const forged = await fetch(`${base}/v1/book.get`, {
    method: "POST",
    headers: {
      host: `evil.example:${port}`,
      "content-type": "application/json",
      "sec-fetch-site": "same-origin",
    },
    body: JSON.stringify({ version: APPLICATION_API_VERSION, bookId: "local-book", input: {} }),
  });
  expect(forged.status).toBe(421);
  expect(forged.headers.get("content-security-policy")).toBe("frame-ancestors 'none'");

  // The names that are right, in any case.
  for (const host of [
    `127.0.0.1:${port}`,
    `localhost:${port}`,
    `LOCALHOST:${port}`,
    `[::1]:${port}`,
  ]) {
    const answer = await get(port, "/health", "*/*", host);
    expect(answer.status, host).toBe(200);
    expect(answer.text).toContain('"service":"rastrata"');
  }
});

test("the owner key is attached to the app's own requests and to nothing else", async () => {
  const { base, ownerKey } = await installed();
  const opens = async (headers: Record<string, string>) =>
    (await call(base, "book.get", headers)).status;

  // No credentials: a program with no token is refused, and told what to do.
  const bare = await call(base, "book.get");
  expect(bare.status).toBe(401);
  expect((await bare.json()).error.code).toBe("authentication_required");
  // The app, in a browser, says so with Sec-Fetch-Site; the owner key is attached for it.
  const app = await call(base, "book.get", { "sec-fetch-site": "same-origin" });
  expect(app.status).toBe(200);
  const book = (await app.json()).data;
  expect(book.principal).toEqual({ kind: "owner" });
  expect(book.ownerAccess).toBe("key");
  // A browser too old to send it still sends its own Origin with a POST.
  expect(await opens({ origin: new URL(base).origin })).toBe(200);
  // Another site is not the app: no key, whatever else it claims.
  for (const site of ["cross-site", "same-site", "none"]) {
    expect(await opens({ "sec-fetch-site": site }), site).toBe(401);
  }
  expect(await opens({ origin: "https://evil.example" })).toBe(403);
  expect(await opens({ origin: "https://evil.example", "sec-fetch-site": "same-origin" })).toBe(
    403,
  );
  expect(await opens({ origin: "null", "sec-fetch-site": "same-origin" })).toBe(403);
  // A credential that is present is never replaced: a wrong one stays wrong.
  expect(await opens({ authorization: "Bearer nonsense", "sec-fetch-site": "same-origin" })).toBe(
    401,
  );
  expect(await opens({ authorization: `Bearer ${ownerKey}` })).toBe(200);

  // The browser routes (/api) work the same way.
  expect((await fetch(`${base}/api/book`)).status).toBe(401);
  expect(
    (await fetch(`${base}/api/book`, { headers: { "sec-fetch-site": "same-origin" } })).status,
  ).toBe(200);
  expect(
    (await fetch(`${base}/api/book`, { headers: { "sec-fetch-site": "cross-site" } })).status,
  ).toBe(401);
});

test("an agent's token is never upgraded to the owner by the app's key", async () => {
  const { base, ownerKey } = await installed();
  // Set up a book, then ask for a token as the owner (the key, as the command line sends it).
  const owner = { authorization: `Bearer ${ownerKey}` };
  const setup = await fetch(`${base}/api/book/setup`, {
    method: "POST",
    headers: { "content-type": "application/json", ...owner },
    body: JSON.stringify({
      name: "Token Co",
      currency: "USD",
      fiscalYear: 2026,
      periodModel: "monthly",
      accounts: [
        { code: "1000", name: "Cash", role: "asset" },
        { code: "3000", name: "Capital", role: "equity" },
      ],
    }),
  });
  expect(setup.status).toBe(200);
  const created = await fetch(`${base}/v1/tokens.create`, {
    method: "POST",
    headers: { "content-type": "application/json", ...owner },
    body: JSON.stringify({
      version: APPLICATION_API_VERSION,
      bookId: "local-book",
      operationId: crypto.randomUUID(),
      input: { label: "bookkeeper", permissions: ["read"] },
    }),
  });
  expect(created.status).toBe(200);
  const token = (await created.json()).data.secret as string;
  expect(token).toMatch(/^rst_/);

  // With the token, and the browser's headers, the caller is still the token: read only.
  const asToken = await call(base, "book.get", {
    authorization: `Bearer ${token}`,
    "sec-fetch-site": "same-origin",
  });
  const principal = (await asToken.json()).data.principal;
  expect(principal.kind).toBe("token");
  const denied = await call(base, "tokens.list", {
    authorization: `Bearer ${token}`,
    "sec-fetch-site": "same-origin",
  });
  expect(denied.status).toBe(403);
  // And the browser routes refuse a token, as they always have.
  const legacy = await fetch(`${base}/api/book`, {
    headers: { authorization: `Bearer ${token}`, "sec-fetch-site": "same-origin" },
  });
  expect(legacy.status).toBe(403);
});

test("a large upload passes through the key-attaching path with its body intact", async () => {
  const { base, ownerKey } = await installed();
  const statement = new TextEncoder().encode(
    `Date,Amount,Description\n${"01/02/2026,-12.34,COFFEE SHOP\n".repeat(60_000)}`,
  );
  expect(statement.byteLength).toBeGreaterThan(1_500_000);
  // Without credentials the upload is refused, whatever it carries.
  expect(
    (
      await fetch(`${base}/v1/uploads`, {
        method: "POST",
        headers: { "content-type": "text/csv" },
        body: statement,
      })
    ).status,
  ).toBe(401);
  // As the app sends it, through the same path, every byte arrives.
  const sent = await fetch(`${base}/v1/uploads`, {
    method: "POST",
    headers: {
      "content-type": "text/csv",
      "x-upload-name": "statement.csv",
      "sec-fetch-site": "same-origin",
    },
    body: statement,
  });
  const reply = await sent.json();
  // The ingest slice archives it (200); a build without it says so (503). Never a truncated body.
  expect([200, 503]).toContain(sent.status);
  if (sent.status === 200) {
    expect(reply.data.size).toBe(statement.byteLength);
    expect(reply.data.sha256).toBe(createHash("sha256").update(statement).digest("hex"));
  }
  expect(ownerKey).toMatch(/^rso_/);
});

test("every response carries the headers that keep the app from being framed or read by another site", async () => {
  const { base } = await installed();
  const responses = [
    await fetch(`${base}/`, { headers: { accept: "text/html" } }),
    await fetch(`${base}/assets/app-1a2b3c.js`),
    await fetch(`${base}/health`),
    await fetch(`${base}/nowhere`),
    await call(base, "book.get"),
    await call(base, "book.get", { "sec-fetch-site": "same-origin" }),
    await fetch(`${base}/api/book`),
  ];
  for (const response of responses) {
    await response.arrayBuffer();
    expect(response.headers.get("x-frame-options")).toBe("DENY");
    expect(response.headers.get("cross-origin-resource-policy")).toBe("same-origin");
    expect(response.headers.get("x-content-type-options")).toBe("nosniff");
    expect(response.headers.get("referrer-policy")).toBe("no-referrer");
    expect(response.headers.get("content-security-policy")).toContain("frame-ancestors 'none'");
  }
  // The page has the whole policy: scripts only from itself and the one inline script it carries.
  const policy = responses[0]?.headers.get("content-security-policy") ?? "";
  const hash = createHash("sha256").update(THEME).digest("base64");
  expect(policy).toContain(`script-src 'self' 'sha256-${hash}'`);
  expect(policy).toContain("default-src 'none'");
  expect(policy).toContain("connect-src 'self'");
  expect(policy).toContain("object-src 'none'");
  expect(policy).not.toContain("unsafe-eval");
  expect(policy).not.toMatch(/script-src[^;]*unsafe-inline/);
});

test("the development API is unchanged: the app's headers do not attach a key, and a plain 404 stays one", async () => {
  const directory = mkdtempSync(join(tmpdir(), "rastrata-web-dev-"));
  const runtime = await startLocalApplicationServer({
    path: join(directory, "book.sqlite"),
    port: 0,
    ownerKey: issueOwnerKey(),
  });
  cleanup.push(async () => {
    await runtime.server.stop(true);
    await runtime.stop();
    rmSync(directory, { recursive: true, force: true });
  });
  const base = `http://127.0.0.1:${runtime.server.port}`;
  expect((await call(base, "book.get", { "sec-fetch-site": "same-origin" })).status).toBe(401);
  const missing = await fetch(`${base}/`, { headers: { accept: "text/html" } });
  expect(missing.status).toBe(404);
  expect(missing.headers.get("content-type")).toContain("text/plain");
  expect(missing.headers.get("x-frame-options")).toBeNull();
  // The Host rule applies here as well.
  const forged = await fetch(`${base}/health`, { headers: { host: "evil.example" } });
  expect(forged.status).toBe(421);
});

test("a service that is locked sends a browser that is not signed in the sign-in page at every address that would have been the app", async () => {
  const web = await loadWebApp(build({ signIn: true }));
  if (!web) throw new Error("no build");
  const serve = (
    path: string,
    headers: Record<string, string> = {},
    signedIn?: boolean,
    method = "GET",
  ) =>
    web.serve(
      new Request(`http://app.test${path}`, { method, headers }),
      signedIn === undefined ? undefined : { signedIn },
    );
  const text = async (response: Response | null) => (response ? await response.text() : null);

  // Nobody in: the sign-in page, with a policy made from its own inline script, never cached.
  for (const path of ["/", "/index.html", "/journal/new", "/a/b/c"]) {
    const answer = serve(path, { accept: "text/html" }, false);
    expect(await text(answer), path).toBe(SIGN_IN);
    expect(answer?.headers.get("cache-control"), path).toBe("no-store");
    expect(answer?.headers.get("content-security-policy"), path).toBe(
      contentSecurityPolicy(inlineScriptHashes(SIGN_IN)),
    );
  }
  // The root is the page whatever the browser says it accepts; any other address needs a request for a page.
  expect(await text(serve("/", {}, false))).toBe(SIGN_IN);
  expect(serve("/journal/new", { accept: "application/json" }, false)).toBeNull();
  // Files stay as they were: the build's own files are open to all, and one that is not there is not a page.
  expect((await serve("/assets/app-1a2b3c.js", {}, false)?.text())?.length).toBeGreaterThan(0);
  expect(serve("/assets/missing.js", { accept: "*/*" }, false)).toBeNull();
  expect(await text(serve("/signin.html", {}, false))).toBe(SIGN_IN);
  // Help is for the people who use the app: its topics are not sent to a browser that is not signed in, and
  // are to one that is (or on a service with no lock).
  expect(
    serve("/help-content/hosted/a-topic.json", { accept: "application/json" }, false),
  ).toBeNull();
  for (const signedIn of [true, undefined]) {
    const topic = serve("/help-content/hosted/a-topic.json", {}, signedIn);
    expect(await text(topic)).toBe('{"id":"a-topic"}');
    expect(topic?.headers.get("content-type")).toBe("application/json; charset=utf-8");
    expect(topic?.headers.get("cache-control")).toBe("no-cache");
  }
  // A request for the head of the page has no body.
  const head = serve("/", {}, false, "HEAD");
  expect(head?.status).toBe(200);
  expect(await head?.text()).toBe("");
  // Signed in, or told nothing (a service with no lock), the page is the app.
  for (const path of ["/", "/index.html", "/journal/new"]) {
    expect(await text(serve(path, { accept: "text/html" }, true)), path).toBe(INDEX);
    expect(await text(serve(path, { accept: "text/html" })), path).toBe(INDEX);
  }
  // Not the app's page even for the sign-in page's own policy: its hash is the only one it allows besides itself.
  expect(serve("/", {}, false)?.headers.get("content-security-policy")).toContain(
    inlineScriptHashes(SIGN_IN)[0] ?? "?",
  );
});

test("a browser that came from another website is given a hop and not the sign-in page, since its cookie is not sent", async () => {
  const web = await loadWebApp(build({ signIn: true }));
  if (!web) throw new Error("no build");
  const arriving = { "sec-fetch-site": "cross-site", "sec-fetch-mode": "navigate" };
  const ask = (headers: Record<string, string>, path = "/reports", method = "GET") =>
    web.serve(new Request(`http://app.test${path}`, { method, headers }), { signedIn: false });

  const hop = ask({ accept: "text/html", ...arriving });
  expect(hop?.status).toBe(200);
  const body = (await hop?.text()) ?? "";
  expect(body).toContain('<meta http-equiv="refresh" content="0">');
  // Nothing of either page is in it, and nothing may be cached.
  expect(body).not.toContain("signin-4d5e6f");
  expect(body).not.toContain("app-1a2b3c");
  expect(hop?.headers.get("cache-control")).toBe("no-store");
  expect(hop?.headers.get("content-security-policy")).toBe(contentSecurityPolicy([]));
  expect(hop?.headers.get("x-frame-options")).toBe("DENY");
  expect(await ask({ ...arriving }, "/", "HEAD")?.text()).toBe("");
  // Once: the same request made from this page, or by a browser that says nothing, is the sign-in page.
  for (const headers of [
    { accept: "text/html", "sec-fetch-site": "same-origin", "sec-fetch-mode": "navigate" },
    { accept: "text/html", "sec-fetch-site": "same-site", "sec-fetch-mode": "navigate" },
    { accept: "text/html", "sec-fetch-site": "none", "sec-fetch-mode": "navigate" },
    { accept: "text/html" },
    // Not a navigation: a script or an image from another website is not given the hop.
    { accept: "text/html", "sec-fetch-site": "cross-site", "sec-fetch-mode": "no-cors" },
  ])
    expect(await ask(headers)?.text(), JSON.stringify(headers)).toBe(SIGN_IN);
});

test("a build with no sign-in page sends the app to every browser, as one made before the page existed did", async () => {
  const web = await loadWebApp(build());
  if (!web) throw new Error("no build");
  const answer = web.serve(new Request("http://app.test/", { headers: { accept: "text/html" } }), {
    signedIn: false,
  });
  expect(await answer?.text()).toBe(INDEX);
});

test("without a build the service still answers its API and says so for the rest", async () => {
  const { base } = await installed({ withWeb: false });
  expect((await fetch(`${base}/health`)).status).toBe(200);
  expect((await fetch(`${base}/`, { headers: { accept: "text/html" } })).status).toBe(404);
  expect(await loadWebApp(join(tmpdir(), "rastrata-no-such-build"))).toBeNull();
});

test("inline scripts are allowed by their hash and nothing else", () => {
  const hashOf = (text: string) => `'sha256-${createHash("sha256").update(text).digest("base64")}'`;
  expect(inlineScriptHashes(INDEX)).toEqual([hashOf(THEME)]);
  expect(
    inlineScriptHashes(
      `<script>a</script><SCRIPT type="text/javascript">b</SCRIPT><script src="/x.js"></script><script type="module" crossorigin src = "/y.js"></script>`,
    ),
  ).toEqual([hashOf("a"), hashOf("b")]);
  expect(inlineScriptHashes("<p>no script</p>")).toEqual([]);
  expect(contentSecurityPolicy([])).toContain("script-src 'self';");
});
