import { expect, test, type Page } from "@playwright/test";

/** The Transactions register (Lanes/UXAccounting/Transactions): finding F01 of the UX rework, where
 * Status and Amount sat behind a sideways scroll because an entry was named by its 64-character
 * identifier. */
const story = (name: string) =>
  `/iframe.html?id=lanes-uxaccounting-transactions--${name}&viewMode=story`;
const HEADERS = ["Date", "Description", "Category", "Amount"] as const;

/** The filters are folded behind the search box's Filter button. */
async function openFilters(page: Page) {
  const filter = page.getByRole("button", { name: /^Filter/ });
  if ((await filter.getAttribute("aria-expanded")) !== "true") await filter.click();
}

test("the amount is on screen at desktop width and the table never scrolls sideways", async ({
  page,
}) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  for (const name of ["default", "long-content"]) {
    await page.goto(story(name));
    const region = page.getByRole("region", { name: /^Transactions, scroll/ });
    await expect(region).toBeVisible();
    const size = await region.evaluate((element) => ({
      scroll: element.scrollWidth,
      client: element.clientWidth,
    }));
    expect(size.scroll, `${name}: the table is as wide as its container`).toBeLessThanOrEqual(
      size.client,
    );
    for (const header of HEADERS) {
      const box = await page.getByRole("columnheader", { name: header, exact: true }).boundingBox();
      expect(box, header).not.toBeNull();
      expect((box?.x ?? -1) >= 0 && (box?.x ?? 0) + (box?.width ?? 0) <= 1440, header).toBe(true);
    }
    // Reading order: date, description, category, amount.
    const xs = await Promise.all(
      HEADERS.map(
        async (header) =>
          (await page.getByRole("columnheader", { name: header, exact: true }).boundingBox())?.x ??
          -1,
      ),
    );
    expect(xs).toEqual([...xs].sort((a, b) => a - b));
  }
});

test("an entry is named by what it says and goes to its own page, a draft opens beside the list, and no identifier is on the surface", async ({
  page,
}) => {
  await page.goto(story("default"));
  const table = page.getByRole("table", { name: "Transactions" });
  // The name is the way into the entry, where its number is; the list shows no number.
  const link = (name: string) => table.getByRole("link", { name, exact: true });
  await expect(link("March depreciation on the laptop and monitor")).toHaveAttribute(
    "href",
    /^\/journal\//,
  );
  await expect(link("Opening balances")).toBeVisible();
  // A draft has no page in this list: its name opens it beside the list.
  await expect(
    table.getByRole("button", {
      name: "First quarter estimated tax, waiting for the confirmation number",
      exact: true,
    }),
  ).toBeVisible();
  // The ledger's own names for these entries are 71 characters long and are not shown.
  await expect(table).not.toContainText(/source-[0-9a-f]{64}/);
  await expect(table).not.toContainText(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-/);
  // A short name the person gave an entry is a note under what it says, not a second description.
  const paper = table.getByRole("row").filter({ hasText: "March depreciation" });
  await expect(paper).toContainText("Ref. DEP-0326");
  const grocery = table.getByRole("row").filter({ hasText: "PERSONAL GROCERY MARKET" });
  await expect(grocery).not.toContainText("Ref.");
});

test("the accounts of an entry read as money moving, and a split says so", async ({ page }) => {
  await page.goto(story("default"));
  const table = page.getByRole("table", { name: "Transactions" });
  const row = (text: string) => table.getByRole("row").filter({ hasText: text });
  // Credited accounts first, then the debited ones: the bank paid, the draw received.
  await expect(row("PERSONAL GROCERY MARKET").locator(".rt-register-cell-accounts")).toHaveText(
    /Business checking.*Owner's draw/,
  );
  // A customer paid: from Sales into the bank.
  await expect(row("STRIPE TRANSFER").locator(".rt-register-cell-accounts")).toHaveText(
    /Sales.*Business checking/,
  );
  // Two accounts on one side are listed together.
  await expect(row("STAPLES").locator(".rt-register-cell-accounts")).toHaveText(
    /Business checking.*Office expense, Equipment and computers/,
  );
  // An opening entry has several accounts on each side.
  await expect(row("Opening balances").locator(".rt-register-cell-accounts")).toHaveText(
    /Business credit card, Owner's investment.*Business checking, Business savings, Equipment and computers/,
  );
  // Account codes are for the chart, the pickers and the reports, not for a list of entries.
  await expect(table.locator(".rt-register-cell-accounts").first()).not.toContainText(/\b\d{4} ·/);
  // At most three accounts are named on a side, then how many more there are.
  await page.goto(story("long-content"));
  await expect(
    page
      .getByRole("table", { name: "Transactions" })
      .getByRole("row")
      .filter({ hasText: "Annual renewal" })
      .locator(".rt-register-cell-accounts"),
  ).toContainText("1 more");
});

test("in a list whose entries have no page, the identifier of an entry is one click away, under Details", async ({
  page,
}) => {
  await page.goto(story("side-sheet"));
  await page
    .getByRole("button", { name: "March depreciation on the laptop and monitor", exact: true })
    .click();
  const dialog = page.getByRole("dialog", { name: "No. 25", exact: true });
  await expect(dialog).toBeVisible();
  await expect(dialog.getByText(/source-[0-9a-f]{64}/)).toBeHidden();
  await dialog.getByText("Details", { exact: true }).click();
  await expect(dialog.getByText(/source-[0-9a-f]{64}/)).toBeVisible();
});

test("at rest the list is its search box and the first rows, and the filters open in one row", async ({
  page,
}) => {
  await page.setViewportSize({ width: 1440, height: 800 });
  await page.goto(story("default"));
  await expect(page.getByRole("searchbox", { name: "Search transactions" })).toBeVisible();
  await expect(page.getByText("Posting dates", { exact: true })).toBeHidden();
  // The table starts high enough for its first rows to be in view.
  const first = await page
    .getByRole("table", { name: "Transactions" })
    .getByRole("row")
    .nth(2)
    .boundingBox();
  expect((first?.y ?? 9999) + (first?.height ?? 0)).toBeLessThan(800);
  // Opened, the filters share a row: dates, account, type and status.
  await openFilters(page);
  const tools = ["Posting dates", "Account", "Type", "Status"];
  const tops = await Promise.all(
    tools.map(async (label) => {
      const box = await page.getByText(label, { exact: true }).first().boundingBox();
      expect(box, label).not.toBeNull();
      return Math.round(box?.y ?? 0);
    }),
  );
  expect(Math.max(...tops) - Math.min(...tops)).toBeLessThanOrEqual(4);
});

test("a reversed entry says so, its reversal says what it reverses, and no identifier shows", async ({
  page,
}) => {
  await page.goto(story("default"));
  const table = page.getByRole("table", { name: "Transactions" });
  // A state is said only when it is not the normal one.
  const original = table.getByRole("row").filter({ hasText: "Tools purchase entered twice" });
  await expect(original).toContainText("Reversed");
  const reversal = table.getByRole("row").filter({ hasText: "Reversal of No. 18" });
  await expect(reversal).toContainText("Entered twice by mistake");
  await expect(reversal).not.toContainText("Reversed");
  // The ledger writes the original's identifier into the reversal's narration; a person never reads it.
  await expect(table).not.toContainText(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-/);
  // The history in the side sheet of a list without entry pages says the same of the pair.
  await page.goto(story("side-sheet"));
  await page.getByRole("button", { name: /^Reversal of No\. 18/ }).click();
  await expect(page.getByRole("dialog", { name: "No. 24", exact: true })).toBeVisible();
});

test("the menu at the end of a row offers what can be done, and a reversed entry offers nothing", async ({
  page,
}) => {
  await page.goto(story("default"));
  const table = page.getByRole("table", { name: "Transactions" });
  // An ordinary posted entry can be reversed.
  await table.getByRole("button", { name: "Actions for No. 23", exact: true }).click();
  await page.getByRole("menuitem", { name: "Reverse" }).click();
  await expect(page.getByRole("status").filter({ hasText: "Reverse No. 23 chosen" })).toBeVisible();
  // A draft is edited instead.
  await table.getByRole("button", { name: /^Actions for Draft$/ }).click();
  await expect(page.getByRole("menuitem", { name: "Edit draft" })).toBeVisible();
  await page.keyboard.press("Escape");
  // An entry a reversal already links, and the reversal itself, have no actions.
  await expect(table.getByRole("button", { name: "Actions for No. 18", exact: true })).toHaveCount(
    0,
  );
  await expect(table.getByRole("button", { name: "Actions for No. 24", exact: true })).toHaveCount(
    0,
  );
});

test("the same actions are buttons in the entry's side sheet, which gets out of the way", async ({
  page,
}) => {
  await page.goto(story("side-sheet"));
  await page.getByRole("button", { name: "PERSONAL GROCERY MARKET", exact: true }).click();
  const dialog = page.getByRole("dialog", { name: "No. 23", exact: true });
  await dialog.getByRole("button", { name: "Reverse", exact: true }).click();
  await expect(dialog).toBeHidden();
  await expect(page.getByRole("status").filter({ hasText: "Reverse No. 23 chosen" })).toBeVisible();
});

test("on a phone a row is two lines, and neither the page nor the table scrolls sideways", async ({
  page,
}) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto(story("long-content"));
  const region = page.getByRole("region", { name: /^Transactions, scroll/ });
  await expect(region).toBeVisible();
  expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(390);
  await region.focus();
  await expect(region).toBeFocused();
  const size = await region.evaluate((element) => ({
    scroll: element.scrollWidth,
    client: element.clientWidth,
  }));
  expect(size.scroll, "the table is as wide as its region").toBeLessThanOrEqual(size.client);
  // What the entry came to is on screen, at the end of the first line.
  const amount = await region
    .getByRole("row")
    .nth(1)
    .locator(".rt-register-cell-amount")
    .boundingBox();
  const bounds = await region.boundingBox();
  expect(amount && bounds).toBeTruthy();
  expect((amount?.x ?? 0) + (amount?.width ?? 0)).toBeLessThanOrEqual(
    (bounds?.x ?? 0) + (bounds?.width ?? 0) + 1,
  );
});
