/** The Accounts page in a browser test: the chart is folded by kind, and an account with nothing in it is
 * counted under its kind. A test that is about one account's row opens the whole chart first. */
import { expect, type Page } from "@playwright/test";

/** Open every kind and list every account, so that any account's row is on the page. It can be called
 * again after the chart changed or the page was read again. */
export async function showWholeChart(page: Page): Promise<void> {
  const chart = page.locator(".rt-chart-groups");
  await expect(chart).toBeVisible();
  const closed = chart.locator('.rt-chart-group-head[aria-expanded="false"]');
  while ((await closed.count()) > 0) await closed.first().click();
  const more = chart.locator('.rt-chart-group-rest button[aria-expanded="false"]');
  while ((await more.count()) > 0) await more.first().click();
}

/** An account's row in the chart, by its name. */
export const chartRow = (page: Page, name: string | RegExp) =>
  page.locator(".rt-chart-groups").getByRole("row").filter({ hasText: name });

/** Open an account's own page from Accounts, the way a person does: find it by its name and choose it. */
export async function openAccount(page: Page, name: string): Promise<void> {
  await page.goto("/accounts");
  await page.getByRole("searchbox", { name: "Search accounts" }).fill(name);
  await page.locator(".rt-chart-groups").getByRole("link", { name, exact: true }).click();
  await expect(page.getByRole("heading", { level: 1, name, exact: true })).toBeVisible();
}

/** Open the Account details fold of an account's page (what changes the account is in it). */
export async function openAccountDetails(page: Page): Promise<void> {
  const fold = page.getByRole("button", { name: "Account details", exact: true });
  if ((await fold.getAttribute("aria-expanded")) !== "true") await fold.click();
  await expect(fold).toHaveAttribute("aria-expanded", "true");
}
