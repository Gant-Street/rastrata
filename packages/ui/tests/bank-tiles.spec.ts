import { expect, type Page, test } from "@playwright/test";
import { shown } from "./support/shown";

// The bank tiles against fictional accounts in Storybook. (Every story is also scanned for
// accessibility in both themes by lane-stories.spec.ts, and the figures the tiles are built from are
// checked in apps/web, tests/unit/banking-summary.test.ts.)
const story = (id: string) => `/iframe.html?id=lanes-uxbanking-banktileband--${id}&viewMode=story`;
const tiles = (page: Page) => page.locator(".rt-bank-tile");
const tile = (page: Page, name: string) =>
  page.locator(".rt-bank-tile", { has: page.getByRole("heading", { name, exact: true }) });

/** How many distinct left edges the tiles have: how many cells sit across the band. */
async function across(page: Page): Promise<number> {
  await expect(tiles(page).first()).toBeVisible();
  const edges = await tiles(page).evaluateAll((cells) =>
    cells.map((cell) => Math.round(cell.getBoundingClientRect().left)),
  );
  return new Set(edges).size;
}

test("each account is a cell: its name, the books' balance and one line, and the cell is the link to the account", async ({
  page,
}) => {
  await page.goto(story("default"));
  await expect(tiles(page)).toHaveCount(4);
  await expect(page.getByRole("heading", { level: 3 })).toHaveCount(4);

  // What the bank says is said because it is not what the books hold, and what waits is counted in words.
  const checking = tile(page, "Business checking");
  await expect(checking).toContainText(shown.money("20729.65"));
  await expect(checking.locator(".rt-bank-tile-line")).toHaveText(
    new RegExp(
      `^Bank says ${shown.money("21004.15").replace(".", "\\.")}\\s*·\\s*,?\\s*8 to review$`,
    ),
  );
  const open = checking.getByRole("link", { name: "Business checking", exact: true });
  await expect(open).toHaveAttribute("href", "#account-acc_1000");
  // The link covers the cell: a click anywhere on it opens the account.
  const cell = await checking.boundingBox();
  const hit = await page.evaluate(
    ([x, y]) =>
      document
        .elementFromPoint(x as number, y as number)
        ?.closest("a")
        ?.getAttribute("href"),
    [(cell?.x ?? 0) + (cell?.width ?? 0) - 12, (cell?.y ?? 0) + (cell?.height ?? 0) - 8],
  );
  expect(hit).toBe("#account-acc_1000");

  // An account with nothing to say is its name and its figure: it claims nothing about itself.
  const savings = tile(page, "Business savings");
  await expect(savings).toContainText(shown.money("6000.00"));
  await expect(savings.locator(".rt-bank-tile-line")).toHaveCount(0);

  // A card that owes money is a negative figure, with a real minus sign.
  const owed = tile(page, "Business credit card");
  await expect(owed).toContainText(shown.money("-1250.00"));

  // Stripe, with nothing connected: it says only that, and its one link is the way in.
  const stripe = tile(page, "Stripe");
  await expect(stripe).toContainText("Not connected");
  await expect(stripe.getByRole("link")).toHaveCount(1);
  await expect(stripe.getByRole("link", { name: "Connect Stripe" })).toHaveAttribute(
    "href",
    "#connect-stripe",
  );

  // A cell is one link and no button: what to do about an account is said in "Needs you".
  await expect(page.locator(".rt-bank-tiles").getByRole("button")).toHaveCount(0);
  await expect(page.locator(".rt-bank-tiles").getByRole("link")).toHaveCount(4);
  await expect(
    page.getByText(/in your books|Reconciled through|Not reconciled|Nothing to review/),
  ).toHaveCount(0);
});

test("a figure the bank agrees with is not said twice, and an account with nothing waiting says nothing", async ({
  page,
}) => {
  await page.goto(story("all-reviewed"));
  await expect(tiles(page)).toHaveCount(3);
  await expect(page.locator(".rt-bank-tile-line")).toHaveCount(0);
  await expect(page.locator(".rt-bank-tile[data-attention]")).toHaveCount(0);
  await expect(page.getByText(/Bank says|to review/)).toHaveCount(0);
});

test("a connection that needs attention says so on its account; Stripe says its own figure", async ({
  page,
}) => {
  await page.goto(story("connections"));
  const broken = tile(page, "Rho business checking");
  await expect(broken).toContainText("The connection needs attention");
  await expect(broken).toHaveAttribute("data-attention", "");
  // Fixing it is one row of "Needs you": the cell's link is still the account.
  await expect(broken.getByRole("link")).toHaveCount(1);
  const stripe = tile(page, "Stripe");
  await expect(stripe.locator(".rt-bank-tile-line")).toHaveText(
    new RegExp(
      `^Stripe says ${shown.money("2431.17").replace(".", "\\.")}\\s*·\\s*,?\\s*3 to review$`,
    ),
  );
  await expect(stripe.getByRole("link", { name: "Stripe", exact: true })).toHaveAttribute(
    "href",
    "#account-acc_1100",
  );
  // How long ago a connection read is not said here.
  await expect(page.getByText(/synced|Connected/)).toHaveCount(0);
});

test("Stripe with a key that works and no accounts chosen yet: the cell's link is the next step, and it is not a fault", async ({
  page,
}) => {
  await page.goto(story("stripe-setup"));
  const stripe = tile(page, "Stripe");
  await expect(stripe).not.toContainText("needs attention");
  await expect(stripe.getByRole("link")).toHaveCount(1);
  await expect(stripe.getByRole("link", { name: "Finish setting up Stripe" })).toHaveAttribute(
    "href",
    "#connect-stripe",
  );
  await expect(stripe).not.toHaveAttribute("data-attention", "");
});

test("the row decides how many cells fit from its own width, and nothing is cut off", async ({
  page,
}) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto(story("default"));
  expect(await across(page)).toBe(4);
  await page.goto(story("single-account"));
  expect(await across(page)).toBe(1);
  await page.goto(story("many-accounts"));
  expect(await across(page)).toBe(4);
  // Seven accounts wrap onto a second row, and the second row starts back at the left edge.
  const rows = await tiles(page).evaluateAll((cells) =>
    cells.map((cell) => Math.round(cell.getBoundingClientRect().top)),
  );
  expect(new Set(rows).size).toBe(2);
  await page.goto(story("medium"));
  expect(await across(page)).toBe(2);
  await page.goto(story("narrow"));
  expect(await across(page)).toBe(1);

  // A name far too long and a figure past a billion wrap; the page does not scroll sideways.
  await page.goto(story("long-content"));
  await expect(tile(page, "Reserve")).toBeVisible();
  const overflow = await page.evaluate(
    () => document.documentElement.scrollWidth - document.documentElement.clientWidth,
  );
  expect(overflow).toBeLessThanOrEqual(0);
  await expect(page.locator(".rt-bank-tile").first()).toContainText(shown.money("1234567890.12"));
});

test("at a phone's width the tiles stack, and nothing scrolls sideways", async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto(story("many-accounts"));
  expect(await across(page)).toBe(1);
  const overflow = await page.evaluate(
    () => document.documentElement.scrollWidth - document.documentElement.clientWidth,
  );
  expect(overflow).toBeLessThanOrEqual(0);
});

test("Tab visits one link a cell, in order, and every one shows where focus is", async ({
  page,
  browserName,
}) => {
  await page.goto(story("default"));
  await expect(tiles(page)).toHaveCount(4);
  // Safari on a Mac does not Tab to links unless asked to; Option-Tab is its way through everything.
  const tab = browserName === "webkit" && process.platform === "darwin" ? "Alt+Tab" : "Tab";
  const order = ["Business checking", "Business savings", "Business credit card", "Connect Stripe"];
  for (const name of order) {
    await page.keyboard.press(tab);
    const link = page.getByRole("link", { name, exact: true });
    await expect(link).toBeFocused();
    const ring = await link.evaluate((element) => getComputedStyle(element).outlineStyle);
    expect(ring).not.toBe("none");
  }
});

test("each state of the read is said in words, and no figure is shown that was not read", async ({
  page,
}) => {
  await page.goto(story("loading"));
  await expect(page.getByRole("status").filter({ hasText: /\S/ })).toHaveText(
    "Checking your accounts…",
  );
  await expect(page.locator(".rt-bank-tiles")).toHaveAttribute("aria-busy", "true");
  await expect(tiles(page)).toHaveCount(0);

  await page.goto(story("failed"));
  await expect(page.getByRole("alert")).toContainText("Your accounts could not be read");
  await expect(page.getByRole("alert")).toContainText("Nothing in your books has changed.");
  await expect(page.getByRole("button", { name: "Try again" })).toBeVisible();
  await expect(tiles(page)).toHaveCount(0);

  // A read that failed after one worked keeps the figures and says they may be old.
  await page.goto(story("stale"));
  await expect(tiles(page)).toHaveCount(4);
  await expect(page.getByRole("status").filter({ hasText: /\S/ })).toContainText(
    "These figures may be out of date",
  );
  await expect(page.getByRole("button", { name: "Try again" })).toBeVisible();
});
