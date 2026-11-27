import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { type APIRequestContext, expect, type Locator, type Page, test } from "@playwright/test";
import axe from "axe-core";
import { setChecked, transactionRow } from "../support/accounting";
import { chartRow, openAccount, openAccountDetails, showWholeChart } from "../support/chart";
import { shown } from "../support/shown";

declare global {
  interface Window {
    axe: typeof axe;
    __pwned?: number;
  }
}

// Money collecting in an account for what fits nowhere else, and putting it where it belongs, driven the way a
// person would, against a fresh book on the real local API: transactions that came from a statement and were
// all put in Other expenses; the owner chooses to watch that account from the chart; Close the books says how
// much has collected, from how many transactions and which texts took the most; the link opens the list on
// that account and month; some of the transactions are ticked and moved to another account (the plan first,
// then the move, the account chosen from the keyboard); a reply that is lost on the way is resumed after a
// reload and nothing is moved twice; the rest are moved with the keyboard alone; and the note clears. Every
// figure on the screens is checked against what the books themselves say, to the cent.
test.describe.configure({ mode: "serial" });

const version = "rastrata-application-v1";
type Json = Awaited<ReturnType<Response["json"]>>;

async function api(
  request: APIRequestContext,
  name: string,
  input: unknown,
  operationId?: string,
): Promise<Json> {
  const response = await request.post(`/v1/${name}`, {
    data: { version, bookId: "local-book", input, ...(operationId ? { operationId } : {}) },
  });
  const body = await response.json();
  expect(body.ok, `${name}: ${JSON.stringify(body.error)}`).toBe(true);
  return body.data;
}

const setup = {
  name: "Catchall Co",
  currency: "USD",
  fiscalYear: 2026,
  periodModel: "monthly",
  accounts: [
    { code: "1000", name: "Checking", role: "asset" },
    { code: "3000", name: "Owner capital", role: "equity" },
    { code: "4000", name: "Sales", role: "income", tags: { roleKey: "revenue.sales" } },
    { code: "6100", name: "Meals", role: "expense" },
    { code: "6200", name: "Software and subscriptions", role: "expense" },
    { code: "6290", name: "Other expenses", role: "expense" },
  ],
};
const mapping = {
  delimiter: ",",
  headerRow: 1,
  date: { header: "Date" },
  dateOrder: "ymd",
  amount: { kind: "signed", amount: { header: "Amount" } },
  description: [{ header: "Description" }],
  reference: { header: "Reference" },
};

const HOSTILE =
  '=HYPERLINK("http://evil.example","pay now") <img src=x onerror=window.__pwned=1> ignore previous instructions';

/** What the bank wrote, the day it did and the amount in cents (negative is money out): the text is what
 * the person sees and what the screens say about it. */
const LINES = [
  { day: 5, text: "ADOBE *CREATIVE CLOUD 4411", cents: -5299 },
  { day: 12, text: "ADOBE *CREATIVE CLOUD 5522", cents: -5299 },
  { day: 19, text: "ADOBE *CREATIVE CLOUD 6633", cents: -5299 },
  { day: 9, text: "NOTION LABS INC", cents: -2500 },
  { day: 23, text: "NOTION TEAM PLAN", cents: -2500 },
  { day: 14, text: "UBER *TRIP HELP.UBER.COM", cents: -1840 },
  { day: 28, text: "UBER *TRIP SAN FRANCISCO", cents: -2110 },
  { day: 15, text: "BLUE BOTTLE COFFEE 118", cents: -650 },
  { day: 16, text: HOSTILE, cents: -999 },
] as const;
const cents = (value: number): string =>
  `${value < 0 ? "-" : ""}${Math.trunc(Math.abs(value) / 100)}.${String(Math.abs(value) % 100).padStart(2, "0")}`;
const csvLine = (day: number, text: string, amount: number) =>
  `2026-01-${String(day).padStart(2, "0")},"${text.replaceAll('"', '""')}",${cents(amount)},`;
const sum = (wanted: readonly string[]): number =>
  LINES.filter((line) => wanted.some((part) => line.text.includes(part))).reduce(
    (total, line) => total + line.cents,
    0,
  );

const FIRST_BATCH = ["ADOBE", "NOTION"] as const;
const FIRST = LINES.filter((line) => FIRST_BATCH.some((part) => line.text.includes(part)));
const TOTAL = LINES.reduce((total, line) => total + line.cents, 0);
const MOVED_FIRST = sum(FIRST_BATCH);
const SECOND_BATCH = ["UBER"] as const;
const MOVED_SECOND = sum(SECOND_BATCH);
/** The lunch typed by hand, in cents: it is on Meals before anything moves there. */
const LUNCH = 7500;

const money = (value: number): string => shown.money(cents(Math.abs(value)));

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

const inTheme = async (page: Page, theme: "light" | "dark") => {
  await page.evaluate((value) => {
    document.documentElement.dataset.theme = value;
  }, theme);
  // A scan must not sample colors in the middle of the theme change's short transition.
  await page.addStyleTag({
    content: "*,*::before,*::after{transition:none!important;animation:none!important}",
  });
};

/** A scan in both themes. */
async function scanBoth(page: Page, label: string) {
  for (const theme of ["light", "dark"] as const) {
    await inTheme(page, theme);
    await scan(page, `${label} (${theme})`);
  }
  await inTheme(page, "light");
}

/** True when the page itself does not scroll sideways: a table may scroll inside its own region, the page
 * may not. */
const fitsWidth = (page: Page) =>
  page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth);

const SIZES = [
  { width: 1440, height: 900, name: "1440" },
  { width: 390, height: 844, name: "390" },
] as const;

/** Pictures of the screens for whoever reviews them, when asked for (CATCHALL_SHOTS names the folder), at
 * the two widths the screens are made for. Not part of what is tested. */
async function shot(page: Page, name: string): Promise<void> {
  const folder = process.env.CATCHALL_SHOTS;
  if (!folder) return;
  mkdirSync(folder, { recursive: true });
  const original = page.viewportSize();
  for (const size of SIZES) {
    await page.setViewportSize({ width: size.width, height: size.height });
    await page.waitForTimeout(250);
    await page.screenshot({ path: join(folder, `${name}-${size.name}.png`), fullPage: false });
  }
  if (original) await page.setViewportSize(original);
}

/** Press Tab until the element has the cursor, as a person does; it is a failure if it is not reached in a
 * dozen presses. */
async function tabTo(page: Page, target: Locator): Promise<void> {
  for (let press = 0; press < 12; press += 1) {
    await page.keyboard.press("Tab");
    if (await target.evaluate((element) => element === document.activeElement)) return;
  }
  await expect(target).toBeFocused();
}

/** Wait for the list to stop being read again. */
const settled = (page: Page) =>
  expect(page.getByText("Refreshing…", { exact: false })).toHaveCount(0);

const ACCOUNTS: Record<string, string> = {};
/** The chart's balances as the books say them, by account name. */
async function balances(request: APIRequestContext): Promise<Record<string, string>> {
  const chart = await api(request, "accounts.list", {});
  return Object.fromEntries(
    (chart.accounts as { name: string; balance: string; id: string }[]).map((account) => {
      ACCOUNTS[account.name] = account.id;
      return [account.name, account.balance];
    }),
  );
}

/** How the books say a month's note: the checklist, as the screens read it. */
async function noteOf(request: APIRequestContext) {
  const checklist = await api(request, "cutover.checklist", { periodId: "period-01" });
  return (checklist.notes ?? []) as Json[];
}

const journalRegister = (page: Page) => page.getByRole("table", { name: "Transactions" });
const noteRegion = (page: Page) => page.getByRole("region", { name: "Notes about this month" });
const dialog = (page: Page) => page.getByRole("dialog", { name: /^Change the account of/ });
/** The row of the list that says some text. */
const rowOf = (page: Page, text: string | RegExp): Locator => transactionRow(page, text);
const openList = async (page: Page) => {
  await page.goto("/journal?accountId=6290&from=2026-01-01&to=2026-01-31");
  await expect(page.getByRole("heading", { name: "Transactions", level: 1 })).toBeVisible();
  await expect(journalRegister(page)).toBeVisible();
  await settled(page);
};

test("the books: transactions from a statement, all in Other expenses, and nobody watching it yet", async ({
  request,
}) => {
  await api(request, "book.setup", setup, crypto.randomUUID());
  const csv = `Date,Description,Amount,Reference\n${[
    ...LINES.map((line) => csvLine(line.day, line.text, line.cents)),
    csvLine(20, "CLIENT PAYMENT 17", 90_000),
  ].join("\n")}\n`;
  const upload = await request.post("/v1/uploads", {
    headers: { "content-type": "text/csv", "x-upload-name": "statement.csv" },
    data: csv,
  });
  const receipt = (await upload.json()).data as { sha256: string };
  await api(
    request,
    "import.commit",
    { sha256: receipt.sha256, ledgerAccountId: "1000", mapping },
    crypto.randomUUID(),
  );
  const listed = await api(request, "inbox.list", { pageSize: 100 });
  expect(listed.count).toBe(LINES.length + 1);
  const idOf = (text: string) =>
    (listed.items as { id: string; line: { description: string } }[]).find(
      (item) => item.line.description === text,
    )?.id as string;
  const expenses = LINES.map((line) => idOf(line.text));
  expect(expenses.every(Boolean)).toBe(true);
  await api(
    request,
    "inbox.categorize",
    { itemIds: expenses, accountId: "6290" },
    crypto.randomUUID(),
  );
  await api(
    request,
    "inbox.categorize",
    { itemIds: [idOf("CLIENT PAYMENT 17")], accountId: "4000" },
    crypto.randomUUID(),
  );
  const posted = await api(
    request,
    "inbox.post",
    { itemIds: [...expenses, idOf("CLIENT PAYMENT 17")] },
    crypto.randomUUID(),
  );
  expect(posted.applied).toBe(LINES.length + 1);

  // An entry typed by hand, in another account: the list has it, and it has no box.
  const draft = await api(
    request,
    "drafts.create",
    {
      data: {
        date: "2026-01-21",
        reference: "CARD-LUNCH",
        narration: "Lunch with a client, paid by card",
        lines: [
          { accountId: "6100", debit: "75.00", credit: "" },
          { accountId: "1000", debit: "", credit: "75.00" },
        ],
      },
    },
    crypto.randomUUID(),
  );
  const plan = await api(
    request,
    "journal.prepare",
    { draftId: draft.id, expectedVersion: draft.version },
    crypto.randomUUID(),
  );
  await api(request, "operations.commit", { planId: plan.planId, planHash: plan.planHash });

  // Everything the statement said is in Other expenses, to the cent, and no note is made while nobody watches it.
  const books = await balances(request);
  expect(books["Other expenses"]).toBe(cents(-TOTAL));
  expect(await noteOf(request)).toEqual([]);
});

test("Close the books says nothing about an account nobody has asked it to watch", async ({
  page,
}) => {
  await page.goto("/periods");
  await expect(page.getByRole("heading", { name: "Close the books", level: 1 })).toBeVisible();
  const january = page.getByRole("region", { name: "Through January 2026" });
  await expect(january).toBeVisible();
  await expect(january.getByRole("button", { name: "Close through January 2026" })).toBeVisible();
  await expect(noteRegion(page)).toHaveCount(0);
});

test("the owner asks to watch Other expenses from the chart, and the chart says it is watched", async ({
  page,
  request,
}) => {
  const errors: string[] = [];
  page.on("pageerror", (error) => errors.push(error.message));
  await page.goto("/accounts");
  await expect(page.getByRole("heading", { name: "Accounts", level: 1 })).toBeVisible();
  // The chart is folded by kind: every kind is opened, so each account's row is on the page.
  await showWholeChart(page);
  await expect(chartRow(page, "Other expenses").getByText("Watched at month end")).toHaveCount(0);

  // Watching is offered on an account's own page, under Account details. An account that is neither an
  // expense nor an income is not offered it, nor is one that is another key's.
  const watchButton = page.getByRole("button", { name: /^(Watch|Stop watching) this account$/ });
  await openAccount(page, "Checking");
  await openAccountDetails(page);
  await expect(page.getByRole("button", { name: "Edit tags", exact: true })).toBeVisible();
  await expect(watchButton).toHaveCount(0);
  await openAccount(page, "Sales");
  await openAccountDetails(page);
  await expect(watchButton).toHaveCount(0);

  await openAccount(page, "Other expenses");
  await openAccountDetails(page);
  await page.getByRole("button", { name: "Watch this account", exact: true }).click();
  const watch = page.getByRole("dialog", { name: "Watch Other expenses" });
  await expect(watch).toBeVisible();
  await expect(watch).toContainText(
    "When you close a month, you will see how much was spent on Other expenses",
  );
  await expect(watch).toContainText("It never stops you closing a month.");
  await shot(page, "watch-dialog");
  await scanBoth(page, "the Watch this account dialog");
  await watch.getByRole("button", { name: "Watch this account" }).click();
  await expect(page.getByText("Other expenses is watched at month end.")).toBeVisible();
  await expect(watch).toHaveCount(0);
  // Focus is back on the button that opened the dialog, which now offers to stop.
  await expect(page.getByRole("button", { name: "Stop watching this account" })).toBeFocused();

  // The books say the same: one account carries the mark.
  const chart = await api(request, "accounts.list", {});
  const marked = (chart.accounts as { name: string; tags: { roleKey?: string } }[]).filter(
    (account) => account.tags.roleKey === "catchall.expense",
  );
  expect(marked.map((account) => account.name)).toEqual(["Other expenses"]);
  expect(errors).toEqual([]);

  // Stopping is offered on the account that is watched, and nothing else about the books changes.
  await page.getByRole("button", { name: "Stop watching this account" }).click();
  const stop = page.getByRole("dialog", { name: "Stop watching Other expenses" });
  await expect(stop).toContainText("Nothing in your books changes.");
  await stop.getByRole("button", { name: "Cancel" }).click();
  await expect(stop).toHaveCount(0);
  await expect(page.getByRole("button", { name: "Stop watching this account" })).toBeVisible();

  // The chart says it is watched, under the account's name.
  await page.goto("/accounts");
  await showWholeChart(page);
  await expect(chartRow(page, "Other expenses").getByText("Watched at month end")).toBeVisible();
  await shot(page, "chart-watched");
});

test("Close the books says how much has collected, from how many transactions and who took the most, and links to them", async ({
  page,
  request,
}) => {
  const errors: string[] = [];
  page.on("pageerror", (error) => errors.push(error.message));
  await page.goto("/periods");
  const january = page.getByRole("region", { name: "Through January 2026" });
  const notes = noteRegion(page);
  await expect(notes).toBeVisible();
  await expect(
    notes.getByRole("heading", { name: "Money is collecting in Other expenses" }),
  ).toBeVisible();
  await expect(notes).toContainText(
    `Other expenses holds ${money(TOTAL)} from ${LINES.length} transactions in January 2026.`,
  );
  // It never holds up a close, and it says so.
  await expect(notes).toContainText("This does not stop you closing the month.");
  // The books say the same, to the cent.
  const [note] = await noteOf(request);
  expect(note).toMatchObject({
    code: "catchall_holds_money",
    amount: cents(-TOTAL),
    transactions: LINES.length,
    account: { name: "Other expenses", role: "expense" },
  });
  // Where most of it went, largest first, the figures the books give.
  const places = notes.locator(".rt-close-note-places li");
  expect(await places.count()).toBeGreaterThan(0);
  const largest = (note.largest as { name: string; amount: string }[]).map((place) => place.amount);
  expect(largest).toEqual([...largest].sort((a, b) => Number(b) - Number(a)));
  await expect(places.first()).toContainText(shown.money(largest[0] as string));
  // What a bank wrote is shown as text, whatever it holds.
  await expect(notes.locator("img, script")).toHaveCount(0);
  expect(await page.evaluate(() => window.__pwned)).toBeUndefined();
  expect(await fitsWidth(page)).toBe(true);
  await notes.scrollIntoViewIfNeeded();
  await shot(page, "close-the-books-note");
  await scanBoth(page, "Close the books with a note");
  // The month can be closed whatever the note says: the note is not one of the things left.
  await expect(january.getByRole("button", { name: "Close through January 2026" })).toBeVisible();
  await expect(january.getByRole("listitem").filter({ hasText: "Other expenses" })).toHaveCount(0);

  const link = notes.getByRole("link", { name: "See these transactions in Other expenses" });
  await expect(link).toHaveAttribute(
    "href",
    "/journal?accountId=6290&from=2026-01-01&to=2026-01-31",
  );
  await link.click();
  await expect(page.getByRole("heading", { name: "Transactions", level: 1 })).toBeVisible();
  await expect(journalRegister(page)).toBeVisible();
  // The list opens on that account and that month, and says so.
  await expect(page).toHaveURL(/\/journal\?accountId=6290/);
  await expect(page.getByRole("combobox", { name: "Account" })).toHaveValue("Other expenses");
  await expect(page.getByLabel("From")).toHaveValue(shown.dateBox("2026-01-01"));
  await expect(page.getByLabel("To")).toHaveValue(shown.dateBox("2026-01-31"));
  await settled(page);
  await expect(journalRegister(page).getByRole("row")).toHaveCount(LINES.length + 1);
  expect(errors).toEqual([]);
});

test("the list has a box only on a transaction that can change account", async ({ page }) => {
  await page.goto("/journal?from=2026-01-01&to=2026-01-31");
  await expect(journalRegister(page)).toBeVisible();
  await settled(page);
  // Every transaction that came from the statement has one, whichever account it is on...
  for (const line of LINES)
    await expect(
      rowOf(page, line.text === HOSTILE ? /HYPERLINK/ : line.text).getByRole("checkbox"),
    ).toHaveCount(1);
  await expect(rowOf(page, "CLIENT PAYMENT 17").getByRole("checkbox")).toHaveCount(1);
  // ...and the one typed by hand does not.
  await expect(rowOf(page, "Lunch with a client")).toHaveCount(1);
  await expect(rowOf(page, "Lunch with a client").getByRole("checkbox")).toHaveCount(0);
});

test("the first five are moved: the plan is read before anything changes, then they go, and the list follows", async ({
  page,
  request,
}) => {
  const errors: string[] = [];
  page.on("pageerror", (error) => errors.push(error.message));
  const before = await balances(request);
  await openList(page);
  for (const line of FIRST) await setChecked(rowOf(page, line.text), /^Select/, true);
  await expect(
    page.getByText(`${FIRST.length} selected across pages`, { exact: true }),
  ).toBeVisible();
  await shot(page, "transactions-selected");
  await page.getByRole("button", { name: "Change account" }).click();

  const change = dialog(page);
  await expect(change).toBeVisible();
  await expect(change).toContainText(`Change the account of ${FIRST.length} transactions`);
  await expect(change).toContainText("Nothing is edited or deleted.");
  // The account is chosen from the keyboard: the field has the cursor, typing finds the account.
  const account = change.getByRole("combobox", { name: /^Move to account/ });
  await expect(account).toBeFocused();
  await page.keyboard.type("soft");
  // The list follows what is typed; the person sees it, and then moves down it.
  await expect(page.getByRole("option", { name: /Software and subscriptions/ })).toBeVisible();
  await page.keyboard.press("ArrowDown");
  await page.keyboard.press("Enter");
  await expect(account).toHaveValue("Software and subscriptions");
  await page.keyboard.press("Tab");
  await page.keyboard.type("Software, not other");
  await shot(page, "change-account-choose");
  await scanBoth(page, "Change account, choosing the account");
  await page.keyboard.press("Enter");

  // The plan: nothing has changed yet, and every transaction is listed with where it goes.
  await expect(
    change.getByText(`All ${FIRST.length} transactions will move to Software and subscriptions.`),
  ).toBeVisible();
  await expect(change.getByRole("status").filter({ hasText: "will move to" })).toBeFocused();
  const table = change.getByRole("table", { name: "What will happen to each transaction" });
  await expect(table.locator("tbody tr")).toHaveCount(FIRST.length);
  await expect(table.getByText("Will move").filter({ visible: true })).toHaveCount(FIRST.length);
  for (const line of FIRST) await expect(table).toContainText(line.text);
  await expect(table.getByText("Other expenses").filter({ visible: true }).first()).toBeVisible();
  await shot(page, "change-account-plan");
  await scanBoth(page, "Change account, the plan");
  expect(await fitsWidth(page)).toBe(true);
  expect((await balances(request))["Other expenses"]).toBe(before["Other expenses"]);

  await change.getByRole("button", { name: `Move ${FIRST.length} transactions` }).click();
  await expect(
    change.getByText(`${FIRST.length} transactions moved to Software and subscriptions.`),
  ).toBeVisible();
  await expect(change.getByText("The old entries stay in your books")).toBeVisible();
  await shot(page, "change-account-done");
  await scanBoth(page, "Change account, done");
  await change.getByRole("button", { name: "Done" }).click();
  await expect(change).toHaveCount(0);
  await expect(
    page.getByText(`${FIRST.length} transactions moved to Software and subscriptions.`),
  ).toBeVisible();

  // The books say the same, to the cent: the five are on Software, nothing was lost, nothing was made up.
  const after = await balances(request);
  expect(after["Software and subscriptions"]).toBe(cents(-MOVED_FIRST));
  expect(after["Other expenses"]).toBe(cents(-(TOTAL - MOVED_FIRST)));
  expect(after.Checking).toBe(before.Checking);
  // Five entries were reversed, each once: the list says so, and the old entries are still in it.
  const reversed = await api(request, "journal.list", {
    accountId: ACCOUNTS["Other expenses"],
    status: "Posted",
  });
  expect((reversed.corrections as Json[]).length).toBe(FIRST.length);
  await settled(page);
  for (const line of FIRST) await expect(rowOf(page, line.text)).toHaveCount(1);
  await expect(page.getByText("Reversed", { exact: true }).first()).toBeVisible();
  // What was ticked is let go of.
  await expect(page.getByText(/selected across pages/)).toHaveCount(0);
  // The list has no box on a transaction that has been reversed, or on the reversal itself.
  await expect(rowOf(page, "ADOBE *CREATIVE CLOUD 4411").getByRole("checkbox")).toHaveCount(0);
  expect(errors).toEqual([]);

  // Close the books now says less.
  const [note] = await noteOf(request);
  expect(note).toMatchObject({
    code: "catchall_holds_money",
    amount: cents(-(TOTAL - MOVED_FIRST)),
    transactions: LINES.length - FIRST.length,
  });
  await page.goto("/periods");
  await expect(noteRegion(page)).toContainText(
    `Other expenses holds ${money(TOTAL - MOVED_FIRST)} from ${LINES.length - FIRST.length} transactions in January 2026.`,
  );
});

test("a reply that is lost on the way is resumed after a reload, and nothing is moved twice", async ({
  page,
  request,
}) => {
  const before = await balances(request);
  await openList(page);
  for (const line of LINES.filter((item) => SECOND_BATCH.some((part) => item.text.includes(part))))
    await setChecked(rowOf(page, line.text), /^Select/, true);
  await page.getByRole("button", { name: "Change account" }).click();
  const change = dialog(page);
  const account = change.getByRole("combobox", { name: /^Move to account/ });
  await account.fill("Meals");
  await page.getByRole("option", { name: /Meals/ }).click();
  await change.getByRole("button", { name: "Show what will happen" }).click();
  await expect(change.getByText("will move to Meals.")).toBeVisible();

  // The service does the work, and its answer never arrives: the screen cannot know.
  let lost = 0;
  await page.route("**/v1/inbox.recategorize", async (route) => {
    const body = JSON.parse(route.request().postData() ?? "{}");
    if (body.input?.dryRun === true) return route.continue();
    await route.fetch();
    lost += 1;
    return route.abort("connectionreset");
  });
  await change.getByRole("button", { name: /^Move 2 transactions$/ }).click();
  await expect(change.getByText("Waiting for the answer")).toBeVisible();
  await expect(change.getByRole("button", { name: "Resume" })).toBeEnabled();
  // Moving is not offered beside a request that is waiting.
  await expect(change.getByRole("button", { name: /^Move 2 transactions$/ })).toHaveCount(0);
  await shot(page, "change-account-waiting");
  await scanBoth(page, "Change account, waiting for the answer");
  expect(lost).toBe(1);
  // The books did it once.
  expect((await balances(request)).Meals).toBe(cents(LUNCH - MOVED_SECOND));

  // The page is closed and opened again: the request is found, and it is the same request.
  await page.unroute("**/v1/inbox.recategorize");
  await page.reload();
  await expect(page.getByRole("heading", { name: "Transactions", level: 1 })).toBeVisible();
  const waiting = page
    .getByRole("status")
    .filter({ hasText: /\S/ })
    .filter({ hasText: "A change of account is waiting for an answer" });
  await expect(waiting).toBeVisible();
  await shot(page, "change-account-waiting-page");
  await waiting.getByRole("button", { name: "Resume" }).click();
  const again = dialog(page);
  await expect(again.getByText("Waiting for the answer")).toBeVisible();
  await again.getByRole("button", { name: "Resume" }).click();
  await expect(again.getByText("2 transactions moved to Meals.")).toBeVisible();
  await again.getByRole("button", { name: "Done" }).click();
  await expect(again).toHaveCount(0);

  // Two transactions, two reversals: the same identity did the work once.
  const after = await balances(request);
  expect(after["Other expenses"]).toBe(cents(-(TOTAL - MOVED_FIRST - MOVED_SECOND)));
  const listed = await api(request, "journal.list", {
    accountId: ACCOUNTS["Other expenses"],
    status: "Posted",
  });
  expect((listed.corrections as Json[]).length).toBe(FIRST.length + 2);
  expect(after.Checking).toBe(before.Checking);
});

test("the rest are moved with the keyboard alone, and the note clears", async ({
  page,
  request,
  browserName,
}) => {
  test.skip(
    browserName === "webkit",
    "Safari's default Tab order skips links and buttons (Option+Tab reaches them), and this test walks it with Tab.",
  );
  const errors: string[] = [];
  page.on("pageerror", (error) => errors.push(error.message));
  await openList(page);
  await settled(page);
  // The first box has the cursor; Space ticks it; the page's box ticks all the rest that can be moved.
  const selectPage = page.getByRole("checkbox", { name: "Select page", exact: true });
  await selectPage.focus();
  await page.keyboard.press("Space");
  await expect(page.getByText("2 selected across pages", { exact: true })).toBeVisible();
  // Every other transaction on the page (the ones that were moved and their reversals) has no box.
  const action = page.getByRole("button", { name: "Change account" });
  await action.focus();
  await page.keyboard.press("Enter");
  const change = dialog(page);
  await expect(change.getByRole("combobox", { name: /^Move to account/ })).toBeFocused();
  await page.keyboard.type("meals");
  await expect(page.getByRole("option", { name: /Meals/ })).toBeVisible();
  await page.keyboard.press("ArrowDown");
  await page.keyboard.press("Enter");
  await expect(change.getByRole("combobox", { name: /^Move to account/ })).toHaveValue("Meals");
  // Tab on to the button that checks, through the reason and Cancel, and press it.
  await tabTo(page, change.getByRole("button", { name: "Show what will happen" }));
  await page.keyboard.press("Enter");
  await expect(change.getByText("All 2 transactions will move to Meals.")).toBeVisible();
  // The hostile text is text.
  await expect(change.getByText(/HYPERLINK/).first()).toBeVisible();
  await expect(change.locator("img, script")).toHaveCount(0);
  expect(await page.evaluate(() => window.__pwned)).toBeUndefined();
  // The table can be scrolled with the keyboard, and the buttons follow it.
  await tabTo(
    page,
    change.getByRole("region", { name: "The transactions and what will happen to each" }),
  );
  await tabTo(page, change.getByRole("button", { name: "Move 2 transactions" }));
  await page.keyboard.press("Enter");
  await expect(change.getByText("2 transactions moved to Meals.")).toBeVisible();
  await expect(change.getByRole("status").filter({ hasText: "moved to Meals" })).toBeFocused();
  await page.keyboard.press("Tab");
  await expect(change.getByRole("button", { name: "Done" })).toBeFocused();
  await page.keyboard.press("Enter");
  await expect(change).toHaveCount(0);
  // Focus is back where the person was, not lost with the button that went.
  await expect(page.getByRole("heading", { name: "Transactions", level: 1 })).toBeFocused();

  // Everything the statement said is where the person put it, and Other expenses holds nothing.
  const after = await balances(request);
  expect(after["Other expenses"]).toBe("0.00");
  expect(after["Software and subscriptions"]).toBe(cents(-MOVED_FIRST));
  expect(after.Meals).toBe(cents(LUNCH - (TOTAL - MOVED_FIRST)));
  expect(errors).toEqual([]);

  // The note is gone: nothing is collecting there.
  expect(await noteOf(request)).toEqual([]);
  await page.goto("/periods");
  await expect(
    page
      .getByRole("region", { name: "Through January 2026" })
      .getByRole("button", { name: "Close through January 2026" }),
  ).toBeVisible();
  await expect(noteRegion(page)).toHaveCount(0);
  await shot(page, "close-the-books-clear");
});
