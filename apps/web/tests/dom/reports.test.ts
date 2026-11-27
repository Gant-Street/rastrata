import { expect, test, type Download, type Page } from "./support/playwright";
import type axe from "axe-core";
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { shown } from "../support/shown";
import { pick } from "../support/pick";
declare global {
  interface Window {
    axe: typeof axe;
  }
}

// The Reports screen, driven the way a person would, against a fresh book on the real local API: an
// October cash book (so a fiscal year is not a calendar year) with six postings. Every figure the
// screen shows is checked against what the API itself says.
const version = "rastrata-application-v1";
test.describe.configure({ mode: "serial" });

const setup = {
  name: "Harbor Studio",
  currency: "USD",
  fiscalYear: 2025,
  fiscalYearStartMonth: 10,
  basis: "cash",
  periodModel: "monthly",
  accounts: [
    { code: "1000", name: "Operating cash", role: "asset", tags: { cashFlowClass: "cash" } },
    { code: "1100", name: "Equipment", role: "asset", tags: { cashFlowClass: "investing" } },
    { code: "2000", name: "Card balance", role: "liability", tags: { cashFlowClass: "operating" } },
    { code: "3000", name: "Owner capital", role: "equity", tags: { cashFlowClass: "financing" } },
    { code: "4000", name: "Design fees", role: "income" },
    { code: "5000", name: "Supplies", role: "expense" },
  ],
};
/** A fixed "today" inside the book's fiscal calendar (2025-10-01 to 2026-09-30). */
const TODAY = new Date("2026-06-15T12:00:00");

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

async function post(
  request: import("@playwright/test").APIRequestContext,
  date: string,
  narration: string,
  lines: [string, string, string][],
) {
  const draft = await api(
    request,
    "drafts.create",
    {
      data: {
        date,
        reference: narration.slice(0, 40),
        narration,
        lines: lines.map(([accountId, debit, credit]) => ({ accountId, debit, credit })),
      },
    },
    crypto.randomUUID(),
  );
  const planId = crypto.randomUUID();
  const plan = await api(
    request,
    "journal.prepare",
    { draftId: draft.id, expectedVersion: 1 },
    planId,
  );
  await api(request, "operations.commit", { planId, planHash: plan.planHash });
}

/** Another report: Reports in the bar is the way back to the list, then the report by its name. The list
 * carries the dates and the choices of the report just read, as moving between statements always did. */
async function openReport(page: Page, name: string) {
  await page
    .locator("header.app-header")
    .getByRole("link", { name: "Reports", exact: true })
    .click();
  await page.locator("main").getByRole("link", { name, exact: true }).click();
  await expect(page.getByRole("heading", { level: 1, name, exact: true })).toBeVisible();
}

const statement = (page: Page, title: string) =>
  page.getByRole("region", { name: new RegExp(`^${title}`) });
/** One of the row's lists (Date range, Compare) by its button: while a list closes, the list itself still answers
 * to the label. */
const list = (page: Page, label: string) =>
  page.getByRole("combobox", { name: label, exact: true });
/** The Net income row at the foot of the profit and loss table: the figure the statement exists to state,
 * read where a person reads it. */
const netIncomeRow = (page: Page) =>
  statement(page, "Profit and loss").getByRole("row", { name: /^Net income/ });
/** The first figure of that row: the period's own (a comparison adds a column of its own and one of change). */
const netIncome = (page: Page) => netIncomeRow(page).locator(".rt-money").first();
/** "Report details" at the foot of a statement: a disclosure, closed until it is asked for. */
const detailsButton = (page: Page) =>
  page.getByRole("button", { name: "Report details", exact: true });
const openDetails = async (page: Page) => {
  const toggle = detailsButton(page);
  if ((await toggle.getAttribute("aria-expanded")) !== "true") await toggle.click();
  await expect(toggle).toHaveAttribute("aria-expanded", "true");
};
/** The whole fingerprint in the body of Report details, where it can be read and selected. */
const fingerprint = (page: Page) =>
  page.locator(".rt-report-foot .rt-details-value[data-mono]").first();
/** Export is a button that opens a short list; choose one of its items. */
const exportAs = async (page: Page, item: string) => {
  await page.getByRole("button", { name: "Export", exact: true }).click();
  await page.getByRole("menuitem", { name: item, exact: true }).click();
};

test("a fresh book is set up and the default statement is the fiscal year to date, tied to the API", async ({
  page,
  request,
}) => {
  const errors: string[] = [];
  page.on("pageerror", (error) => errors.push(error.message));
  await api(request, "book.setup", setup, crypto.randomUUID());
  await post(request, "2025-10-05", "Owner contribution", [
    ["1000", "5000.00", ""],
    ["3000", "", "5000.00"],
  ]);
  await post(request, "2025-11-10", "November design fees", [
    ["1000", "1200.00", ""],
    ["4000", "", "1200.00"],
  ]);
  await post(request, "2025-12-12", "December supplies", [
    ["5000", "300.00", ""],
    ["1000", "", "300.00"],
  ]);
  await post(request, "2026-01-20", "Laptop", [
    ["1100", "2000.00", ""],
    ["1000", "", "2000.00"],
  ]);
  await post(request, "2026-02-14", "Supplies on the card", [
    ["5000", "80.00", ""],
    ["2000", "", "80.00"],
  ]);
  await post(request, "2026-03-03", "March design fees", [
    ["1000", "900.00", ""],
    ["4000", "", "900.00"],
  ]);

  await page.clock.setFixedTime(TODAY);
  await page.goto("/reports?tab=profit-loss");
  // The page is the statement's own: its name is the title, and it has no "Back to" line (Reports is marked
  // in the bar).
  await expect(page.getByRole("heading", { name: "Profit and loss", level: 1 })).toBeVisible();
  await expect(page.getByRole("link", { name: /^Back to/ })).toHaveCount(0);
  await expect(page.getByRole("tab")).toHaveCount(0);
  await expect(page.getByRole("heading", { name: "Profit and loss", level: 2 })).toBeVisible();
  // What the report is, in one line above the table: the book, the dates and the basis.
  await expect(page.locator(".rt-report-book")).toHaveText("Harbor Studio");
  await expect(page.locator(".rt-report-period")).toHaveText(
    shown.range("2025-10-01", "2026-06-15"),
  );
  await expect(page.locator(".rt-report-context").getByText("Cash basis")).toBeVisible();
  // The figure a statement exists to state is the Net income row of its table, and it is the API's.
  await expect(netIncome(page)).toHaveText(shown.money("1720.00"));
  const report = await api(request, "reports.get", { asOf: "2026-06-15" });
  expect(report.profitAndLoss.netIncome).toBe("1720.00");
  await expect(statement(page, "Profit and loss")).toContainText(shown.money("2100.00"));
  await expect(statement(page, "Profit and loss")).toContainText(shown.money("380.00"));
  // The proof is one click away: "Report details" says only its name while it is closed, and neither the
  // revision nor the fingerprint is on the page until it is opened.
  await expect(detailsButton(page)).toHaveAttribute("aria-expanded", "false");
  await expect(page.locator(".rt-report-foot .rt-details-preview")).toHaveCount(0);
  await expect(page.locator(".rt-report-foot").getByRole("button", { name: /Copy/ })).toHaveCount(
    0,
  );
  await expect(fingerprint(page)).toBeHidden();
  expect(await page.locator("body").innerText()).not.toContain(report.populationHash);
  expect(await page.locator("body").innerText()).not.toContain("Book revision");
  await openDetails(page);
  await expect(fingerprint(page)).toHaveText(report.populationHash);
  await expect(fingerprint(page)).toBeVisible();
  // Inside, the fingerprint has the button that copies all of it.
  await expect(
    page.locator(".rt-report-foot").getByRole("button", { name: "Copy fingerprint", exact: true }),
  ).toBeVisible();
  const foot = page.locator(".rt-report-foot");
  await expect(foot).toContainText(report.bookRevision);
  await expect(foot).toContainText("Cash basis");
  await expect(foot).toContainText("USD");
  await expect(foot).toContainText("2025");
  expect(errors).toEqual([]);
});

test("every statement states what it is, and says nothing of a check that holds", async ({
  page,
  request,
}) => {
  await page.clock.setFixedTime(TODAY);
  await page.goto("/reports?from=2026-03-01&to=2026-03-31");
  await openReport(page, "Balance sheet");
  await expect(page.getByRole("heading", { name: "Balance sheet", level: 2 })).toBeVisible();
  await expect(page.locator(".rt-report-period")).toHaveText(`As of ${shown.date("2026-03-31")}`);
  // A check that holds is not said: the totals of the statement already show it (Total assets, and Total
  // liabilities and equity beneath them). It is said, at the head, the moment it does not hold.
  await expect(page.getByRole("region", { name: "The accounting equation" })).toHaveCount(0);
  await expect(page.getByText("Balanced.")).toHaveCount(0);
  await expect(statement(page, "Balance sheet")).toContainText("6,800.00");
  // Earnings of earlier years are worked out, never posted: the line says so in one sentence.
  await expect(
    page.getByText("Worked out from each year's postings and carried forward"),
  ).toBeVisible();

  await openReport(page, "Cash flow");
  await expect(page.getByRole("heading", { name: "Cash flow", level: 2 })).toBeVisible();
  await expect(page.getByRole("region", { name: "Cash ties out" })).toHaveCount(0);
  await expect(statement(page, "Cash flow")).toContainText("Net cash from operating activities");
  const flow = await api(request, "reports.cashFlow", { asOf: "2026-03-31", from: "2026-03-01" });
  expect(flow.closingCash).toBe("4800.00");
  // The statement ends where a cash flow statement does: the change, and the cash it started and ended with.
  await expect(
    statement(page, "Cash flow").getByRole("row", { name: /^Cash at the start of the period/ }),
  ).toContainText("3,900.00");
  await expect(
    statement(page, "Cash flow").getByRole("row", { name: /^Cash at the end of the period/ }),
  ).toContainText("4,800.00");
  await expect(page.locator(".rt-tie")).toHaveCount(0);

  await openReport(page, "Trial balance");
  await expect(page.getByRole("region", { name: "Debits equal credits" })).toHaveCount(0);
  await expect(
    statement(page, "Trial balance").getByRole("row", { name: /1000\s+Operating cash/ }),
  ).toContainText("4,800.00");
});

test("accounts with no activity in the period are left out, and a choice in View shows them", async ({
  page,
}) => {
  await page.clock.setFixedTime(TODAY);
  await page.goto("/reports?from=2026-03-01&to=2026-03-31");
  await expect(page.getByRole("heading", { name: "Profit and loss", level: 2 })).toBeVisible();
  // March had design fees and no supplies: the quiet account is not a row of zeros, and nothing is said of it
  // under the table (no sentence with a link in it); the way to see it is a choice in View.
  await expect(statement(page, "Profit and loss")).toContainText("Design fees");
  await expect(statement(page, "Profit and loss")).not.toContainText("Supplies");
  await expect(page.getByText(/with no activity (is|are) hidden/)).toHaveCount(0);
  await expectView(page, EMPTY, false);
  await setView(page, EMPTY, true);
  await expect(page).toHaveURL(/zero=1/);
  await expect(statement(page, "Profit and loss")).toContainText("Supplies");
  await page.reload();
  await expect(statement(page, "Profit and loss")).toContainText("Supplies");
  await expectView(page, EMPTY, true);
  // The way back is the same choice.
  await setView(page, EMPTY, false);
  await expect(page).not.toHaveURL(/zero=1/);
  await expect(statement(page, "Profit and loss")).not.toContainText("Supplies");
});

test("an amount leads to the activity behind it, and back to the same statement", async ({
  page,
  request,
}) => {
  await page.clock.setFixedTime(TODAY);
  await page.goto("/reports?tab=balance-sheet");
  await page
    .getByRole("link", { name: /activity for 1000 Operating cash/ })
    .first()
    .click();
  await expect(page.getByRole("heading", { level: 1, name: "Operating cash" })).toBeVisible();
  await expect(page.getByRole("row", { name: /Totals for this period/ })).toContainText("4,800.00");
  // What it was built from is under Report details at the foot, as on a statement: no 64-character
  // fingerprint is on the surface.
  await expect(detailsButton(page)).toHaveAttribute("aria-expanded", "false");
  expect(await page.locator("main").innerText()).not.toMatch(/\b[0-9a-f]{64}\b/i);
  await openDetails(page);
  await expect(fingerprint(page)).toHaveText(/^[0-9a-f]{64}$/);
  // Opening, five postings of cash and the closing line, all in one region.
  const table = page.getByRole("region", { name: /^Transactions of / });
  await expect(table).toContainText("Owner contribution");
  await expect(table).toContainText("Laptop");
  await page.getByRole("link", { name: "Back to the report" }).click();
  await expect(page.getByRole("heading", { level: 1, name: "Balance sheet" })).toBeVisible();

  // From an amount to the activity, then to the journal entry that made it.
  await openReport(page, "Profit and loss");
  await page
    .getByRole("link", { name: /activity for 4000 Design fees/ })
    .first()
    .click();
  await expect(page.getByRole("region", { name: /^Transactions of / })).toContainText("2,100.00");
  await page
    .getByRole("region", { name: /^Transactions of / })
    .getByRole("link", { name: "November design fees" })
    .click();
  await expect(page.getByRole("heading", { level: 1, name: /^No\. \d+/ })).toBeVisible();
  // The header, the two lines and the total.
  await expect(page.getByRole("region", { name: "Entry lines" }).getByRole("row")).toHaveCount(4);
  // The journal entry was verified against the report it was opened from.
  const report = await api(request, "reports.get", { asOf: "2026-06-15" });
  expect(page.url()).toContain(`population=${report.populationHash}`);
});

test("the toolbar is usable from the keyboard alone: its choices, the Export list, and the way out of it", async ({
  page,
  browserName,
}) => {
  test.skip(
    browserName === "webkit",
    "Safari's default Tab order skips links and buttons (Option+Tab reaches them), and this test walks it with Tab.",
  );
  await page.clock.setFixedTime(TODAY);
  await page.goto("/reports?tab=profit-loss");
  // From the title, Tab reaches each choice in order.
  await page.getByRole("heading", { name: "Profit and loss", level: 1 }).focus();
  await page.keyboard.press("Tab");
  await expect(list(page, "Date range")).toBeFocused();
  await page.keyboard.press("Tab");
  await expect(list(page, "Compare")).toBeFocused();
  // View (months in columns, % of income) comes before Export.
  await page.keyboard.press("Tab");
  await expect(page.getByRole("button", { name: "View", exact: true })).toBeFocused();
  await page.keyboard.press("Tab");
  const exportButton = page.getByRole("button", { name: "Export", exact: true });
  await expect(exportButton).toBeFocused();
  await expect(exportButton).toHaveAttribute("aria-expanded", "false");
  // The Down arrow opens the list on its first item; the arrows move between the items.
  await page.keyboard.press("ArrowDown");
  await expect(exportButton).toHaveAttribute("aria-expanded", "true");
  const item = (name: string) => page.getByRole("menuitem", { name, exact: true });
  await expect(item("Download CSV")).toBeVisible();
  await expect(item("Download CSV")).toHaveAttribute("data-highlighted", "");
  await page.keyboard.press("ArrowDown");
  await expect(item("Print or save as PDF")).toHaveAttribute("data-highlighted", "");
  await page.keyboard.press("ArrowUp");
  await expect(item("Download CSV")).toHaveAttribute("data-highlighted", "");
  // Escape puts the list away and gives focus back to the button, wherever focus was in the list.
  await page.keyboard.press("Escape");
  await expect(exportButton).toHaveAttribute("aria-expanded", "false");
  await expect(exportButton).toBeFocused();
  await expect(item("Download CSV")).toBeHidden();
  // Choosing a period puts its dates in the address and gives focus back to the list.
  await pick(page, list(page, "Date range"), { value: "lastQuarter" });
  await expect(page).toHaveURL(/from=2026-01-01&to=2026-03-31/);
  await expect(list(page, "Date range")).toBeFocused();
});

// The tests of % of income come here, while the book is still the one the first test set up: the tests
// after them post entries of their own, and the figures worked out by hand below are those of this book.
// ---- % of income -------------------------------------------------------------------------------------
// The profit and loss with each amount's share of total income. The book is Harbor Studio: income 1,200.00 in
// November and 900.00 in March, which is 2,100.00; supplies 300.00 in December and 80.00 in February, which is
// 380.00; net income 1,720.00. Worked by hand, to one decimal, a tie going away from zero:
//   supplies 380 / 2,100 = 18.095% -> 18.1;  net income 1,720 / 2,100 = 81.904% -> 81.9;  income 100.0.
// January to March: income 900.00, supplies 80.00 (8.888% -> 8.9), net income 820.00 (91.111% -> 91.1).
// October to December: income 1,200.00, supplies 300.00 (25.0), net income 900.00 (75.0).
// December alone: no income, and supplies of 300.00. February alone: no income, and supplies of 80.00.
/** The report's View button, and a choice in its menu (there only while the menu is open). */
const viewButton = (page: Page) => page.getByRole("button", { name: "View", exact: true });
const viewChoice = (page: Page, name: string) =>
  page.getByRole("menuitemcheckbox", { name, exact: true });
/** Whether a choice of View is on: opens the menu, reads it, and puts the menu away. */
const expectView = async (page: Page, name: string, on: boolean) => {
  await viewButton(page).click();
  await expect(viewChoice(page, name)).toBeChecked({ checked: on });
  await page.keyboard.press("Escape");
  await expect(viewChoice(page, name)).toBeHidden();
};
/** Turn a choice of View on or off the way a person does: open the menu and choose it. */
const setView = async (page: Page, name: string, on: boolean) => {
  await viewButton(page).click();
  const choice = viewChoice(page, name);
  await expect(choice).toBeVisible();
  if ((await choice.isChecked()) !== on) await choice.click();
  else await page.keyboard.press("Escape");
  await expect(choice).toBeHidden();
  await expectView(page, name, on);
};
const SHARE = "% of income";
const EMPTY = "Accounts with no activity";
const shareHeaders = (page: Page) => page.getByRole("columnheader", { name: /^% of income/ });
const choose = (page: Page, on: boolean) => setView(page, SHARE, on);
const profitRow = (page: Page, pattern: RegExp) =>
  statement(page, "Profit and loss").getByRole("row", { name: pattern });
/** Where a picture of the screen is left for a person to look at, when a run is asked to leave them. */
const picture = async (page: Page, name: string) => {
  const folder = process.env.PERCENT_SHOTS;
  if (!folder) return;
  mkdirSync(folder, { recursive: true });
  await page.screenshot({ path: join(folder, `${name}.png`), fullPage: true });
};
const textOf = async (download: Download): Promise<string> => {
  const chunks: Buffer[] = [];
  for await (const chunk of await download.createReadStream()) chunks.push(chunk as Buffer);
  return Buffer.concat(chunks).toString("utf8");
};

test("% of income: a comparison has a share of its own, divided by its own period's income, and the file follows", async ({
  page,
  request,
}) => {
  await page.clock.setFixedTime(TODAY);
  await page.goto("/reports?from=2026-01-01&to=2026-03-31&compare=previous-period&share=income");
  await expectView(page, SHARE, true);
  await expect(shareHeaders(page)).toHaveCount(2);
  // The columns are: the period, its share, the period before, its share, and the change.
  const now = shown.range("2026-01-01", "2026-03-31");
  const before = shown.range("2025-10-01", "2025-12-31");
  await expect(statement(page, "Profit and loss").getByRole("columnheader")).toHaveText([
    "Account",
    `${now} · USD`,
    `% of income, ${now}`,
    `${before} · USD`,
    `% of income, ${before}`,
    "Change · USD",
  ]);
  // Supplies: 80.00 is 8.9% of 900.00, and the 300.00 before is 25.0% of that period's 1,200.00 (it would be
  // 33.3% of this period's 900.00). Net income: 91.1% and 75.0%.
  const supplies = profitRow(page, /5000\s+Supplies/);
  await expect(supplies).toContainText("8.9%");
  await expect(supplies).toContainText("25.0%");
  await expect(supplies).not.toContainText("33.3%");
  await expect(netIncomeRow(page)).toContainText("91.1%");
  await expect(netIncomeRow(page)).toContainText("75.0%");
  await expect(profitRow(page, /^Total income\s+[−\d]/)).toContainText("100.0%");
  const compared = await api(request, "reports.get", {
    asOf: "2026-03-31",
    from: "2026-01-01",
    compare: "previousPeriod",
    share: "income",
  });
  const supplyRow = (
    compared.profitAndLoss.rows as { code: string; share: string; comparativeShare: string }[]
  ).find((entry) => entry.code === "5000");
  expect(supplyRow).toMatchObject({ share: "8.9", comparativeShare: "25.0" });
  await picture(page, "share-1440-comparison");

  // The file: the amount, its share, the comparison, its share, the change.
  const [download] = await Promise.all([
    page.waitForEvent("download"),
    exportAs(page, "Download CSV"),
  ]);
  const file = await textOf(download);
  expect(file).toContain(
    "Account ID,Code,Account,Type,Amount,% of income,Comparative,Comparative % of income,Change\r\n",
  );
  expect(file).toContain("Supplies,expense,80.00,8.9,300.00,25.0,-220.00\r\n");
  expect(file).toContain(",,Net income,,820.00,91.1,900.00,75.0,-80.00\r\n");
});

test("% of income: a period with no income shows no share and says so, and a comparison with none says which", async ({
  page,
}) => {
  await page.clock.setFixedTime(TODAY);
  // December has supplies of 300.00 and no income at all.
  await page.goto("/reports?from=2025-12-01&to=2025-12-31&share=income");
  await expect(page.getByRole("heading", { name: "Profit and loss", level: 2 })).toBeVisible();
  await expect(page.getByText("No income to compare with", { exact: true })).toBeVisible();
  await expect(
    page.getByText(
      "There is no income in these dates to compare with, so nothing is shown as a share of income.",
    ),
  ).toBeVisible();
  // The column is there, every cell is a dash that a screen reader calls "No share of income", and the
  // amounts are all as they were. Nothing in the body is a percentage.
  await expect(shareHeaders(page)).toHaveCount(1);
  await expect(profitRow(page, /5000\s+Supplies/)).toContainText("300.00");
  const table = statement(page, "Profit and loss");
  expect(await table.locator(".rt-share-none").count()).toBeGreaterThanOrEqual(4);
  expect(await table.getByText("No share of income").count()).toBeGreaterThanOrEqual(4);
  expect((await table.locator("tbody, tfoot").allInnerTexts()).join(" ")).not.toContain("%");
  await expect(netIncomeRow(page)).toContainText(shown.money("-300.00"));
  await picture(page, "share-1440-no-income");

  // March has income and the month before it (February) has none: March keeps its shares, the comparison
  // has dashes, and the page says it is the comparison that has no income.
  await page.goto("/reports?from=2026-03-01&to=2026-03-31&compare=previous-period&share=income");
  await expect(shareHeaders(page)).toHaveCount(2);
  await expect(page.getByText("No income in the comparison period", { exact: true })).toBeVisible();
  await expect(page.getByText("No income to compare with", { exact: true })).toHaveCount(0);
  await expect(profitRow(page, /4000\s+Design fees/)).toContainText("100.0%");
  await expect(netIncomeRow(page)).toContainText("100.0%");
  await expect(profitRow(page, /5000\s+Supplies/)).toContainText("80.00");
  expect(await table.locator(".rt-share-none").count()).toBeGreaterThanOrEqual(4);
});

test("% of income: months in columns and shares do not combine, the other statements do not offer it, and the choice is back where it can be used", async ({
  page,
}) => {
  await page.clock.setFixedTime(TODAY);
  await page.goto("/reports?by=month&share=income");
  // A link that asks for both gets the months, and View says so.
  await expectView(page, "By month", true);
  await expectView(page, SHARE, false);
  await expect(page).not.toHaveURL(/share=/);
  await expect(shareHeaders(page)).toHaveCount(0);

  // Choosing the share takes the months out of the columns.
  await choose(page, true);
  await expect(page).not.toHaveURL(/by=month/);
  await expectView(page, "By month", false);
  await expect(shareHeaders(page)).toHaveCount(1);

  // The balance sheet has no income to take a share of: View does not offer it, no column is added, and
  // the address keeps the choice for the profit and loss.
  await openReport(page, "Balance sheet");
  await viewButton(page).click();
  await expect(viewChoice(page, "By month")).toBeVisible();
  await expect(viewChoice(page, SHARE)).toHaveCount(0);
  await page.keyboard.press("Escape");
  await expect(page.getByRole("columnheader", { name: /% of income/ })).toHaveCount(0);
  await expect(page).toHaveURL(/share=income/);
  await openReport(page, "Profit and loss");
  await expectView(page, SHARE, true);
  await expect(shareHeaders(page)).toHaveCount(1);

  // Choosing months turns the share off, and taking the months away does not turn it back on.
  await setView(page, "By month", true);
  await expectView(page, SHARE, false);
  await expect(page).not.toHaveURL(/share=/);
  await setView(page, "By month", false);
  await expectView(page, SHARE, false);
  await expect(shareHeaders(page)).toHaveCount(0);
});

test("% of income: the keyboard turns it on and off from View, and focus comes back to View", async ({
  page,
  browserName,
}) => {
  test.skip(
    browserName === "webkit",
    "Safari's default Tab order skips links and buttons (Option+Tab reaches them), and this test walks it with Tab.",
  );
  await page.clock.setFixedTime(TODAY);
  await page.goto("/reports?tab=profit-loss");
  await expect(netIncome(page)).toHaveText(shown.money("1720.00"));
  await viewButton(page).focus();
  await page.keyboard.press("Enter");
  await expect(viewChoice(page, SHARE)).toBeVisible();
  // The menu opens on its first choice (By month); one step down is % of income.
  await page.keyboard.press("ArrowDown");
  await page.keyboard.press("Enter");
  await expect(viewChoice(page, SHARE)).toBeHidden();
  await expect(viewButton(page)).toBeFocused();
  await expect(shareHeaders(page)).toHaveCount(1);
  await expect(netIncomeRow(page)).toContainText("81.9%");
  // A person who cannot see the column appear is told that the statement now has it.
  await expect(
    page
      .getByRole("status")
      .filter({ hasText: `${shown.range("2025-10-01", "2026-06-15")}, with % of income.` }),
  ).toHaveCount(1);
  await page.keyboard.press("Enter");
  await expect(viewChoice(page, SHARE)).toBeChecked();
  await page.keyboard.press("ArrowDown");
  await page.keyboard.press("Enter");
  await expect(viewButton(page)).toBeFocused();
  await expect(shareHeaders(page)).toHaveCount(0);
  await expect(page.getByRole("status").filter({ hasText: "with % of income" })).toHaveCount(0);
  // It is the choice after Compare, and the one before Export, in the order a person tabs.
  await list(page, "Compare").focus();
  await page.keyboard.press("Tab");
  await expect(viewButton(page)).toBeFocused();
  await page.keyboard.press("Tab");
  await expect(page.getByRole("button", { name: "Export", exact: true })).toBeFocused();
});

/** The months of the fiscal year to date on the test's "today" (October 1, 2025 to June 15, 2026). */
const MONTHS: readonly [string, string, string][] = [
  ["Oct 2025", "2025-10-01", "2025-10-31"],
  ["Nov 2025", "2025-11-01", "2025-11-30"],
  ["Dec 2025", "2025-12-01", "2025-12-31"],
  ["Jan 2026", "2026-01-01", "2026-01-31"],
  ["Feb 2026", "2026-02-01", "2026-02-28"],
  ["Mar 2026", "2026-03-01", "2026-03-31"],
  ["Apr 2026", "2026-04-01", "2026-04-30"],
  ["May 2026", "2026-05-01", "2026-05-31"],
  ["", "2026-06-01", "2026-06-15"],
];

test("by month: a figure leads to the transactions of its own month, in that month's population, and back to the months", async ({
  page,
  request,
}) => {
  await page.clock.setFixedTime(TODAY);
  await page.goto("/reports?by=month");
  const table = statement(page, "Profit and loss");
  await expect(table.getByRole("columnheader")).toHaveCount(MONTHS.length + 2);
  const march = await api(request, "reports.get", { from: "2026-03-01", asOf: "2026-03-31" });
  // The figure for March (the sixth column of figures) is a link with the dates and the fingerprint of March.
  const link = table
    .getByRole("row", { name: /4000\s+Design fees/ })
    .locator("td")
    .nth(5)
    .getByRole("link");
  await expect(link).toHaveAttribute("title", "View transactions");
  await expect(link).toContainText(shown.range("2026-03-01", "2026-03-31"));
  await link.click();
  await expect(page.getByRole("heading", { level: 1, name: "Design fees" })).toBeVisible();
  const address = new URL(page.url());
  expect(address.searchParams.get("accountId")).toBe("4000");
  expect(address.searchParams.get("asOf")).toBe("2026-03-31");
  expect(address.searchParams.get("from")).toBe("2026-03-01");
  expect(address.searchParams.get("to")).toBe("2026-03-31");
  expect(address.searchParams.get("population")).toBe(march.populationHash);
  expect(address.searchParams.get("back")).toBe("/reports?tab=profit-loss&by=month");
  await expect(page.getByRole("region", { name: /^Transactions of / })).toContainText(
    "March design fees",
  );
  await page.getByRole("link", { name: "Back to the report" }).click();
  await expectView(page, "By month", true);
  await expect(table.getByRole("columnheader")).toHaveCount(MONTHS.length + 2);
});

test("by month: the balance sheet has the position at the end of each month, balanced in every column, and the trial balance has no months", async ({
  page,
  request,
}) => {
  await page.clock.setFixedTime(TODAY);
  await page.goto("/reports?tab=balance-sheet&by=month");
  const table = statement(page, "Balance sheet");
  await expect(table.getByRole("columnheader")).toHaveText([
    "Account",
    ...MONTHS.slice(0, -1).map((entry) => entry[0]),
    `As of ${shown.date("2026-06-15")}`,
  ]);
  // Every column balances: total assets are total liabilities and equity.
  const assets = await table
    .getByRole("row", { name: /^Total assets/ })
    .locator(".rt-money")
    .allInnerTexts();
  const both = await table
    .getByRole("row", { name: /^Total liabilities and equity/ })
    .locator(".rt-money")
    .allInnerTexts();
  expect(assets).toHaveLength(MONTHS.length);
  expect(both).toEqual(assets);
  // March's column is the balance sheet as of March 31, and the last is as of today: the API's.
  const march = await api(request, "reports.get", { from: "2026-03-01", asOf: "2026-03-31" });
  expect(assets[5]).toBe(shown.money(march.balanceSheet.assets));
  const today = await api(request, "reports.get", { from: "2026-06-01", asOf: "2026-06-15" });
  expect(assets.at(-1)).toBe(shown.money(today.balanceSheet.assets));
  // A trial balance is one day: nothing to lay out by month, and no comparison to offer either. Its View
  // holds the one choice it has, the accounts with no activity.
  await openReport(page, "Trial balance");
  await viewButton(page).click();
  await expect(viewChoice(page, "By month")).toHaveCount(0);
  await expect(viewChoice(page, EMPTY)).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(page).not.toHaveURL(/by=month/);
  await expect(statement(page, "Trial balance").getByRole("columnheader")).toHaveCount(3);
  // Coming back, the months are still chosen.
  await openReport(page, "Balance sheet");
  await expectView(page, "By month", true);
});

test("by month: the CSV is the months as they are on screen, with what each column was read from, and nothing a spreadsheet would run", async ({
  page,
  request,
}) => {
  await page.clock.setFixedTime(TODAY);
  await page.goto("/reports?by=month");
  await expect(statement(page, "Profit and loss").getByRole("columnheader")).toHaveCount(
    MONTHS.length + 2,
  );
  const [download] = await Promise.all([
    page.waitForEvent("download"),
    exportAs(page, "Download CSV"),
  ]);
  expect(download.suggestedFilename()).toBe("profit-loss-by-month-2025-10-01-to-2026-06-15.csv");
  const stream = await download.createReadStream();
  const chunks: Buffer[] = [];
  for await (const chunk of stream) chunks.push(chunk as Buffer);
  const text = Buffer.concat(chunks).toString("utf8");
  expect(text.startsWith("﻿Report,Profit and loss by month\r\n")).toBe(true);
  const total = await api(request, "reports.get", { from: "2025-10-01", asOf: "2026-06-15" });
  expect(text).toContain("Book,Harbor Studio\r\n");
  expect(text).toContain("Basis,cash\r\n");
  expect(text).toContain(`Book revision,${total.bookRevision}\r\n`);
  expect(text).toContain(`Population hash,${total.populationHash}\r\n`);
  // Each column's dates and fingerprint.
  const june = await api(request, "reports.get", { from: "2026-06-01", asOf: "2026-06-15" });
  expect(text).toContain(`2026-06,2026-06-01,2026-06-15,${june.populationHash}\r\n`);
  expect(text).toContain("Column,From,To,Population hash\r\n");
  // The heading of the table and the row for Design fees, in plain decimals.
  expect(text).toContain(
    "Account ID,Code,Account,Type,2025-10,2025-11,2025-12,2026-01,2026-02,2026-03,2026-04,2026-05,2026-06,Total\r\n",
  );
  const fees = text.split("\r\n").find((line) => line.startsWith("4000,4000,Design fees,income,"));
  expect(fees).toBeDefined();
  const figures = (fees as string).split(",").slice(4);
  expect(figures).toHaveLength(MONTHS.length + 1);
  expect(figures.every((figure) => /^-?\d+\.\d{2}$/.test(figure))).toBe(true);
  const row = (total.profitAndLoss.rows as { accountId: string; amount: string }[]).find(
    (entry) => entry.accountId === "4000",
  );
  expect(figures.at(-1)).toBe(row?.amount);
  // A spreadsheet runs a cell that begins with = + - or @: none of the text cells does.
  for (const line of text.split("\r\n"))
    for (const cell of line.split(","))
      if (!/^-?\d+\.\d{2}$/.test(cell)) expect(cell, line).not.toMatch(/^[=+\-@]/);
  await expect(page.locator(".rt-report-actions")).toContainText(
    "Downloaded profit-loss-by-month-2025-10-01-to-2026-06-15.csv.",
  );
});

test("by month: Report details lists the fingerprint of each column, and the revision all of them were read at", async ({
  page,
  request,
}) => {
  await page.clock.setFixedTime(TODAY);
  await page.goto("/reports?by=month");
  await expect(statement(page, "Profit and loss").getByRole("columnheader")).toHaveCount(
    MONTHS.length + 2,
  );
  await openDetails(page);
  const total = await api(request, "reports.get", { from: "2025-10-01", asOf: "2026-06-15" });
  await expect(page.locator(".rt-report-foot")).toContainText(total.bookRevision);
  await page.getByRole("button", { name: "The fingerprint of each column", exact: true }).click();
  const rows = page.locator(".rt-report-columns").getByRole("row");
  // A heading and a row for each month and the total.
  await expect(rows).toHaveCount(MONTHS.length + 2);
  const june = await api(request, "reports.get", { from: "2026-06-01", asOf: "2026-06-15" });
  await expect(rows.nth(MONTHS.length)).toContainText(june.populationHash);
  await expect(rows.last()).toContainText(total.populationHash);
});

test("the fingerprint is copied from its row in Report details, and says so once it is on the clipboard", async ({
  page,
  context,
  browserName,
}) => {
  test.skip(browserName !== "chromium", "A test can grant clipboard access only in Chromium.");
  await context.grantPermissions(["clipboard-read", "clipboard-write"]);
  await page.clock.setFixedTime(TODAY);
  await page.goto("/reports?tab=profit-loss");
  // Closed, the fold says only its name, with no button beside it; opened, the fingerprint is there to read, with
  // the button that copies all of it on its own row.
  await expect(detailsButton(page)).toHaveAttribute("aria-expanded", "false");
  await expect(page.getByRole("button", { name: "Copy fingerprint" })).toHaveCount(0);
  await openDetails(page);
  const hash = (await fingerprint(page).textContent()) as string;
  expect(hash).toMatch(/^[0-9a-f]{64}$/);
  await page.getByRole("button", { name: "Copy fingerprint" }).click();
  await expect(page.getByRole("button", { name: "Copied fingerprint" })).toBeVisible();
  await expect(page.locator(".rt-report-foot").getByRole("status")).toContainText(
    "Copied fingerprint",
  );
  expect(await page.evaluate(() => navigator.clipboard.readText())).toBe(hash);
  // The label goes back after a moment, ready to copy again.
  await expect(page.getByRole("button", { name: "Copy fingerprint" })).toBeVisible();
  // The whole fingerprint stays there to read and select, whatever the clipboard says.
  await expect(fingerprint(page)).toHaveText(hash);
});

test("a report pinned to a version of the book says so without printing the version, and the version is under Report details", async ({
  page,
  request,
}) => {
  await page.clock.setFixedTime(TODAY);
  const report = await api(request, "reports.get", { asOf: "2026-06-15" });
  await page.goto(`/reports?revision=${report.bookRevision}`);
  const notice = page.getByText("This report shows the book as it stood at an earlier version");
  await expect(notice).toBeVisible();
  await expect(notice).not.toContainText(String(report.bookRevision));
  await expect(page.getByRole("heading", { name: "Profit and loss", level: 2 })).toBeVisible();
  await openDetails(page);
  await expect(page.locator(".rt-report-foot")).toContainText(String(report.bookRevision));
});
