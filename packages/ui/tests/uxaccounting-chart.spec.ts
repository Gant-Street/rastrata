import { expect, type Locator, type Page, test } from "@playwright/test";
import { pick } from "./support/pick";
import { shown } from "./support/shown";

/** Accounts (Lanes/UXAccounting/Chart of accounts): the bank and card accounts as rows, then the chart
 * folded by kind (step 4 of Simpler Rastrata). "New account" and "Edit account" are drawers whose footer
 * says what saving will do. */
const story = (name: string) =>
  `/iframe.html?id=lanes-uxaccounting-chart-of-accounts--${name}&viewMode=story`;

/** Turn a checkbox on or off the way a person does: by clicking what is drawn, its label. The input is clipped
 * to a pixel under the drawn box, so a click made on it (`check({ force: true })`) took in Chromium and left the
 * box as it was in Firefox and WebKit. */
async function setChecked(
  scope: Page | Locator,
  name: string | RegExp,
  checked: boolean,
): Promise<void> {
  const box = scope.getByRole("checkbox", { name });
  if ((await box.isChecked()) !== checked) await box.locator("xpath=ancestor::label[1]").click();
  if (checked) await expect(box).toBeChecked();
  else await expect(box).not.toBeChecked();
}

const group = (page: Page, id: string) => page.locator(`.rt-chart-group[data-group="${id}"]`);
const head = (page: Page, name: RegExp) => page.getByRole("button", { name });
const fits = (page: Page) =>
  page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth);

test("a bank or card account is a row: its name, what the bank says, its balance and Reconcile", async ({
  page,
}) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto(story("default"));
  const rows = page.getByRole("region", { name: "Bank and cards" }).getByRole("listitem");
  await expect(rows).toHaveCount(3);
  const checking = rows.nth(0);
  await expect(checking.getByRole("link", { name: "Business checking" })).toHaveAttribute(
    "href",
    "#account-acc_1000",
  );
  await expect(checking.locator(".rt-bank-row-line")).toHaveText(
    /^Bank says 21,004\.15 as of Mar 20, 2026\s*·\s*,?\s*8 to review$/,
  );
  await expect(checking.locator(".rt-bank-row-balance")).toHaveText("20,729.65");
  // The one thing to do is a button on the row, named for its account.
  await checking.getByRole("button", { name: "Reconcile Business checking" }).click();
  await expect(
    page.getByRole("status").filter({ hasText: "Reconcile Business checking" }),
  ).toBeVisible();
  // A card that owes money, with nothing else to say.
  await expect(rows.nth(1).locator(".rt-bank-row-balance")).toHaveText("−1,250.00");
  await expect(rows.nth(1).locator(".rt-bank-row-line")).toHaveText("");
  // Stripe, not connected: it says so, has no figure, and its one control is the way in.
  await expect(rows.nth(2)).toContainText("Not connected");
  await expect(rows.nth(2).getByRole("link", { name: "Connect Stripe" })).toHaveAttribute(
    "href",
    "#connect-stripe",
  );
  await expect(rows.nth(2).getByRole("button")).toHaveCount(0);
});

test("the chart is five lines, one a kind, with how many accounts it has and what they add up to", async ({
  page,
}) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto(story("default"));
  await expect(page.locator(".rt-chart-group-head")).toHaveCount(5);
  await expect(page.locator(".rt-chart-group-name")).toHaveText([
    /^Assets \(4\)/,
    /^Liabilities \(1\)/,
    /^Equity \(2\)/,
    /^Income \(1\)/,
    /^Expenses \(3\)/,
  ]);
  await expect(group(page, "asset").locator(".rt-chart-group-total")).toHaveText("20,120.50");
  // A screen reader hears the count as words.
  await expect(head(page, /^Assets\s*, 4 accounts/)).toHaveAttribute("aria-expanded", "false");
  // Income and expenses hold something, so they are open; what is owned and owed opens when asked.
  await expect(head(page, /^Expenses/)).toHaveAttribute("aria-expanded", "true");
  await expect(head(page, /^Income/)).toHaveAttribute("aria-expanded", "true");
  await expect(page.getByRole("link", { name: "Business savings" })).toHaveCount(0);
  await head(page, /^Assets/).focus();
  await page.keyboard.press("Enter");
  await expect(head(page, /^Assets/)).toHaveAttribute("aria-expanded", "true");
  await expect(page.getByRole("link", { name: "Business savings" })).toBeVisible();
  await page.keyboard.press("Space");
  await expect(head(page, /^Assets/)).toHaveAttribute("aria-expanded", "false");
  // No code, type or tax line column, and no switch for more columns.
  await expect(page.getByRole("columnheader", { name: /Code|Type|Tax line/ })).toHaveCount(0);
  await expect(page.getByRole("checkbox")).toHaveCount(0);
});

test("an open kind lists what holds something; the rest are counted under it and shown when asked", async ({
  page,
}) => {
  await page.goto(story("default"));
  const expenses = group(page, "expense");
  await expect(expenses.getByRole("row")).toHaveCount(2);
  await expect(expenses.getByRole("link", { name: "Software and subscriptions" })).toBeVisible();
  await expect(expenses.locator(".rt-chart-group-rest")).toHaveText(
    /^2 more with nothing in them\.\s*Show them$/,
  );
  await expenses.getByRole("button", { name: "Show them" }).click();
  await expect(expenses.getByRole("row")).toHaveCount(4);
  // A closed account says it is closed.
  await expect(expenses.getByRole("row").filter({ hasText: "Old account" })).toContainText(
    "Closed",
  );
  await expenses.getByRole("button", { name: "Hide the empty ones" }).click();
  await expect(expenses.getByRole("row")).toHaveCount(2);
  // A kind in which nothing holds anything lists all of its accounts, with no line under them.
  await page.goto(story("new-book"));
  await expect(page.locator('.rt-chart-group-head[aria-expanded="true"]')).toHaveCount(0);
  await head(page, /^Equity/).click();
  await expect(group(page, "equity").getByRole("row")).toHaveCount(3);
  await expect(group(page, "equity").locator(".rt-chart-group-rest")).toHaveCount(0);
});

test("a row is a name and a balance: the name opens the account, and nothing else is on the row", async ({
  page,
}) => {
  await page.goto(story("every-kind-open"));
  const link = page
    .locator(".rt-chart-groups")
    .getByRole("link", { name: "Business checking", exact: true });
  await expect(link).toHaveAttribute("href", /\/ledger\?accountId=acct-1000$/);
  // An account is renamed, closed, watched and tagged on its own page: the chart has no menu on a row.
  await expect(
    page.locator(".rt-chart-groups").getByRole("button", { name: /^Actions for/ }),
  ).toHaveCount(0);
  const row = page.getByRole("row").filter({ hasText: "Software and subscriptions" });
  await expect(row.getByRole("link")).toHaveCount(1);
  await expect(row.getByRole("button")).toHaveCount(0);
  await expect(row.getByRole("cell")).toHaveText(["19.00"]);
});

test("a search opens every kind with a match, shows every match, and leaves the others out", async ({
  page,
}) => {
  await page.goto(story("default"));
  await page.getByRole("searchbox", { name: "Search accounts" }).fill("old");
  // A closed account with nothing in it is found: a search hides nothing under a kind.
  await expect(page.locator(".rt-chart-group-head")).toHaveCount(1);
  await expect(page.getByRole("link", { name: "Old account" })).toBeVisible();
  await expect(page.locator(".rt-chart-group-rest")).toHaveCount(0);
  // By its code, and by the words of its tax line.
  await page.getByRole("searchbox", { name: "Search accounts" }).fill("1010");
  await expect(page.getByRole("link", { name: "Business savings" })).toBeVisible();
  await page.getByRole("searchbox", { name: "Search accounts" }).fill("gross receipts");
  await expect(page.locator(".rt-chart-groups").getByRole("link")).toHaveText(["Sales"]);
  await page.getByRole("searchbox", { name: "Search accounts" }).fill("zzz");
  await expect(page.getByRole("status").filter({ hasText: "No accounts match" })).toBeVisible();
  // Clearing the search puts the chart back as it was.
  await page.getByRole("searchbox", { name: "Search accounts" }).fill("");
  await expect(page.locator(".rt-chart-group-head")).toHaveCount(5);
  await expect(head(page, /^Assets/)).toHaveAttribute("aria-expanded", "false");
});

test("the new account drawer asks a name, a type and a code, offers the code, and says what it will do", async ({
  page,
}) => {
  await page.goto(story("new-account-drawer-open"));
  const dialog = page.getByRole("dialog", { name: "New account" });
  await expect(dialog).toBeVisible();
  // It opens on the name, with the footer asking for what is missing.
  await expect(dialog.getByRole("textbox", { name: /^Name/ })).toBeFocused();
  const code = dialog.getByRole("textbox", { name: /^Code/ });
  await expect(code).toHaveValue("6300");
  await expect(dialog).toContainText("Suggested 6300. You can change it.");
  // The date it starts on is the field under Advanced, never part of the sentence.
  await expect(dialog).toContainText("This adds 6300 Software as an Expense.");
  // The type changes the code offered, until a code has been typed.
  await pick(page, dialog.getByLabel("Type"), { value: "bank" });
  await expect(code).toHaveValue("1020");
  await expect(dialog).toContainText("as a Bank account");
  await code.fill("1999");
  await pick(page, dialog.getByLabel("Type"), { value: "card" });
  await expect(code).toHaveValue("1999");
  // Advanced holds the rest, closed until it is asked for.
  await expect(dialog.getByRole("combobox", { name: "Parent account" })).toBeHidden();
  await dialog.getByRole("button", { name: "Advanced" }).click();
  await expect(dialog.getByRole("combobox", { name: "Parent account" })).toBeVisible();
  await expect(dialog.getByRole("textbox", { name: /^Role key/ })).toBeVisible();
  await expect(dialog.getByLabel(/^Starts on/)).toHaveValue(shown.dateBox("2026-03-21"));
});

test("a missing name or a taken code is said beside its field, and the cursor goes to it", async ({
  page,
}) => {
  await page.goto(story("new-account-empty"));
  const dialog = page.getByRole("dialog", { name: "New account" });
  await dialog.getByRole("button", { name: "Add account" }).click();
  await expect(dialog).toContainText("Enter a name.");
  await expect(dialog.getByRole("textbox", { name: /^Name/ })).toBeFocused();
  await dialog.getByRole("textbox", { name: /^Name/ }).fill("Software");
  await dialog.getByRole("textbox", { name: /^Code/ }).fill("6200");
  await dialog.getByRole("button", { name: "Add account" }).click();
  await expect(dialog).toContainText("6200 is already used by Software and subscriptions.");
  await expect(dialog.getByRole("textbox", { name: /^Code/ })).toBeFocused();
});

test("Enter in the name adds the account, Escape closes the drawer and focus goes back", async ({
  page,
}) => {
  await page.goto(story("new-account-drawer-open"));
  const dialog = page.getByRole("dialog", { name: "New account" });
  await dialog.getByRole("textbox", { name: /^Name/ }).press("Enter");
  await expect(dialog).toBeHidden();
  await expect(
    page.getByRole("status").filter({ hasText: "Adding 6300 Software in this preview." }),
  ).toBeVisible();
  await page.getByRole("button", { name: "New account" }).click();
  await expect(dialog).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(dialog).toBeHidden();
  await expect(page.getByRole("button", { name: "New account" })).toBeFocused();
});

test("a warning is read before the account is added, and a refusal cannot be passed", async ({
  page,
}) => {
  await page.goto(story("new-account-warning"));
  const dialog = page.getByRole("dialog", { name: "New account" });
  await expect(dialog.getByText("Check before you add")).toBeVisible();
  await expect(dialog).toContainText("already closed");
  await expect(dialog.getByRole("textbox", { name: /^Name/ })).toBeDisabled();
  await expect(dialog.getByRole("button", { name: "Add anyway" })).toBeEnabled();
  await page.goto(story("new-account-refused"));
  const refused = page.getByRole("dialog", { name: "New account" });
  await expect(refused.getByRole("alert")).toContainText("already used");
  await expect(refused.getByRole("button", { name: "Add anyway" })).toBeDisabled();
});

test("the edit drawer renames or closes, and says which", async ({ page }) => {
  await page.goto(story("edit-account-drawer-open"));
  const dialog = page.getByRole("dialog", { name: "Edit account" });
  await expect(dialog).toContainText("Change the name, or close the account.");
  await dialog.getByRole("textbox", { name: /^Name/ }).fill("Software and apps");
  await expect(dialog).toContainText(
    "This renames Software and subscriptions to Software and apps, starting Mar 21, 2026.",
  );
  await setChecked(dialog, "Close this account", true);
  await expect(dialog).toContainText("and closes it on Mar 21, 2026.");
  await expect(dialog.getByRole("button", { name: "Close account" })).toBeVisible();
});

test("on a phone a bank row is two lines, the chart fits, and the drawer fits", async ({
  page,
}) => {
  for (const width of [390, 360]) {
    await page.setViewportSize({ width, height: 844 });
    await page.goto(story("every-kind-open"));
    await expect(page.locator(".rt-chart-group-head")).toHaveCount(5);
    expect(await fits(page)).toBe(true);
    // The name and the balance on one line, then what the bank says and Reconcile on the next.
    const row = page.getByRole("region", { name: "Bank and cards" }).getByRole("listitem").first();
    const name = await row.locator(".rt-bank-row-name").boundingBox();
    const balance = await row.locator(".rt-bank-row-balance").boundingBox();
    const line = await row.locator(".rt-bank-row-line").boundingBox();
    expect(Math.abs((name?.y ?? 0) - (balance?.y ?? 99))).toBeLessThan(6);
    expect(line?.y).toBeGreaterThan((name?.y ?? 0) + (name?.height ?? 0) - 1);
  }
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto(story("new-account-drawer-open"));
  expect(await fits(page)).toBe(true);
  await expect(
    page.getByRole("dialog", { name: "New account" }).getByRole("button", { name: "Add account" }),
  ).toBeVisible();
});
