import { type APIRequestContext, expect, type Page, test } from "@playwright/test";
import axe from "axe-core";
import { shown } from "../support/shown";
import { pick } from "../support/pick";

declare global {
  interface Window {
    axe: typeof axe;
  }
}

// The move from another system, driven the way a person would, against a fresh book on the real
// local API: the cutover date is recorded, the opening balances are typed from the keyboard,
// reviewed, prepared and posted, and the checklist then says why the month cannot close yet. The
// entry the ledger holds is compared with the figures typed, to the cent.
const version = "rastrata-application-v1";
test.describe.configure({ mode: "serial" });

/** The first day of the month two months ago: a cutover in the past, so a month has ended since. */
const now = new Date();
const first = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() - 2, 1));
const CUTOVER = first.toISOString().slice(0, 10);
/** The fiscal year starts on the cutover month, so the book's calendar holds both it and today. */
const setup = {
  name: "Harbor Studio",
  currency: "USD",
  fiscalYear: first.getUTCFullYear(),
  fiscalYearStartMonth: first.getUTCMonth() + 1,
  basis: "accrual",
  periodModel: "monthly",
  accounts: [
    { code: "1000", name: "Operating account", role: "asset", tags: { cashFlowClass: "cash" } },
    { code: "1100", name: "Equipment", role: "asset", tags: { cashFlowClass: "investing" } },
    { code: "2000", name: "Card balance", role: "liability", tags: { cashFlowClass: "operating" } },
    { code: "3000", name: "Owner capital", role: "equity", tags: { cashFlowClass: "financing" } },
    { code: "3900", name: "Opening balance equity", role: "equity" },
    { code: "4000", name: "Design fees", role: "income" },
    { code: "5000", name: "Supplies", role: "expense" },
  ],
};

// Xero's exports are made up here, small, in the layouts Xero documents. The trial balance is as at
// the day before the cutover date, written the way Xero writes a date in a title line.
const MONTH_NAMES = [
  "January",
  "February",
  "March",
  "April",
  "May",
  "June",
  "July",
  "August",
  "September",
  "October",
  "November",
  "December",
];
const dayBefore = new Date(Date.UTC(first.getUTCFullYear(), first.getUTCMonth(), 0));
const XERO_AS_AT = `${dayBefore.getUTCDate()} ${MONTH_NAMES[dayBefore.getUTCMonth()]} ${dayBefore.getUTCFullYear()}`;
const XERO_CHART = [
  "*Code,*Name,*Type,*Tax Code,Description,Dashboard,Expense Claims,Enable Payments,Balance",
  "090,Operating account,Bank,Tax Exempt,,No,No,No,12000.00",
  "091,Card balance,Bank,Tax Exempt,,No,No,No,-523.10",
  "200,Design fees,Revenue,Tax Exempt,,No,No,Yes,",
  "310,Cost of Goods Sold,Direct Costs,Tax Exempt,,No,No,Yes,",
  "400,Supplies,Expense,Tax Exempt,,No,No,Yes,",
  "470,Other Revenue,Revenue,Tax Exempt,,No,No,Yes,",
].join("\n");
const XERO_TRIAL_BALANCE = [
  "Trial Balance",
  "Harbor Studio",
  `As at ${XERO_AS_AT}`,
  "",
  "Account,Debit,Credit,YTD Debit,YTD Credit",
  "Assets",
  "Operating account (090),12000.00,,12000.00,",
  "Liabilities",
  "Card balance (091),,523.10,,523.10",
  "Equity",
  "Retained Earnings (960),,11476.90,,11476.90",
  "Total,12000.00,12000.00,12000.00,12000.00",
].join("\n");
const csvFile = (name: string, text: string) => ({
  name,
  mimeType: "text/csv",
  buffer: Buffer.from(text),
});

async function api(request: APIRequestContext, name: string, input: unknown, operationId?: string) {
  const response = await request.post(`/v1/${name}`, {
    data: { version, bookId: "local-book", input, ...(operationId ? { operationId } : {}) },
  });
  const body = await response.json();
  expect(body.ok, JSON.stringify(body.error)).toBe(true);
  return body.data;
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
/** Both themes, one after the other, on whatever the page now shows. */
const scanBothThemes = async (page: Page, label: string) => {
  for (const theme of ["light", "dark"] as const) {
    await settle(page, theme);
    await scan(page, `${label} (${theme})`);
  }
  await settle(page, "light");
};
const noSidewaysScroll = async (page: Page, label: string) => {
  const overflow = await page.evaluate(
    () => document.documentElement.scrollWidth - document.documentElement.clientWidth,
  );
  // When it does scroll, say which elements reach past the edge, so the cause is in the message.
  const offenders =
    overflow > 0
      ? await page.evaluate(() =>
          [...document.querySelectorAll<HTMLElement>("body *")]
            .filter(
              (element) =>
                element.getBoundingClientRect().right > document.documentElement.clientWidth + 1,
            )
            .slice(0, 8)
            .map((element) => `${element.tagName.toLowerCase()}.${element.className}`.slice(0, 80)),
        )
      : [];
  expect(overflow, `${label} scrolls sideways: ${offenders.join(" | ")}`).toBeLessThanOrEqual(0);
};

const balance = (page: Page, account: string) =>
  page.getByLabel(`Balance for ${account}`, { exact: true });
const tableRow = (page: Page, name: RegExp) => page.getByRole("row", { name });

test("before there is a book, every screen of the move says so in plain words and does not fail", async ({
  page,
}) => {
  const errors: string[] = [];
  page.on("pageerror", (error) => errors.push(error.message));
  page.on("console", (message) => {
    // A request the service answers with an error status is the browser's own console line.
    if (message.type() === "error" && !/^Failed to load resource/.test(message.text()))
      errors.push(message.text());
  });
  const screens = [
    ["/opening", "Opening balances"],
    ["/xero", "Import from Xero"],
    ["/tie-out", "Compare with Xero"],
    ["/gaps", "Things to check"],
  ] as const;
  for (const [path, title] of screens) {
    await page.goto(path);
    await expect(page.getByRole("heading", { level: 1, name: title }), path).toBeVisible();
    await expect(page.getByText("There is no book yet"), path).toBeVisible();
    await expect(
      page.locator("main").getByRole("link", { name: "Set up your books" }),
      path,
    ).toHaveAttribute("href", "/");
    // Not an error: nothing says it could not be loaded.
    await expect(page.getByText(/could not be loaded/), path).toHaveCount(0);
  }
  await scanBothThemes(page, "a screen of the move before there is a book");
  expect(errors).toEqual([]);
});

test("a fresh book: Home offers the opening balances, and the cutover date is recorded", async ({
  page,
  request,
}) => {
  const errors: string[] = [];
  page.on("pageerror", (error) => errors.push(error.message));
  await api(request, "book.setup", setup, crypto.randomUUID());

  await page.goto("/");
  // The start of a new book has one quiet line for a person moving from another system, and it goes there.
  const start = page.locator(".rt-start");
  await expect(start).toContainText("Moving from another system");
  await start.getByRole("link", { name: "Bring in your books", exact: true }).click();
  // The page of that name lists the ways in; the start date and the opening balances are the first.
  await expect(page).toHaveURL(/\/settings\/bring-in$/);
  await page
    .locator("main")
    .getByRole("link", { name: /^Start date and opening balances/ })
    .click();
  await expect(page).toHaveURL(/\/opening$/);
  const heading = page.getByRole("heading", { level: 1, name: "Opening balances" });
  await expect(heading).toBeVisible();

  // Nothing can be reviewed before the cutover date is recorded, and the screen says why.
  await expect(page.getByRole("button", { name: "Review the entry" })).toBeDisabled();
  await expect(page.getByText(/Record the start date first/)).toBeVisible();

  await page.getByLabel("Start date", { exact: true }).fill(CUTOVER);
  await page.getByRole("button", { name: "Record start date" }).focus();
  await page.keyboard.press("Enter");
  await expect(page.getByText(`Start date recorded: ${shown.date(CUTOVER)}.`)).toBeVisible();
  // Recording it again is not offered as the main action: nothing has changed.
  await expect(page.getByRole("button", { name: "Record start date" })).toBeDisabled();

  // The service holds the date, not only the page.
  const state = await api(request, "cutover.get", {});
  expect(state.cutover.cutoverDate).toBe(CUTOVER);

  // With the date recorded the books are still not in: only a posted entry takes the line away.
  await page.goto("/");
  await expect(
    page.locator(".rt-start").getByRole("link", { name: "Bring in your books", exact: true }),
  ).toBeVisible();
  expect(errors).toEqual([]);
});

test("Xero's chart is read, decided and kept, and the mapping stands", async ({
  page,
  request,
}) => {
  const errors: string[] = [];
  page.on("pageerror", (error) => errors.push(error.message));
  await page.goto("/xero");
  await expect(page.getByRole("heading", { level: 1, name: "Import from Xero" })).toBeVisible();
  // Four files, one step at a time: the first is open and asks for its file, the others are only named.
  await expect(page.getByText("Four files from Xero, one at a time.")).toBeVisible();
  const step = (name: RegExp) => page.locator(".rt-step-trigger").filter({ hasText: name });
  await expect(step(/Chart of accounts/)).toHaveAttribute("aria-expanded", "true");
  for (const name of [/Trial balance/, /Account transactions/, /Where Xero was reconciled/])
    await expect(step(name)).toHaveAttribute("aria-expanded", "false");
  const choose = page.getByRole("main").getByRole("button", { name: "Choose a file", exact: true });
  await expect(choose).toHaveText(["Choose a file"]);
  // Its words can be read: they are not the colour of the button (they once were, black on black).
  const colours = await choose.first().evaluate((element) => {
    const style = getComputedStyle(element);
    return { text: style.color, button: style.backgroundColor };
  });
  expect(colours.text).not.toBe(colours.button);
  await scanBothThemes(page, "the Xero import before any file");

  await page
    .getByLabel(/^Xero's chart of accounts/)
    .setInputFiles(csvFile("chart.csv", XERO_CHART));
  await expect(page.getByText("Read chart.csv.")).toBeVisible();
  // How the columns were read is one disclosure away, before anything is kept.
  await page.getByText(/^How the columns were read \(\d+\)$/).click();
  await expect(page.getByRole("row", { name: /^\*Code Code$/ })).toBeVisible();
  await expect(page.getByRole("row", { name: /^\*Type Type$/ })).toBeVisible();
  // Every account was read and is shown with how sure its match is; nothing is kept yet.
  await expect(page.getByText(/6 accounts: \d+ certain, \d+ likely, \d+ to check\./)).toBeVisible();
  expect((await api(request, "xero.status", {})).chartImportedAt).toBeNull();
  await expect(page.getByText(/^Needs your decision \(\d+\)$/)).toBeVisible();

  // What nothing in the book resembles is decided from the keyboard: one account is left out on
  // purpose, one is mapped to an account of the book.
  await pick(page, page.getByLabel("Account for Xero account 310"), "Leave out");
  await pick(page, page.getByLabel("Account for Xero account 470"), "4000 · Design fees");
  await expect(page.getByLabel("Account for Xero account 470")).toHaveAttribute(
    "data-value",
    "4000",
  );
  await scanBothThemes(page, "the Xero chart, decided");
  await page.getByRole("button", { name: "Keep the mapping" }).click();
  // Kept: the step folds to one line that says what came of it, and the next file is asked for.
  await expect(step(/Chart of accounts/)).toContainText("6 accounts, 1 not matched");
  await expect(step(/Trial balance/)).toHaveAttribute("aria-expanded", "true");

  // The service holds the decisions, not only the page.
  const status = await api(request, "xero.status", {});
  expect(status.chartImportedAt).not.toBeNull();
  expect(status.counts.skipped).toBe(1);
  // The finished step is one line that says what came of it, and the next file is what is asked for.
  await page.reload();
  await expect(step(/Chart of accounts/)).toContainText("6 accounts, 1 not matched");
  await expect(step(/Chart of accounts/)).toContainText("Change");
  await expect(step(/Trial balance/)).toHaveAttribute("aria-expanded", "true");
  expect(errors).toEqual([]);
});

test("a trial balance is read as at the day before the cutover and fills the opening balances", async ({
  page,
  request,
}) => {
  const errors: string[] = [];
  page.on("pageerror", (error) => errors.push(error.message));
  await page.goto("/xero");
  await page
    .getByLabel(/^Xero's Trial Balance report/)
    .setInputFiles(csvFile("tb.csv", XERO_TRIAL_BALANCE));
  await expect(page.getByText("Read tb.csv.")).toBeVisible();
  await expect(page.getByText(/Debits and credits balance on every column/)).toBeVisible();
  await expect(
    page.getByText(/That is the day before the start date.*right for opening balances/),
  ).toBeVisible();
  const table = page.getByRole("table", { name: "Accounts in the trial balance" });
  await expect(table.getByRole("row", { name: /Operating account/ })).toContainText("12,000.00");
  await expect(table.getByRole("row", { name: /Retained Earnings/ })).toContainText(
    "Retained earnings",
  );
  await scanBothThemes(page, "the Xero trial balance");

  // Kept for the comparison, and the service holds it.
  await page.getByRole("button", { name: "Keep for the comparison" }).first().click();
  await expect(page.getByText("tb.csv is kept for the comparison.")).toBeVisible();
  expect((await api(request, "xero.status", {})).trialBalances).toHaveLength(1);

  // Taken to the opening balances screen, which fills its table and says what to do next. Nothing is
  // reviewed or posted by the hand-off.
  await page.getByRole("button", { name: "Use as opening balances" }).click();
  await expect(page).toHaveURL(/\/opening$/);
  await expect(
    page.getByText(/Filled 2 balances from the Xero trial balance as at /),
  ).toBeVisible();
  await expect(balance(page, "Operating account")).toHaveValue("12,000.00");
  await expect(balance(page, "Card balance")).toHaveValue("523.10");
  expect((await api(request, "journal.list", { status: "Posted" })).entries).toEqual([]);
  expect(errors).toEqual([]);
});

test("balances are typed from the keyboard and the entry balances to the cent", async ({
  page,
  request,
}) => {
  const errors: string[] = [];
  page.on("pageerror", (error) => errors.push(error.message));
  await page.goto("/opening");
  await expect(page.getByText(`Start date recorded: ${shown.date(CUTOVER)}.`)).toBeVisible();

  const checking = balance(page, "Operating account");
  const equipment = balance(page, "Equipment");
  const card = balance(page, "Card balance");
  // The offset is calculated, so it is not a row to type in.
  await expect(page.getByLabel(/^Balance for Opening balance equity/)).toHaveCount(0);

  await checking.focus();
  await page.keyboard.type("12,000.00");
  // Enter and Down move to the next account's amount, with its text selected.
  await page.keyboard.press("Enter");
  await expect(equipment).toBeFocused();
  await page.keyboard.type("1,300.50");
  await page.keyboard.press("ArrowDown");
  await expect(card).toBeFocused();
  await page.keyboard.type("523.10");
  await page.keyboard.press("ArrowUp");
  await expect(equipment).toBeFocused();
  await expect(equipment).toHaveValue("1,300.50");

  // The totals follow while typing, in exact cents: 13,300.50 owned, 523.10 owed, and the rest is equity.
  await expect(tableRow(page, /^Entered balances/)).toContainText("13,300.50");
  await expect(tableRow(page, /^Entered balances/)).toContainText("523.10");
  const offset = tableRow(page, /Opening balance equity \(offset, calculated\)/);
  await expect(offset).toContainText("12,777.40");
  await expect(tableRow(page, /^Total/)).toContainText("13,300.50");
  await expect(page.getByText("Debits and credits agree.")).toBeVisible();

  // An amount that is not an amount says so beside the field, blocks the review, and is not added.
  // Income and expense accounts are folded away until they are asked for.
  const profitLoss = page.getByRole("button", { name: /Income and expenses/ });
  await expect(profitLoss).toHaveAttribute("aria-expanded", "false");
  const owner = balance(page, "Owner capital");
  await owner.fill("12.345");
  await expect(page.getByText(/Enter an amount such as 1,234.56/).first()).toBeVisible();
  await expect(owner).toHaveAttribute("aria-invalid", "true");
  await expect(page.getByText("Fix 1 amount before reviewing.")).toBeVisible();
  await expect(page.getByRole("button", { name: "Review the entry" })).toBeDisabled();
  await scanBothThemes(page, "the opening balances with an amount that cannot be read");
  await owner.fill("0");
  await owner.press("Tab");
  await expect(page.getByRole("button", { name: "Review the entry" })).toBeEnabled();

  // Review shows the exact entry: the typed lines and the calculated offset, balanced.
  await page.getByRole("button", { name: "Review the entry" }).focus();
  await page.keyboard.press("Enter");
  const entry = page.getByRole("table", { name: `Opening entry dated ${shown.date(CUTOVER)}` });
  await expect(entry).toBeVisible();
  await expect(entry.getByRole("row", { name: /Operating account/ })).toContainText("12,000.00");
  await expect(entry.getByRole("row", { name: /Card balance/ })).toContainText("523.10");
  await expect(entry.getByRole("row", { name: /Offset/ })).toContainText("12,777.40");
  await expect(page.getByText("Balanced: debits and credits agree exactly.")).toBeVisible();
  await scanBothThemes(page, "the reviewed entry");

  // Changing a balance after the review makes the review stale: it must be done again.
  await checking.fill("12,000.01");
  await expect(page.getByText(/The balances changed after this review/)).toBeVisible();
  await expect(page.getByRole("button", { name: "Prepare the entry" })).toBeDisabled();
  await checking.fill("12,000.00");
  await page.getByRole("button", { name: "Review the entry" }).click();
  await expect(page.getByRole("button", { name: "Prepare the entry" })).toBeEnabled();
  expect(errors).toEqual([]);

  // Nothing has been posted: reviewing and typing wrote no journal.
  const page1 = await api(request, "journal.list", { status: "Posted" });
  expect(page1.entries).toEqual([]);
});

test("the entry is prepared, posted and held by the ledger exactly as typed", async ({
  page,
  request,
}) => {
  const errors: string[] = [];
  page.on("pageerror", (error) => errors.push(error.message));
  await page.goto("/opening");
  const typed = {
    "Operating account": "12,000.00",
    Equipment: "1,300.50",
    "Card balance": "523.10",
  };
  for (const [account, amount] of Object.entries(typed)) await balance(page, account).fill(amount);
  await page.getByRole("button", { name: "Review the entry" }).click();
  await page.getByRole("button", { name: "Prepare the entry" }).click();
  await expect(
    page.getByText("Prepared. This is the exact entry the ledger will post."),
  ).toBeVisible();
  // The revision and the plan's hash are machine detail: one click away, under Details.
  await expect(page.getByText("Book revision", { exact: true })).toBeHidden();
  await page.getByRole("button", { name: "Details" }).click();
  await expect(page.getByText("Book revision", { exact: true })).toBeVisible();
  await expect(page.getByText(/^[0-9a-f]{64}$/)).toBeVisible();
  // Prepared is not posted.
  expect((await api(request, "journal.list", { status: "Posted" })).entries).toEqual([]);

  await page.getByRole("button", { name: "Post opening balances" }).click();
  // The button that had the focus is gone: the confirmation takes it.
  const confirmed = page.getByRole("heading", { name: "Opening balances posted." });
  await expect(confirmed).toBeVisible();
  await expect(confirmed).toBeFocused();
  await expect(page.getByText(`The entry is dated ${shown.date(CUTOVER)}.`)).toBeVisible();

  // The ledger holds one entry, dated on the cutover date, with exactly the typed figures and the
  // offset that makes the two sides agree.
  const posted = (await api(request, "journal.list", { status: "Posted" })).entries;
  expect(posted).toHaveLength(1);
  const [entry] = posted;
  expect(entry.isoDate).toBe(CUTOVER);
  expect(entry.debitTotal).toBe("13300.50");
  expect(entry.creditTotal).toBe("13300.50");
  const lines = Object.fromEntries(
    entry.lines.map((line: { accountId: string; debit: string | null; credit: string | null }) => [
      line.accountId,
      { debit: line.debit, credit: line.credit },
    ]),
  );
  expect(lines["1000"]).toEqual({ debit: "12000.00", credit: null });
  expect(lines["1100"]).toEqual({ debit: "1300.50", credit: null });
  expect(lines["2000"]).toEqual({ debit: null, credit: "523.10" });
  expect(lines["3900"]).toEqual({ debit: null, credit: "12777.40" });
  expect(entry.lines).toHaveLength(4);
  expect(errors).toEqual([]);
});

test("once posted, the screen says so, the date is fixed, and the next steps are offered", async ({
  page,
}) => {
  await page.goto("/opening");
  await expect(
    page.getByRole("heading", { name: "Opening balances are already posted." }),
  ).toBeVisible();
  await expect(page.getByRole("link", { name: "Open the entry" })).toBeVisible();
  // The date is read, not edited: it cannot move once the entry is posted, so there is no field to leave
  // disabled, only what was recorded.
  await expect(page.getByText(/^Start date recorded:/)).toBeVisible();
  await expect(page.getByLabel("Start date", { exact: true })).toHaveCount(0);
  await expect(page.getByRole("button", { name: "Post opening balances" })).toHaveCount(0);
  const next = page.getByRole("region", { name: "What to do next" });
  await expect(
    next.getByRole("link", { name: "Import your bank and card statements" }),
  ).toBeVisible();
  await expect(next.getByRole("link", { name: "Close the books" })).toBeVisible();
  await scanBothThemes(page, "the opening balances once posted");
  await next.getByRole("link", { name: "Close the books" }).click();
  await expect(page).toHaveURL(/\/periods$/);
  await expect(page.getByRole("heading", { level: 1, name: "Close the books" })).toBeVisible();
});

test("Close the books says why the month cannot close, and Home agrees", async ({
  page,
  request,
}) => {
  const errors: string[] = [];
  page.on("pageerror", (error) => errors.push(error.message));
  // The old address of the month checklist opens Close the books.
  await page.goto("/cutover");
  await expect(page).toHaveURL(/\/periods$/);
  await expect(page.getByRole("heading", { level: 1, name: "Close the books" })).toBeVisible();
  // One card, for the oldest month that has ended, holds something and is still open.
  const card = page.locator(".rt-close-card");
  await expect(card.getByRole("heading", { level: 2 })).toHaveText(/^Through [A-Z][a-z]+ \d{4}$/);
  // What is left is a sentence a line, each with the one place that deals with it.
  await expect(card).toContainText(/Operating account is not reconciled through /);
  // A liability named like a card is a card to reconcile: it stands in the way until it is.
  await expect(card).toContainText(/Card balance is not reconciled through /);
  await expect(card.getByRole("link", { name: "Reconcile Operating account" })).toHaveAttribute(
    "href",
    /^\/reconcile/,
  );
  await expect(card.getByRole("link", { name: "Reconcile Card balance" })).toHaveAttribute(
    "href",
    /^\/reconcile/,
  );
  // The backup that has not been checked leads to the safety lane's screen.
  await expect(card.getByRole("link", { name: "Back up now" })).toHaveAttribute(
    "href",
    "/settings/backups",
  );
  await expect(card.getByRole("button", { name: /^Close through / })).toBeDisabled();
  // An account with a balance and no statement that is not a bank or a card is not asked for.
  await expect(card).not.toContainText("Equipment");

  // What the page says is what the service says: the same verdict, the same reasons, one source.
  const checklist = await api(request, "cutover.checklist", {});
  expect(checklist.verdict.state).toBe("not_yet");
  expect(checklist.opening.status).toBe("posted");
  expect(checklist.accounts.map((account: { code: string }) => account.code)).toEqual([
    "1000",
    "2000",
  ]);
  expect(checklist.otherAccounts.map((account: { code: string }) => account.code)).toEqual([
    "1100",
  ]);

  await scanBothThemes(page, "Close the books with things left");

  // Home says the same thing as rows a person can act on (the accounts to reconcile, the backup to make),
  // and does not name the month a second time for them.
  await page.goto("/");
  const reconcile = page.locator('[data-need="reconcile"]');
  await expect(reconcile).toContainText(
    /ready to check against (its|their) [A-Z][a-z]+ statements?\./,
  );
  await expect(page.locator('[data-need="backup"]')).toBeVisible();
  await expect(page.locator('[data-need="close"]')).toHaveCount(0);
  await scanBothThemes(page, "Home with the month's accounts to reconcile");
  await reconcile.getByRole("link", { name: "Reconcile", exact: true }).click();
  await expect(page).toHaveURL(/\/reconcile/);
  expect(errors).toEqual([]);
});

test("at phone width nothing scrolls sideways and the amounts stay readable", async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  for (const path of ["/opening", "/periods", "/"]) {
    await page.goto(path);
    await expect(page.getByRole("heading", { level: 1 })).toBeVisible();
    await noSidewaysScroll(page, path);
  }
  await page.goto("/periods");
  await expect(page.locator(".rt-close-card")).toBeVisible();
  await scanBothThemes(page, "Close the books at phone width");
});

test("the comparison with Xero says what could be compared, and the gap log keeps what was found", async ({
  page,
  request,
}) => {
  const errors: string[] = [];
  page.on("pageerror", (error) => errors.push(error.message));
  await page.goto("/tie-out");
  await expect(page.getByRole("heading", { level: 1, name: "Compare with Xero" })).toBeVisible();
  // Only a trial balance as at the day before the cutover is stored: no month ends with Xero
  // reconciled, so nothing is compared, and the screen says so instead of saying all is well.
  await expect(page.getByText(/Nothing could be compared/)).toBeVisible();
  await scanBothThemes(page, "the comparison with nothing to compare");
  await noSidewaysScroll(page, "the comparison");

  // Recording is safe when there is little to record: it says how many gaps it added.
  await page.getByRole("button", { name: "Add to Things to check" }).click();
  await expect(
    page.getByText(/\d+ gaps? (was|were) added; \d+ (was|were) already in the log\./),
  ).toBeVisible();

  // A gap is added by hand, and closed only with a note.
  await page.goto("/gaps");
  await expect(page.getByRole("heading", { level: 1, name: "Things to check" })).toBeVisible();
  await page
    .getByLabel("Title", { exact: true })
    .fill("Xero's repeating invoices have no home here");
  await pick(page, page.getByLabel("Kind"), "Missing feature");
  await page.getByLabel("Detail").fill("Two customers are billed every month.");
  await page.getByRole("button", { name: "Add gap" }).click();
  await expect(page.getByText("Gap added.")).toBeVisible();
  const card = page.getByRole("article").filter({ hasText: "repeating invoices" });
  await expect(card).toBeVisible();
  await expect(card.getByText("Missing feature")).toBeVisible();
  await scanBothThemes(page, "the gap log with one open gap");

  await card.getByRole("button", { name: "Close this gap" }).click();
  const note = card.getByLabel("What was found", { exact: true });
  await expect(note).toBeFocused();
  await card.getByRole("button", { name: "Close gap" }).click();
  await expect(card.getByText(/Say what was found before closing the gap/)).toBeVisible();
  await note.fill("Not needed: the studio bills by hand.");
  await card.getByRole("button", { name: "Close gap" }).click();
  await expect(page.getByText("No gap is open.", { exact: true })).toBeVisible();
  const closed = await api(request, "gaps.list", { status: "closed" });
  expect(closed.gaps).toHaveLength(1);
  expect(closed.gaps[0].resolution).toBe("Not needed: the studio bills by hand.");

  await page.getByRole("button", { name: /^Closed/ }).click();
  await expect(page.getByText("Not needed: the studio bills by hand.")).toBeVisible();
  await page.getByRole("button", { name: "Reopen" }).click();
  await expect(page.getByText("No gap has been closed yet.", { exact: true })).toBeVisible();
  expect((await api(request, "gaps.list", { status: "open" })).gaps).toHaveLength(1);
  expect(errors).toEqual([]);
});

test("the Xero screens fit a phone", async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  for (const path of ["/xero", "/tie-out", "/gaps"]) {
    await page.goto(path);
    await expect(page.getByRole("heading", { level: 1 })).toBeVisible();
    await noSidewaysScroll(page, path);
  }
  await page.goto("/gaps");
  await scanBothThemes(page, "the gap log at phone width");
});
