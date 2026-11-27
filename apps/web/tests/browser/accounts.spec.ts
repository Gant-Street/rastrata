import { type ChildProcess, execFileSync, spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { join, resolve } from "node:path";
import {
  type APIRequestContext,
  expect,
  type Page,
  request as playwrightRequest,
  test,
} from "@playwright/test";
import axe from "axe-core";
import { expectWithin } from "../support/budget.ts";

// biome-ignore lint/suspicious/noExplicitAny: decoded JSON of many shapes
type Json = any;

declare global {
  interface Window {
    axe: typeof axe;
    /** Whether the typeface for the business's name was loaded at the first moment the header was in the page (set by the test's own script). */
    __faceAtHeader?: boolean;
    /** The calls the page made to the service's health and the control plane, in order (set by the test's own script). */
    __calls?: string[];
  }
}

/** The whole product on this computer (apps/control-worker/tooling/dev-stack.ts): the pod with accounts and many books, the control Worker under workerd, the built
 * web app, behind one address. A stranger opens it and sees only the sign-in page, signs up with an emailed code, makes a workspace and is in the application, whose
 * requests carry the workspace's token. A second browser accepts an invitation from a link and is in the same book. The stack is served over https (`--tls`, a certificate made for
 * the run, which each browser is told to accept) so that Chromium, Firefox and WebKit all keep the `Secure` session cookie; the tests share the stack and run one after another. */
test.describe.configure({ mode: "serial" });
test.use({ actionTimeout: 20_000 });

const version = "rastrata-application-v1";
/** What a place that has been seen is allowed to take from the click to being in the page, with the service slow: the plan's 100 ms and what a busy computer adds (docs/reference/program/performance.md, "Under 100 ms"). */
const PLACE_BUDGET_MS = 150;
const repository = resolve(process.cwd(), "../..");
let child: ChildProcess | undefined;
let base = "";

test.beforeAll(async () => {
  test.setTimeout(90_000);
  if (!existsSync(join(repository, "apps/web/dist/index.html")))
    throw new Error("Build the web app first: bun run --cwd apps/web build");
  child = spawn(
    process.execPath,
    [
      join(repository, "apps/control-worker/tooling/dev-stack.ts"),
      "--port",
      "0",
      // Over https, so that Firefox and WebKit, which keep a `Secure` cookie only from https, are the same product as Chromium (the browser is told to accept the run's own certificate).
      "--tls",
      // The thirty days after a workspace is deleted are seconds here, so that the last test can see one erased.
      "--deletion-grace-ms",
      "6000",
      "--deletion-sweep-ms",
      "1000",
    ],
    {
      cwd: join(repository, "apps/control-worker"),
      env: { PATH: process.env.PATH ?? "", HOME: process.env.HOME ?? "" },
      stdio: ["ignore", "pipe", "pipe"],
    },
  );
  let output = "";
  child.stdout?.on("data", (chunk) => {
    output += String(chunk);
  });
  child.stderr?.on("data", (chunk) => {
    output += String(chunk);
  });
  const deadline = Date.now() + 80_000;
  while (!/dev-stack ready (https:\/\/localhost:\d+)/.test(output)) {
    if (Date.now() > deadline || child.exitCode !== null)
      throw new Error(`the stack did not start: ${output}`);
    await new Promise((done) => setTimeout(done, 100));
  }
  base = /dev-stack ready (https:\/\/localhost:\d+)/.exec(output)?.[1] as string;
});

test.afterAll(async () => {
  if (child && child.exitCode === null) {
    child.kill("SIGTERM");
    await new Promise((done) => child?.once("exit", done));
  }
});

interface Sent {
  to: string;
  subject: string;
  text: string;
}
/** The newest mail to an address that matches `pattern`: the stack keeps what it would have sent. */
async function mailTo(
  request: APIRequestContext,
  address: string,
  pattern: RegExp,
  since = 0,
): Promise<Sent> {
  const deadline = Date.now() + 10_000;
  for (;;) {
    const all = ((await (await request.get(`${base}/__dev/mail`)).json()) as Sent[]).slice(since);
    const found = [...all].reverse().find((mail) => mail.to === address && pattern.test(mail.text));
    if (found) return found;
    if (Date.now() > deadline) throw new Error(`no mail to ${address}`);
    await new Promise((done) => setTimeout(done, 100));
  }
}
/** How many messages the stack has kept: a code is the page's own when it is in a message after this many (an address that signed in before has codes in older ones). */
const mailCount = async (request: APIRequestContext): Promise<number> =>
  ((await (await request.get(`${base}/__dev/mail`)).json()) as Sent[]).length;
const codeIn = (mail: Sent): string => /\b(\d{6})\b/.exec(mail.text)?.[1] as string;

/** Everything the browser says is wrong with a page, and every request for data the page makes, with the token it carried. */
async function watch(page: Page) {
  const problems: string[] = [];
  const data: { url: string; authorization: string | undefined }[] = [];
  page.on("console", (message) => {
    // WebKit says a request that was cut off (the page left while it was on its way) was refused "due to access control checks"; the other browsers say "Failed to load resource". A real
    // policy violation is not this: it is reported by the listener added below.
    if (
      message.type() === "error" &&
      !/^Failed to load resource|due to access control checks/.test(message.text())
    )
      problems.push(`console: ${message.text().slice(0, 200)}`);
  });
  page.on("pageerror", (error) => {
    // A request still on its way when the page leaves is cancelled, and WebKit lets the page hear of it (as "due to access control checks") while it goes; the others do not.
    if (!/due to access control checks/.test(error.message))
      problems.push(`error: ${error.message.slice(0, 200)}`);
  });
  page.on("request", (request) => {
    if (/\/v1\//.test(request.url()))
      data.push({ url: request.url(), authorization: request.headers().authorization });
  });
  await page.addInitScript(() => {
    document.addEventListener("securitypolicyviolation", (event) => {
      console.error(`policy: ${event.violatedDirective} blocked ${event.blockedURI}`);
    });
  });
  await page.addInitScript({ content: axe.source });
  return { problems, data };
}

async function scan(page: Page, label: string) {
  // A colour read in the middle of a transition is not the page's colour.
  await page.addStyleTag({
    content: "*,*::before,*::after{transition:none!important;animation:none!important}",
  });
  for (const theme of ["light", "dark"] as const) {
    await page.evaluate(
      (value) => document.documentElement.setAttribute("data-theme", value),
      theme,
    );
    const violations = await page.evaluate(async () => {
      const result = await window.axe.run(document.body, {
        runOnly: { type: "tag", values: ["wcag2a", "wcag2aa", "wcag21aa"] },
      });
      return result.violations.map(({ id, nodes }) => ({
        id,
        targets: nodes.map((n) => n.target),
      }));
    });
    expect(violations, `${label} (${theme})`).toEqual([]);
  }
  await page.evaluate(() => document.documentElement.removeAttribute("data-theme"));
}

const gateHeading = (page: Page, name: string | RegExp) => page.getByRole("heading", { name });
/** Types a code into the code's six boxes, as a person does; the sixth digit sends it. */
const enterCode = async (page: Page, code: string) => {
  await page.getByLabel("Digit 1 of 6").click();
  await page.keyboard.type(code);
};

/** A person signs up (or in) with an address: the address, the code from the mail, the code. */
async function signUp(page: Page, request: APIRequestContext, address: string) {
  const since = await mailCount(request);
  await page.getByLabel("Email address").fill(address);
  await page.getByRole("button", { name: "Continue", exact: true }).click();
  await expect(gateHeading(page, "Check your email")).toBeVisible();
  const mail = await mailTo(request, address, /\b\d{6}\b/, since);
  await enterCode(page, codeIn(mail));
}

const bookSetup = {
  name: "Acme Books",
  currency: "USD",
  fiscalYear: 2026,
  periodModel: "monthly",
  accounts: [
    { code: "1000", name: "Business checking", role: "asset" },
    { code: "3000", name: "Owner's investment", role: "equity" },
    { code: "5000", name: "Software and subscriptions", role: "expense" },
  ],
};

/** A request made from inside the page, as the application makes them: the browser sends its cookies (the API client of the test does not send a `Secure` cookie over
 * plain http, which a browser does for a loopback address). */
async function inPage(
  page: Page,
  path: string,
  init: { method?: string; headers?: Record<string, string>; body?: unknown } = {},
): Promise<{ status: number; body: Json }> {
  return page.evaluate(
    async ({ path, init }) => {
      const response = await fetch(path, {
        method: init.method ?? "GET",
        headers: {
          ...(init.body === undefined ? {} : { "content-type": "application/json" }),
          ...init.headers,
        },
        ...(init.body === undefined ? {} : { body: JSON.stringify(init.body) }),
      });
      return { status: response.status, body: await response.json().catch(() => null) };
    },
    { path, init },
  );
}

/** The workspace the page has open sets its book up, with the page's own requests (the setup screen does the same through the application). Returns the workspace's id. */
async function setUpBook(page: Page, name = "Acme Books"): Promise<string> {
  const list = await inPage(page, "/auth/workspaces");
  const workspace = list.body.workspaces[0].id as string;
  const issued = await inPage(page, "/auth/workspace-token", {
    method: "POST",
    body: { workspace },
  });
  expect(issued.status).toBe(200);
  const setup = await inPage(page, "/v1/book.setup", {
    method: "POST",
    headers: { authorization: `Bearer ${issued.body.token}` },
    body: {
      version,
      bookId: "local-book",
      operationId: "6b7c8d9e-0f1a-4b2c-9d3e-4f5a6b7c8d9e",
      input: { ...bookSetup, name },
    },
  });
  expect(setup.status).toBe(200);
  return workspace;
}

/** Someone with a workspace of their own and a book in it, in the application. */
async function startOut(page: Page, request: APIRequestContext, address: string, name: string) {
  await page.goto(`${base}/`);
  await signUp(page, request, address);
  await expect(gateHeading(page, "Create your workspace")).toBeVisible();
  await page.getByLabel("Workspace name").fill(name);
  await page.getByRole("button", { name: "Create workspace" }).click();
  await expect(page.locator("#main")).toBeVisible();
  const workspace = await setUpBook(page, name);
  await page.reload();
  await expect(page.locator("#main")).toBeVisible();
  return workspace;
}

// A computer with Touch ID (or any device that makes passkeys) would be offered one after every code; the flows below are about other things, so this browser has said "Not now"
// already. The passkey tests take it back.
test.beforeEach(async ({ page }) => {
  await page.addInitScript(() => {
    try {
      localStorage.setItem("rastrata-passkey-declined", "yes");
    } catch {
      // A page with no storage is offered a passkey; none of these flows meets one.
    }
  });
});

test("a stranger sees only the sign-in page, signs up with an emailed code, makes a workspace and is in the application with the workspace's token on every request", async ({
  page,
  request,
}) => {
  const watched = await watch(page);
  await page.goto(`${base}/`);
  // Only the sign-in page: no application chrome, and no request for data.
  await expect(gateHeading(page, "Sign in or create an account")).toBeVisible();
  await expect(page.getByRole("link", { name: "Skip to content" })).toHaveCount(0);
  await expect(page.getByLabel("Email address")).toHaveAttribute("autocomplete", "email webauthn");
  // The one field of the form is not labelled "(required)" (the founder, 2026-10-27: "not a normal pattern"); assistive technology is still told.
  await expect(page.getByLabel("Email address", { exact: true })).toHaveAttribute(
    "aria-required",
    "true",
  );
  // The fine print is one line wherever the card is full width (the founder did not like it on two).
  const fine = await page.locator(".gate-fine").evaluate((element) => {
    const range = document.createRange();
    range.selectNodeContents(element);
    return {
      lines: new Set([...range.getClientRects()].map((rect) => Math.round(rect.bottom))).size,
      wide: element.getBoundingClientRect().width >= 380,
    };
  });
  if (fine.wide) expect(fine.lines).toBe(1);
  // Whoever signs up is told what they agree to, with the terms and the policy one click away, on the public site and in a tab of their own.
  const terms = page.getByRole("link", { name: "Terms (opens in a new tab)" });
  const privacy = page.getByRole("link", { name: "Privacy Policy (opens in a new tab)" });
  await expect(terms).toHaveAttribute("href", "https://rastrata.com/terms/");
  await expect(privacy).toHaveAttribute("href", "https://rastrata.com/privacy/");
  await expect(terms).toHaveAttribute("target", "_blank");
  await expect(terms).toHaveAttribute("rel", /noopener/);
  await scan(page, "the sign-in page");
  // The first screen does not advertise how a person signs in (the founder's ruling, 2026-10-17: no code, no email sent, no password). The code is named on the screen that asks for it.
  await expect(page.locator("body")).not.toContainText(
    /password|six-digit|emailed|emails? you|\bcodes?\b/i,
  );
  // An address that is not one is told so before anything is sent.
  await page.getByLabel("Email address").fill("not an address");
  await page.getByRole("button", { name: "Continue", exact: true }).click();
  await expect(
    page.getByRole("alert").filter({ hasText: "Enter a valid email address" }),
  ).toBeVisible();

  await page.getByLabel("Email address").fill("ann@example.com");
  await page.getByRole("button", { name: "Continue", exact: true }).click();
  await expect(gateHeading(page, "Check your email")).toBeVisible();
  await expect(page.getByText("Enter the code we sent to ann@example.com.")).toBeVisible();
  await expect(page.getByLabel("Digit 1 of 6")).toHaveAttribute("autocomplete", "one-time-code");
  await scan(page, "the code page");
  // A wrong code is told in a person's words, and the right one signs in.
  const mail = await mailTo(request, "ann@example.com", /\b\d{6}\b/);
  const right = codeIn(mail);
  await enterCode(page, right === "000000" ? "111111" : "000000");
  await expect(
    page.getByRole("alert").filter({ hasText: "That code is not right." }),
  ).toBeVisible();
  await enterCode(page, right);

  // Nobody has a workspace yet: the page asks for one.
  await expect(gateHeading(page, "Create your workspace")).toBeVisible();
  await scan(page, "the workspace page");
  await page.getByLabel("Workspace name").fill("Acme Books");
  await page.getByRole("button", { name: "Create workspace" }).click();

  // In the application: its shell, and every request for data carries a signed token.
  await expect(page.locator("#main")).toBeVisible();
  await expect(gateHeading(page, "Create your workspace")).toHaveCount(0);
  await expect.poll(() => watched.data.length).toBeGreaterThan(0);
  expect(
    watched.data.every((request) =>
      /^Bearer [\w-]+\.[\w-]+\.[\w-]+$/.test(request.authorization ?? ""),
    ),
  ).toBe(true);
  expect(watched.problems).toEqual([]);
});

test("a reload stays in the application, with no sign-in page in between; the stranger's own browser is still a stranger", async ({
  page,
  context,
  browser,
}) => {
  const watched = await watch(page);
  // Each test has a browser context of its own, so this one signs up a person of its own.
  await page.goto(`${base}/`);
  await signUp(page, context.request, "carol@example.com");
  await expect(gateHeading(page, "Create your workspace")).toBeVisible();
  await page.getByLabel("Workspace name").fill("Second Co");
  await page.getByRole("button", { name: "Create workspace" }).click();
  await expect(page.locator("#main")).toBeVisible();
  // The page is read again from the server: the application, straight away (the hint cookie), and the sign-in page is never in the document.
  const response = await page.reload();
  expect(response?.headers()["content-security-policy"]).not.toContain("challenges.cloudflare.com");
  await expect(page.locator("#main")).toBeVisible();
  await expect(page.getByLabel("Email address")).toHaveCount(0);
  // Another browser, with nothing, is sent the sign-in page at every address.
  const stranger = await browser.newContext();
  const open = await stranger.newPage();
  for (const path of ["/", "/journal", "/settings/members"]) {
    await open.goto(`${base}${path}`);
    await expect(gateHeading(open, "Sign in or create an account")).toBeVisible();
  }
  await stranger.close();
  expect(watched.problems).toEqual([]);
});

test("a page opened again by someone signed in asks for the service's health and the token of the open workspace from its first lines, once each, and its code asks for neither again", async ({
  page,
  context,
}) => {
  const watched = await watch(page);
  await startOut(page, context.request, "wren@example.com", "Wren Books");
  // From here: every call the page makes to the service's health and the control plane, in the order its first lines and its code made them. A call is counted where the page makes it (`fetch`),
  // and not where the network carries it: a browser sends a request again by itself when its connection to the service had gone stale, which is not the page asking twice.
  await page.addInitScript(() => {
    const calls: string[] = [];
    window.__calls = calls;
    const original = window.fetch.bind(window);
    window.fetch = ((input: RequestInfo | URL, init?: RequestInit) => {
      const request = input instanceof Request ? input : null;
      const url = new URL(request ? request.url : String(input), window.location.href);
      if (
        url.pathname === "/health" ||
        (url.pathname.startsWith("/auth/") && url.pathname !== "/auth/rum")
      )
        calls.push(`${(init?.method ?? request?.method ?? "GET").toUpperCase()} ${url.pathname}`);
      return original(input, init);
    }) as typeof window.fetch;
  });
  const tokens: number[] = [];
  page.on("response", (response) => {
    if (new URL(response.url()).pathname === "/auth/workspace-token")
      tokens.push(response.status());
  });
  await page.reload();
  await expect(page.locator("#main")).toBeVisible();
  const sent = (await page.evaluate(() => window.__calls)) ?? [];
  // The first lines' two requests leave first, ahead of the page's own calls (the session, the configuration, the workspace), and the page's code makes neither again: one health and
  // one token, and the token is answered 200.
  expect(sent.slice(0, 2).sort()).toEqual(["GET /health", "POST /auth/workspace-token"]);
  expect(sent.filter((call) => call === "GET /health")).toHaveLength(1);
  expect(sent.filter((call) => call === "POST /auth/workspace-token")).toHaveLength(1);
  expect(tokens).toEqual([200]);
  // A browser that remembers no workspace (a first visit, a storage that was cleared) asks for the health and nothing more of the first lines: no token is asked for. The page then
  // chooses the workspace and is read again, and that load, which remembers one, asks for both.
  await page.evaluate(() => localStorage.removeItem("rastrata:workspace"));
  // (This page goes on to the one that chooses a workspace, so what it asked is kept where the page is not.)
  const asked: string[] = [];
  page.on("request", (request) => {
    const path = new URL(request.url()).pathname;
    if (path === "/health" || (path.startsWith("/auth/") && path !== "/auth/rum"))
      asked.push(`${request.method()} ${path}`);
  });
  await page.reload();
  await expect.poll(() => asked.length).toBeGreaterThan(0);
  expect(asked[0]).toBe("GET /health");
  expect(asked).not.toContain("POST /auth/workspace-token");
  expect(watched.problems).toEqual([]);
});

test("a place the person has seen is drawn at once from what the page holds, with the service slow, and the page asks the service again behind it", async ({
  page,
  context,
}) => {
  const watched = await watch(page);
  await startOut(page, context.request, "ida@example.com", "Ida Books");
  const navigation = page.getByRole("navigation", { name: "Main navigation" });
  // The first visit to Accounts asks the service.
  await navigation.getByRole("link", { name: "Accounts", exact: true }).click();
  await expect(page.getByRole("heading", { level: 1, name: "Accounts" })).toBeVisible();
  await expect(page.getByText("Expenses (1)")).toBeVisible();
  await navigation.getByRole("link", { name: "Home", exact: true }).click();
  await expect(page.locator("#main")).toBeVisible();
  // What the page holds is given at once when it is two seconds old or more; from here the service takes a second and a half to say what the accounts are.
  await page.waitForTimeout(2200);
  const asked: number[] = [];
  await page.route("**/v1/accounts.list", async (route) => {
    asked.push(Date.now());
    await new Promise((done) => setTimeout(done, 1500));
    // (A request the page has given up on while it waited is already handled: that is not the test's to fail.)
    await route.continue().catch(() => undefined);
  });
  const started = Date.now();
  await navigation.getByRole("link", { name: "Accounts", exact: true }).click();
  await expect(page.getByText("Expenses (1)")).toBeVisible({
    timeout: 700,
  });
  expect(Date.now() - started).toBeLessThan(1200);
  // The service was asked again behind it, and the page is the same when it has answered.
  await expect.poll(() => asked.length, { timeout: 3000 }).toBeGreaterThan(0);
  await page.waitForTimeout(1800);
  await expect(page.getByText("Expenses (1)")).toBeVisible();
  await page.unroute("**/v1/accounts.list");
  expect(watched.problems).toEqual([]);
});

/** The time from a click on a link of the main navigation to its screen being in the page with nothing waiting in it, measured in the page itself (the moment of the click to the first frame that
 * has the screen's heading and no placeholder), in milliseconds; -1 when it did not come in five seconds. */
async function drawnAfter(page: Page, link: string, heading: string): Promise<number> {
  return page.evaluate(
    ({ link, heading }) =>
      new Promise<number>((resolve) => {
        const anchor = [
          ...document.querySelectorAll<HTMLAnchorElement>(
            'nav[aria-label="Main navigation"] a[href]',
          ),
        ].find((candidate) => candidate.textContent?.trim().startsWith(link));
        if (!anchor) return resolve(-1);
        const started = performance.now();
        anchor.click();
        const look = () => {
          const title = document.querySelector("#main h1")?.textContent?.trim();
          if (title === heading && document.querySelector("#main .rt-skeleton") === null)
            return resolve(performance.now() - started);
          if (performance.now() - started > 5000) return resolve(-1);
          requestAnimationFrame(look);
        };
        look();
      }),
    { link, heading },
  );
}

test("the places are a click away: with the service taking 400 ms for every read, a place the person has seen is in the page within the budget, and no screen's file is asked for at the click", async ({
  page,
  context,
}) => {
  const watched = await watch(page);
  const files: string[] = [];
  page.on("requestfinished", (request) => {
    if (/\/assets\/[^/]+\.js$/.test(new URL(request.url()).pathname)) files.push(request.url());
  });
  await startOut(page, context.request, "bud@example.com", "Bud Budget");
  const navigation = page.getByRole("navigation", { name: "Main navigation" });
  // Each place seen once, as a person sees them. The screen the person is on stays until the next one is whole, so what a place is called is waited for by name, and Home's is read while
  // the page is on it.
  const headings = new Map<string, string>([
    ["Accounts", "Accounts"],
    ["Reports", "Reports"],
    ["Home", (await page.locator("#main h1").first().innerText()).trim()],
  ]);
  for (const place of ["Accounts", "Reports", "Home"]) {
    await navigation.getByRole("link", { name: place, exact: true }).click();
    await expect(
      page.getByRole("heading", { level: 1, name: headings.get(place) ?? place, exact: true }),
    ).toBeVisible();
    await expect(page.locator("#main .rt-skeleton")).toHaveCount(0);
  }
  // Every screen's file comes while the page is idle after its first draw (src/preload.ts): wait until none has come for two seconds, which also makes what the page holds older than two.
  let seen = -1;
  const deadline = Date.now() + 30_000;
  while (Date.now() < deadline) {
    seen = files.length;
    await page.waitForTimeout(2200);
    if (files.length === seen) break;
  }
  expect(files.length, "the files of the screens came").toBe(seen);
  expect(files.length).toBeGreaterThan(20);
  await page.route("**/v1/**", async (route) => {
    await new Promise((done) => setTimeout(done, 400));
    // (A request the page has given up on while it waited is already handled: that is not the test's to fail.)
    await route.continue().catch(() => undefined);
  });
  const times: Record<string, number[]> = {};
  for (const place of ["Reports", "Accounts", "Home", "Accounts", "Reports", "Home"]) {
    const before = files.length;
    const took = await drawnAfter(page, place, headings.get(place) ?? place);
    times[place] = [...(times[place] ?? []), Math.round(took)];
    expect(took, `${place} came in`).toBeGreaterThanOrEqual(0);
    // A place seen before is drawn from what the page holds, not after the service's 400 ms (a clock is only asserted on a quiet machine, tests/support/budget.ts), and from files that are
    // already here.
    expectWithin(`${place}, from the click to its content`, took, PLACE_BUDGET_MS);
    expect(files.length, `a file was asked for at the click on ${place}`).toBe(before);
    await page.waitForTimeout(300);
  }
  test.info().annotations.push({ type: "drawn in ms", description: JSON.stringify(times) });
  await page.unroute("**/v1/**");
  expect(watched.problems).toEqual([]);
});

test("a screen whose file is gone because a release replaced it is not an error: the page reads itself again, once, and opens the screen", async ({
  page,
  context,
}) => {
  const watched = await watch(page);
  let refusing = true;
  let refused = 0;
  // A tab that was opened before a release asks for a file the service no longer has, and the service says "Not found" as it does for any file that is not there. The page that is read
  // again is the new release's, which has the file.
  await page.route(/\/assets\/periods-[^/]*\.js$/, async (route) => {
    if (!refusing) return route.continue();
    refused += 1;
    return route.fulfill({
      status: 404,
      contentType: "application/json",
      body: '{"message":"Not found.","code":"not_found"}',
    });
  });
  await startOut(page, context.request, "ned@example.com", "Ned Notes");
  page.on("request", (request) => {
    if (request.isNavigationRequest()) refusing = false;
  });
  let loads = 0;
  page.on("load", () => {
    loads += 1;
  });
  // Gone to from inside the page, as a click on a link does.
  await page.evaluate(() => {
    window.history.pushState({}, "", "/periods");
    window.dispatchEvent(new PopStateEvent("popstate"));
  });
  await expect(page.getByRole("heading", { level: 1, name: "Close the books" })).toBeVisible();
  // It was not an error: the page asked for the file, was told there is none, read itself again once, and is on the screen that was asked for.
  expect(refused).toBeGreaterThan(0);
  expect(loads).toBe(1);
  expect(new URL(page.url()).pathname).toBe("/periods");
  expect(
    await page.evaluate(() =>
      Object.keys(sessionStorage).some((key) => key.startsWith("tanstack_router_reload:")),
    ),
  ).toBe(true);
  expect(watched.problems).toEqual([]);
});

test("a business named in a script that is not Latin has its typeface before the header is drawn, and a Latin name asks for no file", async ({
  page,
  context,
  browser,
}) => {
  const watched = await watch(page);
  const faces: string[] = [];
  page.on("request", (request) => {
    const path = new URL(request.url()).pathname;
    if (/\/assets\/fonts\/v[0-9.]+\/[^/]+\.woff2$/.test(path)) faces.push(path);
  });
  // In each document, whether the typeface for "ř" (Latin extended) was there at the first moment the header was in the page: a name drawn before its file came is drawn in one face and then another.
  await page.addInitScript(() => {
    const look = () => {
      if (window.__faceAtHeader !== undefined || !document.querySelector("header")) return;
      window.__faceAtHeader =
        document.fonts.check('1em "Inter Variable"', "ř") &&
        document.fonts.check('1em "JetBrains Mono Variable"', "ř");
    };
    new MutationObserver(look).observe(document, { childList: true, subtree: true });
  });
  await startOut(page, context.request, "dvo@example.com", "Dvořák Interiors");
  // A page opened again by someone whose books are set up knows the name before it draws (a workspace still to be set up draws the setup at once, whatever the book says).
  await page.reload();
  await expect(page.locator("#main")).toBeVisible();
  expect(await page.evaluate(() => window.__faceAtHeader)).toBe(true);
  expect(faces.some((path) => /latin-ext/.test(path))).toBe(true);
  // A name in Basic Latin needs no file, and the page does not wait for one: another person, in a browser of their own.
  const fresh = await browser.newContext({ ignoreHTTPSErrors: true });
  const other = await fresh.newPage();
  const plain: string[] = [];
  other.on("request", (request) => {
    const path = new URL(request.url()).pathname;
    if (/\/assets\/fonts\//.test(path)) plain.push(path);
  });
  await other.goto(`${base}/`);
  await startOut(other, fresh.request, "plain@example.com", "Plain Interiors");
  await other.reload();
  await expect(other.locator("#main")).toBeVisible();
  expect(plain).toEqual([]);
  await fresh.close();
  expect(watched.problems).toEqual([]);
});

/** What is in the page's storage of the copy it keeps of the book: how many records, and every byte of them as text, for a test to look for what must not be there. */
async function whatIsKept(page: Page) {
  return page.evaluate(
    () =>
      new Promise<{ count: number; bytes: string }>((resolve, reject) => {
        const open = indexedDB.open("rastrata-copy", 1);
        open.onerror = () => reject(open.error);
        open.onupgradeneeded = () => {
          // Not there at all.
          open.transaction?.abort();
        };
        open.onsuccess = () => {
          const all = open.result
            .transaction("answers", "readonly")
            .objectStore("answers")
            .getAll();
          all.onsuccess = () => {
            const records = all.result as {
              id: string;
              scope: string;
              data: Uint8Array;
              iv: Uint8Array;
            }[];
            resolve({
              count: records.length,
              bytes: records
                .map(
                  (record) =>
                    `${record.id} ${record.scope} ${new TextDecoder("latin1").decode(record.data)}`,
                )
                .join("\n"),
            });
          };
          all.onerror = () => reject(all.error);
        };
      }),
  );
}

test("the page keeps what it has read on the device, locked, draws from it when it opens again with the service slow, and leaves nothing there when the person signs out", async ({
  page,
  context,
}) => {
  const watched = await watch(page);
  await startOut(page, context.request, "june@example.com", "June Books");
  const navigation = page.getByRole("navigation", { name: "Main navigation" });
  await navigation.getByRole("link", { name: "Accounts", exact: true }).click();
  await expect(page.getByText("Expenses (1)")).toBeVisible();
  // What was read is written to the device a moment later, and says nothing of what it was.
  await expect
    .poll(async () => (await whatIsKept(page)).count, { timeout: 5000 })
    .toBeGreaterThan(1);
  const kept = await whatIsKept(page);
  for (const clear of [
    "Expenses",
    "Business checking",
    "Software and subscriptions",
    "June Books",
    "accounts.list",
  ])
    expect(kept.bytes).not.toContain(clear);

  // Opened again with the service taking a second and a half to answer anything about the book: the places are drawn from what was kept, and not after the service has answered.
  await page.route("**/v1/**", async (route) => {
    await new Promise((done) => setTimeout(done, 1500));
    // (A request the page has given up on while it waited is already handled: that is not the test's to fail.)
    await route.continue().catch(() => undefined);
  });
  const started = Date.now();
  await page.goto(`${base}/accounts`);
  await expect(page.getByText("Expenses (1)")).toBeVisible({ timeout: 1200 });
  expect(Date.now() - started).toBeLessThan(1400);
  await page.unroute("**/v1/**");
  await page.waitForTimeout(300);

  // Signed out: nothing is left on the device, and the sign-in page is what there is.
  await page.locator("footer.app-footer").getByRole("button", { name: "Sign out" }).click();
  await expect(gateHeading(page, "Sign in or create an account")).toBeVisible();
  expect((await whatIsKept(page)).count).toBe(0);
  expect(watched.problems).toEqual([]);
});

test("a page that was drawn tells the control plane how long its load took, once, in numbers only", async ({
  page,
  context,
}) => {
  const watched = await watch(page);
  await startOut(page, context.request, "kay@example.com", "Kay Books");
  // What the page hands the browser to send, with where (a beacon's body is not something the test can read from the network).
  await page.addInitScript(() => {
    const told: { url: string; text: string }[] = [];
    (window as unknown as { __told: typeof told }).__told = told;
    const original = navigator.sendBeacon.bind(navigator);
    navigator.sendBeacon = (url: string | URL, data?: BodyInit | null) => {
      if (data instanceof Blob)
        void data.text().then((text) => told.push({ url: String(url), text }));
      return original(url, data);
    };
  });
  await page.reload();
  await expect(page.locator("#main")).toBeVisible();
  const toldOf = () =>
    page.evaluate(() => (window as unknown as { __told: { url: string; text: string }[] }).__told);
  // Leaving the page is when it tells (a page that is still open tells a few seconds after it was drawn); the browser's own leaving is not seen by the test, so it is said to the page.
  await page.waitForTimeout(500);
  await page.evaluate(() => window.dispatchEvent(new Event("pagehide")));
  await expect.poll(async () => (await toldOf()).length, { timeout: 5000 }).toBeGreaterThan(0);
  // Said again, it is not told again.
  await page.evaluate(() => window.dispatchEvent(new Event("pagehide")));
  await page.waitForTimeout(300);
  const told = await toldOf();
  expect(told).toHaveLength(1);
  expect(told[0]?.url).toBe("/auth/rum");
  const message = JSON.parse(told[0]?.text ?? "{}") as Record<string, unknown>;
  expect(message.v).toBe(1);
  expect(message.kind).toBe("reload");
  expect(String(message.build)).toMatch(/^index-[A-Za-z0-9]+\.js$/);
  const allowed = [
    "v",
    "build",
    "kind",
    "draw",
    "fcp",
    "lcp",
    "ttfb",
    "tokenAt",
    "bookAt",
    "reads",
    "held",
    "copy",
  ];
  expect(Object.keys(message).every((key) => allowed.includes(key))).toBe(true);
  for (const name of ["draw", "fcp", "tokenAt", "bookAt"]) {
    expect(Number.isInteger(message[name]), name).toBe(true);
    expect(message[name] as number, name).toBeGreaterThan(0);
    expect(message[name] as number, name).toBeLessThan(20_000);
  }
  // Nothing in it says who or what: no address, no workspace, no name.
  expect(told[0]?.text).not.toMatch(/@|wsp_|Kay|book_/);
  expect(watched.problems).toEqual([]);
});

test("the typefaces of the scripts that are not Latin are files, fetched when a character needs one and not before, and served to be kept", async ({
  page,
}) => {
  const watched = await watch(page);
  const fetched: string[] = [];
  page.on("request", (request) => {
    const path = new URL(request.url()).pathname;
    if (path.startsWith("/assets/fonts/")) fetched.push(path);
  });
  await page.goto(`${base}/`);
  await expect(gateHeading(page, "Sign in or create an account")).toBeVisible();
  await page.waitForTimeout(700);
  // The words of the page are Latin, and the Latin faces are in the style sheet: no file was needed.
  expect(fetched).toEqual([]);
  expect(await page.evaluate(() => document.fonts.check('16px "Inter Variable"', "Hello"))).toBe(
    true,
  );
  // The page's own text is in its typeface from the first paint: the Latin face of each family, in the style sheet, is loaded.
  const loaded = await page.evaluate(() =>
    [...document.fonts]
      .filter((face) => face.status === "loaded")
      .map((face) => `${face.family}|${face.unicodeRange}`),
  );
  // (Each engine writes the family and the range its own way: with or without quotes, "U+0-FF" or "U+0000-00FF".)
  expect(
    loaded.some((face) => /^["']?Inter Variable["']?\|U\+0*-0*ff\b/i.test(face)),
    loaded.join("; "),
  ).toBe(true);
  // A name in another script is shown in the page's typeface: the browser fetches the face for each script it meets.
  await page.evaluate(() => {
    const line = document.createElement("p");
    line.style.fontFamily = '"Inter Variable"';
    line.textContent = "Привет Αθήνα Việt";
    document.body.append(line);
  });
  await expect.poll(() => fetched.length, { timeout: 5000 }).toBeGreaterThanOrEqual(3);
  for (const script of ["cyrillic", "greek", "vietnamese"])
    expect(
      fetched.some((path) => path.includes(`inter-${script}-`)),
      script,
    ).toBe(true);
  // Served as a font, to be kept for good (the path has the package's version in it).
  const served = await page.request.get(`${base}${fetched[0]}`);
  expect(served.status()).toBe(200);
  expect(served.headers()["content-type"]).toContain("font/woff2");
  expect(served.headers()["cache-control"]).toContain("immutable");
  expect(watched.problems).toEqual([]);
});

test("an invitation's link opens the sign-in page, the person signs in with the invited address and accepts, and is in the same book as the owner", async ({
  page,
  context,
  browser,
}) => {
  const watched = await watch(page);
  await page.goto(`${base}/`);
  await signUp(page, context.request, "olive@example.com");
  await expect(gateHeading(page, "Create your workspace")).toBeVisible();
  await page.getByLabel("Workspace name").fill("Olive Ltd");
  await page.getByRole("button", { name: "Create workspace" }).click();
  await expect(page.locator("#main")).toBeVisible();

  // The owner sets the book up and invites an accountant (the Members page does this in a later test; here the control plane's route is asked directly).
  const workspace = await setUpBook(page);
  const invited = await inPage(page, "/auth/invitations", {
    method: "POST",
    body: { workspace, email: "bob@example.com", role: "accountant" },
  });
  expect(invited.status).toBe(201);
  const mail = await mailTo(context.request, "bob@example.com", /\/invite\//);
  const link = /(https:\/\/localhost:\d+\/invite\/[\w-]{43})/.exec(mail.text)?.[1] as string;
  expect(link).toBeTruthy();

  // Bob, in a browser of his own, opens the link: the sign-in page, saying what it is for.
  const bobContext = await browser.newContext();
  const bob = await bobContext.newPage();
  const bobWatched = await watch(bob);
  await bob.goto(link);
  await expect(gateHeading(bob, "Join Olive Ltd")).toBeVisible();
  await expect(bob.getByText("accountant")).toBeVisible();
  await expect(bob.getByText("b***@example.com")).toBeVisible();
  await scan(bob, "the invitation page");
  await signUp(bob, bobContext.request, "bob@example.com");
  await expect(gateHeading(bob, "Join Olive Ltd")).toBeVisible();
  await expect(
    bob.getByText("Signed in as").or(bob.getByText("You are signed in as")),
  ).toBeVisible();
  await bob.getByRole("button", { name: "Accept and open the workspace" }).click();
  await expect(bob.locator("#main")).toBeVisible();
  // Bob is in the book Olive set up: the business name is in the header.
  await expect(bob.getByText("Acme Books").first()).toBeVisible();
  expect(bobWatched.data.length).toBeGreaterThan(0);
  expect(bobWatched.data.every((request) => /^Bearer /.test(request.authorization ?? ""))).toBe(
    true,
  );
  expect(bobWatched.problems).toEqual([]);
  await bobContext.close();
  expect(watched.problems).toEqual([]);
});

test("inside, the footer says who is signed in and as what, Members is in Settings and no connection is offered, and signing out leaves the browser a stranger", async ({
  page,
  context,
}) => {
  const watched = await watch(page);
  await startOut(page, context.request, "dora@example.com", "Dora Studio");

  // The footer: who, and as what, with the way to the workspaces and the way out.
  const footer = page.locator("footer.app-footer");
  await expect(footer).toContainText("Signed in as dora@example.com · Owner");
  await expect(footer).not.toContainText("owner key");
  await expect(footer.getByRole("link", { name: "Workspaces" })).toHaveAttribute(
    "href",
    "/start?choose=1",
  );
  await expect(footer.getByRole("button", { name: "Sign out" })).toBeVisible();

  // This service keeps no bank or Stripe credential for a book, so it offers none: not in Settings, not on Home, not on For review.
  await page.goto(`${base}/settings`);
  const settings = page.getByRole("navigation", { name: "Settings" });
  await expect(settings.getByRole("link", { name: "Members" })).toBeVisible();
  await expect(settings.getByRole("link", { name: "Connections" })).toHaveCount(0);
  // An agent has a key of its own here (made on the Agents page and exchanged for a short-lived token), so Agents is offered; the service keeps the backups itself, so there are none
  // to verify: the open export is on the Workspace page.
  await expect(settings.getByRole("link", { name: "Agents" })).toBeVisible();
  await expect(settings.getByRole("link", { name: "Backups and export" })).toHaveCount(0);
  // Workspace (the export, and deleting it) is opened from the last line of Business.
  await expect(settings.getByRole("link", { name: "Workspace" })).toHaveCount(0);
  await expect(
    page.getByRole("main").getByRole("link", { name: "Export or delete this workspace" }),
  ).toHaveAttribute("href", "/settings/workspace");
  await page.goto(`${base}/`);
  // A new book: the one thing to do is to import a statement, since this service connects no bank.
  await expect(page.getByRole("heading", { name: "Import a statement to start" })).toBeVisible();
  await expect(
    page.locator(".rt-start").getByRole("link", { name: "Import a statement", exact: true }),
  ).toHaveAttribute("href", "/import");
  await expect(page.getByRole("link", { name: "Connect a bank" })).toHaveCount(0);
  // The first day's Home is not a list of things the service cannot do: nothing about a backup, nothing that
  // "could not be checked", and no list of steps.
  await expect(page.getByText(/backup/i)).toHaveCount(0);
  await expect(page.getByText(/could not be checked/)).toHaveCount(0);
  await expect(page.getByText("Finish setting up")).toHaveCount(0);
  await page.goto(`${base}/inbox`);
  await expect(page.getByRole("link", { name: /^Import (a )?statement$/ }).first()).toBeVisible();
  await expect(page.getByRole("link", { name: "Connect a bank" })).toHaveCount(0);
  await expect(page.getByText("or connect a bank")).toHaveCount(0);
  // An address that was bookmarked says what is true.
  await page.goto(`${base}/settings/stripe`);
  await expect(page.getByText("Stripe is read from your own computer")).toBeVisible();
  await scan(page, "connections, not available");
  await page.goto(`${base}/settings/backups`);
  await expect(page.getByText("There are no backups to make here")).toBeVisible();
  await expect(page.getByRole("link", { name: "Export your books" })).toHaveAttribute(
    "href",
    "/settings/workspace",
  );

  // Members: the owner, alone, who cannot leave, and the form that asks someone in.
  await page.goto(`${base}/settings/members`);
  await expect(page.getByRole("heading", { level: 1, name: "Members" })).toBeVisible();
  const people = page.getByRole("list", { name: "People who can open Dora Studio" });
  const me = people.getByRole("listitem").filter({ hasText: "dora@example.com" });
  await expect(me).toContainText("You");
  await expect(me).toContainText("Owner");
  await expect(me.getByRole("button")).toHaveCount(0);
  await expect(page.getByText("You are the only owner.")).toBeVisible();
  await expect(page.getByRole("heading", { name: "Invite someone" })).toBeVisible();
  await scan(page, "the members page");

  // Workspace: the owner takes the books away as one file. The browser is given a zip named for the export; it tests clean, and is a whole export.
  await page.goto(`${base}/settings/workspace`);
  await expect(page.getByRole("heading", { level: 1, name: "Workspace" })).toBeVisible();
  await scan(page, "the workspace page");
  const [download] = await Promise.all([
    page.waitForEvent("download"),
    page.getByRole("button", { name: "Export your books" }).click(),
  ]);
  expect(download.suggestedFilename()).toMatch(/^\d{8}T\d{6}Z-\d{8}-[0-9a-f]{8}\.zip$/);
  const saved = await download.path();
  expect(() => execFileSync("unzip", ["-tq", saved])).not.toThrow();
  const listing = execFileSync("unzip", ["-Z1", saved]).toString().split("\n");
  for (const name of [
    "README.md",
    "manifest.json",
    "book.json",
    "journals.jsonl",
    "commands.jsonl",
  ])
    expect(listing.some((entry) => entry.endsWith(`/${name}`))).toBe(true);
  expect(execFileSync("unzip", ["-p", saved, "*/book.json"]).toString()).toContain("Dora Studio");
  await expect(page.getByText(/Your books were exported/)).toBeVisible();

  // Workspaces: the list, with the one that is open and the form for another.
  await footer.getByRole("link", { name: "Workspaces" }).click();
  await expect(gateHeading(page, "Choose a workspace")).toBeVisible();
  await expect(page.getByRole("button", { name: "Open Dora Studio" })).toBeVisible();
  await page.getByLabel("Workspace name").fill("Dora Two");
  // It is a workspace of its own, with no book yet: the setup screen, at once, even while the book is slow to
  // answer (no skeleton of Home in between), and still there, with what was typed, when it does.
  const slow = async (route: import("@playwright/test").Route) => {
    await new Promise((done) => setTimeout(done, 3_000));
    await route.continue().catch(() => undefined);
  };
  await page.route("**/v1/book.get", slow);
  await page.getByRole("button", { name: "Create workspace" }).click();
  await expect(page.locator("#main")).toBeVisible();
  await expect(page.getByRole("heading", { name: /set up/i }).first()).toBeVisible({
    timeout: 2_000,
  });
  await expect(page.getByRole("status").filter({ hasText: "Opening your book…" })).toHaveCount(0);
  // And on the next visit, before anything is set up: the same, at once.
  await expect
    .poll(() => page.evaluate(() => localStorage.getItem("rastrata:setup-pending")))
    .not.toBeNull();
  await page.reload();
  await expect(page.getByRole("heading", { name: /set up/i }).first()).toBeVisible({
    timeout: 2_000,
  });
  await expect(page.getByRole("status").filter({ hasText: "Opening your book…" })).toHaveCount(0);
  await page.unroute("**/v1/book.get", slow);
  await expect(page.getByRole("heading", { name: /set up/i }).first()).toBeVisible();

  // Signing out: the browser is a stranger again, at every address, and the page remembers no workspace.
  await page.locator("footer.app-footer").getByRole("button", { name: "Sign out" }).click();
  await expect(gateHeading(page, "Sign in or create an account")).toBeVisible();
  expect(await page.evaluate(() => window.localStorage.getItem("rastrata:workspace"))).toBeNull();
  for (const path of ["/journal", "/settings/members", "/start"]) {
    await page.goto(`${base}${path}`);
    await expect(gateHeading(page, "Sign in or create an account")).toBeVisible();
  }
  expect(watched.problems).toEqual([]);
});

test("the owner asks someone in from the Members page, they accept, the owner changes their role and then takes them out, and the page they have open leaves the workspace", async ({
  page,
  context,
  browser,
}) => {
  const watched = await watch(page);
  await startOut(page, context.request, "erin@example.com", "Erin Ltd");
  await page.goto(`${base}/settings/members`);

  // An address that is not one is told so; a good one is sent a link.
  await page.getByLabel("Email address").fill("not an address");
  await page.getByRole("button", { name: "Send invitation" }).click();
  await expect(
    page.getByRole("alert").filter({ hasText: "Enter the email address of the person to invite." }),
  ).toBeVisible();
  await page.getByLabel("Email address").fill("fay@example.com");
  await page.getByRole("combobox", { name: "Role", exact: true }).click();
  await page.getByRole("option", { name: "Accountant" }).click();
  await page.getByRole("button", { name: "Send invitation" }).click();
  await expect(page.getByText("We sent an invitation to fay@example.com.")).toBeVisible();
  const waiting = page.getByRole("list", { name: "People who were invited and have not joined" });
  await expect(waiting.getByRole("listitem").filter({ hasText: "fay@example.com" })).toContainText(
    "Accountant",
  );
  await scan(page, "the members page with an invitation waiting");

  // Fay, in a browser of her own, follows the link from the mail and accepts.
  const mail = await mailTo(context.request, "fay@example.com", /\/invite\//);
  const link = /(https:\/\/localhost:\d+\/invite\/[\w-]{43})/.exec(mail.text)?.[1] as string;
  const fayContext = await browser.newContext();
  const fay = await fayContext.newPage();
  const fayWatched = await watch(fay);
  await fay.goto(link);
  await signUp(fay, fayContext.request, "fay@example.com");
  await fay.getByRole("button", { name: "Accept and open the workspace" }).click();
  await expect(fay.locator("#main")).toBeVisible();
  await expect(fay.locator("footer.app-footer")).toContainText(
    "Signed in as fay@example.com · Accountant",
  );

  // The owner sees her among the people, no longer waiting.
  await page.reload();
  const people = page.getByRole("list", { name: "People who can open Erin Ltd" });
  const row = people.getByRole("listitem").filter({ hasText: "fay@example.com" });
  await expect(row).toBeVisible();
  await expect(page.getByRole("heading", { name: "Waiting to join" })).toHaveCount(0);

  // Her role is changed from the list: a member reads and drafts.
  await row.getByRole("combobox").click();
  await page.getByRole("option", { name: "Member" }).click();
  await expect(page.getByText("fay@example.com is now member.")).toBeVisible();
  await fay.reload();
  await expect(fay.locator("footer.app-footer")).toContainText(
    "Signed in as fay@example.com · Member",
  );
  // She may read and draft, not take the books away: the Workspace page says so and has no button.
  await fay.goto(`${base}/settings/workspace`);
  await expect(
    fay.getByText("Only an owner or an administrator can export the books."),
  ).toBeVisible();
  await expect(fay.getByRole("button", { name: "Export your books" })).toHaveCount(0);
  // Her own Members page lists the people, offers her no form and no one to remove, and lets her leave.
  await fay.goto(`${base}/settings/members`);
  await expect(fay.getByRole("heading", { level: 1, name: "Members" })).toBeVisible();
  await expect(fay.getByRole("heading", { name: "Invite someone" })).toHaveCount(0);
  await expect(fay.getByRole("button", { name: "Leave" })).toBeVisible();
  await expect(fay.getByRole("button", { name: /^Remove/ })).toHaveCount(0);
  await expect(fay.getByRole("combobox")).toHaveCount(0);

  // The owner takes her out, after being asked to be sure.
  await row.getByRole("button", { name: "Remove fay@example.com" }).click();
  const confirm = page.getByRole("alertdialog", { name: "Remove fay@example.com?" });
  await expect(confirm).toBeVisible();
  await confirm.getByRole("button", { name: "Cancel" }).click();
  await expect(row).toBeVisible();
  await row.getByRole("button", { name: "Remove fay@example.com" }).click();
  await page
    .getByRole("alertdialog", { name: "Remove fay@example.com?" })
    .getByRole("button", { name: "Remove" })
    .click();
  await expect(page.getByText("fay@example.com no longer has access.")).toBeVisible();
  await expect(people.getByRole("listitem").filter({ hasText: "fay@example.com" })).toHaveCount(0);

  // Fay's page, which still holds a token that has not run out, asks for something: the pod says she is not a member, the control plane will not give a new token, and the page
  // takes her to the place where she chooses a workspace. She has none now.
  // (The page may ask by itself first, as it does when the window is used again, and be on its way out before the click gets there: either is the page being refused, which is what is held.)
  await fay
    .getByRole("navigation", { name: "Main navigation" })
    .getByRole("link", { name: "Accounts", exact: true })
    .click({ timeout: 3_000 })
    .catch(() => undefined);
  await expect(gateHeading(fay, "Create your workspace")).toBeVisible();
  expect(await fay.evaluate(() => window.localStorage.getItem("rastrata:workspace"))).toBeNull();
  expect(fayWatched.problems.filter((line) => !/not_a_member|403/.test(line))).toEqual([]);
  await fayContext.close();
  expect(watched.problems).toEqual([]);
});

test("an owner deletes the workspace by typing its name, the page leaves for the list where it is shown as being deleted, the owner brings it back, and when the days are over it is gone", async ({
  page,
  context,
  browser,
}) => {
  const watched = await watch(page);
  await startOut(page, context.request, "gus@example.com", "Gus Garage");
  // A member of it, in a browser of her own: she will see it being deleted, and has no way back.
  const workspace = (await inPage(page, "/auth/workspaces")).body.workspaces[0].id as string;
  const invited = await inPage(page, "/auth/invitations", {
    method: "POST",
    body: { workspace, email: "hana@example.com", role: "member" },
  });
  expect(invited.status).toBe(201);
  const mail = await mailTo(context.request, "hana@example.com", /\/invite\//);
  const link = /(https:\/\/localhost:\d+\/invite\/[\w-]{43})/.exec(mail.text)?.[1] as string;
  const hanaContext = await browser.newContext();
  const hana = await hanaContext.newPage();
  await hana.goto(link);
  await signUp(hana, hanaContext.request, "hana@example.com");
  await hana.getByRole("button", { name: "Accept and open the workspace" }).click();
  await expect(hana.locator("#main")).toBeVisible();

  // Settings, Workspace: the form that deletes it, which says what will happen, and does nothing until the name is typed.
  await page.goto(`${base}/settings/workspace`);
  await expect(page.getByRole("heading", { name: "Delete this workspace" })).toBeVisible();
  await expect(page.getByText(/after that they are erased/)).toBeVisible();
  const confirm = page.getByLabel('Type "Gus Garage" to confirm');
  const remove = page.getByRole("button", { name: "Delete this workspace" });
  await expect(remove).toBeDisabled();
  await confirm.fill("Gus Garag");
  await expect(remove).toBeDisabled();
  await scan(page, "the workspace page with the delete form");
  await confirm.fill("Gus Garage");
  await expect(remove).toBeEnabled();
  await remove.click();

  // The page leaves for the list of workspaces: this one is there, with its date, and is not opened.
  await expect(gateHeading(page, "Choose a workspace")).toBeVisible();
  const row = page.getByRole("listitem").filter({ hasText: "Gus Garage" });
  await expect(row).toContainText("Being deleted");
  await expect(row.getByRole("button", { name: "Bring back Gus Garage" })).toBeVisible();
  await expect(row.getByRole("button", { name: /^Open/ })).toHaveCount(0);
  await scan(page, "the list with a workspace being deleted");

  // Hana, who had it open, is taken out of it on her next request: the pod says it is closed, the control plane will not give her a token, and her page leaves.
  await hana
    .getByRole("navigation", { name: "Main navigation" })
    .getByRole("link", { name: "Accounts", exact: true })
    .click();
  await expect(
    gateHeading(hana, "Create your workspace").or(gateHeading(hana, "Choose a workspace")),
  ).toBeVisible();
  const hanaRow = hana.getByRole("listitem").filter({ hasText: "Gus Garage" });
  if (await hanaRow.count()) {
    await expect(hanaRow).toContainText("Being deleted");
    await expect(hanaRow.getByRole("button")).toHaveCount(0);
  }

  // The owner brings it back and opens it: the books are as they were.
  await row.getByRole("button", { name: "Bring back Gus Garage" }).click();
  await expect(row.getByRole("button", { name: "Open Gus Garage" })).toBeVisible();
  await row.getByRole("button", { name: "Open Gus Garage" }).click();
  await expect(page.locator("#main")).toBeVisible();
  await expect(page.getByText("Gus Garage").first()).toBeVisible();

  // Deleted again, and this time left: when the days are over the workspace is not in any list.
  await page.goto(`${base}/settings/workspace`);
  await page.getByLabel('Type "Gus Garage" to confirm').fill("Gus Garage");
  await page.getByRole("button", { name: "Delete this workspace" }).click();
  await expect(gateHeading(page, "Choose a workspace")).toBeVisible();
  await expect
    .poll(
      async () =>
        (await inPage(page, "/auth/workspaces")).body.workspaces.some(
          (w: { id: string }) => w.id === workspace,
        ),
      { timeout: 30_000, intervals: [500] },
    )
    .toBe(false);
  await page.reload();
  await expect(gateHeading(page, "Create your workspace")).toBeVisible();
  await hanaContext.close();
  expect(watched.problems.filter((line) => !/\b(410|409)\b/.test(line))).toEqual([]);
});

test("a person deletes their account from the list of workspaces: told they are the only owner of one, deletes it, then the account, and the same address starts again with nothing", async ({
  page,
  context,
}) => {
  const watched = await watch(page);
  await startOut(page, context.request, "ivy@example.com", "Ivy Interiors");
  // The application has kept what it read on this device.
  await expect
    .poll(async () => (await whatIsKept(page)).count, { timeout: 10_000 })
    .toBeGreaterThan(0);

  // The account's page, from the foot of the list: a button, and a dialog that says what will happen and does nothing until the address is typed (in any case).
  await page.goto(`${base}/start?choose=1`);
  await expect(gateHeading(page, "Choose a workspace")).toBeVisible();
  await page.getByRole("button", { name: "Account", exact: true }).click();
  await expect(page.getByRole("heading", { name: "Account", exact: true })).toBeVisible();
  await page.getByRole("button", { name: "Delete account" }).click();
  const dialog = page.getByRole("alertdialog", { name: "Delete your account?" });
  await expect(dialog).toBeVisible();
  const confirm = dialog.getByLabel("Type your email to confirm");
  const remove = dialog.getByRole("button", { name: "Delete account" });
  await expect(remove).toBeDisabled();
  await confirm.fill("ivy@example.co");
  await expect(remove).toBeDisabled();
  await confirm.fill("IVY@Example.com");
  await expect(remove).toBeEnabled();
  await remove.click();

  // The only owner of a workspace in use: told which, and nothing was done.
  const blocked = dialog.getByRole("alert").filter({ hasText: "only owner of a workspace" });
  await expect(blocked).toBeVisible();
  await expect(blocked.getByRole("listitem")).toHaveText(["Ivy Interiors"]);
  await scan(page, "the account's dialog with its refusal");
  expect((await inPage(page, "/auth/get-session")).body.user.email).toBe("ivy@example.com");
  await dialog.getByRole("button", { name: "Cancel" }).click();
  await page.getByRole("button", { name: "Back to workspaces" }).click();

  // Delete the workspace (inside it, in Settings), and the page leaves for the list, where it is being deleted.
  await page.getByRole("button", { name: "Open Ivy Interiors" }).click();
  await expect(page.locator("#main")).toBeVisible();
  await page.goto(`${base}/settings/workspace`);
  await page.getByLabel('Type "Ivy Interiors" to confirm').fill("Ivy Interiors");
  await page.getByRole("button", { name: "Delete this workspace" }).click();
  await expect(gateHeading(page, "Choose a workspace")).toBeVisible();

  // Now the account may go: every session ends, and the page is the sign-in page.
  await page.getByRole("button", { name: "Account", exact: true }).click();
  await page.getByRole("button", { name: "Delete account" }).click();
  await dialog.getByLabel("Type your email to confirm").fill("ivy@example.com");
  await dialog.getByRole("button", { name: "Delete account" }).click();
  await expect(page.getByLabel("Email address")).toBeVisible();
  expect((await inPage(page, "/auth/get-session")).body).toBeNull();
  // Nothing of the books they had stays on this device (the sign-in page does not hold the application's code, and deletes what it left).
  expect((await whatIsKept(page)).count).toBe(0);
  const goodbye = await mailTo(context.request, "ivy@example.com", /has been deleted/);
  expect(goodbye.subject).toContain("deleted");

  // The same address starts again with nothing: a new account, and the form to make its first workspace.
  await signUp(page, context.request, "ivy@example.com");
  await expect(gateHeading(page, "Create your workspace")).toBeVisible();
  expect((await inPage(page, "/auth/workspaces")).body.workspaces).toEqual([]);
  expect(watched.problems.filter((line) => !/\b(410|409|401)\b/.test(line))).toEqual([]);
});

test("signing out of every browser from the list ends the session in the other browser too, and the next sign-in finds the workspace again", async ({
  page,
  context,
  browser,
}) => {
  const watched = await watch(page);
  await startOut(page, context.request, "kit@example.com", "Kit Kitchens");
  await expect
    .poll(async () => (await whatIsKept(page)).count, { timeout: 10_000 })
    .toBeGreaterThan(0);
  // The same person in a second browser, signed in.
  const otherContext = await browser.newContext({ ignoreHTTPSErrors: true });
  const other = await otherContext.newPage();
  await other.goto(`${base}/`);
  await signUp(other, otherContext.request, "kit@example.com");
  await expect(
    other.getByRole("heading", { name: "Choose a workspace" }).or(other.locator("#main")),
  ).toBeVisible();
  expect((await inPage(other, "/auth/get-session")).body.user.email).toBe("kit@example.com");

  await page.goto(`${base}/start?choose=1`);
  await page.getByRole("button", { name: "Account", exact: true }).click();
  await page.getByRole("button", { name: "Sign out of every browser" }).click();
  await expect(page.getByLabel("Email address")).toBeVisible();
  await expect(page.getByText("You were signed out of every browser.")).toBeVisible();
  // Nor does this device keep anything of the book they were in.
  expect((await whatIsKept(page)).count).toBe(0);
  expect((await inPage(page, "/auth/get-session")).body).toBeNull();
  expect((await inPage(other, "/auth/get-session")).body).toBeNull();

  // Signing in again finds the workspace: only the sessions went. (The page was asked for the list, so it shows it and opens nothing by itself.)
  await signUp(page, context.request, "kit@example.com");
  await expect(gateHeading(page, "Choose a workspace")).toBeVisible();
  await expect(page.getByRole("button", { name: "Open Kit Kitchens" })).toBeVisible();
  expect((await inPage(page, "/auth/workspaces")).body.workspaces).toHaveLength(1);
  await otherContext.close();
  expect(watched.problems.filter((line) => !/\b(410|409|401)\b/.test(line))).toEqual([]);
});

test("a person adds a passkey on this device, signs out and signs in with it alone, with no code mailed; removed, it signs in no more", async ({
  page,
  context,
  browserName,
}) => {
  // Only Chromium can be given a device to answer the browser's passkey dialog (a virtual authenticator); the others have no such control to drive.
  test.skip(
    browserName !== "chromium",
    "the browser's passkey dialog can only be answered in Chromium",
  );
  const watched = await watch(page);
  // The button is for a browser that cannot suggest a passkey in the email field: this one is made to be such a browser.
  await page.addInitScript(() => {
    Object.defineProperty(PublicKeyCredential, "isConditionalMediationAvailable", {
      value: async () => false,
    });
  });
  await startOut(page, context.request, "pia@example.com", "Pia Pottery");
  // A device that checks who holds it and finds a passkey by the site alone, as a phone or a laptop with a fingerprint reader does.
  const cdp = await context.newCDPSession(page);
  await cdp.send("WebAuthn.enable");
  await cdp.send("WebAuthn.addVirtualAuthenticator", {
    options: {
      protocol: "ctap2",
      transport: "internal",
      hasResidentKey: true,
      hasUserVerification: true,
      isUserVerified: true,
      automaticPresenceSimulation: true,
    },
  });

  await page.goto(`${base}/start?choose=1`);
  await expect(gateHeading(page, "Choose a workspace")).toBeVisible();
  await page.getByRole("button", { name: "Account", exact: true }).click();
  await expect(
    page.getByText("Sign in with your face, your finger or your screen lock."),
  ).toBeVisible();
  await scan(page, "the account's page, with no passkey");
  await page.getByRole("button", { name: "Add a passkey" }).click();
  await expect(page.getByText("The passkey was added.")).toBeVisible();
  await expect(page.getByRole("list", { name: "Your passkeys" }).getByRole("listitem")).toHaveCount(
    1,
  );
  // The address was told: a passkey is a way in that outlasts the session.
  await mailTo(context.request, "pia@example.com", /sign in with your passkey/);
  await scan(page, "the account's page with a passkey");

  // Signed out, the page offers the passkey, and it signs in without a code.
  await page.getByRole("button", { name: "Back to workspaces" }).click();
  await page.getByRole("button", { name: "Sign out", exact: true }).click();
  await expect(page.getByLabel("Email address")).toBeVisible();
  const sent = await mailCount(context.request);
  await scan(page, "the address step with the passkey button");
  await page.getByRole("button", { name: "Sign in with a passkey" }).click();
  await expect(gateHeading(page, "Choose a workspace")).toBeVisible();
  expect(await mailCount(context.request)).toBe(sent);
  expect((await inPage(page, "/auth/get-session")).body.user.email).toBe("pia@example.com");

  // Removed, it is not known here: the device still offers it, and the service says so, in a line that points to the code.
  await page.getByRole("button", { name: "Account", exact: true }).click();
  await page.getByRole("button", { name: /^Remove passkey/ }).click();
  await expect(page.getByText("The passkey was removed.")).toBeVisible();
  await page.getByRole("button", { name: "Back to workspaces" }).click();
  await page.getByRole("button", { name: "Sign out", exact: true }).click();
  await page.getByRole("button", { name: "Sign in with a passkey" }).click();
  await expect(
    page.getByText("That passkey is not known here. Ask for a code instead."),
  ).toBeVisible();
  expect((await inPage(page, "/auth/get-session")).body).toBeNull();
  expect(watched.problems.filter((line) => !/\b(410|409|401|400)\b/.test(line))).toEqual([]);
});

test("right after a first code a new person is offered a passkey, makes it with the device's own check, and the next time the email field's suggestion signs them in with no code", async ({
  page,
  context,
  browserName,
}) => {
  test.skip(
    browserName !== "chromium",
    "the browser's passkey dialog can only be answered in Chromium",
  );
  const watched = await watch(page);
  // This browser has not said "Not now" (the setting made for every test is taken back).
  await page.addInitScript(() => localStorage.removeItem("rastrata-passkey-declined"));
  const cdp = await context.newCDPSession(page);
  await cdp.send("WebAuthn.enable");
  await cdp.send("WebAuthn.addVirtualAuthenticator", {
    options: {
      protocol: "ctap2",
      transport: "internal",
      hasResidentKey: true,
      hasUserVerification: true,
      isUserVerified: true,
      automaticPresenceSimulation: true,
    },
  });
  await page.goto(`${base}/`);
  // A browser that suggests passkeys in the email field shows no passkey button: a stranger is not offered a way in that cannot work for them.
  await expect(page.getByLabel("Email address")).toHaveAttribute("autocomplete", "email webauthn");
  await expect(page.getByRole("button", { name: "Sign in with a passkey" })).toHaveCount(0);
  await signUp(page, context.request, "quin@example.com");
  await expect(gateHeading(page, "Sign in faster next time")).toBeVisible();
  await scan(page, "the passkey offer");
  await page.getByRole("button", { name: "Make a passkey" }).click();
  await expect(gateHeading(page, "Create your workspace")).toBeVisible();
  await mailTo(context.request, "quin@example.com", /sign in with your passkey/);
  await page.getByLabel("Workspace name").fill("Quin Studio");
  await page.getByRole("button", { name: "Create workspace" }).click();
  await expect(page.locator("#main")).toBeVisible();
  const signedIn = await inPage(page, "/auth/get-session");
  expect(signedIn.body.user.email).toBe("quin@example.com");

  // The next time: signed out, the page waits for the passkey among the email field's suggestions.
  await context.clearCookies();
  const sent = await mailCount(context.request);
  await page.goto(`${base}/`);
  // Chromium's virtual device answers a waiting request as a person choosing the suggestion would: the passkey signs them in and the workspace opens, with no code mailed.
  await expect(page.locator("#main")).toBeVisible();
  expect((await inPage(page, "/auth/get-session")).body.user.email).toBe("quin@example.com");
  expect(await mailCount(context.request)).toBe(sent);
  expect(watched.problems.filter((line) => !/\b(410|409|401|400)\b/.test(line))).toEqual([]);
});

test("an owner connects an agent with a code that works once: the command line exchanges it for a key the page never sees, the page says so with no reload, the agent works with exactly what was chosen, and disconnecting ends it", async ({
  page,
  context,
}) => {
  const watched = await watch(page);
  await startOut(page, context.request, "agnes@example.com", "Agnes Studio");

  // The way in is Settings, then Agents: three steps, the usual choice made, one main button, nothing connected.
  await page.goto(`${base}/settings`);
  await page
    .getByRole("navigation", { name: "Settings", exact: true })
    .getByRole("link", { name: "Agents", exact: true })
    .click();
  await expect(page.getByRole("heading", { level: 1, name: "Agents" })).toBeVisible();
  await expect(page.locator(".rt-agent-step-title")).toHaveText([
    "What may it do?",
    "Run this where your agent works",
    "Then ask it",
  ]);
  const choices = page.getByRole("radiogroup", { name: "What may it do?" });
  // The owner may give all three; none of them closes a month.
  await expect(choices.getByRole("radio")).toHaveCount(3);
  await expect(choices.getByRole("radio", { name: /Prepare, for my approval/ })).toBeChecked();
  await expect(page.getByText("Nothing is connected yet.")).toBeVisible();
  const command = page.locator(".rt-agent-code");
  await expect(command).toHaveCount(0);
  // The command needs the command line: the way to get it is beside the button, and opens in a tab of its own.
  const install = page.getByRole("link", { name: "Install the command line" });
  await expect(install).toHaveAttribute("href", "https://rastrata.com/install/#command-line");
  await expect(install).toHaveAttribute("target", "_blank");
  await scan(page, "agents, at rest");

  // The one main button gives the one command. Its code is not a credential: it works once, for ten minutes.
  await page.getByRole("button", { name: "Get the command" }).click();
  await expect(command).toBeVisible();
  const shown = ((await command.textContent()) ?? "").trim();
  const code =
    /^rastrata connect ([0-9A-HJKMNP-TV-Z]{4}-[0-9A-HJKMNP-TV-Z]{4}-[0-9A-HJKMNP-TV-Z]{4}) --endpoint (\S+)$/.exec(
      shown,
    );
  expect(code, shown).not.toBeNull();
  // A workspace that is not at the service's own address names its address in the command.
  expect(code?.[2]).toBe(base);
  await expect(page.getByText("The code works once, for ten minutes.")).toBeVisible();
  await expect(page.getByRole("button", { name: "Get the command" })).toHaveCount(0);
  await scan(page, "agents, the command");

  // The command line, with no cookie and no page: the code for a key, named for where the agent runs.
  const program = await playwrightRequest.newContext({ ignoreHTTPSErrors: true });
  const connect = (name: string, with_ = code?.[1]) =>
    program.post(`${base}/auth/agent-connect`, { data: { code: with_, name } });
  const connected = await connect("Agent on studio-mac");
  expect(connected.status(), await connected.text()).toBe(201);
  const made = (await connected.json()) as Json;
  const secret = made.secret as string;
  expect(secret).toMatch(/^rsa_[0-9a-f]{16}_[A-Za-z0-9_-]{43}$/);
  expect(made.workspace.name).toBe("Agnes Studio");
  expect(made.key.scopes).toEqual(["read", "draft"]);
  // A second command with the same code is told it was used, in words.
  const again = await connect("Another");
  expect(again.status()).toBe(401);
  expect((await again.json()) as Json).toEqual({
    code: "code_used",
    message: "This code was already used. Get a new one in your workspace.",
  });

  // The page, which the person left open, says so by itself: the code goes, the agent is named and listed.
  await expect(page.getByText("Agent on studio-mac is connected.")).toBeVisible({
    timeout: 20_000,
  });
  await expect(command).toHaveCount(0);
  const row = page.locator(".rt-agent-connected-row").filter({ hasText: "Agent on studio-mac" });
  await expect(row).toContainText("Prepare");
  // It is the person's own, so nothing says whose; being listed is being connected, so nothing says "active".
  await expect(row).not.toContainText(/agnes@example\.com|Active/);
  await expect(page.getByRole("button", { name: "Connect another" })).toBeVisible();
  await scan(page, "agents, one connected");

  // The agent: exchanges the key for a token, and works in the book with what was chosen.
  const exchange = async (key = secret) =>
    program.post(`${base}/auth/agent-token`, { data: { key } });
  const exchanged = await exchange();
  expect(exchanged.status(), await exchanged.text()).toBe(200);
  const { token, expiresIn } = (await exchanged.json()) as { token: string; expiresIn: number };
  expect(expiresIn).toBe(300);
  const operation = async (name: string, input: unknown = {}, id?: string) =>
    program.post(`${base}/v1/${name}`, {
      headers: { authorization: `Bearer ${token}` },
      data: { version, bookId: "local-book", input, ...(id ? { operationId: id } : {}) },
    });
  const context1 = await operation("book.get");
  expect(context1.status()).toBe(200);
  const seen = ((await context1.json()) as Json).data;
  expect(seen.principal).toMatchObject({ kind: "token", label: "Agent on studio-mac" });
  expect(seen.permissions).toEqual(["read", "draft"]);
  // It cannot post, though its person, the owner, can.
  const refused = await operation("journal.post", {}, crypto.randomUUID());
  expect(refused.status()).toBe(403);

  // The key was never in the page: not in what it shows, not in what it keeps.
  await expect(page.locator("body")).not.toContainText(secret.slice(-20));
  expect(
    await page.evaluate(() => JSON.stringify({ ...localStorage, ...sessionStorage })),
  ).not.toContain(secret.slice(-20));
  // An owner reads what agents changed where changes are listed.
  await expect(page.getByRole("link", { name: "What agents changed" })).toHaveAttribute(
    "href",
    "/changes?who=agent",
  );

  // Another, that runs the books: the choice is in the code.
  await choices.getByRole("radio", { name: /Run the books/ }).check({ force: true });
  await expect(page.locator(".rt-agent-ask")).toHaveText("“Do this week’s bookkeeping.”");
  await page.getByRole("button", { name: "Get the command" }).click();
  await expect(command).toBeVisible();
  const next = /connect (\S+)/.exec((await command.textContent()) ?? "")?.[1];
  // Changing one's mind takes the code off the screen (it was made for the other choice), and asking again ends it.
  await choices.getByRole("radio", { name: "Read only." }).check({ force: true });
  await expect(command).toHaveCount(0);
  await choices.getByRole("radio", { name: /Run the books/ }).check({ force: true });
  await page.getByRole("button", { name: "Get the command" }).click();
  await expect(command).toBeVisible();
  const latest = /connect (\S+)/.exec((await command.textContent()) ?? "")?.[1];
  expect(latest).not.toBe(next);
  expect((await connect("Old code", next)).status()).toBe(401);
  const second = await connect("Codex weekly routine", latest);
  expect(second.status(), await second.text()).toBe(201);
  expect(((await second.json()) as Json).key.scopes).toEqual(["read", "draft", "post"]);
  const routine = page
    .locator(".rt-agent-connected-row")
    .filter({ hasText: "Codex weekly routine" });
  await expect(routine).toContainText("Run the books", { timeout: 20_000 });

  // Disconnected from the page, after one question: it is gone from the list, and its next exchange is refused.
  await page.getByRole("button", { name: "Disconnect Agent on studio-mac" }).click();
  const dialog = page.getByRole("alertdialog", { name: "Disconnect Agent on studio-mac?" });
  await expect(dialog.getByRole("button", { name: "Keep it" })).toBeFocused();
  await scan(page, "agents, disconnecting");
  await dialog.getByRole("button", { name: "Disconnect", exact: true }).click();
  await expect(dialog).toHaveCount(0);
  await expect(row).toHaveCount(0);
  await expect(routine).toHaveCount(1);
  const after = await exchange();
  expect(after.status()).toBe(401);
  expect(((await after.json()) as Json).code).toBe("key_revoked");
  await program.dispose();
  expect(watched.problems).toEqual([]);
});

test("the Agents page of a workspace whose book is not set up yet is the same three steps, with nothing connected and nothing said to have failed", async ({
  page,
  context,
}) => {
  const watched = await watch(page);
  await page.goto(`${base}/`);
  await signUp(page, context.request, "nina@example.com");
  await expect(gateHeading(page, "Create your workspace")).toBeVisible();
  await page.getByLabel("Workspace name").fill("Nina Books");
  await page.getByRole("button", { name: "Create workspace" }).click();
  await expect(page.locator("#main")).toBeVisible();
  await page.goto(`${base}/settings/agent`);
  await expect(page.getByRole("heading", { level: 1, name: "Agents" })).toBeVisible();
  await expect(page.getByRole("button", { name: "Get the command" })).toBeVisible();
  await expect(page.getByText("Nothing is connected yet.")).toBeVisible();
  await expect(page.getByRole("alert")).toHaveCount(0);
  expect(watched.problems).toEqual([]);
});

test("Close the books in a hosted workspace asks for no backup, and the old address of the month checklist opens it", async ({
  page,
  context,
}) => {
  const watched = await watch(page);
  await page.goto(`${base}/`);
  await signUp(page, context.request, "nora@example.com");
  await expect(gateHeading(page, "Create your workspace")).toBeVisible();
  await page.getByLabel("Workspace name").fill("Nora Studio");
  await page.getByRole("button", { name: "Create workspace" }).click();
  await expect(page.locator("#main")).toBeVisible();
  // The setup wizard, with what it offers.
  await page.getByRole("textbox", { name: "Business name" }).fill("Nora Studio");
  for (let step = 0; step < 3; step += 1)
    await page.getByRole("button", { name: "Continue", exact: true }).click();
  await page.getByRole("button", { name: "Create book", exact: true }).first().click();
  await expect(page.locator(".app-book-name")).toHaveText("Nora Studio");

  await page.goto(`${base}/cutover`);
  await expect(page).toHaveURL(/\/periods$/);
  await expect(page.getByRole("heading", { level: 1, name: "Close the books" })).toBeVisible();
  // A new book has no month to close, and the page says so once.
  await expect(page.locator("#rt-close-through")).toContainText("Nothing to close yet.");
  // The service keeps the history of the books itself: nothing here speaks of a backup.
  await expect(page.getByText(/backup/i)).toHaveCount(0);
  await scan(page, "close the books, a hosted workspace");
  expect(watched.problems).toEqual([]);
});

test("an accountant who joins before the books are set up is told that an owner sets them up and is not given a form that would be refused, and once they are set up the Business page shows them and says who changes them", async ({
  page,
  context,
  browser,
}) => {
  const watched = await watch(page);
  await page.goto(`${base}/`);
  await signUp(page, context.request, "rhea@example.com");
  await expect(gateHeading(page, "Create your workspace")).toBeVisible();
  await page.getByLabel("Workspace name").fill("Rhea Ltd");
  await page.getByRole("button", { name: "Create workspace" }).click();
  await expect(page.locator("#main")).toBeVisible();
  // The owner invites an accountant before the books are set up.
  const list = await inPage(page, "/auth/workspaces");
  const workspace = list.body.workspaces[0].id as string;
  const invited = await inPage(page, "/auth/invitations", {
    method: "POST",
    body: { workspace, email: "sol@example.com", role: "accountant" },
  });
  expect(invited.status).toBe(201);
  const mail = await mailTo(context.request, "sol@example.com", /\/invite\//);
  const link = /(https:\/\/localhost:\d+\/invite\/[\w-]{43})/.exec(mail.text)?.[1] as string;

  const quinnContext = await browser.newContext();
  const quinn = await quinnContext.newPage();
  const quinnWatched = await watch(quinn);
  await quinn.goto(link);
  await signUp(quinn, quinnContext.request, "sol@example.com");
  await quinn.getByRole("button", { name: "Accept and open the workspace" }).click();
  await expect(quinn.locator("#main")).toBeVisible();
  // An accountant may not set the books up (that is the owner's), so there is no setup to fill in: they are told who does.
  await expect(quinn.getByText("The books are not set up yet")).toBeVisible();
  await expect(quinn.getByRole("heading", { name: "Set up your books" })).toHaveCount(0);
  await scan(quinn, "an accountant before the books are set up");
  // What the accountant's page has read is kept on the device (the books are not set up): it is what the page opened again will start from.
  await expect
    .poll(async () => (await whatIsKept(quinn)).count, { timeout: 10_000 })
    .toBeGreaterThan(0);

  // The owner sets the books up. The accountant reads them, and the Business page, which an accountant may not change, says who does.
  await setUpBook(page, "Rhea Ltd");
  // The page is opened again from what it kept (the books were not set up), and what says who is signed in takes its time: the service has said the books are set up long before the page is drawn,
  // and the page must be drawn from what it said (the runners found a page that kept what it had kept).
  await quinn.route("**/auth/get-session", async (route) => {
    await new Promise((done) => setTimeout(done, 800));
    await route.continue().catch(() => undefined);
  });
  await quinn.reload();
  await expect(quinn.locator(".app-book-name")).toHaveText("Rhea Ltd");
  await quinn.unroute("**/auth/get-session");
  await quinn.goto(`${base}/settings`);
  await expect(quinn.getByText("Only an owner or an administrator changes these")).toBeVisible();
  await expect(quinn.getByRole("textbox", { name: "Business name" })).toHaveCount(0);
  await expect(quinn.getByRole("button", { name: "Save changes" })).toHaveCount(0);
  await expect(quinn.getByText("Rhea Ltd").first()).toBeVisible();
  await scan(quinn, "business settings, read only");
  // The owner still has the form.
  await page.goto(`${base}/settings`);
  await expect(page.getByRole("textbox", { name: "Business name" })).toBeVisible();
  await expect(page.getByText("Only an owner or an administrator changes these")).toHaveCount(0);
  expect(quinnWatched.problems).toEqual([]);
  await quinnContext.close();
  expect(watched.problems).toEqual([]);
});

test("when the service has a bad moment Home says so, and asks again when the person says to, without the page being reloaded", async ({
  page,
  context,
}) => {
  // (What the watch reports is not asserted here: the busy answer the test makes is a failed request on purpose. It is what puts the accessibility scan on the page.)
  await watch(page);
  await startOut(page, context.request, "tess@example.com", "Tess Ltd");
  let failing = true;
  await page.route("**/v1/book.get", (route) =>
    failing
      ? route.fulfill({
          status: 503,
          headers: { "content-type": "application/json", "retry-after": "1" },
          body: JSON.stringify({
            version,
            bookId: "local-book",
            ok: false,
            error: {
              code: "server_busy",
              message: "The server is busy with other books; try again in a moment.",
              details: [],
              retryable: true,
            },
          }),
        })
      : route.continue(),
  );
  await page.goto(`${base}/`);
  await expect(page.getByText("Book unavailable")).toBeVisible();
  await expect(page.getByText("The server is busy with other books")).toBeVisible();
  await scan(page, "home, the service busy");
  failing = false;
  await page.getByRole("button", { name: "Try again" }).click();
  await expect(page.locator(".app-book-name")).toHaveText("Tess Ltd");
  await expect(page.getByText("Book unavailable")).toHaveCount(0);
});

test("a first draw that waits over a second shows a rule across the top, never before the second and gone when the page is drawn, on the application and on the sign-in page", async ({
  page,
  context,
}) => {
  test.setTimeout(120_000);
  type Note = { ranAt: number | null; drawnAt: number | null };
  // What the empty page's mark did, noted at every frame until something is drawn into the root: when it first ran (an animation of the root's ::after in its active phase,
  // which is after the delay) and when the page was drawn.
  await page.addInitScript(() => {
    const note: Note = { ranAt: null, drawnAt: null };
    (window as unknown as { __mark: Note }).__mark = note;
    const look = () => {
      const root = document.getElementById("root");
      if (root && root.childElementCount > 0) {
        note.drawnAt = performance.now();
        return;
      }
      const running = document.getAnimations().some((animation) => {
        const effect = animation.effect as KeyframeEffect | null;
        return (
          effect?.pseudoElement === "::after" &&
          (animation as CSSAnimation).animationName.startsWith("rt-wait") &&
          effect.getComputedTiming().progress !== null
        );
      });
      if (running && note.ranAt === null) note.ranAt = performance.now();
      requestAnimationFrame(look);
    };
    requestAnimationFrame(look);
  });
  const mark = () => page.evaluate(() => (window as unknown as { __mark: Note }).__mark);
  const markStillThere = () =>
    page.evaluate(
      () =>
        document
          .getAnimations()
          .filter((animation) => (animation as CSSAnimation).animationName?.startsWith("rt-wait"))
          .length,
    );
  const slow = (pattern: string, ms: number) =>
    page.route(pattern, async (route) => {
      await new Promise((done) => setTimeout(done, ms));
      // (A request the page has given up on while it waited is already handled: that is not the test's to fail.)
      await route.continue().catch(() => undefined);
    });

  // A stranger's page waits on the service's answer: slow, it shows the rule, and when the sign-in is drawn the rule is gone.
  await slow("**/health", 1800);
  await page.goto(`${base}/`);
  await expect(gateHeading(page, "Sign in or create an account")).toBeVisible();
  let seen = await mark();
  expect(seen.ranAt).not.toBeNull();
  expect(seen.ranAt as number).toBeGreaterThanOrEqual(1000);
  expect(seen.drawnAt as number).toBeGreaterThan(seen.ranAt as number);
  expect(await markStillThere()).toBe(0);
  await page.unroute("**/health");

  // The application, with a book that is slow to open (the first visit after it was idle).
  await startOut(page, context.request, "lena@example.com", "Lena Co");
  await slow("**/v1/book.get", 2800);
  await page.reload();
  await expect(page.locator(".app-book-name")).toHaveText("Lena Co", { timeout: 20_000 });
  seen = await mark();
  expect(seen.ranAt).not.toBeNull();
  expect(seen.ranAt as number).toBeGreaterThanOrEqual(1000);
  expect(seen.drawnAt as number).toBeGreaterThan(seen.ranAt as number);
  expect(await markStillThere()).toBe(0);
  await page.unroute("**/v1/book.get");

  // A book that is open draws at once: nothing runs before the second, so a draw under a second never shows it.
  await page.reload();
  await expect(page.locator(".app-book-name")).toHaveText("Lena Co");
  seen = await mark();
  if ((seen.drawnAt as number) < 1000) expect(seen.ranAt).toBeNull();
  else expect(seen.ranAt === null || seen.ranAt >= 1000).toBe(true);
});

test("Changes in a workspace: the owner reads what an agent's key did, by its name, and says they looked; an accountant reads it without who has access and is not offered the look", async ({
  page,
  context,
  browser,
}) => {
  const watched = await watch(page);
  const workspace = await startOut(page, context.request, "cleo@example.com", "Cleo Studio");
  // The owner makes a key for an agent. A program with no cookie and no page exchanges it for a short-lived token and posts as the agent.
  const made = await inPage(page, "/auth/agent-keys", {
    method: "POST",
    body: { workspace, name: "weekly-run", scopes: ["read", "draft", "post"], expiresInDays: 30 },
  });
  expect(made.status, JSON.stringify(made.body)).toBe(201);
  const program = await playwrightRequest.newContext({ ignoreHTTPSErrors: true });
  const exchanged = await program.post(`${base}/auth/agent-token`, {
    data: { key: made.body.secret },
  });
  expect(exchanged.status(), await exchanged.text()).toBe(200);
  const { token } = (await exchanged.json()) as { token: string };
  const as = async (name: string, input: unknown) => {
    const response = await program.post(`${base}/v1/${name}`, {
      headers: { authorization: `Bearer ${token}` },
      data: { version, bookId: "local-book", input, operationId: crypto.randomUUID() },
    });
    expect(response.status(), `${name}: ${await response.text()}`).toBe(200);
    return ((await response.json()) as Json).data as Json;
  };
  const accounts = (await as("accounts.list", {})).accounts as { id: string; code: string }[];
  const id = (code: string) =>
    (accounts.find((account) => account.code === code) as { id: string }).id;
  const post = async (date: string, narration: string) => {
    const draft = await as("drafts.create", {
      data: {
        date,
        reference: narration.slice(0, 20),
        narration,
        lines: [
          { accountId: id("5000"), debit: "25.00", credit: "" },
          { accountId: id("1000"), debit: "", credit: "25.00" },
        ],
      },
    });
    const plan = await as("journal.prepare", { draftId: draft.id, expectedVersion: draft.version });
    const receipt = await as("operations.commit", {
      planId: plan.planId,
      planHash: plan.planHash,
    });
    expect(receipt.disposition).toBe("committed");
  };
  await post("2026-03-12", "ADOBE CREATIVE CLOUD");
  await post("2026-03-14", "NOTION LABS");

  // The owner: Home says what others changed, Changes lists it by the agent's name and the owner's own as "you".
  const line = page.locator('[data-need="changes"]');
  // A hosted book can have a bad moment under load (the page says so and offers to try again): the line is looked for again on a fresh page.
  await expect(async () => {
    await page.goto(`${base}/`);
    await expect(line).toContainText(
      "2 changes were made by others since you last looked: 2 by the agent weekly-run.",
      { timeout: 5_000 },
    );
  }).toPass({ timeout: 40_000 });
  await line.getByRole("link", { name: /Look at them/ }).click();
  await expect(page.getByRole("heading", { level: 1, name: "Changes" })).toBeVisible();
  const agentRows = page.locator('.rt-change[data-maker="agent"]');
  await expect(agentRows).toHaveCount(2);
  await expect(agentRows.first()).toContainText("By the agent weekly-run");
  await expect(page.locator(".rt-change", { hasText: "Opened the books" })).toContainText("By you");
  await scan(page, "changes, the owner");
  await page.screenshot({ path: test.info().outputPath("changes-owner.png"), fullPage: true });
  // The owner can read all of it, so they can say they looked, and Home no longer asks.
  await page.getByRole("button", { name: "I have looked at these" }).click();
  await expect(page.getByText(/^Saved\. You looked at everything up to/)).toBeVisible();
  await expect(page.getByText("Nothing has changed since you last looked")).toBeVisible();

  // An accountant joins. The agent posts once more.
  const invited = await inPage(page, "/auth/invitations", {
    method: "POST",
    body: { workspace, email: "ana@example.com", role: "accountant" },
  });
  expect(invited.status).toBe(201);
  const mail = await mailTo(context.request, "ana@example.com", /\/invite\//);
  const link = /(https:\/\/localhost:\d+\/invite\/[\w-]{43})/.exec(mail.text)?.[1] as string;
  const anaContext = await browser.newContext();
  const ana = await anaContext.newPage();
  const anaWatched = await watch(ana);
  await ana.goto(link);
  await signUp(ana, anaContext.request, "ana@example.com");
  await ana.getByRole("button", { name: "Accept and open the workspace" }).click();
  await expect(ana.locator("#main")).toBeVisible();
  await post("2026-03-18", "GITHUB TEAM");

  // The accountant reads the list; the agent keys are the owner's to see, so their changes are left out and
  // that is said in one quiet line, never as a failure to read; the look is not offered: what they did not see
  // would never be shown to the owner. Home does not ask them either.
  await ana.goto(`${base}/changes?since=all`);
  await expect(ana.getByRole("heading", { level: 1, name: "Changes" })).toBeVisible();
  await expect(ana.locator('.rt-change[data-maker="agent"]')).toHaveCount(3);
  await expect(
    ana.getByText("Changes to agent keys are shown to the owner.", { exact: true }),
  ).toBeVisible();
  await expect(ana.getByText(/could not be read/)).toHaveCount(0);
  await expect(ana.getByRole("button", { name: "I have looked at these" })).toHaveCount(0);
  await expect(ana.getByText(/cannot be marked as looked at/).first()).toBeVisible();
  await scan(ana, "changes, an accountant");
  await ana.screenshot({ path: test.info().outputPath("changes-accountant.png"), fullPage: true });
  await ana.goto(`${base}/`);
  await expect(ana.locator(".rt-today")).toHaveAttribute("data-read", "");
  // The list was read (it is not said to be unread) and was partial, so there is no line about it.
  await expect(ana.getByText(/What changed could not be checked/)).toHaveCount(0);
  await expect(ana.locator('[data-need="changes"]')).toHaveCount(0);
  // The owner is told about the one new change.
  await expect(async () => {
    await page.goto(`${base}/`);
    await expect(line).toContainText(
      "1 change was made by others since you last looked: 1 by the agent weekly-run.",
      { timeout: 5_000 },
    );
  }).toPass({ timeout: 40_000 });
  expect(anaWatched.problems).toEqual([]);
  await anaContext.close();
  await program.dispose();
  expect(watched.problems).toEqual([]);
});

/** Words that are true only of Rastrata on a person's own computer (the installed service, the development API). A
 * page of the hosted service must never show one, not even for the moment before it has read the book. */
const ONLY_ON_A_COMPUTER = [
  /this computer/i,
  /in a terminal/i,
  /rastrata doctor/i,
  /owner (key|lock|access)/i,
  /local (development )?application/i,
  /not configured/i,
  // The Agents page names the service's own address and the variables the command line reads: that is right here too.
  /RASTRATA_(?!API_URL|TOKEN)[A-Z_]+/,
  /\bbun run\b/,
  /installed (service|Rastrata)/i,
  /SimpleFIN/i,
  /this copy of Rastrata/i,
];

const EVERY_PAGE = [
  "/",
  "/inbox",
  "/journal",
  "/journal/new",
  "/accounts",
  "/ledger",
  "/periods",
  "/reports",
  "/reports/payees",
  "/rules",
  "/rules/new",
  "/changes",
  "/reconcile",
  "/import",
  "/opening",
  "/tie-out",
  "/tax",
  "/gaps",
  "/cutover",
  "/xero",
  "/settings",
  "/settings/workspace",
  "/settings/members",
  "/settings/billing",
  "/settings/agent",
  "/settings/banks",
  "/settings/stripe",
  "/settings/connections",
  "/settings/bankfeed",
  "/settings/backups",
  "/settings/move",
];

test("no page of the hosted service says anything that is true only on a person's own computer, not even while it opens, and none has an error", async ({
  page,
  request,
}) => {
  test.setTimeout(240_000);
  const watched = await watch(page);
  // Every text the page ever shows, however briefly: what is there when the document is read, and every text added after.
  await page.addInitScript(() => {
    const seen = new Set<string>();
    (window as unknown as { seenTexts: Set<string> }).seenTexts = seen;
    const note = (node: Node) => {
      const text =
        (node.nodeType === Node.ELEMENT_NODE
          ? (node as HTMLElement).innerText
          : node.textContent) ?? "";
      if (text.trim()) seen.add(text.trim());
    };
    new MutationObserver((changes) => {
      for (const change of changes) {
        if (change.type === "characterData") note(change.target);
        for (const added of change.addedNodes) note(added);
      }
    }).observe(document, { childList: true, subtree: true, characterData: true });
  });
  await startOut(page, request, "sweep@example.com", "Sweep Studio");
  const found: string[] = [];
  for (const path of EVERY_PAGE) {
    await page.goto(`${base}${path}`);
    await page.waitForLoadState("networkidle");
    await page.waitForTimeout(300);
    const texts = await page.evaluate(() => [
      ...(window as unknown as { seenTexts: Set<string> }).seenTexts,
      document.body.innerText,
    ]);
    for (const pattern of ONLY_ON_A_COMPUTER)
      for (const text of texts) {
        const hit = pattern.exec(text);
        if (hit) {
          const at = Math.max(0, hit.index - 60);
          found.push(`${path}: "${text.slice(at, hit.index + 80).replace(/\s+/g, " ")}"`);
          break;
        }
      }
    for (const problem of watched.problems.splice(0)) found.push(`${path}: ${problem}`);
  }
  expect([...new Set(found)]).toEqual([]);
});
