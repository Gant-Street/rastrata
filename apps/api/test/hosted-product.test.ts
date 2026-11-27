// The hosted server as a product: who it answers to behind a tunnel, the web app beside the API, the
// owner's sign-in for a browser, and the probes an orchestrator asks. The server is real (a book in a
// log, on a memory tail and a file bucket); requests are real HTTP with the headers a browser or a
// tunnel would send. See docs/reference/program/hosting/hostedprod.md.
import { afterEach, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import {
  issueOwnerKey,
  issueServiceKey,
  MEMBER_HINT_COOKIE,
  sha256Hex,
} from "@rastrata/application/agent";
import type { MemberTokenVerdict, MemberTokenVerifier } from "@rastrata/application/member-token";
import { APPLICATION_API_VERSION } from "@rastrata/application/schema";
import { MemoryLogTier } from "@rastrata/booklog/testing";
import {
  type HostedServerOptions,
  parseBookStore,
  startHostedApplicationServer,
} from "../src/hosted.ts";
import { SESSION_COOKIE } from "../src/hosted-session.ts";
import { contentSecurityPolicy, inlineScriptHashes, loadWebApp } from "../src/web.ts";

const OWNER_KEY = issueOwnerKey();
const PUBLIC = "https://app.example.test";
const HOST = "app.example.test";
const BOOK = {
  name: "Hosted Co",
  currency: "USD",
  fiscalYear: 2026,
  periodModel: "monthly",
  accounts: [
    { code: "1010", name: "Checking", role: "asset" },
    { code: "3100", name: "Owner draw", role: "equity" },
    { code: "6100", name: "Software", role: "expense" },
  ],
} as const;
const id = (n: number): string => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;

const cleanup: (() => Promise<void> | void)[] = [];
afterEach(async () => {
  for (const step of cleanup.splice(0).reverse()) await step();
});
function folder(): string {
  const directory = mkdtempSync(join(tmpdir(), "rastrata-product-"));
  cleanup.push(() => rmSync(directory, { recursive: true, force: true }));
  return directory;
}

const THEME = `let theme = "system"; document.documentElement.dataset.theme = theme;`;
const INDEX = `<!doctype html><html><head><script>${THEME}</script>
<script type="module" src="/assets/app-1a2b3c.js"></script></head><body><div id="root"></div></body></html>`;
const SIGN_IN = `<!doctype html><html><head><script>${THEME}</script>
<script type="module" src="/assets/signin-4d5e6f.js"></script></head><body><div id="root"></div></body></html>`;
const OUTSIDE = "the-secret-outside-the-build";
/** A build of a web app in a scratch directory, with a file beside it that must stay unreachable. With
 * `signIn`, the build has the sign-in page a locked service sends to a browser that is not signed in. */
function webBuild(options: { signIn?: boolean } = {}): string {
  const parent = folder();
  const web = join(parent, "web");
  mkdirSync(join(web, "assets"), { recursive: true });
  writeFileSync(join(web, "index.html"), INDEX);
  writeFileSync(join(web, "assets", "app-1a2b3c.js"), "console.log('app');");
  if (options.signIn) {
    writeFileSync(join(web, "signin.html"), SIGN_IN);
    writeFileSync(join(web, "assets", "signin-4d5e6f.js"), "console.log('sign-in');");
  }
  writeFileSync(join(parent, "secret.txt"), OUTSIDE);
  return web;
}

interface Started {
  readonly base: string;
  readonly port: number;
  readonly lines: string[];
  readonly tail: MemoryLogTier;
  readonly server: Awaited<ReturnType<typeof startHostedApplicationServer>>;
}

/** A product server on a loopback port: reached as `127.0.0.1`, and answering to whatever `serving`
 * says besides (the Host header says which name a request was sent to). */
async function start(
  options: Partial<HostedServerOptions> & { readonly bulkRoot?: string } = {},
): Promise<Started> {
  const root = options.bulkRoot ?? folder();
  const tail = new MemoryLogTier();
  const lines: string[] = [];
  const { bulkRoot: _bulk, ...rest } = options;
  const server = await startHostedApplicationServer({
    config: parseBookStore("r2log://book-1", {
      RASTRATA_BOOK_BULK: pathToFileURL(join(root, "bucket")).href,
      RASTRATA_BOOK_TAIL: "memory",
      RASTRATA_BOOK_CACHE: join(root, "cache"),
    }),
    port: 0,
    telemetry: false,
    stores: { tail },
    log: (line) => lines.push(line),
    ...rest,
  });
  cleanup.push(() => server.stop());
  const port = server.server.port as number;
  return { base: `http://127.0.0.1:${port}`, port, lines, tail, server };
}

/** The server as the pilot runs it behind the tunnel: one public name, https in front of plain http. */
const tunnelled = (extra: Partial<HostedServerOptions> = {}) =>
  start({
    ownerKey: OWNER_KEY,
    serving: { bind: "0.0.0.0", allowedHosts: [HOST], publicOrigin: PUBLIC },
    web: null,
    ...extra,
  });

interface Reply {
  readonly status: number;
  // biome-ignore lint/suspicious/noExplicitAny: response bodies are inspected loosely
  readonly body: any;
  readonly headers: Headers;
}
async function reply(response: Response): Promise<Reply> {
  const text = await response.text();
  let body: unknown = text;
  try {
    body = JSON.parse(text);
  } catch {
    // not JSON
  }
  return { status: response.status, body, headers: response.headers };
}

/** What the tunnel forwards for a browser at https://app.example.test: the pod's address in the URL,
 * the public name in Host, and the browser's own Origin. */
const BROWSER = { host: HOST, origin: PUBLIC, "sec-fetch-site": "same-origin" };

function operation(
  base: string,
  name: string,
  input: unknown = {},
  options: { operationId?: string; headers?: Record<string, string> } = {},
): Promise<Reply> {
  return fetch(`${base}/v1/${name}`, {
    method: "POST",
    headers: { "content-type": "application/json", ...options.headers },
    body: JSON.stringify({
      version: APPLICATION_API_VERSION,
      bookId: "local-book",
      input,
      ...(options.operationId ? { operationId: options.operationId } : {}),
    }),
  }).then(reply);
}

const signIn = (
  base: string,
  key: string,
  headers: Record<string, string> = BROWSER,
  body: BodyInit = JSON.stringify({ key }),
): Promise<Reply> =>
  fetch(`${base}/session/owner`, {
    method: "POST",
    headers: { "content-type": "application/json", ...headers },
    body,
  }).then(reply);

/** `name=value` of the cookie a sign-in set, as a browser would send it back. */
const cookieOf = (answer: Reply): string =>
  (answer.headers.get("set-cookie") ?? "").split(";")[0] ?? "";

async function signedIn(base: string): Promise<string> {
  const answer = await signIn(base, OWNER_KEY);
  expect(answer.status).toBe(200);
  return cookieOf(answer);
}

/** A request written by hand, for what a client library would not send (an absolute-form target). */
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
  return { status: Number(/^HTTP\/1\.[01] (\d{3})/.exec(received)?.[1] ?? 0), text: received };
}

// ---- H1: who it answers to ----------------------------------------------------------------------------

test("behind the tunnel it answers to the public name, with the browser's own https Origin, and to nobody else", async () => {
  const { base } = await tunnelled();
  const health = (headers: Record<string, string>) =>
    fetch(`${base}/health`, { headers }).then((response) => response.status);

  expect(await health({ host: HOST })).toBe(200);
  // The browser's Origin is https while the pod sees plain http for the same host.
  expect(await health({ host: HOST, origin: PUBLIC })).toBe(200);
  // No Origin at all is a command line or a page opened by address: let in.
  expect(await health({ host: HOST })).toBe(200);

  // A Host that is not on the list: a rebinding attempt or a stray.
  expect(await health({ host: "evil.example" })).toBe(421);
  expect(await health({ host: `${HOST}.evil.example` })).toBe(421);
  // The loopback names are for a server bound to loopback: this one listens beyond it.
  expect(await health({ host: base.replace("http://", "") })).toBe(421);
  expect(await health({ host: "localhost" })).toBe(421);
  // The listed name may carry the public port or the server's own, and no other.
  expect(await health({ host: `${HOST}:443` })).toBe(200);
  expect(await health({ host: `${HOST}:9` })).toBe(421);

  // An Origin has to be this server's own: its scheme as the deployment says, the host it was sent to.
  for (const origin of [
    "http://app.example.test", // the pod's own scheme, which no browser at the public name uses
    "https://evil.example",
    "https://app.example.test.evil.example",
    "https://app.example.test:8443",
    "null",
    "https://app.example.test/",
    "app.example.test",
    "ftp://app.example.test",
  ])
    expect(await health({ host: HOST, origin }), origin).toBe(403);
});

test("an Origin has to be the host the request was sent to, even when it is another name the server answers to", async () => {
  const { base } = await tunnelled({
    serving: {
      bind: "0.0.0.0",
      allowedHosts: [HOST, "status.example.test"],
      publicOrigin: PUBLIC,
    },
  });
  const status = (headers: Record<string, string>) =>
    fetch(`${base}/health`, { headers }).then((response) => response.status);
  expect(await status({ host: "status.example.test", origin: "https://status.example.test" })).toBe(
    200,
  );
  // A page on one name making requests to the other (the same site, so a SameSite cookie would go).
  expect(await status({ host: HOST, origin: "https://status.example.test" })).toBe(403);
  expect(await status({ host: "status.example.test", origin: PUBLIC })).toBe(403);
});

test("the application's own check of an Origin passes behind the tunnel: it is shown the address people use", async () => {
  const { base } = await tunnelled();
  // The application refuses an Origin that is not its request's own, and its request is the pod's http.
  const answer = await operation(
    base,
    "book.get",
    {},
    {
      headers: { ...BROWSER, authorization: `Bearer ${OWNER_KEY}` },
    },
  );
  expect(answer.status).toBe(200);
  expect(answer.body.ok).toBe(true);
  // A browser at another name is refused before the application is asked.
  const stranger = await operation(
    base,
    "book.get",
    {},
    {
      headers: { host: HOST, origin: "https://evil.example", authorization: `Bearer ${OWNER_KEY}` },
    },
  );
  expect(stranger.status).toBe(403);
});

test("a loopback server answers to its loopback names with its own port, as it always did, and to its listed names", async () => {
  const { base, port } = await start({ serving: { allowedHosts: [HOST] } });
  const get = (headers: Record<string, string>) =>
    fetch(`${base}/health`, { headers }).then((response) => response.status);
  expect(await get({})).toBe(200);
  expect(await get({ host: `localhost:${port}` })).toBe(200);
  expect(await get({ host: `[::1]:${port}` })).toBe(200);
  expect(await get({ host: `localhost:${port + 1}` })).toBe(421);
  expect(await get({ host: "localhost" })).toBe(421);
  expect(await get({ host: HOST })).toBe(200);
  expect(await get({ host: "evil.example" })).toBe(421);
  // With no public address the scheme is the request's own: http.
  expect(await get({ origin: base })).toBe(200);
  expect(await get({ origin: `https://127.0.0.1:${port}` })).toBe(403);
  expect(await get({ origin: "https://example.com" })).toBe(403);
});

test("the Host header decides, whatever the request line names", async () => {
  const { port } = await start();
  const ask = (target: string, host: string) =>
    raw(port, `GET ${target} HTTP/1.1\r\nHost: ${host}\r\nConnection: close\r\n\r\n`);
  expect((await ask(`http://127.0.0.1:${port}/health`, "evil.example")).status).toBe(421);
  expect((await ask("http://evil.example/health", `127.0.0.1:${port}`)).status).toBe(200);
  expect((await ask("/health", `127.0.0.1:${port}`)).status).toBe(200);
  expect((await ask("/health", "a b")).status).toBe(421);
});

test("a server that listens beyond this computer must have names to answer to and a key to ask for", async () => {
  const config = parseBookStore("r2log://book-1", {
    RASTRATA_BOOK_BULK: "memory",
    RASTRATA_BOOK_TAIL: "memory",
    RASTRATA_BOOK_CACHE: join(folder(), "cache"),
  });
  const attempt = (serving: HostedServerOptions["serving"], ownerKey?: string) =>
    startHostedApplicationServer({
      config,
      port: 0,
      telemetry: false,
      ...(serving ? { serving } : {}),
      ...(ownerKey ? { ownerKey } : {}),
    });
  await expect(attempt({ bind: "0.0.0.0" }, OWNER_KEY)).rejects.toThrow("RASTRATA_ALLOWED_HOSTS");
  await expect(attempt({ bind: "0.0.0.0", allowedHosts: [HOST] })).rejects.toThrow(
    "RASTRATA_OWNER_KEY",
  );
  await expect(attempt({ bind: "::", allowedHosts: [HOST] })).rejects.toThrow("RASTRATA_OWNER_KEY");
  await expect(attempt({ bind: "not-an-address" })).rejects.toThrow("RASTRATA_BIND");
  await expect(attempt({ allowedHosts: ["https://app.example.test"] })).rejects.toThrow(
    "RASTRATA_ALLOWED_HOSTS",
  );
  await expect(attempt({ allowedHosts: ["app.example.test:8080"] })).rejects.toThrow(
    "RASTRATA_ALLOWED_HOSTS",
  );
  await expect(attempt({ publicOrigin: "app.example.test" })).rejects.toThrow(
    "RASTRATA_PUBLIC_ORIGIN",
  );
  await expect(attempt({ publicOrigin: "https://app.example.test/app" })).rejects.toThrow(
    "RASTRATA_PUBLIC_ORIGIN",
  );
  await expect(
    attempt({ allowedHosts: [HOST], publicOrigin: "https://other.example.test" }),
  ).rejects.toThrow("does not");
  await expect(attempt({ publicOrigin: "ftp://localhost" })).rejects.toThrow(
    "RASTRATA_PUBLIC_ORIGIN",
  );
});

// ---- H2: the web app beside the API ---------------------------------------------------------------------

test("the web app is served beside the API with its policy, its cache rules and the single-page fallback, and nothing outside the build", async () => {
  const web = await loadWebApp(webBuild());
  const { base, port } = await tunnelled({ web });
  const get = (path: string, headers: Record<string, string> = {}) =>
    fetch(`${base}${path}`, { headers: { host: HOST, ...headers } });

  const page = await get("/", { accept: "text/html" });
  expect(page.status).toBe(200);
  expect(await page.text()).toBe(INDEX);
  expect(page.headers.get("cache-control")).toBe("no-store");
  expect(page.headers.get("content-security-policy")).toBe(
    contentSecurityPolicy(inlineScriptHashes(INDEX)),
  );
  expect(page.headers.get("x-frame-options")).toBe("DENY");
  expect(page.headers.get("x-content-type-options")).toBe("nosniff");
  // Over https people keep to https.
  expect(page.headers.get("strict-transport-security")).toBe("max-age=31536000");

  const script = await get("/assets/app-1a2b3c.js");
  expect(script.headers.get("cache-control")).toBe("public, max-age=31536000, immutable");
  expect(script.headers.get("content-type")).toBe("text/javascript; charset=utf-8");

  // A deep link or a reload gets the app; anything else that is missing is a 404, not HTML.
  const deep = await get("/journal/new", { accept: "text/html,*/*;q=0.8" });
  expect(deep.status).toBe(200);
  expect(await deep.text()).toBe(INDEX);
  // A file that is not there is told so and never kept, by Cloudflare or by the browser: it may be there after the next release.
  const absent = await get("/assets/missing.js");
  expect(absent.status).toBe(404);
  expect(absent.headers.get("cache-control")).toBe("no-store");
  expect((await get("/robots.txt")).status).toBe(404);
  // No listing of a directory, no way out of the build, whatever the path says.
  for (const path of [
    "/assets/",
    "/assets",
    "/",
    "/%2e%2e/secret.txt",
    "/..%2fsecret.txt",
    "/assets/../../secret.txt",
  ]) {
    const answer = await raw(
      port,
      `GET ${path} HTTP/1.1\r\nHost: ${HOST}\r\nAccept: */*\r\nConnection: close\r\n\r\n`,
    );
    expect(answer.text, path).not.toContain(OUTSIDE);
  }
  // The paths that belong to services are never the app's, even for a browser.
  for (const path of ["/auth/login", "/session/other", "/control/status", "/live/x", "/ready/x"]) {
    const answer = await get(path, { accept: "text/html" });
    expect(answer.status, path).toBe(404);
    expect(await answer.text(), path).not.toContain("<!doctype html>");
  }
  // And the API is where it was: a locked book asks for a key.
  expect((await operation(base, "book.get", {}, { headers: { host: HOST } })).status).toBe(401);
});

test("the page and the files it is made of are answered whatever Origin a browser names, and everything that reads or changes a book still has to name this server's own", async () => {
  const web = await loadWebApp(webBuild());
  const { base, lines } = await tunnelled({ web });
  const ask = (path: string, headers: Record<string, string>, method = "GET") =>
    fetch(`${base}${path}`, { method, headers: { host: HOST, accept: "text/html", ...headers } });
  // What a browser may say that is not this server's own: nothing it can say changes what the page is.
  const named = [
    "null",
    "https://rastrata.example",
    "https://evil.example",
    "http://app.example.test",
    "https://app.example.test:8443",
    "app.example.test",
  ];
  for (const origin of named) {
    const page = await ask("/", { origin });
    expect(page.status, origin).toBe(200);
    expect(await page.text(), origin).toBe(INDEX);
    expect((await ask("/", { origin }, "HEAD")).status, origin).toBe(200);
    expect((await ask("/assets/app-1a2b3c.js", { origin })).status, origin).toBe(200);
    expect((await ask("/journal/new", { origin })).status, origin).toBe(200);
  }
  // The server's own, as a browser names it for the script and the stylesheet of its page, is let in as it was.
  expect((await ask("/assets/app-1a2b3c.js", { origin: PUBLIC })).status).toBe(200);
  expect(lines.filter((line) => line.startsWith("refused:"))).toEqual([]);

  // Everything else is as it was: the API, the sign-in, the routes of services and every request that is not a read.
  for (const [path, method] of [
    ["/v1/book.get", "GET"],
    ["/v1/book.get", "POST"],
    ["/api/book.get", "GET"],
    ["/session/owner", "POST"],
    ["/session", "DELETE"],
    ["/health", "GET"],
    ["/", "POST"],
    ["/assets/app-1a2b3c.js", "POST"],
    ["/journal/new", "PUT"],
  ] as const) {
    const answer = await ask(path, { origin: "https://evil.example" }, method);
    expect(answer.status, `${method} ${path}`).toBe(403);
    expect((await answer.json()).code, `${method} ${path}`).toBe("origin_denied");
  }

  // Each refusal is told to the log once a minute, by where it was asked and what the browser said, never by what it asked for.
  const told = lines.filter((line) => line.startsWith("refused: origin_denied"));
  expect(told).toContain("refused: origin_denied POST page site=- origin=https://evil.example");
  expect(told).toContain("refused: origin_denied GET /v1 site=- origin=https://evil.example");
  expect(told).toContain(
    "refused: origin_denied DELETE /session site=- origin=https://evil.example",
  );
  expect(told.filter((line) => line.includes("POST /v1"))).toHaveLength(1);
  const before = lines.length;
  await ask("/v1/book.get", { origin: "https://evil.example" }, "POST");
  await ask("/invite/secret-token-123?email=person@example.com", { origin: "null" }, "POST");
  expect(lines.length).toBe(before + 1);
  const joined = lines.join("\n");
  expect(joined).not.toContain("secret-token-123");
  expect(joined).not.toContain("person@example.com");
  expect(lines.at(-1)).toBe("refused: origin_denied POST page site=- origin=null");

  // A server with no web app has no page to read: an Origin that is not its own is refused as it always was.
  const bare = await start({ ownerKey: OWNER_KEY, web: null });
  const refused = await fetch(`${bare.base}/`, { headers: { origin: "https://evil.example" } });
  expect(refused.status).toBe(403);
});

test("the product server keeps off https headers when people reach it over http, and the API alone carries none of the page's", async () => {
  const web = await loadWebApp(webBuild());
  const local = await start({ web });
  const page = await fetch(`${local.base}/`, { headers: { accept: "text/html" } });
  expect(page.status).toBe(200);
  expect(page.headers.get("strict-transport-security")).toBeNull();
  // Without a web app nothing is hardened or served: the experiment harness as it was.
  const bare = await start();
  expect((await fetch(`${bare.base}/`, { headers: { accept: "text/html" } })).status).toBe(404);
  expect((await fetch(`${bare.base}/health`)).headers.get("x-frame-options")).toBeNull();
});

test("a locked service sends the sign-in page and not the app to a browser with no session, and the app once it has one", async () => {
  const web = await loadWebApp(webBuild({ signIn: true }));
  const { base } = await tunnelled({ web });
  const page = async (path: string, headers: Record<string, string> = {}) => {
    const answer = await fetch(`${base}${path}`, {
      headers: { host: HOST, accept: "text/html", ...headers },
    });
    return { status: answer.status, text: await answer.text(), headers: answer.headers };
  };

  // Nobody is signed in: every address that would have been the app is the sign-in page, and nothing of the app
  // (its page, the name of its script) is sent.
  for (const path of ["/", "/index.html", "/journal/new", "/settings/backups"]) {
    const answer = await page(path);
    expect(answer.status, path).toBe(200);
    expect(answer.text, path).toBe(SIGN_IN);
    expect(answer.text, path).not.toContain("app-1a2b3c");
    expect(answer.headers.get("cache-control"), path).toBe("no-store");
    expect(answer.headers.get("content-security-policy"), path).toBe(
      contentSecurityPolicy(inlineScriptHashes(SIGN_IN)),
    );
    expect(answer.headers.get("x-frame-options"), path).toBe("DENY");
  }
  // A page asked for without saying so (a probe, a tool) is the sign-in page at the root too.
  expect((await page("/", { accept: "*/*" })).text).toBe(SIGN_IN);
  // The files under /assets stay open (their names are hashes and they hold no data), and what belongs to the
  // services is as it was.
  expect((await page("/assets/app-1a2b3c.js")).status).toBe(200);
  expect((await page("/assets/signin-4d5e6f.js")).text).toContain("sign-in");
  expect((await page("/session/other")).status).toBe(404);
  expect((await page("/health")).status).toBe(200);
  // A made-up cookie is no session, and a wrong key opens nothing.
  expect((await page("/", { cookie: `${SESSION_COOKIE}=${"a".repeat(43)}` })).text).toBe(SIGN_IN);
  expect((await signIn(base, issueOwnerKey())).status).toBe(401);
  expect((await page("/")).text).toBe(SIGN_IN);

  // Signed in, the same addresses are the app.
  const jar = cookieOf(await signIn(base, OWNER_KEY));
  for (const path of ["/", "/index.html", "/journal/new"])
    expect((await page(path, { cookie: jar })).text, path).toBe(INDEX);

  // Arriving from another website, a browser does not send a cookie that is SameSite=Strict, so a person who is
  // signed in would be told to sign in: it is given a page with nothing in it that asks again at once, from here.
  const arriving = { "sec-fetch-site": "cross-site", "sec-fetch-mode": "navigate" };
  const hop = await page("/reports", arriving);
  expect(hop.status).toBe(200);
  expect(hop.text).toContain('http-equiv="refresh"');
  expect(hop.text).not.toContain("app-1a2b3c");
  expect(hop.headers.get("cache-control")).toBe("no-store");
  const again = { "sec-fetch-site": "same-origin", "sec-fetch-mode": "navigate" };
  expect((await page("/reports", { ...again, cookie: jar })).text).toBe(INDEX);
  // With no session after all, the second request is the sign-in page: the hop is made once.
  expect((await page("/reports", again)).text).toBe(SIGN_IN);

  // Signing out ends it, and the page that follows is the sign-in again.
  const out = await fetch(`${base}/session`, {
    method: "DELETE",
    headers: { ...BROWSER, cookie: jar },
  });
  expect(out.status).toBe(200);
  expect((await page("/", { cookie: jar })).text).toBe(SIGN_IN);
});

test("a service with accounts sends the application to a browser that carries the hint the control plane sets, and the sign-in page to one that does not; the hint unlocks nothing", async () => {
  const web = await loadWebApp(webBuild({ signIn: true }), { accounts: true });
  const world = await withMembers({ web });
  const page = async (path: string, headers: Record<string, string> = {}) => {
    const answer = await fetch(`${world.base}${path}`, {
      headers: { host: HOST, accept: "text/html", ...headers },
    });
    return { status: answer.status, text: await answer.text(), headers: answer.headers };
  };
  const hint = { cookie: `${MEMBER_HINT_COOKIE}=1` };

  // A stranger, and a browser with a hint of the wrong value, a made-up session or a hint under another name: the sign-in page.
  for (const cookie of [
    "",
    `${MEMBER_HINT_COOKIE}=0`,
    `${MEMBER_HINT_COOKIE}=`,
    "rastrata_in=1",
    `x${MEMBER_HINT_COOKIE}=1`,
  ])
    expect((await page("/", cookie ? { cookie } : {})).text, cookie).toBe(SIGN_IN);
  // With the hint (among other cookies, as a browser sends them): the application, at any address, and also from another website, since the hint is Lax.
  for (const path of ["/", "/journal/new", "/settings/members"]) {
    expect((await page(path, hint)).text, path).toBe(INDEX);
    expect((await page(path, { cookie: `a=b; ${MEMBER_HINT_COOKIE}=1; c=d` })).text, path).toBe(
      INDEX,
    );
  }
  expect(
    (
      await page("/reports", {
        ...hint,
        "sec-fetch-site": "cross-site",
        "sec-fetch-mode": "navigate",
      })
    ).text,
  ).toBe(INDEX);
  // The hint is the application's shell and nothing else: the data is behind the API, which asks for a signed token whatever cookie came with the request.
  const book = await world.call("not-a-token-aaaaaaaaaa.bbbbbbbbbbbb.cccccccccccc", "book.get");
  expect(book.status).toBe(401);
  const withHint = await fetch(`${world.base}/v1/book.get`, {
    method: "POST",
    headers: { "content-type": "application/json", ...hint, ...BROWSER },
    body: JSON.stringify({ version: APPLICATION_API_VERSION, bookId: "local-book", input: {} }),
  });
  expect(withHint.status).toBe(401);
  expect(world.tail.records).toEqual([]);
  // The link in an invitation is the sign-in page for everyone, hint or not: it reads what the link is for and lets the person in.
  for (const headers of [
    {},
    hint,
    { "sec-fetch-site": "cross-site", "sec-fetch-mode": "navigate" },
  ]) {
    // `/start` is where the application sends someone who has to choose a workspace: the same page.
    for (const path of [`/invite/${"A".repeat(43)}`, "/start"]) {
      const answer = await page(path, headers);
      expect(answer.text, path).toBe(SIGN_IN);
      expect(answer.headers.get("cache-control"), path).toBe("no-store");
    }
  }
  // The sign-in page of a service with accounts may load the bot check's widget, the application and every other page may not.
  const policy = (await page("/")).headers.get("content-security-policy");
  expect(policy).toBe(contentSecurityPolicy(inlineScriptHashes(SIGN_IN), { captcha: true }));
  expect(policy).toContain("script-src 'self'");
  expect(policy).toContain("https://challenges.cloudflare.com");
  expect(policy).toContain("frame-src https://challenges.cloudflare.com");
  const appPolicy = (await page("/", hint)).headers.get("content-security-policy");
  expect(appPolicy).toBe(contentSecurityPolicy(inlineScriptHashes(INDEX)));
  expect(appPolicy).not.toContain("challenges.cloudflare.com");
  // The health answer says that people sign in with accounts here.
  const health = (await reply(await fetch(`${world.base}/health`, { headers: { host: HOST } })))
    .body;
  expect(health.hosted.accounts).toBe(true);
});

test("a service without accounts ignores the hint and gives the invitation path no meaning: the owner's session decides, as it always did", async () => {
  const web = await loadWebApp(webBuild({ signIn: true }));
  const { base } = await tunnelled({ web });
  const page = async (path: string, headers: Record<string, string> = {}) => {
    const answer = await fetch(`${base}${path}`, {
      headers: { host: HOST, accept: "text/html", ...headers },
    });
    return { text: await answer.text(), headers: answer.headers };
  };
  expect((await page("/", { cookie: `${MEMBER_HINT_COOKIE}=1` })).text).toBe(SIGN_IN);
  // A stranger at an invitation path is the sign-in page like any other address; with the owner's session it is the application.
  expect((await page(`/invite/${"A".repeat(43)}`)).text).toBe(SIGN_IN);
  const jar = cookieOf(await signIn(base, OWNER_KEY));
  expect((await page(`/invite/${"A".repeat(43)}`, { cookie: jar })).text).toBe(INDEX);
  expect((await page("/")).headers.get("content-security-policy")).toBe(
    contentSecurityPolicy(inlineScriptHashes(SIGN_IN)),
  );
  const health = (await reply(await fetch(`${base}/health`, { headers: { host: HOST } }))).body;
  expect(health.hosted.accounts).toBeUndefined();
  // Only a pod with many books refuses to keep a bank or Stripe credential; this one's book can.
  expect(health.hosted.connections).toBeUndefined();
  // No hosted pod makes backups of a book: the log is the backup, and the platform keeps it.
  expect(health.hosted.backups).toBe(false);
});

test("a service with nothing locked sends the app to everyone, and so does a build that has no sign-in page", async () => {
  const withPage = await loadWebApp(webBuild({ signIn: true }));
  const open = await start({ web: withPage });
  const asked = { accept: "text/html" };
  expect(await (await fetch(`${open.base}/`, { headers: asked })).text()).toBe(INDEX);

  const without = await loadWebApp(webBuild());
  const locked = await tunnelled({ web: without });
  const answer = await fetch(`${locked.base}/`, { headers: { host: HOST, ...asked } });
  expect(await answer.text()).toBe(INDEX);
});

// ---- H3: the owner signs in --------------------------------------------------------------------------------

test("the owner signs in with the key and gets a session cookie that is never the key; the application then sees the owner", async () => {
  const { base, lines } = await tunnelled();
  // Nothing signed in: the application's own refusal, in its own shape, with the identities echoed.
  const refused = await operation(base, "book.setup", BOOK, {
    operationId: id(1),
    headers: BROWSER,
  });
  expect(refused.status).toBe(401);
  expect(refused.body).toMatchObject({
    version: APPLICATION_API_VERSION,
    bookId: "local-book",
    operationId: id(1),
    ok: false,
    error: { code: "authentication_required", retryable: false, details: [] },
  });
  // There is nothing to read at /session: the service answers for signing out only.
  expect((await fetch(`${base}/session`, { headers: BROWSER })).status).toBe(405);

  const answer = await signIn(base, OWNER_KEY);
  expect(answer.status).toBe(200);
  expect(answer.body).toEqual({ ok: true, signedIn: true });
  const cookie = answer.headers.get("set-cookie") ?? "";
  // The attributes are the contract: __Host- prefix, whole site, no Domain, HttpOnly, Secure, Strict.
  expect(cookie).toMatch(
    new RegExp(
      `^${SESSION_COOKIE}=[A-Za-z0-9_-]{43}; Path=/; Secure; HttpOnly; SameSite=Strict; Max-Age=604800$`,
    ),
  );
  expect(cookie).not.toContain("Domain");
  expect(cookie).not.toContain(OWNER_KEY);
  expect(answer.headers.get("cache-control")).toBe("no-store");
  expect(JSON.stringify(answer.body)).not.toContain(OWNER_KEY);

  const jar = cookieOf(answer);
  const as = { ...BROWSER, cookie: jar };
  // The application sees the owner, and its book works: a write and a read.
  const setup = await operation(base, "book.setup", BOOK, { operationId: id(1), headers: as });
  expect(setup.status).toBe(200);
  const book = await operation(base, "book.get", {}, { headers: as });
  expect(book.body.data).toMatchObject({
    principal: { kind: "owner" },
    ownerAccess: "key",
    setup: { name: "Hosted Co" },
  });
  const created = await operation(
    base,
    "drafts.create",
    {
      data: {
        date: "2026-03-02",
        reference: "cookie",
        narration: "cookie",
        lines: [
          { accountId: "6100", debit: "5.00", credit: "" },
          { accountId: "1010", debit: "", credit: "5.00" },
        ],
      },
    },
    { operationId: id(2), headers: as },
  );
  expect(created.status).toBe(200);
  const drafts = await operation(base, "drafts.list", {}, { headers: as });
  expect(
    drafts.body.data.drafts.map((draft: { data: { reference: string } }) => draft.data.reference),
  ).toEqual(["cookie"]);
  // The browser's older routes take the session too.
  expect((await fetch(`${base}/api/book`, { headers: as })).status).toBe(200);
  expect((await fetch(`${base}/api/book`, { headers: BROWSER })).status).toBe(401);

  // Nothing said about a key: not in a line of the log, not in an answer.
  const wrong = await signIn(base, issueOwnerKey());
  expect(wrong.status).toBe(401);
  expect(wrong.body).toEqual({
    ok: false,
    error: { code: "invalid_key", message: "That key was not accepted.", retryable: false },
  });
  expect(wrong.headers.get("set-cookie")).toBeNull();
  expect(lines.length).toBeGreaterThan(0);
  expect(lines.join("\n")).not.toContain(OWNER_KEY);
  expect(lines.join("\n")).not.toContain(jar.split("=")[1] ?? "?");
});

test("signing in takes the key in a JSON body and nowhere else, and only from the service's own page", async () => {
  // (Every refusal below is an attempt, and the limit on attempts has its own test.)
  const { base } = await tunnelled({ sessions: { attempts: 1000 } });
  const bad = async (answer: Promise<Reply>, status: number) => {
    const done = await answer;
    expect(done.status).toBe(status);
    expect(done.headers.get("set-cookie")).toBeNull();
    expect(JSON.stringify(done.body)).not.toContain(OWNER_KEY);
  };
  // A key in the address is not read, and the request is refused for having it.
  await bad(
    fetch(`${base}/session/owner?key=${OWNER_KEY}`, {
      method: "POST",
      headers: { "content-type": "application/json", ...BROWSER },
      body: JSON.stringify({ key: OWNER_KEY }),
    }).then(reply),
    400,
  );
  await bad(
    fetch(`${base}/session/owner/${OWNER_KEY}`, { method: "POST", headers: BROWSER }).then(reply),
    404,
  );
  // Not JSON, not an object with the key alone, not a string, too large.
  await bad(signIn(base, OWNER_KEY, { ...BROWSER, "content-type": "text/plain" }), 415);
  await bad(signIn(base, OWNER_KEY, BROWSER, "not json"), 400);
  await bad(signIn(base, OWNER_KEY, BROWSER, JSON.stringify([OWNER_KEY])), 400);
  await bad(signIn(base, OWNER_KEY, BROWSER, JSON.stringify({ key: OWNER_KEY, extra: 1 })), 400);
  await bad(signIn(base, OWNER_KEY, BROWSER, JSON.stringify({ key: 7 })), 400);
  await bad(signIn(base, OWNER_KEY, BROWSER, JSON.stringify({ key: "" })), 400);
  await bad(signIn(base, OWNER_KEY, BROWSER, JSON.stringify({ key: "x".repeat(5000) })), 413);
  // The wrong method.
  await bad(fetch(`${base}/session/owner`, { headers: BROWSER }).then(reply), 405);
  // Another website, a sibling subdomain, or a request that does not say where it came from.
  await bad(signIn(base, OWNER_KEY, { host: HOST, origin: "https://evil.example" }), 403);
  await bad(signIn(base, OWNER_KEY, { ...BROWSER, "sec-fetch-site": "cross-site" }), 403);
  await bad(signIn(base, OWNER_KEY, { ...BROWSER, "sec-fetch-site": "same-site" }), 403);
  await bad(signIn(base, OWNER_KEY, { host: HOST }), 403);
  // And with all of it right, in.
  expect((await signIn(base, OWNER_KEY)).status).toBe(200);
  expect((await signIn(base, OWNER_KEY, { host: HOST, origin: PUBLIC })).status).toBe(200);
});

test("a few attempts a minute for each client, counted by the address Cloudflare saw or else the connection's", async () => {
  let now = 1_000_000;
  const { base, lines } = await tunnelled({ sessions: { now: () => now } });
  const attempt = (headers: Record<string, string> = {}, key = issueOwnerKey()) =>
    signIn(base, key, { ...BROWSER, ...headers });
  const outcomes = async (headers: Record<string, string>, times: number) => {
    const statuses: number[] = [];
    for (let n = 0; n < times; n += 1) statuses.push((await attempt(headers)).status);
    return statuses;
  };
  // Five wrong keys are answered as wrong keys; the sixth is not even looked at.
  expect(await outcomes({ "cf-connecting-ip": "203.0.113.7" }, 7)).toEqual([
    401, 401, 401, 401, 401, 429, 429,
  ]);
  const limited = await attempt({ "cf-connecting-ip": "203.0.113.7" }, OWNER_KEY);
  // Even the right key waits its turn, and is told how long.
  expect(limited.status).toBe(429);
  expect(limited.headers.get("retry-after")).toMatch(/^\d+$/);
  expect(Number(limited.headers.get("retry-after"))).toBeGreaterThan(0);
  expect(Number(limited.headers.get("retry-after"))).toBeLessThanOrEqual(60);
  expect(limited.body.error).toMatchObject({ code: "too_many_attempts", retryable: true });
  // Another client has a count of its own.
  expect((await attempt({ "cf-connecting-ip": "203.0.113.8" })).status).toBe(401);
  expect((await attempt({ "cf-connecting-ip": "2001:db8::1" })).status).toBe(401);
  // A header that is not an address is not believed: those requests are the connection's (127.0.0.1) and share one count.
  expect(await outcomes({ "cf-connecting-ip": "not-an-address" }, 6)).toEqual([
    401, 401, 401, 401, 401, 429,
  ]);
  expect(await outcomes({}, 2)).toEqual([429, 429]);
  // A minute later the count starts again, and the right key gets in.
  now += 61_000;
  expect((await attempt({ "cf-connecting-ip": "203.0.113.7" }, OWNER_KEY)).status).toBe(200);
  // The log says that a client was limited, once, and nothing about a key.
  expect(lines.filter((line) => line.includes("limited for 203.0.113.7"))).toHaveLength(1);
  expect(lines.join("\n")).not.toContain(OWNER_KEY);
});

test("signing out forgets the session, a session ends after a day of no use or a week, and a new sign-in replaces the old one", async () => {
  let now = 5_000_000;
  const { base } = await tunnelled({
    sessions: { now: () => now, idleMs: 60_000, lifetimeMs: 300_000, attempts: 100 },
  });
  const using = async (jar: string) =>
    (await operation(base, "book.get", {}, { headers: { ...BROWSER, cookie: jar } })).status;

  const jar = await signedIn(base);
  expect(await using(jar)).toBe(200);
  const out = await fetch(`${base}/session`, {
    method: "DELETE",
    headers: { ...BROWSER, cookie: jar },
  }).then(reply);
  expect(out.status).toBe(200);
  expect(out.headers.get("set-cookie")).toMatch(
    new RegExp(`^${SESSION_COOKIE}=; Path=/; Secure; HttpOnly; SameSite=Strict; Max-Age=0$`),
  );
  // The cookie a browser forgot may still be somewhere: it opens nothing.
  expect(await using(jar)).toBe(401);
  // Signing out from another site is not signing out.
  const second = await signedIn(base);
  const forged = await fetch(`${base}/session`, {
    method: "DELETE",
    headers: { host: HOST, origin: "https://evil.example", cookie: second },
  }).then(reply);
  expect(forged.status).toBe(403);
  expect(await using(second)).toBe(200);

  // Idle: each use keeps the session alive, a pause that is long enough ends it.
  now += 50_000;
  expect(await using(second)).toBe(200);
  now += 50_000;
  expect(await using(second)).toBe(200);
  now += 61_000;
  expect(await using(second)).toBe(401);
  // Lifetime: use does not keep a session past the longest it may live.
  const third = await signedIn(base);
  for (let step = 0; step < 6; step += 1) {
    now += 51_000;
    expect(await using(third)).toBe(step < 5 ? 200 : 401);
  }
  // Signing in again from a browser that has a session ends that one.
  const fourth = await signedIn(base);
  const replaced = await signIn(base, OWNER_KEY, { ...BROWSER, cookie: fourth });
  expect(replaced.status).toBe(200);
  expect(await using(fourth)).toBe(401);
  expect(await using(cookieOf(replaced))).toBe(200);
});

test("the key and an agent token still work as a bearer, a bearer is never upgraded by a cookie, and a cookie never reaches the application", async () => {
  const { base } = await tunnelled();
  const jar = await signedIn(base);
  const bearer = (token: string, extra: Record<string, string> = {}) => ({
    authorization: `Bearer ${token}`,
    ...extra,
  });
  // The command line: no cookie, no Origin, the key as a bearer.
  expect(
    (await operation(base, "book.get", {}, { headers: { host: HOST, ...bearer(OWNER_KEY) } }))
      .status,
  ).toBe(200);
  // A token the owner made is held to what it was given.
  await operation(base, "book.setup", BOOK, {
    operationId: id(1),
    headers: { host: HOST, ...bearer(OWNER_KEY) },
  });
  const made = await operation(
    base,
    "tokens.create",
    { label: "reader", permissions: ["read"] },
    {
      operationId: id(2),
      headers: { host: HOST, ...bearer(OWNER_KEY) },
    },
  );
  expect(made.status).toBe(200);
  const token = made.body.data.secret as string;
  const asToken = await operation(
    base,
    "book.get",
    {},
    { headers: { host: HOST, ...bearer(token) } },
  );
  expect(asToken.body.data.principal.kind).toBe("token");
  // A refused bearer is refused, whatever cookie comes with it: it does not fall back to the session.
  const refused = await operation(
    base,
    "book.get",
    {},
    {
      headers: { ...BROWSER, cookie: jar, ...bearer(issueOwnerKey()) },
    },
  );
  expect(refused.status).toBe(401);
  expect(refused.body.error.code).toBe("token_invalid");
  // A token presented with a cookie stays a token.
  const kept = await operation(
    base,
    "book.get",
    {},
    {
      headers: { ...BROWSER, cookie: jar, ...bearer(token) },
    },
  );
  expect(kept.body.data.principal.kind).toBe("token");
  // Without a credential the application is never asked, even for what it would have answered.
  expect((await operation(base, "schema", {}, { headers: { host: HOST } })).status).toBe(401);
  expect((await fetch(`${base}/v1/schema`, { headers: { host: HOST } })).status).toBe(401);
  expect(
    (await fetch(`${base}/v1/schema`, { headers: { host: HOST, ...bearer(OWNER_KEY) } })).status,
  ).toBe(200);
});

test("a stranger is told only what the page may offer: the book, the stores, how many are open and the telemetry are for the owner's key, and a wrong key is a stranger", async () => {
  const { base } = await tunnelled({ agentTokens: false });
  const read = async (headers: Record<string, string>) =>
    (await reply(await fetch(`${base}/health`, { headers: { host: HOST, ...headers } }))).body;
  const stranger = await read({});
  expect(stranger).toEqual({ ok: true, hosted: { backups: false, agents: false } });
  for (const wrong of [
    `Bearer ${OWNER_KEY.slice(0, -1)}x`,
    `Bearer rst_0123456789abcdef_${"A".repeat(43)}`,
    "Bearer",
    "Basic abc",
  ])
    expect(await read({ authorization: wrong })).toEqual(stranger);
  // Nothing of what the operator sees is in what a stranger sees.
  const text = JSON.stringify(stranger);
  for (const hidden of ["book", "tail", "bulk", "role", "open", "books", "telemetry"])
    expect(text, hidden).not.toContain(`"${hidden}"`);
  // The owner's key sees the book and the stores, as before.
  const owner = await read({ authorization: `Bearer ${OWNER_KEY}` });
  expect(owner.ok).toBe(true);
  expect(owner.hosted).toMatchObject({
    book: "book-1",
    open: false,
    role: "idle",
    backups: false,
    agents: false,
  });
  expect(owner.hosted.tail).toBeDefined();
});

test("with agent tokens off, only the owner key as a bearer reaches the book: made-up credentials never take the lease back", async () => {
  const { base, tail } = await tunnelled({ agentTokens: false });
  const open = async (): Promise<boolean> =>
    (
      await reply(
        await fetch(`${base}/health`, {
          headers: { host: HOST, authorization: `Bearer ${OWNER_KEY}` },
        }),
      )
    ).body.hosted.open;
  const as = (credential: string) => ({ host: HOST, authorization: `Bearer ${credential}` });
  const madeUp = `rst_0123456789abcdef_${"A".repeat(43)}`;
  // The page is told that no agent has access here, so that it offers none; a pod that takes agent tokens says nothing.
  const health = (await reply(await fetch(`${base}/health`, { headers: { host: HOST } }))).body;
  expect(health.hosted.agents).toBe(false);
  const taking = await tunnelled();
  expect(
    (await reply(await fetch(`${taking.base}/health`, { headers: { host: HOST } }))).body.hosted
      .agents,
  ).toBeUndefined();
  // Nothing has asked the book for anything: it is not open and the tail has granted and renewed nothing.
  expect(await open()).toBe(false);
  expect(tail.records).toEqual([]);
  // A well-formed token nobody made, a key that is not the owner's, text that is neither, a very long one.
  for (const credential of [madeUp, issueOwnerKey(), "garbage", "x".repeat(5000)]) {
    for (const name of ["book.get", "journal.list"]) {
      const refused = await operation(base, name, {}, { headers: as(credential) });
      expect(refused.status, `${name} ${credential.slice(0, 8)}`).toBe(401);
      expect(refused.body.error.code).toBe("token_invalid");
    }
  }
  expect((await fetch(`${base}/api/book`, { headers: as(madeUp) })).status).toBe(401);
  // A token is told why, and a refused upload is read no further than a request with no credentials is.
  const told = await operation(base, "book.get", {}, { headers: as(madeUp) });
  expect(told.body.error.message).toContain("owner key, not an agent token");
  const upload = await fetch(`${base}/v1/uploads`, {
    method: "POST",
    headers: { ...as(madeUp), "content-type": "application/octet-stream" },
    body: new Uint8Array(200_000),
  });
  expect(upload.status).toBe(401);
  // After all of that the book was never asked.
  expect(await open()).toBe(false);
  expect(tail.records).toEqual([]);
  // The owner key opens the door, and that is what wakes the book.
  const owner = await operation(base, "book.get", {}, { headers: as(OWNER_KEY) });
  expect(owner.status).toBe(200);
  expect(await open()).toBe(true);
  expect(tail.records.some((record) => record.op === "grant")).toBe(true);
  // A browser's session is the owner's, so it works too.
  const jar = await signedIn(base);
  const session = await operation(base, "book.get", {}, { headers: { ...BROWSER, cookie: jar } });
  expect(session.status).toBe(200);
  // And a token the owner really made is refused, with the reason, now that the book is open.
  await operation(base, "book.setup", BOOK, { operationId: id(1), headers: as(OWNER_KEY) });
  const made = await operation(
    base,
    "tokens.create",
    { label: "reader", permissions: ["read"] },
    { operationId: id(2), headers: as(OWNER_KEY) },
  );
  expect(made.status).toBe(200);
  const real = await operation(base, "book.get", {}, { headers: as(made.body.data.secret) });
  expect(real.status).toBe(401);
  expect(real.body.error.message).toContain("owner key, not an agent token");
});

test("a session is not enough for a request another site could have made", async () => {
  const { base } = await tunnelled();
  const jar = await signedIn(base);
  const post = (headers: Record<string, string>) =>
    operation(base, "book.get", {}, { headers: { host: HOST, cookie: jar, ...headers } });
  // The page's own request.
  expect((await post({ origin: PUBLIC, "sec-fetch-site": "same-origin" })).status).toBe(200);
  expect((await post({ origin: PUBLIC })).status).toBe(200);
  expect((await post({ "sec-fetch-site": "same-origin" })).status).toBe(200);
  // From another website, or a sibling subdomain, or a page that does not say where it came from.
  const crossSite = await post({ origin: PUBLIC, "sec-fetch-site": "cross-site" });
  expect(crossSite.status).toBe(403);
  expect(crossSite.body.error.code).toBe("origin_denied");
  expect((await post({ origin: PUBLIC, "sec-fetch-site": "same-site" })).status).toBe(403);
  expect((await post({})).status).toBe(403);
  expect((await post({ origin: "https://evil.example" })).status).toBe(403);
  // Reading by address, as a person does, is theirs.
  const read = (headers: Record<string, string>) =>
    fetch(`${base}/api/book`, { headers: { host: HOST, cookie: jar, ...headers } }).then(
      (r) => r.status,
    );
  expect(await read({})).toBe(200);
  expect(await read({ "sec-fetch-site": "none" })).toBe(200);
  expect(await read({ "sec-fetch-site": "cross-site" })).toBe(403);
});

test("a server with no owner key has no sign-in, and one that asks for no sessions has none", async () => {
  const open = await start();
  expect((await signIn(open.base, OWNER_KEY, { host: `127.0.0.1:${open.port}` })).status).toBe(404);
  expect((await operation(open.base, "book.get")).status).toBe(200);
  const without = await tunnelled({ sessions: false });
  expect((await signIn(without.base, OWNER_KEY)).status).toBe(404);
  // The key as a bearer is all there is.
  expect(
    (
      await operation(
        without.base,
        "book.get",
        {},
        { headers: { host: HOST, authorization: `Bearer ${OWNER_KEY}` } },
      )
    ).status,
  ).toBe(200);
});

test("a body is held only as far as the application takes it, and not at all for a caller with nothing to show", async () => {
  const { base } = await tunnelled();
  const big = "x".repeat(200_000);
  const send = (headers: Record<string, string>, body: string) =>
    fetch(`${base}/v1/drafts.create`, {
      method: "POST",
      headers: { "content-type": "application/json", host: HOST, ...headers },
      body,
    }).then(reply);
  // Signed in or not, a JSON request over 128 KiB is the application's 413.
  const jar = await signedIn(base);
  const large = await send({ ...BROWSER, cookie: jar }, JSON.stringify({ input: big }));
  expect(large.status).toBe(413);
  expect(large.body.error.code).toBe("request_too_large");
  // Without a credential a large body is not read, and the answer is the sign-in one.
  const anonymous = await send({}, JSON.stringify({ input: big }));
  expect(anonymous.status).toBe(401);
  // The browser's older routes keep their plain 413.
  const legacy = await fetch(`${base}/api/book/setup`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      host: HOST,
      authorization: `Bearer ${OWNER_KEY}`,
    },
    body: big,
  }).then(reply);
  expect(legacy.status).toBe(413);
});

// ---- H4: the probes ------------------------------------------------------------------------------------------

test("/live and /ready answer on any Host with no session, and depend on neither the lease nor the tail", async () => {
  // A tail that nobody answers for: a book that cannot be opened. The server can still serve.
  const dead = await Bun.serve({
    port: 0,
    hostname: "127.0.0.1",
    fetch: () =>
      new Response("<html>1027</html>", { status: 429, headers: { "content-type": "text/html" } }),
  });
  cleanup.push(() => dead.stop(true));
  const config = parseBookStore("r2log://book-1", {
    RASTRATA_BOOK_BULK: pathToFileURL(join(folder(), "bucket")).href,
    RASTRATA_BOOK_TAIL: `http://127.0.0.1:${dead.port}`,
    RASTRATA_BOOK_TAIL_TOKEN: "a-token-for-the-test",
    RASTRATA_BOOK_CACHE: join(folder(), "cache"),
  });
  const server = await startHostedApplicationServer({
    config,
    port: 0,
    telemetry: false,
    env: { RASTRATA_BOOK_TAIL_TOKEN: "a-token-for-the-test" },
    ownerKey: OWNER_KEY,
    serving: { bind: "0.0.0.0", allowedHosts: [HOST], publicOrigin: PUBLIC },
    web: null,
  });
  cleanup.push(() => server.stop());
  const base = `http://127.0.0.1:${server.server.port}`;

  // What a kubelet sends: the pod's own address as Host, no cookie, no Origin.
  for (const host of ["10.42.1.7:8080", HOST, "evil.example"])
    for (const path of ["/live", "/ready"]) {
      const answer = await fetch(`${base}${path}`, { headers: { host } }).then(reply);
      expect(answer.status, `${path} as ${host}`).toBe(200);
      expect(answer.body.ok).toBe(true);
      expect(answer.headers.get("cache-control")).toBe("no-store");
    }
  expect(
    (await fetch(`${base}/ready`, { method: "HEAD", headers: { host: "10.42.1.7" } })).status,
  ).toBe(200);
  expect((await fetch(`${base}/ready`, { method: "POST", headers: { host: HOST } })).status).toBe(
    404,
  );
  // The book was never opened and the tail is down; a person is told once, in words, that the service is at its limit.
  const jar = await signedIn(base);
  const codes: string[] = [];
  for (let n = 0; n < 8; n += 1) {
    const book = await operation(base, "book.get", {}, { headers: { ...BROWSER, cookie: jar } });
    expect(book.status).toBe(503);
    expect(book.body.version).toBe(APPLICATION_API_VERSION);
    expect(book.body.error.retryable).toBe(true);
    expect(book.headers.get("retry-after")).toMatch(/^\d+$/);
    codes.push(book.body.error.code);
  }
  // A few calls find the tail down; then the breaker stands in front of it and the person reads one message.
  expect(codes.slice(-3)).toEqual(["service_limit", "service_limit", "service_limit"]);
  const last = await operation(base, "book.get", {}, { headers: { ...BROWSER, cookie: jar } });
  expect(last.body.error.message).toBe("Service limit reached, try again later.");
  // And through all of it the probes say it can serve; /health is as it was.
  expect((await fetch(`${base}/ready`, { headers: { host: "10.42.1.7:8080" } })).status).toBe(200);
  const health = await fetch(`${base}/health`, {
    headers: { host: HOST, authorization: `Bearer ${OWNER_KEY}` },
  }).then(reply);
  expect(health.status).toBe(200);
  expect(health.body.hosted).toEqual({
    book: "book-1",
    open: false,
    role: "idle",
    bulk: "file",
    tail: "do",
    backups: false,
    // What this pod has handed on to another pod of the service, told to the owner's key only.
    peers: { forwarded: 0, unreachable: 0, refused: 0, unanswered: 0, lastFailure: null },
  });
  expect(server.role).toBe("idle");
});

test("the probes and the page are not counted in the book: asking for them never opens it", async () => {
  const web = await loadWebApp(webBuild());
  const { base, server } = await tunnelled({ web });
  await fetch(`${base}/live`);
  await fetch(`${base}/ready`);
  await fetch(`${base}/`, { headers: { host: HOST, accept: "text/html" } });
  await fetch(`${base}/health`, { headers: { host: HOST } });
  expect(server.book).toBeNull();
  expect(server.role).toBe("idle");
});

test("the replay mode of the manifest reaches the application: a trusted server applies what the log holds and never executes it again, a full one applies it and executes it again behind its first answer", async () => {
  const root = folder();
  const tail = new MemoryLogTier();
  const bearer = { host: HOST, authorization: `Bearer ${OWNER_KEY}` };
  const options = { ownerKey: OWNER_KEY, bulkRoot: root, stores: { tail }, web: null } as const;
  const serving = { bind: "0.0.0.0", allowedHosts: [HOST], publicOrigin: PUBLIC };
  const first = await start({ ...options, serving });
  await operation(first.base, "book.setup", BOOK, { operationId: id(1), headers: bearer });
  for (let n = 0; n < 3; n += 1) {
    const posted = await operation(
      first.base,
      "journal.post",
      {
        data: {
          date: "2026-03-02",
          reference: `r${n}`,
          narration: `r${n}`,
          lines: [
            { accountId: "6100", debit: "5.00", credit: "" },
            { accountId: "1010", debit: "", credit: "5.00" },
          ],
        },
      },
      { operationId: id(10 + n), headers: bearer },
    );
    expect(posted.status).toBe(200);
  }
  await first.server.stop();

  // What a read of the book did, as the service counts it: a process that knows nothing reads the log.
  const read = async (replay: "full" | "trusted") => {
    const second = await start({ ...options, serving, replay, bulkRoot: root, stores: { tail } });
    const listed = await operation(
      second.base,
      "journal.list",
      { status: "Posted" },
      { headers: bearer },
    );
    expect(listed.body.data.count).toBe(3);
    const application = second.server.book?.application as unknown as
      | {
          service: {
            readStats: { verified: number; trusted: number; fallbacks: number };
            verification(): Promise<void> | null;
          };
        }
      | undefined;
    if (!application) throw new Error("the book is not open");
    // What the read was answered from, before anything behind it has run.
    const answered = { ...application.service.readStats };
    // And what has been done once the check that runs behind the answer (a `full` server's) has ended.
    await application.service.verification();
    const checked = { ...application.service.readStats };
    await second.server.stop();
    return { answered, checked };
  };
  // The setup and the three entries are four outcomes. A `full` server answers from the stored revisions and executes each outcome again behind the answer,
  // a write waiting for that; a `trusted` one applies each as stored and never executes it again.
  const full = await read("full");
  // (How much of the check has run by the time the read is looked at depends on the book's size; for four outcomes it may be all of it.)
  expect(full.answered).toMatchObject({ trusted: 4, fallbacks: 0 });
  expect(full.checked).toMatchObject({ verified: 4, trusted: 4, fallbacks: 0 });
  const trusted = await read("trusted");
  expect(trusted.checked).toMatchObject({ verified: 0, trusted: 4, fallbacks: 0 });
});

// ---- member tokens and the control plane's key ---------------------------------------------------------------

/** The control plane's tokens as the front door sees them: a verifier that knows the tokens it was told of (the checking of a real signed
 * token is the application package's test, and the control Worker's). Tokens have the shape of one: three parts of base64url. */
function members() {
  const known = new Map<string, MemberTokenVerdict>();
  let counter = 0;
  const verifier: MemberTokenVerifier = {
    verify: async (token) => known.get(token) ?? { kind: "refused" },
  };
  const issue = (verdict: MemberTokenVerdict): string => {
    const token = `aaaaaaaaaa${String(++counter).padStart(4, "0")}.bbbbbbbbbbbb.cccccccccccc`;
    known.set(token, verdict);
    return token;
  };
  const forUser = (userId: string, bookId = "book-1"): string =>
    issue({ kind: "valid", claims: { sub: userId, wid: "wsp_0000000001", bid: bookId } });
  return { verifier, issue, forUser };
}

const USER = (n: number): string => `user_${String(n).padStart(10, "0")}`;

async function withMembers(extra: Partial<HostedServerOptions> = {}) {
  const tokens = members();
  const serviceKey = issueServiceKey();
  const serviceDigest = await sha256Hex(serviceKey);
  const started = await tunnelled({
    agentTokens: false,
    memberTokens: { origin: PUBLIC, verifier: tokens.verifier },
    serviceKeys: [serviceDigest],
    ...extra,
  });
  const as = (credential: string, more: Record<string, string> = {}) => ({
    host: HOST,
    authorization: `Bearer ${credential}`,
    ...more,
  });
  const open = async (): Promise<boolean> =>
    (
      await reply(
        await fetch(`${started.base}/health`, {
          headers: { host: HOST, authorization: `Bearer ${OWNER_KEY}` },
        }),
      )
    ).body.hosted.open;
  let n = 100;
  const call = (credential: string, name: string, input: unknown = {}, writes = false) =>
    operation(started.base, name, input, {
      headers: as(credential),
      ...(writes ? { operationId: id(++n) } : {}),
    });
  return { ...started, ...tokens, serviceKey, serviceDigest, as, open, call };
}

test("a signed token that cannot be checked costs the book nothing: made-up, for another book, or with its keys out of reach", async () => {
  const world = await withMembers();
  expect(await world.open()).toBe(false);
  // A token nobody signed, and a good one for another book: refused before the book is asked, in words.
  const madeUp = await world.call("aaaaaaaaaa9999.bbbbbbbbbbbb.cccccccccccc", "book.get");
  expect(madeUp.status).toBe(401);
  expect(madeUp.body.error.code).toBe("token_invalid");
  const other = await world.call(world.forUser(USER(1), "another-book"), "book.get");
  expect(other.status).toBe(403);
  expect(other.body.error.code).toBe("book_scope_mismatch");
  // The control plane's keys out of reach: nothing is known of the token, so the answer is to try again, not that it is bad.
  const unreachable = world.issue({ kind: "unavailable" });
  const unavailable = await world.call(unreachable, "book.get");
  expect(unavailable.status).toBe(503);
  expect(unavailable.body.error).toMatchObject({ code: "sign_in_unavailable", retryable: true });
  // Not the book, not the tail, not even for an upload or the browser's older routes.
  const upload = await fetch(`${world.base}/v1/uploads`, {
    method: "POST",
    headers: {
      ...world.as("aaaaaaaaaa9999.bbbbbbbbbbbb.cccccccccccc"),
      "content-type": "application/octet-stream",
    },
    body: new Uint8Array(200_000),
  });
  expect(upload.status).toBe(401);
  expect(
    (
      await fetch(`${world.base}/api/book`, {
        headers: world.as(world.forUser(USER(1), "another-book")),
      })
    ).status,
  ).toBe(403);
  expect(await world.open()).toBe(false);
  expect(world.tail.records).toEqual([]);
});

test("a person is in the book as the book's member table says, and a removal takes effect at the next request with the same token", async () => {
  const world = await withMembers();
  expect((await world.call(OWNER_KEY, "book.setup", BOOK, true)).status).toBe(200);
  const token = world.forUser(USER(2));
  // A good token for a person the book does not know: told so, and nothing opened for them to read.
  const stranger = await world.call(token, "book.get");
  expect(stranger.status).toBe(403);
  expect(stranger.body.error.code).toBe("not_a_member");
  // The control plane, with its own key, puts them in as an accountant.
  const added = await world.call(
    world.serviceKey,
    "members.add",
    { userId: USER(2), email: "Bo@Example.com", role: "accountant" },
    true,
  );
  expect(added.status).toBe(200);
  expect(added.body.data).toMatchObject({
    userId: USER(2),
    email: "bo@example.com",
    role: "accountant",
  });

  const context = await world.call(token, "book.get");
  expect(context.status).toBe(200);
  expect(context.body.data.member).toEqual({ userId: USER(2), role: "accountant" });
  expect(context.body.data.principal).toBeUndefined();
  expect(context.body.data.permissions).toEqual(["read", "draft", "post", "correct", "close"]);
  // What an accountant may do: read, and not change the chart or who is in the book.
  expect((await world.call(token, "accounts.list")).status).toBe(200);
  const chart = await world.call(
    token,
    "accounts.prepareCreate",
    { code: "5000", name: "Supplies", role: "expense", effectiveOn: "2026-03-01" },
    true,
  );
  expect(chart.status).toBe(403);
  expect(chart.body.error.code).toBe("permission_denied");
  const people = await world.call(
    token,
    "members.add",
    { userId: USER(3), email: "c@example.com", role: "owner" },
    true,
  );
  expect(people.status).toBe(403);
  expect(
    (await world.call(token, "members.list")).body.data.members.map(
      (m: { userId: string }) => m.userId,
    ),
  ).toEqual([USER(2)]);
  // The browser's older routes have no roles and are the owner's.
  const legacy = await fetch(`${world.base}/api/book`, { headers: world.as(token) });
  expect(legacy.status).toBe(403);
  expect(((await legacy.json()) as { code: string }).code).toBe("scope_denied");

  // Taken out, the same token opens nothing at the next request.
  expect(
    (await world.call(world.serviceKey, "members.remove", { userId: USER(2) }, true)).body.data
      .removed,
  ).toBe(true);
  const gone = await world.call(token, "accounts.list");
  expect(gone.status).toBe(403);
  expect(gone.body.error.code).toBe("not_a_member");
});

test("the control plane's key changes who is in the book and can do nothing else, and a key that is not one of its keys is refused before the book", async () => {
  const world = await withMembers();
  expect((await world.call(OWNER_KEY, "book.setup", BOOK, true)).status).toBe(200);
  const first = await world.call(
    world.serviceKey,
    "members.add",
    { userId: USER(1), email: "a@example.com", role: "owner" },
    true,
  );
  expect(first.status).toBe(200);
  // It can read who is in the book and not the book: no entries, accounts or tokens, and no way to make one that could.
  expect((await world.call(world.serviceKey, "members.list")).status).toBe(200);
  for (const [name, input, writes] of [
    ["journal.list", {}, false],
    ["accounts.list", {}, false],
    ["book.get", {}, false],
    ["tokens.list", {}, false],
    ["tokens.create", { label: "x", permissions: ["read"] }, true],
  ] as const) {
    const refused = await world.call(world.serviceKey, name, input, writes);
    expect(refused.status, name).toBe(403);
    expect(refused.body.error.code, name).toBe("permission_denied");
  }
  expect(
    (await fetch(`${world.base}/api/book`, { headers: world.as(world.serviceKey) })).status,
  ).toBe(403);

  // A key that is shaped like one and is not one of the control plane's is refused with the book unasked.
  const fresh = await withMembers();
  const wrong = await fresh.call(
    issueServiceKey(),
    "members.add",
    { userId: USER(1), email: "a@example.com", role: "owner" },
    true,
  );
  expect(wrong.status).toBe(401);
  expect(wrong.body.error.code).toBe("token_invalid");
  expect(await fresh.open()).toBe(false);
  expect(fresh.tail.records).toEqual([]);
});

test("two keys are accepted while the control plane's key is rotated, and the service has no key at all unless it is given digests", async () => {
  const oldKey = issueServiceKey();
  const newKey = issueServiceKey();
  const world = await withMembers({
    serviceKeys: [await sha256Hex(oldKey), await sha256Hex(newKey)],
  });
  for (const key of [oldKey, newKey]) {
    const answer = await world.call(
      key,
      "members.add",
      { userId: USER(1), email: "a@example.com", role: "owner" },
      true,
    );
    expect(answer.status).toBe(200);
  }
  const without = await tunnelled({ agentTokens: false });
  const refused = await operation(
    without.base,
    "members.add",
    { userId: USER(1), email: "a@example.com", role: "owner" },
    {
      operationId: id(300),
      headers: { host: HOST, authorization: `Bearer ${oldKey}` },
    },
  );
  expect(refused.status).toBe(401);
  expect(without.tail.records).toEqual([]);
});

test("nobody but the process can say who is calling: the header that does it is dropped from whatever a caller sends", async () => {
  const world = await withMembers();
  expect((await world.call(OWNER_KEY, "book.setup", BOOK, true)).status).toBe(200);
  await world.call(
    world.serviceKey,
    "members.add",
    { userId: USER(1), email: "a@example.com", role: "owner" },
    true,
  );
  // The owner with a forged header is the owner, not the person it names.
  const forged = await operation(
    world.base,
    "book.get",
    {},
    {
      headers: world.as(OWNER_KEY, { "x-rastrata-principal": "guess.member.user_0000000001" }),
    },
  );
  expect(forged.status).toBe(200);
  expect(forged.body.data.principal).toEqual({ kind: "owner" });
  expect(forged.body.data.member).toBeUndefined();
  // With no credentials at all it is still no credentials.
  const bare = await operation(
    world.base,
    "book.get",
    {},
    {
      headers: { host: HOST, "x-rastrata-principal": "guess.service.control" },
    },
  );
  expect(bare.status).toBe(401);
  // A member's own token, with a header that names someone else, is the member.
  const mine = world.forUser(USER(1));
  const named = await operation(
    world.base,
    "book.get",
    {},
    {
      headers: world.as(mine, { "x-rastrata-principal": "guess.service.control" }),
    },
  );
  expect(named.status).toBe(200);
  expect(named.body.data.member).toEqual({ userId: USER(1), role: "owner" });
});

test("a service that is not locked ignores member tokens and the control plane's key, and one that is locked still refuses agent tokens", async () => {
  const world = await withMembers();
  expect((await world.call(OWNER_KEY, "book.setup", BOOK, true)).status).toBe(200);
  const created = await world.call(
    OWNER_KEY,
    "tokens.create",
    { label: "bot", permissions: ["read"] },
    true,
  );
  expect(created.status).toBe(200);
  // An agent token is refused at the door, and the member verifier was not asked about it.
  const told = await world.call(created.body.data.secret as string, "book.get");
  expect(told.status).toBe(401);
  expect(told.body.error.message).toContain("owner key, not an agent token");
  // The owner key and a browser session are as they were.
  expect((await world.call(OWNER_KEY, "book.get")).body.data.principal).toEqual({ kind: "owner" });
  const jar = await signedIn(world.base);
  expect(
    (await operation(world.base, "book.get", {}, { headers: { ...BROWSER, cookie: jar } })).status,
  ).toBe(200);
});
