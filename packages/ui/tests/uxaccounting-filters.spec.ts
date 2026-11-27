import { expect, test, type Page } from "@playwright/test";
import { pick } from "./support/pick";

/** The Transactions filters, the kit's way (Lanes/UXAccounting/Transactions, "Kit filters"): the period is the
 * kit's DateRangeField and the account is its AccountPicker, and everything starts on All. They are folded
 * behind the Filter button at the end of the search box. */
const story = (name: string) =>
  `/iframe.html?id=lanes-uxaccounting-transactions--${name}&viewMode=story`;

async function openFilters(page: Page) {
  const filter = page.getByRole("button", { name: /^Filter/ });
  if ((await filter.getAttribute("aria-expanded")) !== "true") await filter.click();
}

test("everything starts on All, in one row, behind the Filter button", async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto(story("kit-filters"));
  // At rest the list shows its search box and nothing else.
  await expect(page.getByLabel("Posting dates", { exact: true })).toBeHidden();
  await openFilters(page);
  const dates = page.getByLabel("Posting dates", { exact: true });
  await expect(dates).toHaveText("All dates");
  await expect(page.getByRole("combobox", { name: "Account" })).toHaveValue("All accounts");
  await expect(page.getByRole("combobox", { name: "Type" })).toContainText("All types");
  await expect(page.getByRole("combobox", { name: "Status", exact: true })).toContainText(
    "All statuses",
  );
  // The period, the account, Type and Status are one row, under the search box.
  const tops = await Promise.all(
    [
      dates,
      page.getByRole("combobox", { name: "Account" }),
      page.getByRole("combobox", { name: "Type" }),
      page.getByRole("combobox", { name: "Status", exact: true }),
    ].map(async (control) => (await control.boundingBox())?.y ?? -1),
  );
  expect(Math.max(...tops) - Math.min(...tops)).toBeLessThan(40);
  await expect(page.getByRole("status", { name: "What the filters chose" })).toHaveText(
    "dates all to all · account all · status all",
  );
});

test("a period of the book's own calendar narrows the dates, and All dates clears it", async ({
  page,
}) => {
  await page.goto(story("kit-filters"));
  await openFilters(page);
  const dates = page.getByLabel("Posting dates", { exact: true });
  // Today in the story is March 23, 2026.
  await pick(page, dates, "This month");
  await expect(page.getByRole("status", { name: "What the filters chose" })).toContainText(
    "dates 2026-03-01 to 2026-03-31",
  );
  await pick(page, dates, "All dates");
  await expect(page.getByRole("status", { name: "What the filters chose" })).toContainText(
    "dates all to all",
  );
});

test("a custom range applies only when both dates are in", async ({ page }) => {
  await page.goto(story("kit-filters"));
  await openFilters(page);
  await pick(page, page.getByLabel("Posting dates", { exact: true }), "Custom");
  await page.getByLabel("From", { exact: true }).fill("2026-03-05");
  await page.getByLabel("From", { exact: true }).blur();
  // Half a range is held, not applied.
  await expect(page.getByRole("status", { name: "What the filters chose" })).toContainText(
    "dates all to all",
  );
  await page.getByLabel("To", { exact: true }).fill("2026-03-20");
  await page.getByLabel("To", { exact: true }).blur();
  await expect(page.getByRole("status", { name: "What the filters chose" })).toContainText(
    "dates 2026-03-05 to 2026-03-20",
  );
});

test("the account is chosen by typing part of its name, and All accounts clears it", async ({
  page,
}) => {
  await page.goto(story("kit-filters"));
  await openFilters(page);
  const account = page.getByRole("combobox", { name: "Account" });
  await account.fill("soft");
  await page.getByRole("option", { name: /Software and subscriptions/ }).click();
  await expect(account).toHaveValue("Software and subscriptions");
  await expect(page.getByRole("status", { name: "What the filters chose" })).not.toContainText(
    "account all",
  );
  // Back to everything.
  await account.fill("all");
  await page.getByRole("option", { name: "All accounts" }).click();
  await expect(account).toHaveValue("All accounts");
  await expect(page.getByRole("status", { name: "What the filters chose" })).toContainText(
    "account all",
  );
});

test("the filters hold at a phone's width, in a column", async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto(story("kit-filters"));
  await openFilters(page);
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(
    true,
  );
  await expect(page.getByLabel("Posting dates", { exact: true })).toBeVisible();
  await expect(page.getByRole("combobox", { name: "Account" })).toBeVisible();
});
