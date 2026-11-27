import { type APIRequestContext, expect, type Page, test } from "@playwright/test";
import axe from "axe-core";
import { expectWithin } from "../support/budget";
import { shown } from "../support/shown";
import { pick } from "../support/pick";
import { setChecked } from "../support/accounting";

declare global {
  interface Window {
    axe: typeof axe;
  }
}

// One fresh book, and a stand-in SimpleFIN Bridge on this machine that serves a fictional September: a
// checking account (eleven posted transactions and one pending), a savings account and an account in
// euros. The service is told the one address it may speak to over http; this page never sees the
// access URL it is given. Everything is driven the way a person would, and every write goes through
// the real local API. Nothing here is a real credential, bank or account.
const version = "rastrata-application-v1";
test.describe.configure({ mode: "serial" });

/** The stand-in Bridge, which the config tells this test about. */
const bridge = process.env.RASTRATA_FAKE_SIMPLEFIN_URL ?? "";

const setup = {
  name: "Feed Co",
  currency: "USD",
  fiscalYear: 2026,
  periodModel: "monthly",
  accounts: [
    { code: "1000", name: "Business Checking", role: "asset" },
    { code: "1100", name: "Business Savings", role: "asset" },
    { code: "3000", name: "Owner's equity", role: "equity" },
    { code: "4000", name: "Sales", role: "income" },
    { code: "5000", name: "Software", role: "expense" },
  ],
};

async function api(request: APIRequestContext, name: string, input: unknown, operationId?: string) {
  const response = await request.post(`/v1/${name}`, {
    data: { version, bookId: "local-book", input, ...(operationId ? { operationId } : {}) },
  });
  const body = await response.json();
  expect(body.ok, JSON.stringify(body.error)).toBe(true);
  return body.data;
}

async function fake(
  request: APIRequestContext,
  method: "GET" | "POST",
  path: string,
  body?: unknown,
) {
  const response = await request.fetch(`${bridge}/__fake/${path}`, {
    method,
    ...(body === undefined ? {} : { data: body }),
  });
  expect(response.ok(), path).toBe(true);
  return response.json();
}

async function scan(page: Page, label: string) {
  // Each navigation starts a new document, so settle colours on this one: axe reads the colours a
  // theme change is still transitioning through otherwise.
  await page.addStyleTag({
    content: "*,*::before,*::after{transition:none!important;animation:none!important}",
  });
  await page.addScriptTag({ content: axe.source });
  const violations = await page.evaluate(async () =>
    (
      await window.axe.run(document.body, {
        runOnly: { type: "tag", values: ["wcag2a", "wcag2aa", "wcag21aa"] },
      })
    ).violations.map(({ id, nodes }) => ({ id, targets: nodes.map((node) => node.target) })),
  );
  expect(violations, label).toEqual([]);
}

const account = (page: Page, name: string) =>
  page
    .locator(".rt-bankfeed-account")
    .filter({ has: page.getByRole("heading", { name, level: 3 }) });

const fact = (page: Page, name: string) =>
  page
    .locator(".rt-bankfeed-result .rt-bankfeed-facts > div")
    .filter({ has: page.getByText(name, { exact: true }) });

const connectedHeading = (page: Page) => page.getByText("Connected to 127.0.0.1");

test("before anything is connected the screen says what this is, what it costs and what it cannot promise", async ({
  page,
  request,
}) => {
  const errors: string[] = [];
  page.on("pageerror", (error) => errors.push(error.message));
  await api(request, "book.setup", setup, crypto.randomUUID());

  // Home is not asking for anything yet, and offers the way to connect a bank.
  await page.goto("/");
  await expect(page.locator(".rt-today")).toHaveAttribute("data-read", "");
  await expect(page.locator('[data-need="bankfeed"]')).toHaveCount(0);
  await page.getByRole("link", { name: "Connect a bank" }).click();
  await expect(page).toHaveURL(/\/settings\/bankfeed$/);
  await expect(page.getByRole("heading", { name: "Bank connection", level: 1 })).toBeFocused();

  // The honest part, before any token is asked for.
  await expect(page.getByText("The SimpleFIN Bridge is a separate paid service.")).toBeVisible();
  await expect(page.getByText(/about \$15 a year when this was written/)).toBeVisible();
  await expect(page.getByText(/business accounts are covered less often/)).toBeVisible();
  await expect(page.getByText(/stops at 20 in any 24 hours/)).toBeVisible();

  // The token is typed into a masked field. Nothing else on the page can take one.
  const token = page.getByLabel("Setup token");
  await expect(token).toHaveAttribute("type", "password");
  await expect(token).toHaveAttribute("autocomplete", "off");
  await expect(page.locator("input[type=password]")).toHaveCount(1);
  // Nothing to read or sync with, and the screen does not pretend otherwise.
  await expect(page.getByRole("button", { name: "Sync now" })).toHaveCount(0);
  expect(errors).toEqual([]);
});

test("a token that is not one, or points elsewhere, is refused before anything is sent, and the field is cleared", async ({
  page,
  request,
}) => {
  const asked: string[] = [];
  page.on("request", (sent) => asked.push(sent.url()));
  await page.goto("/settings/bankfeed");
  const token = page.getByLabel("Setup token");

  // Pressing Connect with nothing in the field says so and sends nothing.
  await page.getByRole("button", { name: "Connect", exact: true }).click();
  await expect(page.getByText("Paste the setup token first.")).toBeVisible();

  // Something that is not a token.
  await token.fill("this is not a setup token at all");
  await token.press("Enter");
  await expect(page.getByText("That is not a SimpleFIN setup token.")).toBeVisible();
  await expect(token).toHaveValue("");

  // A well-formed token that points at a server that is not the Bridge.
  const elsewhere = Buffer.from("https://example.invalid/simplefin/claim/ABCDEF123456").toString(
    "base64",
  );
  await token.fill(elsewhere);
  await token.press("Enter");
  await expect(
    page.getByText("This setup token points to a server that is not the SimpleFIN Bridge"),
  ).toBeVisible();
  await expect(token).toHaveValue("");

  // The token went in a request body and nowhere else: never in an address, never kept.
  expect(asked.filter((url) => url.includes(elsewhere) || url.includes("token="))).toEqual([]);
  expect(
    await page.evaluate(() => JSON.stringify({ ...localStorage, ...sessionStorage })),
  ).not.toContain(elsewhere);
  // And nothing was asked of the Bridge.
  expect((await fake(request, "GET", "log")).requests).toHaveLength(0);
});

test("a setup token connects the Bridge, the accounts come up unlinked, and the access URL is nowhere on the page", async ({
  page,
  request,
}) => {
  test.setTimeout(60_000);
  const errors: string[] = [];
  page.on("pageerror", (error) => errors.push(error.message));
  const asked: string[] = [];
  page.on("request", (sent) => asked.push(sent.url()));
  const { setupToken } = await fake(request, "GET", "token");
  const secrets = await fake(request, "GET", "access");

  await page.goto("/settings/bankfeed");
  const token = page.getByLabel("Setup token");
  await token.fill(setupToken);
  // Pressing Connect empties the field at once, whatever happens next.
  await page.getByRole("button", { name: "Connect", exact: true }).focus();
  const started = Date.now();
  await page.keyboard.press("Enter");
  await expect(token).toHaveCount(0);
  await expect(page.getByText("Connected. Now choose which accounts to read.")).toBeVisible();
  expectWithin("connecting and listing the accounts", Date.now() - started, 10_000);
  await expect(connectedHeading(page)).toBeVisible();
  await expect(page.getByRole("heading", { name: "Accounts", level: 2 })).toBeFocused();

  // Every account the Bridge lists, none of them linked, and the balance as the Bridge reports it.
  for (const name of ["Business Checking", "Business Savings", "Euro Account"])
    await expect(account(page, name)).toContainText("Not linked, never read");
  await expect(account(page, "Business Checking")).toContainText("6,878.18");
  await expect(account(page, "Business Checking")).toContainText("Example Bank");
  await expect(account(page, "Euro Account")).toContainText("250.00");
  await expect(account(page, "Euro Account")).toContainText("Rastrata does not convert currencies");
  await expect(page.getByText("The Bridge lists 3 accounts and none is linked")).toBeVisible();

  // The access URL is in a private file beside the book. Not here: not in the page, not in storage,
  // not in any address the page asked for.
  const body = page.locator("body");
  for (const secret of [secrets.password, secrets.user, secrets.accessUrl, setupToken])
    await expect(body).not.toContainText(secret);
  const stored = await page.evaluate(() => JSON.stringify({ ...localStorage, ...sessionStorage }));
  for (const secret of [secrets.password, secrets.user, setupToken])
    expect(stored).not.toContain(secret);
  expect(asked.filter((url) => url.includes(setupToken) || url.includes(secrets.password))).toEqual(
    [],
  );
  expect(errors).toEqual([]);
});

test("linking chooses what is read; a sync queues the transactions in For review, posts nothing and shows the connection's balance as what it is", async ({
  page,
  request,
}) => {
  test.setTimeout(90_000);
  const errors: string[] = [];
  page.on("pageerror", (error) => errors.push(error.message));
  await page.goto("/settings/bankfeed");
  await expect(page.getByRole("button", { name: "Sync now" })).toBeDisabled();
  await expect(
    page.getByText("Link an account first: nothing is read until you do."),
  ).toBeVisible();

  // Linking without choosing a chart account says what to do.
  const savings = account(page, "Business Savings");
  await savings.getByRole("button", { name: "Link this account" }).click();
  await expect(
    savings.getByText("Choose the chart account this one is recorded to."),
  ).toBeVisible();

  // Link the checking account to the chart account of the same name, from the keyboard.
  const checking = account(page, "Business Checking");
  await pick(page, checking.getByLabel("Chart account"), "1000 · Business Checking");
  await checking.getByLabel("First day to read").fill("2026-09-01");
  await checking.getByRole("button", { name: "Link this account" }).focus();
  await page.keyboard.press("Enter");
  await expect(checking.getByText("Chart account")).toBeVisible();
  await expect(checking).toContainText("1000 Business Checking");
  await expect(checking).toContainText(shown.date("2026-09-01"));
  await expect(checking).toContainText("Not read yet");
  // The other two are still not read, and the screen says so.
  await expect(account(page, "Business Savings")).toContainText("Not linked, never read");
  await expect(
    page.getByText("2 accounts are not linked. Unlinked accounts are never fetched."),
  ).toBeVisible();

  // Sync from the keyboard. The result is the service's own answer.
  await expect(page.getByRole("button", { name: "Sync now" })).toBeEnabled();
  await page.getByRole("button", { name: "Sync now" }).focus();
  const started = Date.now();
  await page.keyboard.press("Enter");
  await expect(page.getByText("The sync finished")).toBeVisible();
  expectWithin("a sync of eleven transactions", Date.now() - started, 10_000);
  await expect(fact(page, "New transactions")).toContainText("11");
  await expect(fact(page, "Already imported")).toContainText("0");
  await expect(fact(page, "Started")).toContainText("by you");
  await expect(page.locator(".rt-bankfeed-result")).toContainText(
    "11 transactions queued for review. Nothing was posted.",
  );
  await expect(page.getByRole("link", { name: "Review the transactions" })).toHaveAttribute(
    "href",
    "/inbox",
  );
  await expect(
    page.getByText(/Requests to the Bridge in the last 24 hours: \d+ of about 24/),
  ).toBeVisible();

  // The account says how far it was read, and the Bridge's balance against the books, to the cent:
  // the lines wait in the Inbox, nothing is posted, and 1,000.00 of the balance is before September.
  await expect(checking).toContainText("Read through");
  const balance = checking.locator(".rt-bankfeed-balance");
  await expect(balance).toContainText("Balance from the connection");
  await expect(balance).toContainText("6,878.18");
  await expect(balance.locator("div").filter({ hasText: "Waiting for review" })).toContainText(
    "5,878.18",
  );
  await expect(balance.locator("[data-difference]")).toContainText("1,000.00");
  await expect(balance).toContainText(
    "A balance from the connection is what the Bridge says, not your bank's statement.",
  );

  // The Inbox has the posted lines (not the pending one), and nothing is posted.
  await page.getByRole("link", { name: "Review the transactions" }).click();
  await expect(page).toHaveURL(/\/inbox$/);
  await expect(page.getByText("ACME INVOICE 77 PAYMENT").first()).toBeVisible();
  await expect(page.getByText("CARD HOLD HOTEL")).toHaveCount(0);
  const summary = await api(request, "inbox.summary", {});
  expect(summary.counts).toMatchObject({ toReview: 11, posted: 0 });
  expect((await api(request, "journal.list", { page: 1 })).count).toBe(0);

  // Home carries the story at a glance: the transactions the sync queued are waiting for a person,
  // and nothing about the connection itself needs one.
  await page.goto("/");
  await expect(page.locator('[data-need="review"]')).toContainText("11 transactions to review.");
  await expect(page.locator('[data-need="bankfeed"]')).toHaveCount(0);
  expect(errors).toEqual([]);
});

test("an account that appears at the bank later is shown unlinked and is never fetched", async ({
  page,
  request,
}) => {
  test.setTimeout(60_000);
  await fake(request, "POST", "accounts", {
    id: "ACT-card-0004",
    name: "Company Card",
    currency: "USD",
    balance: "-312.45",
    balanceDate: Math.floor(Date.now() / 1000),
    connId: "CON-bank-a",
    transactions: [
      {
        id: "C-1",
        posted: Math.floor(Date.now() / 1000) - 86_400,
        amount: "-312.45",
        description: "AIRLINE",
      },
    ],
  });
  await page.goto("/settings/bankfeed");
  await expect(account(page, "Company Card")).toHaveCount(0);
  await page.getByRole("button", { name: "Check for accounts" }).click();
  await expect(account(page, "Company Card")).toContainText("Not linked, never read");
  await expect(account(page, "Company Card")).toContainText("312.45");
  await expect(page.getByText("3 accounts are not linked.")).toBeVisible();

  // A sync reads the linked account only.
  await page.getByRole("button", { name: "Sync now" }).click();
  await expect(page.getByText("The sync finished")).toBeVisible();
  const asked = (await fake(request, "GET", "log")).requests as {
    query: Record<string, string[]>;
  }[];
  for (const entry of asked) expect(entry.query.account ?? []).not.toContain("ACT-card-0004");
  expect((await api(request, "inbox.list", { filter: { provider: "simplefin" } })).count).toBe(11);
});

test("when the Bridge says a bank needs the owner, the screen says which bank and where to go, and shows the Bridge's words as text", async ({
  page,
  request,
}) => {
  test.setTimeout(60_000);
  await fake(request, "POST", "problems", {
    problems: [
      {
        code: "con.auth",
        msg: "<img src=x onerror=window.__pwned=1> Please sign in again",
        conn_id: "CON-bank-a",
      },
    ],
  });
  await page.goto("/settings/bankfeed");
  await page.getByRole("button", { name: "Check for accounts" }).click();
  const needs = page.getByRole("region", { name: "What needs you" });
  await expect(needs.getByText("A bank connection needs you")).toBeVisible();
  await expect(needs).toContainText("Example Bank");
  await expect(needs).toContainText("SimpleFIN Bridge");
  // The Bridge's own words are set apart, quoted, and are text: nothing in them runs or renders.
  await needs.getByText("What the Bridge said").click();
  await expect(needs.locator("q")).toContainText("<img src=x onerror=window.__pwned=1>");
  await expect(page.locator("img[src='x']")).toHaveCount(0);
  expect(await page.evaluate(() => "__pwned" in window)).toBe(false);

  // Home asks for attention, in words.
  await page.goto("/");
  const line = page.locator('[data-need="bankfeed"]');
  await expect(line).toContainText("Your bank connection needs attention.");
  await line.getByRole("link", { name: /^Fix it/ }).click();
  await expect(page).toHaveURL(/\/settings\/bankfeed$/);

  // The Bridge recovers; asking again clears it.
  await fake(request, "POST", "problems", {});
  await page.goto("/settings/bankfeed");
  await page.getByRole("button", { name: "Check for accounts" }).click();
  await expect(page.getByRole("region", { name: "What needs you" })).toContainText(
    "3 accounts are not linked",
  );
  await expect(page.getByText("A bank connection needs you")).toHaveCount(0);
});

test("the daily sync is off until it is turned on, and a copy that does not run it says so", async ({
  page,
}) => {
  await page.goto("/settings/bankfeed");
  const daily = page.getByRole("heading", { name: "Daily sync", level: 2 });
  await expect(daily).toBeVisible();
  const on = page.getByLabel("Sync once a day by itself");
  await expect(on).not.toBeChecked();
  await expect(page.getByText("This copy of Rastrata is not running the daily sync")).toBeVisible();
  await expect(page.getByLabel("At this time of day")).toHaveValue("06:17");

  await setChecked(page, "Sync once a day by itself", true);
  await page.getByLabel("At this time of day").fill("07:42");
  await page.getByRole("button", { name: "Save" }).focus();
  await page.keyboard.press("Enter");
  await expect(page.getByRole("status").filter({ hasText: "Saved." })).toBeVisible();
  await page.reload();
  await expect(page.getByLabel("Sync once a day by itself")).toBeChecked();
  await expect(page.getByLabel("At this time of day")).toHaveValue("07:42");
});

test("a lost reply stops the sync and resuming sends the original request, never a new one", async ({
  page,
  request,
}) => {
  test.setTimeout(60_000);
  await page.goto("/settings/bankfeed");
  await expect(page.getByRole("button", { name: "Sync now" })).toBeEnabled();
  let sent = 0;
  await page.route("**/v1/bankfeed.sync", async (route) => {
    sent += 1;
    await route.fetch();
    await route.abort("failed");
  });
  await page.getByRole("button", { name: "Sync now" }).click();
  await expect(page.getByText("The result of the sync is uncertain")).toBeVisible();
  await expect(page.getByRole("button", { name: "Sync now" })).toBeDisabled();
  await page.unroute("**/v1/bankfeed.sync");
  // After a reload the retained request is still there, exactly as it was.
  await page.reload();
  await expect(page.getByText("The result of the sync is uncertain")).toBeVisible();
  const before = (await fake(request, "GET", "log")).requests.length;
  await page.getByRole("button", { name: "Resume" }).click();
  await expect(page.getByText("The result of the sync is uncertain")).toHaveCount(0);
  await expect(page.getByText("The sync finished")).toBeVisible();
  expect(sent).toBe(1);
  // The resumed request got the first answer back; the Bridge was not asked again.
  expect((await fake(request, "GET", "log")).requests.length).toBe(before);
});

for (const theme of ["light", "dark"] as const) {
  test(`the Bank connection screen passes the accessibility scan, fits a phone and stays in its own scroll boxes (${theme})`, async ({
    page,
  }) => {
    await page.setViewportSize({ width: 1440, height: 900 });
    await page.goto("/settings/bankfeed");
    await expect(account(page, "Business Checking")).toContainText("Chart account");
    await expect(page.getByRole("heading", { name: "Sync", level: 2, exact: true })).toBeVisible();
    await page.evaluate((value) => {
      document.documentElement.dataset.theme = value;
    }, theme);
    await page.addStyleTag({
      content: "*,*::before,*::after{transition:none!important;animation:none!important}",
    });
    await scan(page, `bank connection (${theme})`);
    await page.screenshot({
      path: test.info().outputPath(`bankfeed-${theme}-1440.png`),
      fullPage: true,
    });
    await page.setViewportSize({ width: 390, height: 844 });
    await expect
      .poll(() => page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth))
      .toBe(true);
    await page.screenshot({
      path: test.info().outputPath(`bankfeed-${theme}-390.png`),
      fullPage: true,
    });
    await page.goto("/");
    await expect(page.locator(".rt-today")).toHaveAttribute("data-read", "");
    await expect
      .poll(() => page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth))
      .toBe(true);
    await scan(page, `home (${theme})`);
    await page.screenshot({
      path: test.info().outputPath(`bankfeed-home-${theme}-390.png`),
      fullPage: true,
    });
  });
}

test("disconnecting asks first, deletes the connection and keeps what was imported", async ({
  page,
  request,
}) => {
  test.setTimeout(60_000);
  await page.goto("/settings/bankfeed");
  await expect(connectedHeading(page)).toBeVisible();

  // Asked first, with the safe choice focused; Escape changes nothing.
  await page.getByRole("button", { name: "Disconnect" }).click();
  const dialog = page.getByRole("alertdialog");
  await expect(dialog.getByRole("button", { name: "Keep it connected" })).toBeFocused();
  await expect(dialog).toContainText("does not tell the Bridge");
  await page.keyboard.press("Escape");
  await expect(dialog).toHaveCount(0);
  await expect(connectedHeading(page)).toBeVisible();

  await page.getByRole("button", { name: "Disconnect" }).click();
  await page.getByRole("alertdialog").getByRole("button", { name: "Disconnect" }).click();
  await expect(page.getByText("Not connected", { exact: true })).toBeVisible();
  // The setup token field is back, empty; the accounts and what was read stay on the page.
  await expect(page.getByLabel("Setup token")).toHaveValue("");
  await expect(account(page, "Business Checking")).toContainText("Chart account");
  await expect(page.getByRole("button", { name: "Sync now" })).toHaveCount(0);
  expect((await api(request, "inbox.list", { filter: { provider: "simplefin" } })).count).toBe(11);
  expect((await api(request, "bankfeed.status", {})).connected).toBe(false);
});
