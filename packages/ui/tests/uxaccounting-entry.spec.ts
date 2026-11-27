import { expect, type Page, test } from "@playwright/test";

/** The new-entry form (Lanes/UXAccounting/New entry): a bar that stays in view with the totals, the one
 * account picker, amounts that are tidied when they are left, and the source an entry came from under
 * "Where this entry came from" only on a form opened for one. */
const story = (name: string) =>
  `/iframe.html?id=lanes-uxaccounting-new-entry--${name}&viewMode=story`;

const debit = (page: Page, line: number) =>
  page.getByRole("textbox", { name: `Debit for line ${line}` });
const credit = (page: Page, line: number) =>
  page.getByRole("textbox", { name: `Credit for line ${line}` });

test("typing in an amount box keeps the cursor there, and leaving it tidies the figure", async ({
  page,
}) => {
  await page.goto(story("empty"));
  const box = debit(page, 1);
  await box.click();
  // One key at a time: a form that built its lines again on every key would lose the focus after the first.
  await page.keyboard.type("1,250.5");
  await expect(box).toBeFocused();
  await expect(box).toHaveValue("1,250.5");
  await page.keyboard.press("Tab");
  await expect(box).toHaveValue("1250.50");
  // A figure that is not an amount stays as typed, and says what is wrong once it is left.
  await credit(page, 2).fill("12.345");
  await credit(page, 2).blur();
  await expect(credit(page, 2)).toHaveValue("12.345");
  await expect(page.getByText("Use at most two decimal places.")).toBeVisible();
  await expect(credit(page, 2)).toHaveAttribute("aria-invalid", "true");
});

test("a line is a debit or a credit: typing one side empties the other", async ({ page }) => {
  await page.goto(story("empty"));
  await debit(page, 1).fill("100");
  await credit(page, 1).fill("40");
  await expect(debit(page, 1)).toHaveValue("");
  await expect(credit(page, 1)).toHaveValue("40");
});

test("the bar's totals follow the lines and say whether the entry balances", async ({ page }) => {
  await page.goto(story("empty"));
  const bar = page.getByRole("group", { name: "Entry totals and actions" });
  await expect(bar).toContainText("Debits 0.00");
  await debit(page, 1).fill("100");
  await credit(page, 2).fill("40");
  await expect(bar).toContainText("Debits 100.00");
  await expect(bar).toContainText("Credits 40.00");
  await expect(bar).toContainText("Difference 60.00");
  await expect(bar).toContainText("Out of balance");
  await credit(page, 2).fill("100");
  await expect(bar).toContainText("Difference 0.00");
  await expect(bar).toContainText("Balanced");
  // An amount that is not one has no totals, and the bar says so.
  await credit(page, 2).fill("abc");
  await expect(bar).toContainText("Fix the amounts to see the totals.");
});

test("the bar stays in view while the lines scroll", async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 700 });
  await page.goto(story("many-lines"));
  const bar = page.getByRole("group", { name: "Entry totals and actions" });
  const inView = async () => {
    const box = await bar.boundingBox();
    expect(box).not.toBeNull();
    expect((box?.y ?? 0) + (box?.height ?? 0)).toBeLessThanOrEqual(700 + 1);
    expect(box?.y ?? -1).toBeGreaterThanOrEqual(0);
  };
  await inView();
  // The page is taller than the window: scroll to the end and the middle, and the bar is still there.
  const height = await page.evaluate(() => document.documentElement.scrollHeight);
  expect(height).toBeGreaterThan(900);
  await page.evaluate(() => window.scrollTo(0, document.documentElement.scrollHeight));
  await inView();
  await page.evaluate(() => window.scrollTo(0, 300));
  await inView();
  await expect(page.getByRole("button", { name: "Post", exact: true })).toBeVisible();
});

test("an account is chosen by typing part of its name, and a closed account cannot be", async ({
  page,
}) => {
  await page.goto(story("empty"));
  const account = page.getByRole("combobox", { name: "Account for line 1" });
  await account.click();
  await page.keyboard.type("soft");
  await page.keyboard.press("ArrowDown");
  await page.keyboard.press("Enter");
  await expect(account).toHaveValue("Software and subscriptions");
  // The code is there to be matched, not the first thing read.
  const second = page.getByRole("combobox", { name: "Account for line 2" });
  await second.click();
  await page.keyboard.type("1000");
  await expect(page.getByRole("option", { name: /Business checking/ })).toBeVisible();
  await second.fill("");
  await page.keyboard.type("old");
  await expect(page.getByRole("option", { name: /Old account/ })).toHaveAttribute(
    "aria-disabled",
    "true",
  );
});

test("Post that cannot go lists what to fix, with a link to each, and keeps the figures", async ({
  page,
}) => {
  await page.goto(story("empty"));
  await debit(page, 1).fill("100");
  await page.getByRole("button", { name: "Post", exact: true }).click();
  const summary = page.getByRole("region", { name: "This entry is not ready" });
  await expect(summary).toBeVisible();
  await expect(summary).toBeFocused();
  await expect(summary).toContainText("Enter a description.");
  await expect(summary).toContainText("Line 1: Choose an account.");
  await expect(summary).toContainText("Line 2: Choose an account.");
  // Each is a link to its own control.
  await summary.getByRole("link", { name: "Enter a description." }).click();
  await expect(page.getByRole("textbox", { name: /^Description/ })).toBeFocused();
  // The figures that were typed are kept (and tidied into two decimals when the box was left).
  await expect(debit(page, 1)).toHaveValue("100.00");
  // Fixing a problem takes it off the list.
  await page.getByRole("textbox", { name: /^Description/ }).fill("Sale");
  await expect(summary).not.toContainText("Enter a description.");
});

test("a refused post says it at each control as well", async ({ page }) => {
  await page.goto(story("refused-post"));
  await expect(page.getByRole("region", { name: "This entry is not ready" })).toContainText(
    "Line 3: Use at most two decimal places.",
  );
  await expect(debit(page, 3)).toHaveAttribute("aria-invalid", "true");
  await expect(page.getByRole("combobox", { name: "Account for line 1" })).toHaveAttribute(
    "aria-invalid",
    "true",
  );
});

test("a balanced entry posts, and a draft only needs a date and an account on each line", async ({
  page,
}) => {
  await page.goto(story("balanced"));
  await page.getByRole("button", { name: "Post", exact: true }).click();
  await expect(
    page.getByRole("status").filter({ hasText: "Posted in this preview." }),
  ).toBeVisible();
  await page.goto(story("empty"));
  await page.getByRole("combobox", { name: "Account for line 1" }).click();
  await page.keyboard.type("checking");
  await page.keyboard.press("ArrowDown");
  await page.keyboard.press("Enter");
  await page.getByRole("combobox", { name: "Account for line 2" }).click();
  await page.keyboard.type("sales");
  await page.keyboard.press("ArrowDown");
  await page.keyboard.press("Enter");
  await page.getByRole("button", { name: "Save draft" }).click();
  await expect(
    page.getByRole("status").filter({ hasText: "Draft saved in this preview." }),
  ).toBeVisible();
});

test("an entry typed by hand has no fold for a source; a form opened for one says where the entry came from", async ({
  page,
}) => {
  await page.goto(story("empty"));
  await expect(
    page.getByRole("button", { name: /Where this entry came from|Advanced/ }),
  ).toHaveCount(0);
  await expect(page.getByText(/Source ID|duplicate/)).toHaveCount(0);
  await page.goto(story("from-source"));
  const toggle = page.getByRole("button", { name: "Where this entry came from" });
  await expect(toggle).toHaveAttribute("aria-expanded", "true");
  // The facts are the source's own, shown and not typed.
  await expect(page.getByText("invoice-1042")).toBeVisible();
  await expect(page.getByText("Invoice 1042 to Harbor Studio")).toBeVisible();
  await expect(page.getByText("invoices/1042.pdf")).toBeVisible();
  await expect(page.getByRole("button", { name: "Inspect source" })).toBeVisible();
  await expect(page.getByRole("textbox", { name: /Source|Evidence/ })).toHaveCount(0);
  await toggle.click();
  await expect(toggle).toHaveAttribute("aria-expanded", "false");
  await expect(page.getByText("invoice-1042")).toBeHidden();
});

test("a long account name wraps and on a phone the lines fit the window", async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  for (const name of ["empty", "long-account-name", "many-lines"]) {
    await page.goto(story(name));
    expect(
      await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth),
      name,
    ).toBe(true);
  }
  // Each box carries its own column name when the header row is not there.
  await page.goto(story("empty"));
  await expect(page.locator(".rt-entry-line-head")).toBeHidden();
  const heading = await page
    .locator(".rt-entry-amount")
    .first()
    .evaluate((element) => getComputedStyle(element, "::before").content);
  expect(heading).toContain("Debit");
  // The bar is still one reach away.
  await expect(page.getByRole("button", { name: "Post", exact: true })).toBeVisible();
});

test("at desktop width the tools, the lines and the bar share one screen", async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 800 });
  await page.goto(story("balanced"));
  for (const name of [
    "Date",
    "Description",
    "Reference (optional)",
    "Account for line 1",
    "Debit for line 1",
    "Credit for line 1",
  ]) {
    const box = await page.getByLabel(name, { exact: false }).first().boundingBox();
    expect(box, name).not.toBeNull();
    expect((box?.y ?? 0) + (box?.height ?? 0), name).toBeLessThanOrEqual(800);
  }
});
