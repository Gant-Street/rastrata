import { expect, test, type Page } from "@playwright/test";
import axe from "axe-core";
import { pick } from "../support/pick";

declare global {
  interface Window {
    axe: typeof axe;
  }
}

// One fresh book of the online business kind, its accounts tagged for Stripe as the chart template
// tags them, and a stand-in Stripe on this machine that serves a fictional month: six payouts, a
// refund, two disputes, an adjustment, a payout that failed and one charge in euros. The service is
// given a made-up key through its environment, exactly where a person would put a real one; this
// page never sees it. Everything is driven the way a person would, and every write goes through the
// real local API.
const version = "rastrata-application-v1";
test.describe.configure({ mode: "serial" });

// Built the way the config builds it, so no key-shaped literal is in the repository.
const stripeKey = ["rk", "test", "BrowserFlowStandInKey000000"].join("_");

const setup = {
  name: "Stripe Co",
  currency: "USD",
  fiscalYear: 2026,
  periodModel: "monthly",
  accounts: [
    { code: "1000", name: "Checking", role: "asset" },
    { code: "1100", name: "Stripe balance", role: "asset", tags: { roleKey: "stripe.balance" } },
    {
      code: "1110",
      name: "Stripe payouts in transit",
      role: "asset",
      tags: { roleKey: "payouts.in-transit" },
    },
    { code: "2500", name: "Sales tax payable", role: "liability", tags: { roleKey: "tax.sales" } },
    { code: "3000", name: "Owner's equity", role: "equity" },
    { code: "4000", name: "Sales", role: "income", tags: { roleKey: "revenue.sales" } },
    { code: "4010", name: "Other sales", role: "income" },
    { code: "4100", name: "Returns and allowances", role: "income", tags: { roleKey: "refunds" } },
    { code: "6025", name: "Stripe fees", role: "expense", tags: { roleKey: "stripe.fees" } },
    {
      code: "6026",
      name: "Chargebacks and disputes",
      role: "expense",
      tags: { roleKey: "chargebacks" },
    },
  ],
};

async function api(
  request: import("@playwright/test").APIRequestContext,
  name: string,
  input: unknown,
  operationId?: string,
) {
  const response = await request.post(`/v1/${name}`, {
    data: { version, bookId: "local-book", input, ...(operationId ? { operationId } : {}) },
  });
  const body = await response.json();
  expect(body.ok, JSON.stringify(body.error)).toBe(true);
  return body.data;
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

/** The account and its payouts, one block. */
const blockOf = (page: Page) => page.getByRole("region", { name: "Payouts" });
const rowsOf = (page: Page) =>
  blockOf(page).getByRole("list", { name: "Stripe payouts" }).getByRole("listitem");

test("a key is found and nothing is asked: a sync books every payout with the book's defaults, and what works is not spoken of", async ({
  page,
  request,
}) => {
  test.setTimeout(90_000);
  const errors: string[] = [];
  page.on("pageerror", (error) => errors.push(error.message));
  await api(request, "book.setup", setup, crypto.randomUUID());

  // Nothing has been read yet, so Home's Stripe tile is what is next (a step, and not a fault): its one link goes to the screen.
  await page.goto("/");
  const homeTile = page.locator(".rt-bank-tile").filter({ hasText: "Stripe" });
  await expect(homeTile.getByRole("link")).toHaveCount(1);
  await expect(homeTile).not.toContainText("needs attention");
  await homeTile.getByRole("link", { name: "Finish setting up Stripe" }).click();
  await expect(page).toHaveURL(/\/settings\/stripe$/);
  await expect(page.getByRole("heading", { name: "Stripe", level: 1 })).toBeFocused();

  // A key that works is not spoken of, and is never shown.
  const main = page.locator("#main");
  await expect(main).not.toContainText(/key/i);
  await expect(page.locator("body")).not.toContainText(stripeKey);
  await expect(page.locator("input[type=password]")).toHaveCount(0);
  await expect(blockOf(page).getByText("No payouts yet.")).toBeVisible();

  // Every option has its default, so they are folded away; under Advanced each account is the one the chart names.
  const options = main.getByRole("button", { name: "Options" });
  await expect(options).toHaveAttribute("aria-expanded", "false");
  await options.click();
  await main.getByRole("button", { name: "Advanced" }).click();
  // A role's field says which account it uses, and nothing more is said of one that is settled.
  for (const [role, account] of [
    ["payouts.in-transit", "1110 · Stripe payouts in transit (from your chart)"],
    ["revenue.sales", "4000 · Sales (from your chart)"],
    ["tax.sales", "2500 · Sales tax payable (from your chart)"],
    ["refunds", "4100 · Returns and allowances (from your chart)"],
    ["chargebacks", "6026 · Chargebacks and disputes (from your chart)"],
    ["stripe.fees", "6025 · Stripe fees (from your chart)"],
    ["stripe.balance", "1100 · Stripe balance (from your chart)"],
  ] as const) {
    await expect(page.locator(`[data-role="${role}"]`)).toContainText(account);
    await expect(page.locator(`[data-role="${role}"] .rt-stripe-role-status`)).toBeEmpty();
  }
  await expect(page.locator('[data-role="stripe.adjustments"]')).toContainText("Optional");
  await expect(page.locator('[data-role="stripe.adjustments"] .rt-stripe-role-status')).toBeEmpty();
  // Before anything is imported the first day can still be chosen.
  await expect(main.getByLabel("First day to import")).toBeVisible();
  await options.click();

  // Nothing was saved, and nothing has to be: the sync is the page's button, from the keyboard.
  const sync = main.getByRole("button", { name: "Sync now" });
  await expect(sync).toBeEnabled();
  await sync.focus();
  await page.keyboard.press("Enter");
  await expect(blockOf(page).getByText(/^Updated /)).toBeVisible({ timeout: 60_000 });

  // Six payouts in the books; the failed one went back to Stripe, and the way to match a bank deposit is the cell itself.
  await expect(rowsOf(page)).toHaveCount(6);
  await expect(rowsOf(page).getByRole("link", { name: "Match", exact: true })).toHaveCount(5);
  await expect(rowsOf(page).filter({ hasText: "Returned to Stripe" })).toHaveCount(1);
  await expect(rowsOf(page).filter({ hasText: "93.31" })).toHaveCount(1);
  await expect(rowsOf(page).getByRole("link").first()).toHaveAttribute("href", "/inbox");
  // The account was learned from Stripe.
  await expect(blockOf(page).getByText("acct_1FixtureAccount0001")).toBeVisible();
  // What works is not spoken of: no record of the sync, no balance that agrees, nothing that needs the person.
  await expect(main).not.toContainText(
    /Sync finished|agree to the cent|Already imported|Stripe holds/,
  );
  await expect(blockOf(page).locator(".rt-stripeacct-attention")).toHaveCount(0);

  // The book took the time zone of the Stripe account, which nobody typed; the first day is fixed now, and gone.
  await options.click();
  await expect(main.getByLabel("Time zone")).toHaveValue("America/Denver");
  await expect(main.getByLabel("First day to import")).toHaveCount(0);
  // The options are saved from the keyboard.
  await main.locator("label").filter({ hasText: "Do not split sales tax" }).click();
  await main.getByRole("button", { name: "Save", exact: true }).focus();
  await page.keyboard.press("Enter");
  await expect(page.getByRole("status").filter({ hasText: "Saved." })).toBeVisible();
  await main.locator("label").filter({ hasText: "Take it from Stripe" }).click();
  await main.getByRole("button", { name: "Save", exact: true }).click();
  await expect(page.getByRole("status").filter({ hasText: "Saved." })).toBeVisible();

  // Home carries the same story at a glance: the payouts without a deposit are a row under Needs you.
  await page.getByRole("link", { name: "Home", exact: true }).click();
  await expect(homeTile.getByRole("link", { name: "Stripe", exact: true })).toBeVisible();
  await expect(homeTile).not.toContainText("Finish setting up");
  await expect(page.locator('[data-need="stripe"]')).toContainText("no matching bank deposit");
  expect(errors).toEqual([]);
});

test("an account the chart does not name is the one thing asked: the block says which, the options open on it, and choosing it settles it", async ({
  page,
  request,
}) => {
  test.setTimeout(60_000);
  const errors: string[] = [];
  page.on("pageerror", (error) => errors.push(error.message));
  // The chart stops tagging the sales account (from the start of the year, so it holds today).
  await api(
    request,
    "accounts.setTags",
    { accountId: "4000", effectiveOn: "2026-01-01", tags: { roleKey: null } },
    crypto.randomUUID(),
  );
  await page.goto("/settings/stripe");
  await expect(page.getByRole("heading", { name: "Stripe", level: 1 })).toBeFocused();
  const main = page.locator("#main");
  const asked = blockOf(page).getByText("Choose an account for Sales.", { exact: true });
  await expect(asked).toBeVisible();
  await expect(main.getByRole("button", { name: "Sync now" })).toBeDisabled();
  // The options are open, on the account that is missing.
  await expect(main.getByRole("button", { name: "Options" })).toHaveAttribute(
    "aria-expanded",
    "true",
  );
  const sales = page.locator('[data-role="revenue.sales"]');
  await expect(sales).toContainText(
    "No account is chosen for Sales, and no open account carries the role key revenue.sales.",
  );
  await scan(page, "stripe, an account to choose");
  // Kept with the run, to be looked at: the one state of the screen in which it asks something.
  await page.screenshot({ path: test.info().outputPath("stripe-asks-1440.png"), fullPage: true });
  await page.setViewportSize({ width: 390, height: 844 });
  await page.screenshot({ path: test.info().outputPath("stripe-asks-390.png"), fullPage: true });
  await page.setViewportSize({ width: 1280, height: 720 });
  // Home's Stripe tile says there is a step to finish, as the next step and not as a fault.
  await page.goto("/");
  await expect(
    page
      .locator(".rt-bank-tile")
      .filter({ hasText: "Stripe" })
      .getByRole("link", { name: "Finish setting up Stripe" }),
  ).toBeVisible();

  // Choose the account here: the screen says it is chosen, and syncing works again.
  await page.goto("/settings/stripe");
  await pick(page, page.getByLabel("Sales", { exact: true }), { value: "4000" });
  await expect(sales).toContainText("4000 · Sales");
  await expect(sales.locator(".rt-stripe-role-status")).toBeEmpty();
  await main.getByRole("button", { name: "Save", exact: true }).focus();
  await page.keyboard.press("Enter");
  await expect(page.getByRole("status").filter({ hasText: "Saved." })).toBeVisible();
  await expect(main.getByRole("button", { name: "Sync now" })).toBeEnabled();
  await expect(asked).toHaveCount(0);
  await page.reload();
  // Settled, so the options are folded again; what was chosen is there.
  const options = main.getByRole("button", { name: "Options" });
  await expect(options).toHaveAttribute("aria-expanded", "false");
  await options.click();
  await main.getByRole("button", { name: "Advanced" }).click();
  await expect(page.getByLabel("Sales", { exact: true })).toHaveAttribute("data-value", "4000");
  await expect(page.locator("body")).not.toContainText(stripeKey);
  expect(errors).toEqual([]);
});

for (const theme of ["light", "dark"] as const) {
  test(`the Stripe screen passes the accessibility scan, fits a phone and stays in its own scroll boxes (${theme})`, async ({
    page,
  }) => {
    await page.goto("/settings/stripe");
    await expect(rowsOf(page)).toHaveCount(6);
    await page.evaluate((value) => {
      document.documentElement.dataset.theme = value;
    }, theme);
    await page.addStyleTag({
      content: "*,*::before,*::after{transition:none!important;animation:none!important}",
    });
    await scan(page, `stripe (${theme})`);
    await page.screenshot({
      path: test.info().outputPath(`stripe-${theme}-1440.png`),
      fullPage: true,
    });
    await page.setViewportSize({ width: 390, height: 844 });
    await expect
      .poll(() => page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth))
      .toBe(true);
    await page.screenshot({
      path: test.info().outputPath(`stripe-${theme}-390.png`),
      fullPage: true,
    });
    await page.goto("/");
    await expect(page.locator(".rt-bank-tile").filter({ hasText: "Stripe" })).toBeVisible();
    await expect
      .poll(() => page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth))
      .toBe(true);
    await scan(page, `home (${theme})`);
  });
}

test("a lost reply stops the sync and resuming sends the original request, never a new one", async ({
  page,
}) => {
  await page.goto("/settings/stripe");
  const sync = page.locator("#main").getByRole("button", { name: "Sync now" });
  await expect(sync).toBeEnabled();
  let sent = 0;
  await page.route("**/v1/stripe.sync", async (route) => {
    sent += 1;
    await route.fetch();
    await route.abort("failed");
  });
  await sync.click();
  const unknown = blockOf(page).getByText(
    "The last sync did not answer, so its result is not known.",
  );
  await expect(unknown).toBeVisible();
  await expect(sync).toBeDisabled();
  await page.unroute("**/v1/stripe.sync");
  // After a reload the retained request is still there, exactly as it was.
  await page.reload();
  await expect(unknown).toBeVisible();
  await blockOf(page).getByRole("button", { name: "Resume" }).click();
  await expect(unknown).toHaveCount(0);
  await expect(blockOf(page).getByText(/^Updated /)).toBeVisible();
  expect(sent).toBe(1);
});
