import { type ChildProcess, spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { join, resolve } from "node:path";
import { type APIRequestContext, expect, type Page, test } from "@playwright/test";
import axe from "axe-core";

// biome-ignore lint/suspicious/noExplicitAny: decoded JSON of many shapes
type Json = any;

declare global {
  interface Window {
    axe: typeof axe;
  }
}

/** Stripe connected with the button, in the whole product on this computer (apps/control-worker/tooling/dev-stack.ts with `--stripe-app`): the pod with accounts and many books, the control
 * Worker under workerd, the built web app, one address, a page that plays the Rastrata app's install page at Stripe, and a fake Stripe that serves a fictional month of payouts for the one account
 * that "installs" the app. One person signs up, makes a workspace and sets its book up; then the story runs once, in order, as a person would: nothing is connected, a person who changes their
 * mind, the install, the first reading, reading again, and stopping. The stack is served over https (`--tls`) for the same reason as the accounts spec's. */
test.describe.configure({ mode: "serial" });
test.use({ actionTimeout: 20_000 });

const version = "rastrata-application-v1";
const repository = resolve(process.cwd(), "../..");
const address = "owner@example.com";
const stripeAccount = "acct_1DevelopmentAccount001";
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
      "--tls",
      "--stripe-app",
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
  text: string;
}
/** The six-digit code in the newest mail to the address: the stack keeps what it would have sent. */
async function codeFor(request: APIRequestContext, to: string): Promise<string> {
  const deadline = Date.now() + 10_000;
  for (;;) {
    const all = (await (await request.get(`${base}/__dev/mail`)).json()) as Sent[];
    const found = [...all].reverse().find((mail) => mail.to === to);
    const code = found ? /\b(\d{6})\b/.exec(found.text)?.[1] : undefined;
    if (code) return code;
    if (Date.now() > deadline) throw new Error(`no mail with a code to ${to}`);
    await new Promise((done) => setTimeout(done, 100));
  }
}

/** Everything the browser says is wrong with a page. */
async function watch(page: Page) {
  const problems: string[] = [];
  page.on("console", (message) => {
    // A request that was cut off because the page moved on is not a fault of the page.
    if (
      message.type() === "error" &&
      !/^Failed to load resource|due to access control checks/.test(message.text())
    )
      problems.push(`console: ${message.text().slice(0, 200)}`);
  });
  page.on("pageerror", (error) => {
    if (!/due to access control checks/.test(error.message))
      problems.push(`error: ${error.message.slice(0, 200)}`);
  });
  await page.addInitScript(() => {
    document.addEventListener("securitypolicyviolation", (event) => {
      console.error(`policy: ${event.violatedDirective} blocked ${event.blockedURI}`);
    });
  });
  await page.addInitScript({ content: axe.source });
  return problems;
}

/** Where the looks of the page are written, when someone wants to look: `RASTRATA_LOOK=<folder>`. Every state of the screen at 1440, 390 and 360 pixels in both themes, which is what a visible
 * change is looked at in before it is shown. Without the setting nothing is written and nothing is slower. */
const lookFolder = process.env.RASTRATA_LOOK ?? "";
async function look(page: Page, name: string): Promise<void> {
  if (lookFolder === "") return;
  const size = page.viewportSize();
  // The theme is the document's own attribute (src/theme.ts): each is put on for its pictures, and what was there is put back.
  const was = await page.evaluate(() => document.documentElement.dataset.theme ?? "");
  for (const scheme of ["light", "dark"] as const) {
    await page.evaluate((theme) => {
      document.documentElement.dataset.theme = theme;
    }, scheme);
    for (const width of [1440, 390, 360]) {
      await page.setViewportSize({ width, height: width === 1440 ? 900 : 780 });
      await page.screenshot({
        path: join(lookFolder, `${name}-${width}-${scheme}.png`),
        fullPage: true,
      });
    }
  }
  await page.evaluate((theme) => {
    document.documentElement.dataset.theme = theme;
  }, was);
  if (size) await page.setViewportSize(size);
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

/** A request made from inside the page, as the application makes them: the browser sends its cookies. */
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

const role = (code: string, name: string, kind: string, roleKey?: string) => ({
  code,
  name,
  role: kind,
  ...(roleKey ? { tags: { roleKey } } : {}),
});

/** The book of an online business, its accounts tagged for Stripe as the chart template tags them, and Stripe's settings: the time zone, and the first day to read. The fictional month the fake
 * Stripe serves is March 2026, so the reading starts there and does not depend on the day the test runs. */
async function setUpBook(page: Page): Promise<void> {
  const list = await inPage(page, "/auth/workspaces");
  const workspace = list.body.workspaces[0].id as string;
  const issued = await inPage(page, "/auth/workspace-token", {
    method: "POST",
    body: { workspace },
  });
  expect(issued.status).toBe(200);
  const call = (name: string, input: unknown) =>
    inPage(page, `/v1/${name}`, {
      method: "POST",
      headers: { authorization: `Bearer ${issued.body.token}` },
      body: { version, bookId: "local-book", operationId: crypto.randomUUID(), input },
    });
  const setup = await call("book.setup", {
    name: "Acme Books",
    currency: "USD",
    fiscalYear: 2026,
    periodModel: "monthly",
    accounts: [
      role("1000", "Business checking", "asset"),
      role("1100", "Stripe balance", "asset", "stripe.balance"),
      role("1110", "Stripe payouts in transit", "asset", "payouts.in-transit"),
      role("2500", "Sales tax payable", "liability", "tax.sales"),
      role("3000", "Owner's equity", "equity"),
      role("4000", "Sales", "income", "revenue.sales"),
      role("4100", "Returns and allowances", "income", "refunds"),
      role("6025", "Stripe fees", "expense", "stripe.fees"),
      role("6026", "Chargebacks and disputes", "expense", "chargebacks"),
    ],
  });
  expect(setup.status).toBe(200);
  // Nothing is said to the book about Stripe: connecting it is all a person does, and the book reads it with its defaults.
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

test("an owner connects Stripe with the button, the first reading books every payout and the record says it finished, reading again books nothing twice, and stopping asks first", async ({
  page,
  request,
}) => {
  test.setTimeout(120_000);
  const problems = await watch(page);
  const main = page.locator("#main");
  // The account and its payouts, one block.
  const block = page.getByRole("region", { name: "Payouts" });
  const rows = block.getByRole("list", { name: "Stripe payouts" }).getByRole("listitem");
  const menu = page.getByRole("button", { name: "Actions for Stripe" });

  await test.step("a person signs up and has a workspace with a book", async () => {
    await page.goto(`${base}/`);
    await page.getByLabel("Email address").fill(address);
    await page.getByRole("button", { name: "Continue", exact: true }).click();
    await expect(page.getByRole("heading", { name: "Check your email" })).toBeVisible();
    const code = await codeFor(request, address);
    await page.getByLabel("Digit 1 of 6").click();
    await page.keyboard.type(code);
    await expect(page.getByRole("heading", { name: "Create your workspace" })).toBeVisible();
    await page.getByLabel("Workspace name").fill("Acme Books");
    await page.getByRole("button", { name: "Create workspace" }).click();
    await expect(page.locator("#main")).toBeVisible();
    await setUpBook(page);
  });

  await test.step("before anything is connected the page is one sentence and the button", async () => {
    await page.goto(`${base}/settings/stripe`);
    await expect(main.getByRole("button", { name: "Connect Stripe", exact: true })).toBeVisible();
    await expect(main.getByText("Import your Stripe payouts automatically.")).toBeVisible();
    // The title, the sentence and the button: nothing else is said, and nothing else can be pressed.
    await expect(main.getByRole("heading")).toHaveCount(1);
    await expect(main.locator("p")).toHaveCount(1);
    await expect(main.getByRole("button")).toHaveCount(1);
    // Nobody can run a sync here, so nothing asks for one, and no key is asked for.
    await expect(main).not.toContainText(/run a sync|sync now|sync again|key/i);
    await expect(page.locator("input[type=password]")).toHaveCount(0);
    await scan(page, "Stripe, not connected");
    await look(page, "1-not-connected");
  });

  await test.step("a person who changes their mind at Stripe's page comes back to the same page, and nothing is connected", async () => {
    await main.getByRole("button", { name: "Connect Stripe", exact: true }).click();
    await expect(page.getByRole("heading", { name: "Install Rastrata?" })).toBeVisible();
    // It is asked the way Stripe's page is: where to come back to, and a value that is this person's alone.
    const asked = new URL(page.url());
    expect(asked.pathname).toBe("/__dev/stripe-install");
    expect(asked.searchParams.get("redirect_uri")).toBe(`${base}/auth/stripe-app/return`);
    expect(asked.searchParams.get("state")?.length).toBeGreaterThan(20);
    await page.getByRole("link", { name: "Cancel" }).click();
    await expect(main.getByRole("button", { name: "Connect Stripe", exact: true })).toBeVisible();
    // They know what they did: the page says nothing of it, and the address no longer carries it.
    await expect(main.locator("p")).toHaveCount(1);
    expect(page.url()).toBe(`${base}/settings/stripe`);
  });

  await test.step("the install connects the account, and with nothing asked the reading books every payout", async () => {
    await main.getByRole("button", { name: "Connect Stripe", exact: true }).click();
    await page.getByRole("link", { name: "Install the app" }).click();
    await expect(block).toBeVisible();
    await expect(block.getByText(stripeAccount)).toBeVisible();
    // The reading finishes by itself: the block says when, and the books are read again. Nobody was asked to save anything first.
    await expect(block.getByText(/^Updated /)).toBeVisible({ timeout: 60_000 });
    await expect(rows).toHaveCount(6);
    await expect(main.getByText("New payouts are imported every day.")).toBeVisible();
    // A payout in the books is not marked; the way to match its bank deposit is the cell itself.
    await expect(rows.getByRole("link", { name: "Match", exact: true })).toHaveCount(5);
    await expect(rows.filter({ hasText: "Returned to Stripe" })).toHaveCount(1);
    // What works is not spoken of: no record of the reading, no balance that agrees, no kind of data, nothing that needs the person.
    await expect(main).not.toContainText(/sync|agree to the cent|live mode|Imported through/i);
    await expect(block.locator(".rt-stripeacct-attention")).toHaveCount(0);
    // The options are there, folded, with the first day gone: it is fixed, and nothing can be done about it.
    const options = main.getByRole("button", { name: "Options" });
    await expect(options).toHaveAttribute("aria-expanded", "false");
    await options.click();
    // The book took the time zone of the Stripe account, which nobody typed.
    await expect(main.getByLabel("Time zone")).toHaveValue("America/Denver");
    await expect(main.getByLabel("First day to import")).toHaveCount(0);
    await scan(page, "Stripe, connected, options open");
    await look(page, "3b-connected-options-open");
    await options.click();
    await scan(page, "Stripe, connected and read");
    await look(page, "3-connected");
  });

  await test.step("reading again books nothing twice", async () => {
    await menu.click();
    await page.getByRole("menuitem", { name: "Read now" }).click();
    await expect(block.getByText(/^Updated /)).toBeVisible({ timeout: 60_000 });
    await expect(rows).toHaveCount(6);
  });

  await test.step("disconnecting asks first, and what is booked stays", async () => {
    await menu.click();
    await page.getByRole("menuitem", { name: "Disconnect" }).click();
    const asking = page.getByRole("alertdialog", { name: "Disconnect Stripe?" });
    await expect(asking).toBeVisible();
    await scan(page, "Stripe, asked to disconnect");
    await look(page, "4-asked-to-disconnect");
    await asking.getByRole("button", { name: "Keep it" }).click();
    await expect(asking).toHaveCount(0);
    await expect(block.getByText("Disconnected")).toHaveCount(0);
    await menu.click();
    await page.getByRole("menuitem", { name: "Disconnect" }).click();
    await asking.getByRole("button", { name: "Disconnect", exact: true }).click();
    await expect(block.getByText("Disconnected")).toBeVisible();
    // The way back is the page's button, and the payouts are in the books.
    await expect(main.getByRole("button", { name: "Connect Stripe", exact: true })).toBeVisible();
    await expect(rows).toHaveCount(6);
    await scan(page, "Stripe, disconnected");
    await look(page, "5-disconnected");
  });

  expect(problems).toEqual([]);
});
