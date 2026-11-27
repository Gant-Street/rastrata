import { expect, test, type Download, type Page, type Route } from "@playwright/test";
import axe from "axe-core";
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { shown } from "../support/shown";
import { pick, putAway } from "../support/pick";
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
  // One fiscal year, the calendar these tests describe, whatever day they run on.
  calendarThrough: 2025,
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

const scan = async (page: Page, label: string) => {
  await page.addScriptTag({ content: axe.source });
  const violations = await page.evaluate(async () =>
    (
      await window.axe.run(document.body, {
        runOnly: { type: "tag", values: ["wcag2a", "wcag2aa", "wcag21aa"] },
      })
    ).violations.map(({ id, nodes }) => ({ id, targets: nodes.map((node) => node.target) })),
  );
  expect(violations, label).toEqual([]);
};
const settle = async (page: Page, theme: "light" | "dark") => {
  await page.evaluate((value) => {
    document.documentElement.dataset.theme = value;
  }, theme);
  await page.addStyleTag({
    content: "*,*::before,*::after{transition:none!important;animation:none!important}",
  });
};

/** Another report: Reports in the bar is the way back to the list, then the report by its name. The list
 * carries the dates and the choices of the report just read, as moving between statements always did. */
async function openReport(page: Page, name: string) {
  await page
    .locator("header.app-header")
    .getByRole("link", { name: "Reports", exact: true })
    .click();
  await expect(page).toHaveURL(/\/reports$/);
  await page.locator("main").getByRole("link", { name, exact: true }).click();
  await expect(page.getByRole("heading", { level: 1, name, exact: true })).toBeVisible();
}

const statement = (page: Page, title: string) =>
  page.getByRole("region", { name: new RegExp(`^${title}`) });
const select = (page: Page, label: string) => page.getByLabel(label, { exact: true });
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
/** Remember where some of the page's own furniture is, and note whenever any of it is taken out of the
 * page. A read that suspends the router's boundary detaches the page and puts it back: it looks the
 * same afterwards but has lost the focus, which a snapshot of the final page cannot show. Returns how
 * many of the selectors were found, so a selector that matches nothing cannot pass for good news. */
const watchForDetaching = (page: Page, selectors: string[]) =>
  page.evaluate((list) => {
    const kept = list.map((selector) => document.querySelector(selector));
    const state = window as unknown as { detached: string[] };
    state.detached = [];
    new MutationObserver((records) => {
      for (const record of records)
        for (const node of record.removedNodes)
          list.forEach((selector, index) => {
            const element = kept[index];
            if (element && (node === element || node.contains(element)))
              state.detached.push(selector);
          });
    }).observe(document.body, { childList: true, subtree: true });
    return kept.filter((element) => element !== null).length;
  }, selectors);
const detached = (page: Page) =>
  page.evaluate(() => (window as unknown as { detached: string[] }).detached);

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
  // The page is the statement's own. Reports, marked in the bar, is the way back to the list: the page has no
  // "Back to" line of its own, and no row of tabs.
  await expect(page.getByRole("link", { name: /^Back to/ })).toHaveCount(0);
  await expect(
    page.locator("header.app-header").getByRole("link", { name: "Reports", exact: true }),
  ).toHaveAttribute("aria-current", /.+/);
  await expect(page.getByRole("tab")).toHaveCount(0);
  await expect(page.getByRole("heading", { name: "Profit and loss", level: 1 })).toBeVisible();
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
test("the table is on screen at once: the toolbar is one row of choices and the first row of the table is above the fold", async ({
  page,
}) => {
  await page.setViewportSize({ width: 1440, height: 800 });
  await page.clock.setFixedTime(TODAY);
  await page.goto("/reports?tab=profit-loss");
  const first = statement(page, "Profit and loss").getByRole("row").nth(1);
  await expect(first).toBeVisible();
  const box = await first.boundingBox();
  expect((box?.y ?? 9999) + (box?.height ?? 0)).toBeLessThanOrEqual(800);
  // The title, the dates, the comparison, the layout and Export are all within a few rows of each other.
  const title = await page.getByRole("heading", { level: 1 }).boundingBox();
  const exportButton = await page
    .getByRole("button", { name: "Export", exact: true })
    .boundingBox();
  expect((exportButton?.y ?? 0) - (title?.y ?? 0)).toBeLessThan(160);
  for (const label of ["Date range", "Compare"]) await expect(select(page, label)).toBeVisible();
  await expect(viewButton(page)).toBeVisible();
  // The old explanations of the page are not above the table.
  await expect(page.getByText(/This book's fiscal calendar covers/)).toHaveCount(0);
  // The page says what it is in its title; the explanation is in Help, not on the page.
  await expect(page.getByText("Your books as statements for any dates.")).toHaveCount(0);
  await expect(page.getByText("How this works")).toHaveCount(0);
  await expect(page.getByText("Every month is read from the same version")).toHaveCount(0);
});

test("the period, the comparison and the statement live in the address and survive a reload", async ({
  page,
  request,
}) => {
  await page.clock.setFixedTime(TODAY);
  await page.goto("/reports?tab=profit-loss");
  // The periods are the book's own. This book's year starts in October and today is June 15, so this
  // quarter is April to June and the last one is January to March.
  await pick(page, list(page, "Date range"), { value: "lastQuarter" });
  await expect(page.locator(".rt-report-period")).toHaveText(
    shown.range("2026-01-01", "2026-03-31"),
  );
  await expect(netIncome(page)).toHaveText(shown.money("820.00"));
  await expect(page).toHaveURL(/from=2026-01-01&to=2026-03-31/);
  // Custom dates: any two days, kept in the address as typed.
  await pick(page, list(page, "Date range"), { value: "custom" });
  await select(page, "From").fill("2026-03-01");
  await select(page, "To").fill("2026-03-31");
  await expect(page.locator(".rt-report-period")).toHaveText(
    shown.range("2026-03-01", "2026-03-31"),
  );
  await expect(netIncome(page)).toHaveText(shown.money("900.00"));
  await expect(page).toHaveURL(/period=custom&from=2026-03-01&to=2026-03-31/);
  // A comparison with the period before: the same range's own figures, side by side with the change.
  await pick(page, list(page, "Compare"), { value: "previousPeriod" });
  await expect(page).toHaveURL(/compare=previous-period/);
  await expect(
    page.getByRole("columnheader", { name: shown.range("2026-02-01", "2026-02-28") }),
  ).toBeVisible();
  await expect(page.getByRole("columnheader", { name: /^Change/ })).toBeVisible();
  const fees = statement(page, "Profit and loss").getByRole("row", { name: /4000\s+Design fees/ });
  await expect(fees).toContainText("900.00");
  await expect(fees).toContainText("0.00");
  const supplies = statement(page, "Profit and loss").getByRole("row", { name: /5000\s+Supplies/ });
  await expect(supplies).toContainText("80.00");
  // The comparison column is the report that range has on its own.
  const february = await api(request, "reports.get", { asOf: "2026-02-28", from: "2026-02-01" });
  expect(february.profitAndLoss.expenses).toBe("80.00");

  await openReport(page, "General ledger");
  await expect(page).toHaveURL(/tab=general-ledger/);
  await expect(page.getByText("Showing 1 to 2 of 2 transactions.")).toBeVisible();
  // Each line names its entry by number, as Transactions does, and never prints the entry's identifier.
  const ledger = await api(request, "reports.generalLedger", {
    asOf: "2026-03-31",
    from: "2026-03-01",
  });
  expect(ledger.lines.length).toBe(2);
  for (const line of ledger.lines as { journalId: string; postingSequence: string }[]) {
    await expect(page.locator(".rt-ledger-lines")).toContainText(`No. ${line.postingSequence}`);
    await expect(page.locator(".rt-ledger-lines")).not.toContainText(line.journalId);
  }
  // A list of postings has no comparison and no months, so those choices are not offered on it; the
  // comparison is still in the address, and is there again on the statement that can use it.
  await expect(list(page, "Compare")).toHaveCount(0);
  await expect(viewButton(page)).toHaveCount(0);
  await expect(page).toHaveURL(/compare=previous-period/);
  await page.reload();
  await expect(page.getByRole("heading", { name: "General ledger", level: 1 })).toBeVisible();
  await expect(list(page, "Date range")).toHaveAttribute("data-value", "custom");
  await expect(select(page, "From")).toHaveValue(shown.dateBox("2026-03-01"));
  await expect(select(page, "To")).toHaveValue(shown.dateBox("2026-03-31"));
  await expect(page.getByText("Showing 1 to 2 of 2 transactions.")).toBeVisible();
  await openReport(page, "Profit and loss");
  await expect(list(page, "Compare")).toHaveAttribute("data-value", "previousPeriod");
  await expect(page.getByRole("columnheader", { name: /^Change/ })).toBeVisible();
});

test("the whole screen is usable from the keyboard alone", async ({ page, browserName }) => {
  test.skip(
    browserName === "webkit",
    "Safari's default Tab order skips links and buttons (Option+Tab reaches them), and this test walks it with Tab.",
  );
  await page.clock.setFixedTime(TODAY);
  await page.goto("/reports?tab=profit-loss");
  // Another statement is two keys away: Reports in the bar, then the statement, each with Enter.
  await page
    .locator("header.app-header")
    .getByRole("link", { name: "Reports", exact: true })
    .focus();
  await page.keyboard.press("Enter");
  await expect(page).toHaveURL(/\/reports$/);
  await page.getByRole("link", { name: "Balance sheet", exact: true }).focus();
  await page.keyboard.press("Enter");
  await expect(page.getByRole("heading", { name: "Balance sheet", level: 1 })).toBeVisible();
  await page
    .locator("header.app-header")
    .getByRole("link", { name: "Reports", exact: true })
    .focus();
  await page.keyboard.press("Enter");
  await page.getByRole("link", { name: "Profit and loss", exact: true }).focus();
  await page.keyboard.press("Enter");
  await expect(page.getByRole("heading", { name: "Profit and loss", level: 1 })).toBeVisible();
  await page.getByRole("heading", { name: "Profit and loss", level: 1 }).focus();
  // Tab from there to the first amount that leads somewhere, and open it with Enter.
  for (let step = 0; step < 40; step++) {
    await page.keyboard.press("Tab");
    // The table's scroll region is a tab stop too (so it can be scrolled from the keyboard); it is
    // the link inside it that Enter opens.
    const link = await page.evaluate(() =>
      document.activeElement?.tagName === "A" ? (document.activeElement.textContent ?? "") : "",
    );
    if (/activity for 4000 Design fees/.test(link)) break;
  }
  await expect(page.locator("a:focus")).toContainText("activity for 4000 Design fees");
  await page.keyboard.press("Enter");
  await expect(page.getByRole("heading", { level: 1, name: "Design fees" })).toBeVisible();
  // And back to the same statement: the address holds where the person was.
  await page.goBack();
  await expect(page.getByRole("heading", { name: "Profit and loss", level: 1 })).toBeVisible();
  await expect(netIncome(page)).toHaveText(shown.money("1720.00"));
});

test("Export is a menu the keyboard opens, moves in and leaves, as View beside it is", async ({
  page,
  browserName,
}) => {
  test.skip(
    browserName === "webkit",
    "Safari's default Tab order skips buttons (Option+Tab reaches them), and this test walks it with Tab.",
  );
  await page.clock.setFixedTime(TODAY);
  await page.goto("/reports?tab=profit-loss");
  const exportButton = page.getByRole("button", { name: "Export", exact: true });
  const first = page.getByRole("menuitem", { name: "Download CSV", exact: true });
  await exportButton.focus();
  await page.keyboard.press("ArrowDown");
  await expect(first).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(first).toBeHidden();
  await expect(exportButton).toBeFocused();
  // Enter opens it too, the arrows move in it, and pressing elsewhere puts it away.
  await page.keyboard.press("Enter");
  await expect(first).toBeVisible();
  await page.keyboard.press("ArrowDown");
  await expect(page.getByRole("menuitem", { name: "Print or save as PDF" })).toHaveAttribute(
    "data-highlighted",
    "",
  );
  await page.getByRole("heading", { level: 1 }).click();
  await expect(first).toBeHidden();
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

test("% of income: the choice is in the address, every amount has the share the API gives, and the file carries the same figures", async ({
  page,
  request,
}) => {
  const errors: string[] = [];
  page.on("pageerror", (error) => errors.push(error.message));
  await page.clock.setFixedTime(TODAY);
  await page.goto("/reports?tab=profit-loss");
  await expect(netIncome(page)).toHaveText(shown.money("1720.00"));
  // Off to begin with: View has it, not ticked, and the statement has one column of figures.
  await expectView(page, SHARE, false);
  await expect(shareHeaders(page)).toHaveCount(0);
  await expect(page).not.toHaveURL(/share=/);

  await choose(page, true);
  await expect(page).toHaveURL(/share=income/);
  await expect(shareHeaders(page)).toHaveCount(1);
  // The heading says which dates it is the share for, to a screen reader.
  await expect(shareHeaders(page)).toHaveText(
    `% of income, ${shown.range("2025-10-01", "2026-06-15")}`,
  );
  await expect(
    page.getByText("% of income is each amount divided by total income for the same dates"),
  ).toBeVisible();
  await picture(page, "share-1440-default");

  // Every row and total shows the share the API gave it, written the way the screen writes figures.
  const report = await api(request, "reports.get", { asOf: "2026-06-15", share: "income" });
  expect(report.warnings).toEqual([]);
  for (const entry of report.profitAndLoss.rows as { code: string; name: string; share: string }[])
    await expect(profitRow(page, new RegExp(`${entry.code}\\s+${entry.name}`))).toContainText(
      `${entry.share}%`,
    );
  // The totals the statement shows (income and gains are shown as one only when the chart has gains).
  for (const key of ["income", "expense", "netIncome"]) {
    const entry = (
      report.profitAndLoss.totals as { key: string; label: string; share: string }[]
    ).find((total) => total.key === key);
    expect(entry, key).toBeDefined();
    await expect(profitRow(page, new RegExp(`^${entry?.label}\\s+[−\\d]`))).toContainText(
      `${entry?.share}%`,
    );
  }
  // And those are the figures worked out by hand above.
  await expect(profitRow(page, /5000\s+Supplies/)).toContainText("18.1%");
  await expect(profitRow(page, /4000\s+Design fees/)).toContainText("100.0%");
  await expect(netIncomeRow(page)).toContainText("81.9%");
  await expect(netIncomeRow(page)).toContainText(shown.money("1720.00"));

  // A link reproduces the view: reload, and open the address in a page of its own.
  await page.reload();
  await expectView(page, SHARE, true);
  await expect(netIncomeRow(page)).toContainText("81.9%");
  const link = page.url();
  const second = await page.context().newPage();
  await second.clock.setFixedTime(TODAY);
  await second.goto(link);
  await expectView(second, SHARE, true);
  await expect(netIncomeRow(second)).toContainText("81.9%");
  await second.close();

  // The file has the same figures: the service's own, with a byte order mark added for the download.
  const [download] = await Promise.all([
    page.waitForEvent("download"),
    exportAs(page, "Download CSV"),
  ]);
  expect(download.suggestedFilename()).toBe("profit-loss-2025-10-01-to-2026-06-15.csv");
  const file = await textOf(download);
  const served = await api(request, "reports.export", {
    statement: "profit-loss",
    asOf: "2026-06-15",
    share: "income",
  });
  expect(file).toBe(`﻿${served.content}`);
  expect(file).toContain("Account ID,Code,Account,Type,Amount,% of income\r\n");
  expect(file).toContain(",,Net income,,1720.00,81.9\r\n");
  expect(file).toContain("Design fees,income,2100.00,100.0\r\n");
  expect(file).toContain("Supplies,expense,380.00,18.1\r\n");

  // Turned off again, the column goes and the address is what it was.
  await choose(page, false);
  await expect(page).not.toHaveURL(/share=/);
  await expect(shareHeaders(page)).toHaveCount(0);
  await expect(netIncomeRow(page)).not.toContainText("%");
  expect(errors).toEqual([]);
});

test("% of income: both themes and both widths pass the accessibility scan, the page never scrolls sideways, and the table scrolls inside its own region", async ({
  page,
}, testInfo) => {
  test.setTimeout(120_000);
  await page.clock.setFixedTime(TODAY);
  const addresses = [
    "/reports?share=income",
    "/reports?from=2026-01-01&to=2026-03-31&compare=previous-period&share=income",
    "/reports?from=2025-12-01&to=2025-12-31&share=income",
    "/reports?from=2026-03-01&to=2026-03-31&compare=previous-period&share=income",
    "/reports?by=month&share=income",
  ];
  for (const theme of ["light", "dark"] as const)
    for (const address of addresses) {
      await page.goto(address);
      await expect(page.locator(".rt-statement")).toBeVisible();
      await expect(page.getByRole("status").filter({ hasText: /Loading/ })).toHaveCount(0);
      await settle(page, theme);
      await scan(page, `${address} (${theme})`);
    }
  for (const width of [1440, 390]) {
    await page.setViewportSize({ width, height: 900 });
    for (const theme of ["light", "dark"] as const)
      for (const [name, address] of [
        ["share", "/reports?share=income"],
        [
          "share-comparison",
          "/reports?from=2026-01-01&to=2026-03-31&compare=previous-period&share=income",
        ],
        ["share-none", "/reports?from=2025-12-01&to=2025-12-31&share=income"],
      ] as const) {
        await page.goto(address);
        await expect(page.locator(".rt-statement")).toBeVisible();
        await expect(shareHeaders(page).first()).toBeVisible();
        await settle(page, theme);
        expect(
          await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth),
          `${name} at ${width}px ${theme}`,
        ).toBe(true);
        const region = page.getByRole("region", { name: /^Profit and loss/ });
        expect(await region.getAttribute("tabindex")).toBe("0");
        await page.screenshot({
          path: testInfo.outputPath(`reports-${name}-${width}-${theme}.png`),
          fullPage: true,
        });
        await picture(page, `${name}-${width}-${theme}`);
      }
  }
});

/** The whole cents in a figure as the screen prints it ("1,234.50", "−12.00"), so figures can be added up
 * exactly in the test as they are in the books. */
const cents = (text: string): bigint => {
  const match = /^([−-]?)([\d,]+)\.(\d{2})$/.exec(text.trim());
  if (!match) throw new Error(`Not a figure: ${text}`);
  const value =
    BigInt((match[2] as string).replaceAll(",", "")) * 100n + BigInt(match[3] as string);
  return match[1] ? -value : value;
};
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
const monthHeading = (entry: (typeof MONTHS)[number]) =>
  entry[0] || shown.range(entry[1], entry[2]);

test("by month: a column for each month and the total, every figure the API's, and every column read at one book revision", async ({
  page,
  request,
}) => {
  await page.clock.setFixedTime(TODAY);
  const reads: { from?: string; asOf: string; revision?: string }[] = [];
  page.on("request", (made) => {
    if (made.url().includes("/v1/reports.get"))
      reads.push((made.postDataJSON() as { input: (typeof reads)[number] }).input);
  });
  await page.goto("/reports?tab=profit-loss");
  await expect(netIncome(page)).toBeVisible();
  await setView(page, "By month", true);
  await expect(page).toHaveURL(/by=month/);
  // A comparison and months do not combine: the comparison is off, and says why.
  await expect(list(page, "Compare")).toBeDisabled();
  await expect(list(page, "Compare")).toHaveAttribute("data-value", "none");
  await expect(list(page, "Compare")).toHaveAccessibleDescription(
    "Not available with months in columns.",
  );
  const table = statement(page, "Profit and loss");
  await expect(table.getByRole("columnheader")).toHaveText([
    "Account",
    ...MONTHS.map(monthHeading),
    "Total · USD",
  ]);
  // Every figure of the row for Design fees is a figure the API makes for exactly the dates of its column.
  const row = table.getByRole("row", { name: /4000\s+Design fees/ });
  const shownFigures = await row.locator("td .rt-money").allInnerTexts();
  expect(shownFigures).toHaveLength(MONTHS.length + 1);
  const total = await api(request, "reports.get", { from: "2025-10-01", asOf: "2026-06-15" });
  const fees = (report: typeof total) =>
    shown.money(
      (report.profitAndLoss.rows as { accountId: string; amount: string }[]).find(
        (entry) => entry.accountId === "4000",
      )?.amount as string,
    );
  for (const [index, entry] of MONTHS.entries()) {
    const month = await api(request, "reports.get", { from: entry[1], asOf: entry[2] });
    expect(shownFigures[index], monthHeading(entry)).toBe(fees(month));
  }
  expect(shownFigures.at(-1)).toBe(fees(total));
  // The months add up to the total, to the cent: the page checks it and the test checks the page.
  expect(shownFigures.slice(0, -1).reduce((all, figure) => all + cents(figure), 0n)).toBe(
    cents(shownFigures.at(-1) as string),
  );
  await expect(netIncomeRow(page).locator(".rt-money").last()).toHaveText(
    shown.money(total.profitAndLoss.netIncome),
  );
  await expect(page.getByRole("alert")).toHaveCount(0);
  // The whole range was read first and then each month, all of them at the revision the first one said.
  const first = reads.findIndex((read) => read.from === "2025-10-01" && read.asOf === "2026-06-15");
  expect(first).toBeGreaterThanOrEqual(0);
  const monthReads = reads.filter((read) => read.revision !== undefined);
  expect(monthReads).toHaveLength(MONTHS.length);
  expect(monthReads.every((read) => read.revision === total.bookRevision)).toBe(true);
  expect(reads.at(first)?.revision).toBeUndefined();
  // It survives a reload, and the comparison is still off.
  await page.reload();
  await expectView(page, "By month", true);
  await expect(list(page, "Compare")).toBeDisabled();
  await expect(table.getByRole("columnheader")).toHaveCount(MONTHS.length + 2);
  // Turning months off brings the comparison back, and the single column.
  await setView(page, "By month", false);
  await expect(list(page, "Compare")).toBeEnabled();
  await expect(page).not.toHaveURL(/by=month/);
  await expect(table.getByRole("columnheader")).toHaveCount(2);
});

test("dates the book cannot report on are named, and nothing is requested for them", async ({
  page,
}) => {
  await page.clock.setFixedTime(TODAY);
  await page.goto("/reports?tab=profit-loss");
  await pick(page, list(page, "Date range"), { value: "custom" });
  await select(page, "From").fill("2026-04-01");
  await select(page, "To").fill("2026-03-01");
  await expect(page.getByText("The start date is after the end date.")).toBeVisible();
  await expect(select(page, "From")).toHaveAttribute("aria-invalid", "true");
  await expect(page.getByText("Choose valid dates to see this statement.")).toBeVisible();
  // The choices stay where they are, so the dates can be put right: nothing is taken away from under
  // the field being typed in, and no statement is shown for dates that are not usable.
  await expect(select(page, "From")).toBeVisible();
  await expect(page.getByRole("region", { name: /^Profit and loss/ })).toHaveCount(0);
  await expect(statement(page, "Profit and loss")).toHaveCount(0);
  await select(page, "From").fill("2026-01-01");
  await select(page, "To").fill("2027-02-01");
  await expect(
    page.getByText(`Choose dates from ${shown.range("2025-10-01", "2026-09-30")}`),
  ).toBeVisible();
  await select(page, "To").fill("2026-01-31");
  await expect(page.getByRole("heading", { name: "Profit and loss", level: 1 })).toBeVisible();
  await expect(netIncome(page)).toHaveText(shown.money("0.00"));
  // An older link that names only an end date opens as custom dates from the start of the year.
  await page.goto("/reports?asOf=2026-01-31");
  await expect(list(page, "Date range")).toHaveAttribute("data-value", "custom");
  await expect(select(page, "From")).toHaveValue(shown.dateBox("2025-10-01"));
  await expect(select(page, "To")).toHaveValue(shown.dateBox("2026-01-31"));
  await expect(netIncome(page)).toHaveText(shown.money("900.00"));
  // A period the book does not have is said so, never silently replaced.
  await page.goto("/reports?period=month%3A2031-01");
  await expect(page.getByText(/has no period "month:2031-01"/)).toBeVisible();
  await expect(list(page, "Date range")).toHaveAttribute("data-value", "fiscalYearToDate");
});

test("a link made before the dates were chosen with the date range still opens, and dates are read as the period they are", async ({
  page,
}) => {
  await page.clock.setFixedTime(TODAY);
  // The old picker wrote "month:2026-03": it opens as the dates it stood for.
  await page.goto("/reports?period=month%3A2026-03");
  await expect(page.locator(".rt-report-period")).toHaveText(
    shown.range("2026-03-01", "2026-03-31"),
  );
  await expect(list(page, "Date range")).toHaveAttribute("data-value", "custom");
  await expect(netIncome(page)).toHaveText(shown.money("900.00"));
  // Dates that are a period of this book are that period: today is June 15, so January to March is the
  // last quarter and the whole fiscal year to date has no dates in its address.
  await page.goto("/reports?from=2026-01-01&to=2026-03-31");
  await expect(list(page, "Date range")).toHaveAttribute("data-value", "lastQuarter");
  await expect(select(page, "From")).toHaveCount(0);
  await pick(page, list(page, "Date range"), { value: "fiscalYearToDate" });
  await expect(page).not.toHaveURL(/from=/);
  await expect(netIncome(page)).toHaveText(shown.money("1720.00"));
  // A period this book does not reach is listed, and cannot be chosen.
  await list(page, "Date range").click();
  await expect(page.getByRole("option", { name: /Last fiscal year/ })).toBeDisabled();
  await putAway(page);
});

test("a statement downloads as a file that says what it was built from, and prints without the page around it", async ({
  page,
}) => {
  await page.clock.setFixedTime(TODAY);
  await page.goto("/reports?tab=profit-loss");
  const hash = await fingerprint(page).textContent();
  const [download] = await Promise.all([
    page.waitForEvent("download"),
    exportAs(page, "Download CSV"),
  ]);
  expect(download.suggestedFilename()).toBe("profit-loss-2025-10-01-to-2026-06-15.csv");
  const stream = await download.createReadStream();
  const chunks: Buffer[] = [];
  for await (const chunk of stream) chunks.push(chunk as Buffer);
  const text = Buffer.concat(chunks).toString("utf8");
  // A byte order mark first, so a spreadsheet reads accented names correctly.
  expect(text.startsWith("﻿Report,Profit and loss\r\n")).toBe(true);
  expect(text).toContain("Book,Harbor Studio");
  expect(text).toContain("Basis,cash");
  expect(text).toContain(`Population hash,${hash}`);
  expect(text).toContain("Net income");
  // The list put itself away, and focus is back on its button for the person at the keyboard.
  await expect(page.getByRole("button", { name: "Export", exact: true })).toBeFocused();
  await expect(page.locator(".rt-report-actions")).toContainText(
    "Downloaded profit-loss-2025-10-01-to-2026-06-15.csv.",
  );

  await page.emulateMedia({ media: "print" });
  await expect(page.locator(".app-header")).toBeHidden();
  await expect(page.locator(".app-footer")).toBeHidden();
  await expect(page.locator(".rt-period")).toBeHidden();
  await expect(page.locator(".rt-report-controls")).toBeHidden();
  await expect(page.getByRole("heading", { name: "Profit and loss", level: 1 })).toBeVisible();
  await expect(statement(page, "Profit and loss")).toBeVisible();
  // The disclosure does not print; a plain line takes its place, so a page torn from a binder still
  // says what it was built from.
  await expect(page.locator(".rt-report-foot .rt-details")).toBeHidden();
  await expect(page.locator(".rt-report-proof")).toBeVisible();
  await expect(page.locator(".rt-report-proof")).toContainText(hash as string);
  await expect(page.locator(".rt-report-proof")).toContainText("Book revision");
  // Whatever theme is on screen, the paper is white and the ink is black.
  await settle(page, "dark");
  const printed = await page.evaluate(() => {
    const rgba = (css: string) => {
      const canvas = document.createElement("canvas");
      canvas.width = 1;
      canvas.height = 1;
      const context = canvas.getContext("2d") as CanvasRenderingContext2D;
      context.fillStyle = css;
      context.fillRect(0, 0, 1, 1);
      return Array.from(context.getImageData(0, 0, 1, 1).data);
    };
    const amount = document.querySelector(".rt-statement tfoot .rt-money") as Element;
    // The paper behind the amount: the nearest painted background, or the unpainted white page.
    let paper = [255, 255, 255];
    for (let node: Element | null = amount; node; node = node.parentElement) {
      const [red, green, blue, alpha] = rgba(getComputedStyle(node).backgroundColor);
      if (alpha === 255) {
        paper = [red as number, green as number, blue as number];
        break;
      }
    }
    return { paper, ink: rgba(getComputedStyle(amount).color) };
  });
  expect(printed.paper).toEqual([255, 255, 255]);
  expect(printed.ink.slice(0, 3).every((channel) => channel < 40)).toBe(true);
  // The help button beside the basis does nothing on paper.
  await expect(page.locator(".rt-report-context .rt-icon-button")).toHaveCount(1);
  await expect(page.locator(".rt-report-context .rt-icon-button").first()).toBeHidden();
  await page.emulateMedia({ media: "screen" });
  await expect(page.locator(".app-header")).toBeVisible();
  await expect(page.locator(".rt-report-proof")).toBeHidden();
});

test("a figure that leads somewhere says so: a tooltip, an underline under the pointer and the keyboard, and a name that says where", async ({
  page,
}) => {
  await page.clock.setFixedTime(TODAY);
  await page.goto("/reports?tab=profit-loss");
  const link = page.getByRole("link", { name: /activity for 4000 Design fees/ }).first();
  await expect(link).toHaveAttribute("title", "View transactions");
  await expect(link).toHaveAttribute("href", /^\/ledger\?accountId=4000/);
  const underline = () => link.evaluate((element) => getComputedStyle(element).textDecorationLine);
  await page.mouse.move(0, 0);
  expect(await underline()).toBe("none");
  await link.hover();
  expect(await underline()).toBe("underline");
  // The keyboard gets it too.
  await page.mouse.move(0, 0);
  await link.focus();
  expect(await underline()).toBe("underline");
  // A total is not a link: only a figure that has transactions behind it is.
  await expect(netIncomeRow(page).getByRole("link")).toHaveCount(0);
});

test("a report older than the book is named, and reading it again shows the current figures", async ({
  page,
  request,
}) => {
  await page.clock.setFixedTime(TODAY);
  await page.goto("/reports?tab=profit-loss");
  await expect(netIncome(page)).toHaveText(shown.money("1720.00"));
  // The book moves on in another window while this report sits on screen.
  await post(request, "2026-04-01", "April design fees", [
    ["1000", "50.00", ""],
    ["4000", "", "50.00"],
  ]);
  await page
    .getByRole("link", { name: /activity for 4000 Design fees/ })
    .first()
    .click();
  await expect(page.getByText("The book has changed")).toBeVisible();
  await expect(page.getByText(/read the report again/i).first()).toBeVisible();
  await page.getByRole("button", { name: "Read the report again" }).click();
  await expect(page.getByRole("heading", { name: "Profit and loss", level: 1 })).toBeVisible();
  await expect(netIncome(page)).toHaveText(shown.money("1770.00"));
  // Money in and out on Home reads the same statements, so it agrees: this month, to the cent.
  await page.goto("/");
  const month = { asOf: "2026-06-15", from: "2026-06-01" };
  const statements = await api(request, "reports.get", month);
  const june = page
    .getByRole("table", { name: /Money in and out by month/ })
    .getByRole("row", { name: new RegExp(`^${shown.month("2026-06")}`) });
  await expect(june.getByRole("cell").nth(0)).toHaveText(
    shown.money(statements.profitAndLoss.revenue),
  );
  await expect(june.getByRole("cell").nth(1)).toHaveText(
    shown.money(statements.profitAndLoss.expenses),
  );
});

test("both themes and both widths pass the accessibility scan and never scroll the page sideways", async ({
  page,
}, testInfo) => {
  test.setTimeout(120_000);
  await page.clock.setFixedTime(TODAY);
  for (const theme of ["light", "dark"] as const) {
    for (const tab of [
      "profit-loss",
      "balance-sheet",
      "cash-flow",
      "trial-balance",
      "general-ledger",
    ]) {
      await page.goto(`/reports?tab=${tab}&compare=previous-period`);
      await expect(page.getByRole("heading", { level: 2 }).first()).toBeVisible();
      await expect(page.getByRole("status").filter({ hasText: /Loading/ })).toHaveCount(0);
      await settle(page, theme);
      await scan(page, `/reports ${tab} (${theme})`);
    }
    // By month: the table is wider than the page and scrolls inside its own region, with its names in view.
    for (const address of [
      "/reports?by=month",
      "/reports?tab=balance-sheet&by=month",
      // The date range with Custom chosen shows From and To under the list.
      "/reports?period=custom&from=2026-01-01&to=2026-03-31",
    ]) {
      await page.goto(address);
      await expect(page.locator(".rt-statement")).toBeVisible();
      await expect(page.getByRole("status").filter({ hasText: /Loading/ })).toHaveCount(0);
      await settle(page, theme);
      await scan(page, `${address} (${theme})`);
    }
    // The Export list and Report details, opened.
    await page.goto("/reports?tab=profit-loss");
    await expect(page.locator(".rt-statement")).toBeVisible();
    await openDetails(page);
    await page.getByRole("button", { name: "Export", exact: true }).click();
    await expect(page.getByRole("menuitem", { name: "Download CSV" })).toBeVisible();
    await settle(page, theme);
    await scan(page, `/reports with the Export list and the details open (${theme})`);
    // The page every amount leads to, opened the way a person opens it.
    await page.goto("/reports?tab=profit-loss");
    await page
      .getByRole("link", { name: /activity for 4000 Design fees/ })
      .first()
      .click();
    await expect(page.getByRole("heading", { level: 1, name: "Design fees" })).toBeVisible();
    await expect(page.getByRole("row", { name: /Totals for this period/ })).toBeVisible();
    await settle(page, theme);
    await scan(page, `/ledger (${theme})`);
  }
  for (const width of [1440, 390]) {
    await page.setViewportSize({ width, height: 900 });
    for (const theme of ["light", "dark"] as const) {
      await page.goto("/reports?tab=profit-loss");
      await expect(page.getByRole("heading", { name: "Profit and loss", level: 1 })).toBeVisible();
      await settle(page, theme);
      expect(
        await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth),
        `${width}px ${theme}`,
      ).toBe(true);
      await page.screenshot({
        path: testInfo.outputPath(`reports-${width}-${theme}.png`),
        fullPage: true,
      });
      // With a column for each month the table scrolls inside its own region, never the page.
      await page.goto("/reports?by=month");
      await expect(page.locator(".rt-statement")).toBeVisible();
      await settle(page, theme);
      expect(
        await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth),
        `by month at ${width}px ${theme}`,
      ).toBe(true);
      const region = page.getByRole("region", { name: /^Profit and loss/ });
      expect(await region.getAttribute("tabindex")).toBe("0");
      await page.screenshot({
        path: testInfo.outputPath(`reports-by-month-${width}-${theme}.png`),
        fullPage: true,
      });
    }
  }
});

test("reading a statement again keeps the page and the focus where they were, and the old figures say they are busy", async ({
  page,
}) => {
  await page.clock.setFixedTime(TODAY);
  // The last quarter against the one before: the comparison column is where a read once suspended the
  // whole page.
  await page.goto("/reports?from=2026-01-01&to=2026-03-31&compare=previous-period");
  await expect(page.getByRole("columnheader", { name: /^Change/ })).toBeVisible();
  expect(await watchForDetaching(page, [".rt-period", ".rt-report-actions"])).toBe(2);
  let reads = 0;
  await page.route("**/v1/reports.get", async (route) => {
    reads += 1;
    await new Promise((resolve) => setTimeout(resolve, 600));
    await route.continue();
  });
  const period = list(page, "Date range");
  await period.focus();
  await pick(page, period, { value: "thisQuarter" });
  // The last quarter stays on screen, marked busy, while this one is read; nothing around it moves.
  await expect(page.locator('.rt-report-busy[aria-busy="true"]')).toBeVisible();
  await expect(netIncome(page)).toHaveText(shown.money("820.00"));
  await expect(period).toBeFocused();
  await expect(netIncome(page)).toHaveText(shown.money("50.00"));
  await expect(page.locator('.rt-report-busy[aria-busy="false"]')).toBeVisible();
  await expect(period).toBeFocused();
  expect(await detached(page)).toEqual([]);
  expect(reads).toBe(1);
  expect(await detached(page)).toEqual([]);
  // Another statement is a page of its own, opened from the list with the same dates and the same
  // comparison: it reads its own figures, and the profit and loss comes back as it was left.
  for (const name of ["Balance sheet", "Trial balance", "Profit and loss"])
    await openReport(page, name);
  await expect(list(page, "Date range")).toHaveAttribute("data-value", "thisQuarter");
  await expect(netIncome(page)).toHaveText(shown.money("50.00"));
});

test("an answer that arrives late never replaces a newer one", async ({ page }) => {
  await page.clock.setFixedTime(TODAY);
  await page.goto("/reports?from=2026-03-01&to=2026-03-31");
  await expect(netIncome(page)).toHaveText(shown.money("900.00"));
  const from = (request: ReturnType<Route["request"]>) =>
    (request.postDataJSON() as { input: { from?: string } }).input.from;
  // The last quarter is slow and this quarter is quick, and the person asks for this quarter second.
  await page.route("**/v1/reports.get", async (route) => {
    if (from(route.request()) === "2026-01-01")
      await new Promise((resolve) => setTimeout(resolve, 1200));
    await route.continue();
  });
  const slow = page.waitForResponse(
    (response) =>
      response.url().includes("reports.get") && from(response.request()) === "2026-01-01",
  );
  const period = list(page, "Date range");
  await pick(page, period, { value: "lastQuarter" });
  await pick(page, period, { value: "thisQuarter" });
  await expect(netIncome(page)).toHaveText(shown.money("50.00"));
  await slow;
  // Let the page act on the slow answer, if it is going to.
  await page.waitForTimeout(300);
  await expect(netIncome(page)).toHaveText(shown.money("50.00"));
  await expect(page.locator('.rt-report-busy[aria-busy="false"]')).toBeVisible();
  await expect(page).toHaveURL(/from=2026-04-01&to=2026-06-30/);
});

test("turning the pages of an account's activity keeps the table, the pager and the focus in place", async ({
  page,
  request,
}) => {
  await page.clock.setFixedTime(TODAY);
  // One entry with sixty lines on the cash account: three pages of twenty-five.
  await post(request, "2026-05-02", "Sixty small receipts", [
    ...Array.from({ length: 60 }, () => ["1000", "1.00", ""] as [string, string, string]),
    ["4000", "", "60.00"],
  ]);
  await page.goto("/reports?tab=balance-sheet");
  await page
    .getByRole("link", { name: /activity for 1000 Operating cash/ })
    .first()
    .click();
  await expect(page.getByRole("heading", { level: 1, name: "Operating cash" })).toBeVisible();
  await expect(page.getByText(/Showing 1 to 25 of \d+ transactions\./)).toBeVisible();
  expect(await watchForDetaching(page, ['nav[aria-label="Pagination"]', ".rt-table-scroll"])).toBe(
    2,
  );
  await page.route("**/v1/activity.get", async (route) => {
    await new Promise((resolve) => setTimeout(resolve, 500));
    await route.continue();
  });
  const next = page.getByRole("button", { name: "Next page" });
  await next.focus();
  await page.keyboard.press("Enter");
  // The first page stays on screen, busy, while the second is read.
  await expect(page.locator('.rt-report-busy[aria-busy="true"]')).toBeVisible();
  await expect(page.getByText(/Showing 1 to 25 of \d+ transactions\./)).toBeVisible();
  await expect(next).toBeFocused();
  await expect(page.getByText(/Showing 26 to 50 of \d+ transactions\./)).toBeVisible();
  await expect(next).toBeFocused();
  await page.keyboard.press("Enter");
  await expect(page.getByText(/Showing 51 to \d+ of \d+ transactions\./)).toBeVisible();
  await page.getByRole("button", { name: "Previous page" }).focus();
  await page.keyboard.press("Enter");
  await expect(page.getByText(/Showing 26 to 50 of \d+ transactions\./)).toBeVisible();
  await expect(page.getByRole("button", { name: "Previous page" })).toBeFocused();
  expect(await detached(page)).toEqual([]);
});

test("a download made after the book moved says so, and reading again leaves the focus with the statement", async ({
  page,
  request,
}) => {
  await page.clock.setFixedTime(TODAY);
  await page.goto("/reports?tab=profit-loss");
  const before = await netIncome(page).textContent();
  await post(request, "2026-05-20", "May design fees", [
    ["1000", "10.00", ""],
    ["4000", "", "10.00"],
  ]);
  await Promise.all([page.waitForEvent("download"), exportAs(page, "Download CSV")]);
  await expect(page.getByText("The book has changed", { exact: true })).toBeVisible();
  // The button that offers a fresh read disappears when it is pressed; the keyboard must not be lost.
  const again = page.getByRole("button", { name: "Read the report again" });
  await again.focus();
  await page.keyboard.press("Enter");
  await expect(page.getByRole("heading", { name: "Profit and loss", level: 1 })).toBeFocused();
  await expect(netIncome(page)).not.toHaveText(before as string);
  await expect(page.getByText("The book has changed", { exact: true })).toHaveCount(0);
});

test("by month: a posting made while the months are being read cannot split the columns", async ({
  page,
  request,
}) => {
  await page.clock.setFixedTime(TODAY);
  // As soon as the first month is asked for, another window posts to May. Every month was pinned to the
  // book as the first read of the whole range saw it, so the columns are one book, and they add up.
  let posted = false;
  await page.route("**/v1/reports.get", async (route) => {
    const { input } = route.request().postDataJSON() as { input: { revision?: string } };
    if (input.revision !== undefined && !posted) {
      posted = true;
      await post(request, "2026-05-12", "Late design fees", [
        ["1000", "75.00", ""],
        ["4000", "", "75.00"],
      ]);
    }
    await route.continue();
  });
  await page.goto("/reports?by=month");
  const table = statement(page, "Profit and loss");
  await expect(table.getByRole("columnheader")).toHaveCount(MONTHS.length + 2);
  expect(posted).toBe(true);
  // The columns agree with each other and with the total, and nothing says they do not.
  await expect(page.getByRole("alert")).toHaveCount(0);
  const row = table.getByRole("row", { name: /4000\s+Design fees/ });
  const figures = await row.locator("td .rt-money").allInnerTexts();
  expect(figures.slice(0, -1).reduce((all, figure) => all + cents(figure), 0n)).toBe(
    cents(figures.at(-1) as string),
  );
  // The late posting is in neither the May column nor the total: they are the book as the first read saw it.
  const may = await api(request, "reports.get", { from: "2026-05-01", asOf: "2026-05-31" });
  const mayNow = (may.profitAndLoss.rows as { accountId: string; amount: string }[]).find(
    (entry) => entry.accountId === "4000",
  )?.amount as string;
  expect(cents(figures[7] as string) + 7500n).toBe(cents(shown.money(mayNow)));
  // Reading again is the book as it is now, with the posting in its month and in the total.
  await page.unroute("**/v1/reports.get");
  await page.reload();
  await expect(row.locator("td .rt-money").nth(7)).toHaveText(shown.money(mayNow));
});
