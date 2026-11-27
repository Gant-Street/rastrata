import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { expect, test } from "@playwright/test";

// The installed service is the web app and the API in one process, with a strict content policy and a
// key it attaches itself. This starts the real compiled service (apps/api/tooling/build-service.ts) in
// a home of its own, and drives its web app in each browser: every screen loads without breaking the
// policy, the app's own requests are let in and a program with no key is not, and the page cannot be
// framed. A screen that starts to need something the policy forbids (an inline script, a font from
// elsewhere) fails here, not in a user's browser.

// Playwright runs with apps/web as the working directory.
const repository = resolve(process.cwd(), "../..");
let directory = "";
let child: ChildProcess | undefined;
let base = "";
let dataDirectory = "";

test.describe.configure({ mode: "serial" });

test.beforeAll(async () => {
  // Building the service (the web app, then the compiled program) takes a while on a busy machine.
  test.setTimeout(180_000);
  directory = mkdtempSync(join(tmpdir(), "rastrata-installed-spec-"));
  const binary = join(directory, "rastrata-service");
  const build = spawnSync(
    process.execPath,
    [join(repository, "apps/api/tooling/build-service.ts"), "--out", binary],
    { encoding: "utf8" },
  );
  if (build.status !== 0)
    throw new Error(`building the service failed:\n${build.stdout}${build.stderr}`);
  const home = join(directory, "home");
  mkdirSync(home);
  dataDirectory =
    process.platform === "darwin"
      ? join(home, "Library/Application Support/Rastrata")
      : join(home, ".local/share/rastrata");
  child = spawn(binary, [], {
    env: { PATH: process.env.PATH ?? "", HOME: home, RASTRATA_API_PORT: "0" },
    cwd: directory,
    stdio: ["ignore", "pipe", "pipe"],
  });
  let output = "";
  child.stdout?.on("data", (chunk) => {
    output += String(chunk);
  });
  const deadline = Date.now() + 30_000;
  while (!/is running at (http:\/\/127\.0\.0\.1:\d+)/.test(output)) {
    if (Date.now() > deadline || child.exitCode !== null)
      throw new Error(`the service did not start: ${output}`);
    await new Promise((done) => setTimeout(done, 50));
  }
  base = /is running at (http:\/\/127\.0\.0\.1:\d+)/.exec(output)?.[1] as string;
});

test.afterAll(async () => {
  if (child && child.exitCode === null) {
    child.kill("SIGTERM");
    await new Promise((done) => child?.once("exit", done));
  }
  if (directory) rmSync(directory, { recursive: true, force: true });
});

/** Everything the browser says is wrong with a page: console errors, uncaught errors and every
 * Content Security Policy violation (reported to the page by the browser itself). */
async function watch(page: import("@playwright/test").Page): Promise<string[]> {
  const problems: string[] = [];
  page.on("console", (message) => {
    // A request the service answers with an error status (a screen asking about a book that does not
    // exist yet) is the browser's own console line, not a broken page.
    if (message.type() === "error" && !/^Failed to load resource/.test(message.text()))
      problems.push(`console: ${message.text().slice(0, 200)}`);
  });
  page.on("pageerror", (error) => problems.push(`error: ${error.message.slice(0, 200)}`));
  await page.addInitScript(() => {
    document.addEventListener("securitypolicyviolation", (event) => {
      console.error(`policy: ${event.violatedDirective} blocked ${event.blockedURI}`);
    });
  });
  return problems;
}

// The routes the application has today, and the ones its lanes add; a route this build does not have
// shows the app's own "not found" page, which must also load cleanly. A route with an id in its address
// is opened with an id nobody has, which is what a stale bookmark is. Every route the application has
// must be here: `tests/unit/installed-routes.test.ts` fails when one is not.
const ROUTES = [
  "/",
  "/journal",
  "/journal/new",
  "/journal/not-an-entry",
  "/accounts",
  "/periods",
  "/changes",
  "/reports",
  "/reports/payees",
  "/ledger",
  "/inbox",
  "/import",
  "/rules",
  "/rules/new",
  "/rules/not-a-rule",
  "/reconcile",
  "/reconcile/not-a-reconciliation",
  "/cutover",
  "/opening",
  // Settings: the hub (Business, Members, Connections, Bring in your books) and the pages that sit in it. (Members says it is not here: the installed service has no accounts.)
  "/settings",
  "/settings/members",
  "/settings/workspace",
  "/settings/connections",
  "/settings/bring-in",
  "/settings/history",
  "/settings/move",
  "/settings/backups",
  "/settings/agent",
  "/settings/plugins",
  "/settings/stripe",
  // Help: the list, a topic (read from the build's own files, under the content policy) and one that is not there.
  "/help",
  "/help/reconcile-an-account",
  "/help/not-a-topic",
  "/settings/bankfeed",
  "/settings/banks",
  "/settings/billing",
  // The shadow lane: the move from another system.
  "/xero",
  "/tie-out",
  "/gaps",
  // The tax lane: the Tax screen with its five tools.
  "/tax",
  "/not-a-page",
];

/** Opens every route and says which did not open as a screen: a bad status, the app's own error page
 * ("Unable to open this page"), or no main region. */
async function brokenScreens(page: import("@playwright/test").Page): Promise<string[]> {
  const failed: string[] = [];
  for (const route of ROUTES) {
    const response = await page.goto(`${base}${route}`);
    if (response?.status() !== 200) failed.push(`${route}: status ${response?.status()}`);
    await page.waitForLoadState("networkidle");
    if (await page.getByRole("alert").filter({ hasText: "Unable to open this page" }).count())
      failed.push(`${route}: the app could not open it`);
    else if (!(await page.locator("main").count())) failed.push(`${route}: no main region`);
  }
  return failed;
}

test("the watcher sees a policy violation, so a clean run above means something", async ({
  page,
}) => {
  const problems = await watch(page);
  await page.goto(`${base}/`);
  await page.evaluate(() => {
    const script = document.createElement("script");
    script.textContent = "window.injected = true";
    document.head.append(script);
  });
  await expect.poll(() => problems.join("\n")).toContain("policy:");
  expect(await page.evaluate(() => "injected" in window)).toBe(false);
});

test("a first run opens the setup screen, and every other screen opens too, before there is a book", async ({
  page,
}) => {
  const problems = await watch(page);
  const response = await page.goto(`${base}/`);
  expect(response?.status()).toBe(200);
  await expect(page.getByRole("heading", { name: "Set up your books" })).toBeVisible();
  // Someone who types an address or follows a bookmark on a fresh install must not meet an error.
  expect(await brokenScreens(page)).toEqual([]);
  expect(problems).toEqual([]);
});

test("the app sets up a book through its own requests", async ({ page }) => {
  const problems = await watch(page);
  await page.goto(`${base}/`);
  const created = await page.evaluate(async () => {
    const response = await fetch("/api/book/setup", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        name: "Example Co",
        currency: "USD",
        fiscalYear: 2026,
        periodModel: "monthly",
        accounts: [
          { code: "1000", name: "Cash", role: "asset" },
          { code: "3000", name: "Owner capital", role: "equity" },
        ],
      }),
    });
    return { ok: response.ok, status: response.status };
  });
  expect(created, "the app's own request to set up a book").toMatchObject({ ok: true });
  await page.reload();
  // The business is named in the header, and Home is titled Today.
  await expect(page.locator(".app-book-name")).toHaveText("Example Co");
  await expect(page.getByRole("heading", { level: 1, name: "Today" })).toBeVisible();
  expect(problems).toEqual([]);
});

test("every screen loads from the installed service without breaking its content policy", async ({
  page,
}) => {
  const problems = await watch(page);
  expect(await brokenScreens(page)).toEqual([]);
  expect(problems).toEqual([]);
});

test("the footer says the owner lock is on", async ({ page }) => {
  await page.goto(`${base}/`);
  await expect(page.locator("footer")).toContainText("The owner lock is on");
  await expect(page.locator("footer")).not.toContainText("Authentication is not configured");
});

test("the footer says the service is reading the books, and goes quiet when it is done", async ({
  page,
}) => {
  // The service says what it says about reading its book; the footer asks every two seconds while it
  // is reading. (The service's own answers are tested against a real book in apps/api.)
  const answers: Record<string, unknown> = {
    reading: { warming: true, warmup: { state: "reading", done: 5, total: 100, secondsLeft: 41 } },
    ready: { warming: false, warmup: { state: "ready", entries: 100, seconds: 12 } },
    failed: { warming: false, warmup: { state: "failed", error: "damaged" } },
  };
  let now = "reading";
  await page.route("**/health", (route) =>
    route.fulfill({
      json: { ok: true, service: "rastrata", version: "0.0.0", ...(answers[now] as object) },
    }),
  );
  await page.goto(`${base}/`);
  const footer = page.locator("footer");
  await expect(footer).toContainText("Reading your books, about 40 seconds");
  await expect(footer).toContainText("The owner lock is on");
  now = "ready";
  await expect(footer).not.toContainText("Reading your books", { timeout: 10_000 });
  await expect(footer).toContainText("The owner lock is on");
  // A service that could not read them says so, and where to look.
  now = "failed";
  await page.reload();
  await expect(footer).toContainText("Your books could not be read: run rastrata doctor");
});

test("the app's own requests are let in, and a program with no key is not", async ({
  page,
  request,
}) => {
  const problems = await watch(page);
  await page.goto(`${base}/`);
  const statuses = await page.evaluate(async () => {
    const book = await fetch("/v1/book.get", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ version: "rastrata-application-v1", bookId: "local-book", input: {} }),
    });
    const legacy = await fetch("/api/book");
    const upload = await fetch("/v1/uploads", {
      method: "POST",
      headers: { "content-type": "text/csv", "x-upload-name": "statement.csv" },
      body: new Blob(["Date,Amount\n01/02/2026,1.00\n"]),
    });
    return { book: book.status, legacy: legacy.status, upload: upload.status };
  });
  expect(statuses.book).toBe(200);
  expect(statuses.legacy).toBe(200);
  // The upload reaches the ingest slice (200 once a book exists, a refusal about the book before).
  expect([200, 409, 503]).toContain(statuses.upload);

  // Outside the browser, with no key: refused, and told how to get in.
  const bare = await request.post(`${base}/v1/book.get`, {
    data: { version: "rastrata-application-v1", bookId: "local-book", input: {} },
  });
  expect(bare.status()).toBe(401);
  expect((await bare.json()).error.code).toBe("authentication_required");
  // With the key from the data directory, as the command line has it: let in.
  const key = readFileSync(join(dataDirectory, "owner.key"), "utf8").trim();
  const keyed = await request.post(`${base}/v1/book.get`, {
    headers: { authorization: `Bearer ${key}` },
    data: { version: "rastrata-application-v1", bookId: "local-book", input: {} },
  });
  expect(keyed.status()).toBe(200);
  // A request that names another host (what a rebinding page sends) is refused before it is read.
  const forged = await request.get(`${base}/health`, { headers: { host: "evil.example" } });
  expect(forged.status()).toBe(421);
  expect(problems).toEqual([]);
});

test("the Agent access screen lists a token the app made, and the token acts only as itself", async ({
  page,
  request,
}) => {
  const problems = await watch(page);
  await page.goto(`${base}/`);
  // The app makes the token. The page holds no key: the service adds the owner's to its own app's
  // requests, which is what lets the screen work on a locked service.
  const made = await page.evaluate(async () => {
    const response = await fetch("/v1/tokens.create", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        version: "rastrata-application-v1",
        bookId: "local-book",
        operationId: crypto.randomUUID(),
        input: { label: "Installed check", permissions: ["read"] },
      }),
    });
    const body = await response.json();
    return { status: response.status, secret: String(body?.data?.secret ?? "") };
  });
  expect(made.status).toBe(200);
  expect(made.secret).toMatch(/^rst_/);
  // The screen reads its tokens as the owner, so the new one is listed by its name.
  await page.goto(`${base}/settings/agent`);
  await expect(page.getByRole("heading", { level: 1, name: "Agents" })).toBeVisible();
  await expect(page.getByText("Installed check").first()).toBeVisible();
  // Outside the browser the token is a token: it reads, and it cannot manage tokens.
  const bearer = { authorization: `Bearer ${made.secret}` };
  const data = { version: "rastrata-application-v1", bookId: "local-book", input: {} };
  const asToken = await request.post(`${base}/v1/book.get`, { headers: bearer, data });
  expect(asToken.status()).toBe(200);
  expect((await asToken.json()).data.principal.kind).toBe("token");
  const manage = await request.post(`${base}/v1/tokens.list`, { headers: bearer, data });
  expect(manage.status()).toBe(403);
  expect(problems).toEqual([]);
});

test("the page cannot be framed or read by another site", async ({ page, request }) => {
  const response = await request.get(`${base}/`, { headers: { accept: "text/html" } });
  expect(response.headers()["x-frame-options"]).toBe("DENY");
  expect(response.headers()["content-security-policy"]).toContain("frame-ancestors 'none'");
  expect(response.headers()["cross-origin-resource-policy"]).toBe("same-origin");
  expect(response.headers()["content-security-policy"]).not.toMatch(/script-src[^;]*unsafe-inline/);
  // A page of another origin that tries to frame it gets nothing.
  await page.goto(`${base}/health`);
  const framed = await page.evaluate(async (target) => {
    const frame = document.createElement("iframe");
    frame.src = target;
    document.body.append(frame);
    await new Promise((done) => setTimeout(done, 1000));
    try {
      return frame.contentDocument?.body?.textContent?.includes("Rastrata") ?? false;
    } catch {
      return false;
    }
  }, `${base}/`);
  expect(framed).toBe(false);
});

test("a deep link survives a reload", async ({ page }) => {
  await page.goto(`${base}/journal/new`);
  await expect(page.locator("main")).toBeVisible();
  const before = await page.locator("h1").first().textContent();
  await page.reload();
  await expect(page.locator("h1").first()).toHaveText(before ?? "");
  expect(new URL(page.url()).pathname).toBe("/journal/new");
});
