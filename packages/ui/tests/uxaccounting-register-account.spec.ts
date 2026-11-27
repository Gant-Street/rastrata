import { expect, test } from "@playwright/test";

/** An account's page (Lanes/UXAccounting/Account register): what an account's name on Accounts opens. */
const story = (name: string) =>
  `/iframe.html?id=lanes-uxaccounting-account-register--${name}&viewMode=story`;

test("a bank account reads Date, Description, Spent, Received and Balance, with the balance before and the totals", async ({
  page,
}) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto(story("default"));
  const table = page.getByRole("table", { name: "Transactions of Business checking" });
  await expect(table.getByRole("columnheader")).toHaveText([
    "Date",
    "Description",
    "Spent",
    "Received",
    "Balance",
  ]);
  await expect(table.getByRole("row", { name: /Balance before this period/ })).toContainText(
    "0.00",
  );
  await expect(table.getByRole("row", { name: /Totals for this period/ })).toContainText(
    "13,495.12",
  );
  await expect(table.getByRole("row", { name: /Totals for this period/ })).toContainText(
    "13,352.36",
  );
  // What was spent is the credit and what was received the debit: the totals sit under their own headings.
  const totals = table.getByRole("row", { name: /Totals for this period/ }).getByRole("cell");
  await expect(totals).toHaveText(["142.76", "13,495.12", "13,352.36"]);
  // One line under the name says what the books hold and what the bank says; nothing else is said above the table.
  await expect(page.getByText(/^13,352\.36 in your books · Bank says 13,401\.12/)).toBeVisible();
  await expect(
    page.getByText(/Balance at the end of this period|carries on from the start/),
  ).toHaveCount(0);
  // Nothing scrolls sideways at desktop width.
  const region = page.getByRole("region", { name: /^Transactions of Business checking, scroll/ });
  const size = await region.evaluate((element) => ({
    scroll: element.scrollWidth,
    client: element.clientWidth,
  }));
  expect(size.scroll).toBeLessThanOrEqual(size.client);
});

test("a line is blank where there is no amount, leads to its entry, and a reversal reads in words", async ({
  page,
}) => {
  await page.goto(story("default"));
  const line = page.getByRole("row").filter({ hasText: "LINEAR ORBIT" });
  // A payment: Spent has its amount and Received is empty, not 0.00.
  await expect(line.getByRole("cell").nth(1)).toHaveText("19.00");
  await expect(line.getByRole("cell").nth(2)).toHaveText("");
  // The entry's number is on the entry's page: the list has no column of numbers.
  await expect(line).not.toContainText("No. 2");
  await expect(line.getByRole("link", { name: "LINEAR ORBIT" })).toHaveAttribute(
    "href",
    "/journal/journal-2",
  );
  const reversal = page.getByRole("row").filter({ hasText: "Entered twice by mistake" }).last();
  await expect(reversal).toContainText("Reversal: Entered twice by mistake");
  await expect(reversal).not.toContainText("No. 6");
  await expect(page.getByRole("row").filter({ hasText: "Wrong account" })).toContainText(
    "Reversal: Wrong account",
  );
  await expect(page.getByRole("table")).not.toContainText(
    /[0-9a-f]{8}-[0-9a-f]{4}-|source-[0-9a-f]{8}/,
  );
});

test("an account that is not a bank or card account says Debit and Credit, from the balance before the period", async ({
  page,
}) => {
  await page.goto(story("fiscal-year-to-date"));
  const table = page.getByRole("table", { name: "Transactions of Software and subscriptions" });
  await expect(table.getByRole("columnheader")).toHaveText([
    "Date",
    "Description",
    "Debit",
    "Credit",
    "Balance",
  ]);
  await expect(table.getByRole("row", { name: /Balance before this period/ })).toContainText(
    "0.00",
  );
  const line = table.getByRole("row").filter({ hasText: "LINEAR ORBIT" });
  await expect(line.getByRole("cell").nth(1)).toHaveText("19.00");
  await expect(line.getByRole("cell").nth(2)).toHaveText("");
});

test("a period with nothing in it says so, and a second page has its pager", async ({ page }) => {
  await page.goto(story("nothing-in-the-period"));
  await expect(page.getByText("No transactions in this period.")).toBeVisible();
  await expect(page.getByRole("row", { name: /Totals for this period/ })).toBeVisible();
  await page.goto(story("second-page"));
  // The balance before the period is said on the first page only.
  await expect(page.getByRole("row", { name: /Balance before this period/ })).toHaveCount(0);
  await expect(page.getByRole("navigation", { name: "Pagination" })).toBeVisible();
  // It is the last page: Next is off, and Previous goes back.
  await expect(page.getByRole("button", { name: "Next page" })).toBeDisabled();
  await page.getByRole("button", { name: "Previous page" }).click();
  await expect(
    page.getByRole("status").filter({ hasText: "Page 1 in this preview." }),
  ).toBeVisible();
});

test("on a phone a transaction is two lines with its amount named, and nothing scrolls sideways", async ({
  page,
}) => {
  for (const width of [390, 360]) {
    await page.setViewportSize({ width, height: 844 });
    await page.goto(story("default"));
    expect(
      await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth),
    ).toBe(true);
    // The table does not scroll inside its region either: every figure is on the screen.
    const region = page.getByRole("region", { name: /^Transactions of Business checking/ });
    const size = await region.evaluate((element) => ({
      scroll: element.scrollWidth,
      client: element.clientWidth,
    }));
    expect(size.scroll).toBeLessThanOrEqual(size.client);
    const line = page.getByRole("row").filter({ hasText: "LINEAR ORBIT" });
    const description = await line.getByRole("rowheader").boundingBox();
    const spent = await line.getByRole("cell").nth(1).boundingBox();
    const date = await line.getByRole("cell").nth(0).boundingBox();
    const balance = await line.getByRole("cell").nth(3).boundingBox();
    // What it was and its amount on one line; its date and the balance after it on the next.
    expect(Math.abs((description?.y ?? 0) - (spent?.y ?? 99))).toBeLessThan(6);
    expect(date?.y).toBeGreaterThan((description?.y ?? 0) + (description?.height ?? 0) - 2);
    expect(Math.abs((date?.y ?? 0) - (balance?.y ?? 99))).toBeLessThan(6);
    // The headings are out of sight, so each figure says what it is.
    expect(
      await line
        .getByRole("cell")
        .nth(1)
        .evaluate((cell) => getComputedStyle(cell, "::before").content),
    ).toContain("Spent");
    // It is still a table to a screen reader.
    await expect(
      page.getByRole("table", { name: "Transactions of Business checking" }),
    ).toBeVisible();
    await expect(page.getByRole("columnheader", { name: "Spent" })).toBeAttached();
  }
});
