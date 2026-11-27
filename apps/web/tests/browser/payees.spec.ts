import { mkdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { type APIRequestContext, expect, type Locator, type Page, test } from "@playwright/test";
import axe from "axe-core";
import { shown } from "../support/shown";
import { pick } from "../support/pick";
declare global {
  interface Window {
    axe: typeof axe;
  }
}

// Money by payee, driven the way a person would, against a fresh book on the real local API: a studio's
// year with the texts its bank wrote (a coffee shop four ways, a software subscription, a customer, a
// check), an entry typed in by hand, and nobody named. A person names payees out of the texts nobody has
// named, with the keyboard alone, and the page says what the words would find before anything is saved; a
// name changes which row a transaction is in and posts nothing, and the report still adds up to the profit
// and loss to the cent. Every figure the screen shows is checked against what the API itself says.
test.describe.configure({ mode: "serial" });

const version = "rastrata-application-v1";
const YEAR = new Date().getUTCFullYear();
const FROM = `${YEAR}-01-01`;
const TO = `${YEAR}-12-31`;
const ADDRESS = `/reports/payees?from=${FROM}&to=${TO}`;

async function api(request: APIRequestContext, name: string, input: unknown, operationId?: string) {
  const response = await request.post(`/v1/${name}`, {
    data: { version, bookId: "local-book", input, ...(operationId ? { operationId } : {}) },
  });
  const body = await response.json();
  expect(body.ok, `${name}: ${JSON.stringify(body.error)}`).toBe(true);
  return body.data;
}

/** A date this many days ago, but never before January 1 of this year: the book's one fiscal year. */
const daysAgo = (days: number): string => {
  const now = new Date();
  const wanted = new Date(now.getTime() - days * 86_400_000);
  const first = new Date(Date.UTC(now.getUTCFullYear(), 0, 1));
  return (wanted < first ? first : wanted).toISOString().slice(0, 10);
};

let entries = 0;
/** Post an entry between the checking account and one other, from a bank line whose text is `memo` (or, with
 * no source, an entry typed in by hand). `amount` is signed: negative is money out. */
async function post(
  request: APIRequestContext,
  date: string,
  memo: string,
  amount: string,
  category: string,
  fromTheBank = true,
) {
  const out = amount.startsWith("-");
  const absolute = amount.replace("-", "");
  const id = `payees-${++entries}`;
  const draft = await api(
    request,
    "drafts.create",
    {
      data: {
        date,
        reference: id,
        narration: memo,
        ...(fromTheBank ? { source: { id, description: memo } } : {}),
        lines: [
          { accountId: out ? category : "1010", debit: absolute, credit: "" },
          { accountId: out ? "1010" : category, debit: "", credit: absolute },
        ],
      },
    },
    crypto.randomUUID(),
  );
  const plan = await api(
    request,
    "journal.prepare",
    { draftId: draft.id, expectedVersion: 1 },
    crypto.randomUUID(),
  );
  await api(request, "operations.commit", { planId: plan.planId, planHash: plan.planHash });
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

const inTheme = async (page: Page, theme: "light" | "dark") => {
  await page.evaluate((value) => {
    document.documentElement.dataset.theme = value;
  }, theme);
  // A scan must not sample colors in the middle of the theme change's short transition.
  await page.addStyleTag({
    content: "*,*::before,*::after{transition:none!important;animation:none!important}",
  });
};

/** True when the page itself does not scroll sideways: a table may scroll inside its own region, the page
 * may not. */
const fitsWidth = (page: Page) =>
  page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth);

/** Pictures of the screens for whoever reviews them, when asked for (PAYEES_SHOTS names the folder). Not
 * part of what is tested. */
async function shot(page: Page, name: string): Promise<void> {
  const folder = process.env.PAYEES_SHOTS;
  if (!folder) return;
  mkdirSync(folder, { recursive: true });
  await page.screenshot({ path: join(folder, `${name}.png`), fullPage: false });
}

async function openReport(page: Page, address = ADDRESS) {
  await page.goto(address);
  await expect(page.getByRole("heading", { name: "Money by payee", level: 1 })).toBeVisible();
  await expect(page.locator(".rt-payees-summary, .rt-empty").first()).toBeVisible();
}

const unnamedTable = (page: Page) => page.getByRole("table", { name: "Not named yet" });
const payeesTable = (page: Page) => page.getByRole("table", { name: "Payees", exact: true });
const nameButton = (page: Page, text: RegExp) =>
  unnamedTable(page).getByRole("button", { name: text });
const sheetOf = (page: Page, name: string | RegExp) => page.getByRole("dialog", { name });
const found = (dialog: Locator) => dialog.getByRole("region", { name: "What these words find" });

/** The payees the book has, as the service lists them. */
async function listed(request: APIRequestContext) {
  const list = await api(request, "payees.list", { includeRetired: true });
  return list.payees as { id: string; name: string; words: string[]; version: number }[];
}

/** The report as the service gives it, for the whole year. */
const totals = (request: APIRequestContext) =>
  api(request, "payees.totals", { asOf: TO, from: FROM });

test("before there is a book, the screen says so plainly instead of erroring", async ({ page }) => {
  const problems: string[] = [];
  page.on("pageerror", (error) => problems.push(error.message));
  // The browser's own line for a request the service answers with a status (a screen asking about a book
  // that does not exist yet) is not a broken page; any other console error is.
  page.on("console", (message) => {
    if (message.type() === "error" && !/^Failed to load resource/.test(message.text()))
      problems.push(message.text());
  });
  await page.goto("/reports/payees");
  await expect(page.getByRole("heading", { level: 1, name: "Money by payee" })).toBeVisible();
  const notice = page.getByRole("status").filter({ hasText: "No book connected" });
  await expect(notice).toBeVisible();
  // It is a state of the books, not a failure: no alert, no retry.
  await expect(page.getByRole("alert")).toHaveCount(0);
  await expect(page.getByRole("button", { name: "Try again" })).toHaveCount(0);
  expect(problems).toEqual([]);
});

test("a fresh book is set up with a year of what a bank writes", async ({ request }) => {
  await api(
    request,
    "book.setup",
    {
      name: "Fieldnote Studio",
      currency: "USD",
      fiscalYear: YEAR,
      periodModel: "monthly",
      accounts: [
        { code: "1010", name: "Checking", role: "asset" },
        { code: "2100", name: "Credit card", role: "liability" },
        { code: "3100", name: "Owner contributions", role: "equity" },
        { code: "4000", name: "Sales", role: "income" },
        { code: "6100", name: "Software", role: "expense" },
        { code: "6300", name: "Meals", role: "expense" },
        { code: "6400", name: "Supplies", role: "expense" },
        { code: "6900", name: "Rent", role: "expense" },
      ],
    },
    crypto.randomUUID(),
  );
  await post(request, daysAgo(60), "Owner contribution", "5000.00", "3100");
  await post(request, daysAgo(40), "ACH CREDIT NORTHWIND LLC INV 2217", "4000.00", "4000");
  await post(request, daysAgo(20), "ZELLE PAYMENT FROM ACME DESIGN 7781", "2550.00", "4000");
  await post(request, daysAgo(31), "SQ *BLUE BOTTLE COFFEE 1234", "-5.75", "6300");
  await post(request, daysAgo(29), "SQ *BLUE BOTTLE COFFEE 1250", "-6.50", "6300");
  await post(request, daysAgo(12), "SQ *BLUE BOTTLE COFFEE 1288", "-5.75", "6300");
  await post(request, daysAgo(35), "ADOBE *CREATIVE CLOUD 4411", "-54.99", "6100");
  await post(request, daysAgo(22), "ADOBE *CREATIVE CLOUD 4519", "-54.99", "6100");
  await post(request, daysAgo(8), "ADOBE *CREATIVE CLOUD 4602", "-54.99", "6100");
  await post(request, daysAgo(18), "CHIPOTLE 2188", "-19.00", "6300");
  await post(request, daysAgo(5), "CHIPOTLE 2203", "-19.00", "6300");
  await post(request, daysAgo(25), "BLUE MOON CAFE 55", "-12.40", "6300");
  await post(request, daysAgo(14), "AMAZON MKTPLACE AMZN", "-30.99", "6400");
  await post(request, daysAgo(3), "CHECK 1041", "-750.00", "6900");
  // An entry typed in by hand has no bank text: its own description is all there is to name it by.
  await post(
    request,
    daysAgo(10),
    "Rent for the studio, paid by transfer",
    "-1200.00",
    "6900",
    false,
  );
});

test("Money by payee is in the list of reports, with the detail, and has its way back", async ({
  page,
}) => {
  await page.goto("/reports");
  await page
    .getByRole("list", { name: "Detail" })
    .getByRole("link", { name: "Money by payee", exact: true })
    .click();
  await expect(page).toHaveURL(/\/reports\/payees$/);
  await expect(page.getByRole("heading", { name: "Money by payee", level: 1 })).toBeFocused();
  // It is a page under Reports: the bar marks Reports, there is no row of tabs, and one link goes back.
  await expect(
    page
      .getByRole("navigation", { name: "Main navigation" })
      .getByRole("link", { name: "Reports", exact: true }),
  ).toHaveAttribute("aria-current", "true");
  await expect(page.getByRole("navigation", { name: /pages$/ })).toHaveCount(0);
  await page
    .locator("header.app-header")
    .getByRole("link", { name: "Reports", exact: true })
    .click();
  await expect(page).toHaveURL(/\/reports$/);
});

test("with nobody named, every text is listed and the whole adds up to the profit and loss", async ({
  page,
  request,
}) => {
  const problems: string[] = [];
  page.on("pageerror", (error) => problems.push(error.message));
  await openReport(page);
  const core = await api(request, "reports.get", { asOf: TO, from: FROM });
  const income: string = core.profitAndLoss.revenue;
  const expenses: string = core.profitAndLoss.expenses;
  // The four figures every other part is read against are the profit and loss's own.
  const summary = page.locator(".rt-payees-summary");
  await expect(summary).toContainText(shown.money(income));
  await expect(summary).toContainText(shown.money(expenses));
  await expect(
    page.locator(".rt-payees-proof").getByText("Adds up.", { exact: true }).first(),
  ).toBeVisible();
  await expect(page.getByRole("alert")).toHaveCount(0);
  // Nobody has a name: the one sentence says where to start, and every text has its own row.
  await expect(payeesTable(page)).toHaveCount(0);
  await expect(page.getByText("No payee has a transaction in these dates yet")).toBeVisible();
  const table = unnamedTable(page);
  await expect(table.getByRole("row")).toHaveCount(1 + 8);
  for (const text of [
    "ACH CREDIT NORTHWIND LLC INV 2217",
    "ZELLE PAYMENT FROM ACME DESIGN 7781",
    "CHECK 1041",
    "ADOBE *CREATIVE CLOUD 4411",
    "CHIPOTLE 2188",
    "AMAZON MKTPLACE AMZN",
    "BLUE MOON CAFE 55",
  ])
    await expect(table.getByText(text, { exact: true })).toBeVisible();
  // The texts that differ only in digits are one row: three Blue Bottle transactions, 18.00.
  const bottle = table.getByRole("row").filter({ hasText: "SQ *BLUE BOTTLE COFFEE" });
  await expect(bottle).toHaveCount(1);
  await expect(bottle).toContainText("3 transactions");
  await expect(bottle).toContainText(shown.money("18.00"));
  // The entry typed in by hand has no payee to name.
  const none = page.getByRole("table", { name: "No payee" });
  await expect(none.getByRole("row").filter({ hasText: "Entered by hand" })).toContainText(
    shown.money("1200.00"),
  );
  // The proof, at the foot: the profit and loss's total income and total expenses are the places added up.
  const proof = page.locator(".rt-payees-proof");
  await expect(proof).toContainText("Total income");
  await expect(proof).toContainText(shown.money(income));
  await expect(proof).toContainText("Total expenses");
  await expect(proof).toContainText(shown.money(expenses));
  await expect(proof.getByText(/^Adds up\./)).toHaveCount(2);
  // What the screen shows is what the service says, line for line.
  const said = await totals(request);
  expect(said.tieOut).toMatchObject({ matches: true, income, expenses });
  expect(said.unnamedCount).toBe(8);
  // The facts the report was built from are one click away, and there is no machine detail in the open.
  const visibleText = await page.locator("main").innerText();
  expect(visibleText).not.toMatch(/\b[0-9a-f]{64}\b/i);
  expect(visibleText).not.toMatch(/\b\d{4}-\d{2}-\d{2}\b/);
  await page.getByRole("button", { name: /Report details/ }).click();
  await expect(page.getByText("Payees revision")).toBeVisible();
  expect(problems).toEqual([]);
  await shot(page, "report-nobody-named-1440");
});

test("naming a payee with the keyboard alone: the words are tried before anything is saved, and the report still adds up", async ({
  page,
  request,
}) => {
  await openReport(page);
  const before = await totals(request);
  const summary = page.locator(".rt-payees-summary");
  const summaryBefore = await summary.innerText();

  // Escape leaves everything as it was.
  const button = nameButton(page, /^Name this payee, SQ \*BLUE BOTTLE COFFEE/);
  await button.focus();
  await page.keyboard.press("Enter");
  const dialog = sheetOf(page, "Name this payee");
  await expect(dialog).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(dialog).toHaveCount(0);
  await expect(button).toBeFocused();
  expect(await listed(request)).toEqual([]);

  // Open it again: the name and the words are offered, and the name has the focus.
  await page.keyboard.press("Enter");
  await expect(dialog).toBeVisible();
  const name = dialog.getByLabel("Name", { exact: true });
  await expect(name).toBeFocused();
  await expect(name).toHaveValue("Blue Bottle Coffee");
  await expect(dialog.getByLabel("Words that find them")).toHaveValue("blue bottle coffee");
  await expect(dialog.getByText("SQ *BLUE BOTTLE COFFEE", { exact: false }).first()).toBeVisible();
  // Before anything is saved, it says what the words find.
  const tried = found(dialog);
  await expect(tried).toContainText("These words find 3 transactions: 18.00 spent.");
  await expect(tried).toContainText("3 transactions are not named yet.");
  await shot(page, "drawer-name-1440");
  // Tab goes on to the words, and a change to them is tried again.
  await page.keyboard.press("Tab");
  await expect(dialog.getByLabel("Words that find them")).toBeFocused();
  await dialog.getByLabel("Words that find them").fill("blue bottle");
  await expect(tried).toContainText("These words find 3 transactions: 18.00 spent.");
  await dialog.getByLabel("Words that find them").fill("blue bottle coffee");
  await expect(tried).toContainText("These words find 3 transactions");
  // Enter in the name saves it.
  await name.focus();
  await page.keyboard.press("Enter");
  await expect(dialog).toHaveCount(0);

  // The row moved: it is a payee with three transactions and the money it was paid, and its button has the focus.
  const row = payeesTable(page).getByRole("row").filter({ hasText: "Blue Bottle Coffee" });
  await expect(row).toContainText("3 transactions");
  await expect(row).toContainText(shown.money("18.00"));
  await expect(page.getByRole("button", { name: "Open Blue Bottle Coffee" })).toBeFocused();
  await expect(
    page
      .getByRole("status")
      .filter({ hasText: /\S/ })
      .filter({ hasText: "Blue Bottle Coffee is a payee now, with 3 transactions" }),
  ).toBeVisible();
  await expect(unnamedTable(page).getByRole("row")).toHaveCount(1 + 7);
  await expect(unnamedTable(page).getByText("SQ *BLUE BOTTLE", { exact: false })).toHaveCount(0);

  // Nothing was posted and the whole still adds up: the same figures, the same proof, the same book.
  expect(await summary.innerText()).toBe(summaryBefore);
  await expect(
    page.locator(".rt-payees-proof").getByText("Adds up.", { exact: true }).first(),
  ).toBeVisible();
  const after = await totals(request);
  expect(after.tieOut.matches).toBe(true);
  expect(after.bookRevision).toBe(before.bookRevision);
  expect(after.totals).toEqual(before.totals);
  expect(after.tieOut.places.payees).toEqual({ received: "0.00", spent: "18.00", transactions: 3 });
  const named = (await listed(request)).find((payee) => payee.name === "Blue Bottle Coffee");
  expect(named).toMatchObject({ words: ["blue bottle coffee"], version: 1 });
  await shot(page, "report-named-1440");
});

test("words that find more than a payee should are shown for what they would do before they are saved", async ({
  page,
  request,
}) => {
  await openReport(page);
  // A text and its words are offered; the person shortens them to one word, which is also in the Blue
  // Bottle texts, whose payee's longer words keep them.
  const button = nameButton(page, /^Name this payee, BLUE MOON CAFE 55$/);
  await button.focus();
  await page.keyboard.press("Enter");
  const dialog = sheetOf(page, "Name this payee");
  await expect(dialog.getByLabel("Name", { exact: true })).toHaveValue("Blue Moon Cafe");
  await dialog.getByLabel("Name", { exact: true }).fill("Blue Heron");
  await dialog.getByLabel("Words that find them").fill("blue");
  const tried = found(dialog);
  await expect(tried).toContainText("These words find 1 transaction: 12.40 spent.");
  await expect(tried).toContainText(
    "3 transactions contain these words but stay with Blue Bottle Coffee, whose words are longer.",
  );
  await dialog.getByRole("button", { name: "Name this payee" }).click();
  await expect(dialog).toHaveCount(0);
  await expect(payeesTable(page).getByRole("row").filter({ hasText: "Blue Heron" })).toContainText(
    shown.money("12.40"),
  );
  expect((await listed(request)).map((payee) => payee.name).sort()).toEqual([
    "Blue Bottle Coffee",
    "Blue Heron",
  ]);
});

test("a text that two payees match equally is given to neither, says so, and is settled by longer words", async ({
  page,
  request,
}) => {
  // Another payee whose words are as long as Blue Heron's, in the same text.
  await api(request, "payees.save", { name: "Moon Pie", words: ["moon"] }, crypto.randomUUID());
  await openReport(page);
  const tied = page.getByRole("table", { name: "Matched by more than one payee" });
  await expect(tied).toBeVisible();
  const row = tied.getByRole("row").filter({ hasText: "BLUE MOON CAFE 55" });
  await expect(row).toContainText("Matched by");
  await expect(row.getByRole("button", { name: "Change Blue Heron" })).toBeVisible();
  // It is in neither payee's figures, and the proof still counts it.
  await expect(payeesTable(page).getByRole("row").filter({ hasText: "Blue Heron" })).toHaveCount(0);
  await expect(
    page.locator(".rt-payees-proof").getByText("Adds up.", { exact: true }).first(),
  ).toBeVisible();
  await expect(page.locator(".rt-payees-proof")).toContainText("More than one payee");
  await shot(page, "report-ambiguous-1440");

  // The way out: longer words for one of them. It says what they would settle before it saves.
  await row.getByRole("button", { name: "Change Moon Pie" }).click();
  const dialog = sheetOf(page, "Change this payee");
  await expect(dialog.getByLabel("Name", { exact: true })).toHaveValue("Moon Pie");
  await dialog.getByLabel("Words that find them").fill("blue moon");
  await expect(found(dialog)).toContainText(
    "1 transaction matches more than one payee equally now. These words would settle it.",
  );
  await dialog.getByRole("button", { name: "Save" }).click();
  await expect(dialog).toHaveCount(0);
  await expect(tied).toHaveCount(0);
  await expect(payeesTable(page).getByRole("row").filter({ hasText: "Moon Pie" })).toContainText(
    shown.money("12.40"),
  );
  const said = await totals(request);
  expect(said.ambiguousCount).toBe(0);
  expect(said.tieOut.matches).toBe(true);
});

test("a payee's transactions are one click away, each leads to its entry, and the payee can be changed and its earlier versions read", async ({
  page,
  request,
}) => {
  await openReport(page);
  await page.getByRole("button", { name: "Open Blue Bottle Coffee" }).click();
  const sheet = sheetOf(page, "Blue Bottle Coffee");
  await expect(sheet).toBeVisible();
  // What finds it, what it is and what it found.
  await expect(sheet.getByRole("heading", { name: "Words that find this payee" })).toBeVisible();
  await expect(sheet.getByText("blue bottle coffee", { exact: true })).toBeVisible();
  const rows = sheet.getByRole("table").getByRole("row");
  await expect(rows).toHaveCount(1 + 3);
  await expect(sheet).toContainText("3 transactions");
  await expect(sheet.getByText("Found by “blue bottle coffee”").first()).toBeVisible();
  await shot(page, "sheet-payee-1440");
  // The address names the payee, so the sheet can be linked to.
  await expect(page).toHaveURL(/payee=/);
  // Each date leads to the entry.
  const first = sheet.getByRole("link", { name: /^Open the entry of / }).first();
  const entry = await first.getAttribute("href");
  expect(entry).toMatch(/^\/journal\/[^/]+$/);
  await first.click();
  await expect(page).toHaveURL(new RegExp(`${entry?.replaceAll("/", "\\/")}`));
  await page.goBack();
  // Back on the report, the sheet is open again: the address said which payee.
  await expect(sheetOf(page, "Blue Bottle Coffee")).toBeVisible();

  // Change its name from the sheet.
  await sheet.getByRole("button", { name: "Change this payee" }).click();
  const dialog = sheetOf(page, "Change this payee");
  await expect(dialog.getByLabel("Name", { exact: true })).toHaveValue("Blue Bottle Coffee");
  await dialog.getByLabel("Name", { exact: true }).fill("Blue Bottle");
  await dialog.getByLabel("Note").fill("The coffee place by the studio.");
  await dialog.getByRole("button", { name: "Save" }).click();
  await expect(dialog).toHaveCount(0);
  await expect(page.getByRole("status").filter({ hasText: "Saved Blue Bottle." })).toBeVisible();
  const row = payeesTable(page).getByRole("row").filter({ hasText: "Blue Bottle" });
  await expect(row).toContainText(shown.money("18.00"));
  const changed = (await listed(request)).find((payee) => payee.name === "Blue Bottle");
  expect(changed).toMatchObject({ version: 2, words: ["blue bottle coffee"] });
  // The earlier version is kept, with who made it.
  await page.getByRole("button", { name: "Open Blue Bottle" }).click();
  const again = sheetOf(page, "Blue Bottle");
  await expect(again).toContainText("The coffee place by the studio.");
  await again.getByRole("button", { name: "Earlier versions" }).click();
  await expect(again.getByText(/^Version 1, .*, by you: Blue Bottle Coffee$/)).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(again).toHaveCount(0);
});

test("naming a payee from the sheet of a text hands the focus on, and back to the row the sheet was opened from", async ({
  page,
}) => {
  await openReport(page);
  const see = unnamedTable(page).getByRole("button", {
    name: /^See transactions, ZELLE PAYMENT FROM ACME DESIGN/,
  });
  await see.focus();
  await page.keyboard.press("Enter");
  const sheet = sheetOf(page, "Not named yet");
  await expect(sheet.getByRole("table")).toBeVisible();
  // The sheet of a text leads on to naming a payee from it: the form opens with the focus on the name.
  await sheet.getByRole("button", { name: "Name this payee" }).click();
  const dialog = sheetOf(page, "Name this payee");
  await expect(dialog.getByLabel("Name", { exact: true })).toHaveValue("Acme Design");
  await expect(dialog.getByLabel("Name", { exact: true })).toBeFocused();
  // Leaving it puts the focus back where the person was: the row's own button, not the sheet's that is gone.
  await page.keyboard.press("Escape");
  await expect(dialog).toHaveCount(0);
  await expect(see).toBeFocused();
});

test("on a short screen the buttons of the form stay in view while the form scrolls", async ({
  page,
}) => {
  await page.setViewportSize({ width: 1280, height: 560 });
  await openReport(page);
  const button = nameButton(page, /^Name this payee, ADOBE/);
  await button.focus();
  await page.keyboard.press("Enter");
  const dialog = sheetOf(page, "Name this payee");
  await expect(found(dialog)).toContainText("These words find");
  const save = dialog.getByRole("button", { name: "Name this payee" });
  const cancel = dialog.getByRole("button", { name: "Cancel" });
  for (const control of [save, cancel]) {
    const box = await control.boundingBox();
    expect(box?.y ?? -1).toBeGreaterThanOrEqual(0);
    expect((box?.y ?? 0) + (box?.height ?? 0)).toBeLessThanOrEqual(560);
  }
  // The form is taller than the screen, and what is last in it is reached by tabbing, clear of the buttons.
  const note = dialog.getByLabel("Note");
  await note.focus();
  const noteBox = await note.boundingBox();
  const saveBox = await save.boundingBox();
  expect((noteBox?.y ?? 0) + (noteBox?.height ?? 0)).toBeLessThanOrEqual(saveBox?.y ?? 0);
  await page.keyboard.press("Escape");
  await expect(dialog).toHaveCount(0);
});

test("a refusal says why and keeps every answer; a reply that is lost is sent again, and the payee is made once", async ({
  page,
  request,
}) => {
  await openReport(page);
  const button = nameButton(page, /^Name this payee, CHIPOTLE 2188$/);
  await button.focus();
  await page.keyboard.press("Enter");
  const dialog = sheetOf(page, "Name this payee");
  await expect(dialog.getByLabel("Name", { exact: true })).toHaveValue("Chipotle");
  // A name that is another payee's, whatever its case, is refused, and what was typed stays.
  await dialog.getByLabel("Name", { exact: true }).fill("blue bottle");
  await dialog.getByLabel("Note").fill("kept");
  await dialog.getByRole("button", { name: "Name this payee" }).click();
  await expect(dialog.getByRole("alert")).toContainText(
    "A payee named blue bottle already exists.",
  );
  await expect(dialog.getByLabel("Name", { exact: true })).toHaveValue("blue bottle");
  await expect(dialog.getByLabel("Note")).toHaveValue("kept");
  expect((await listed(request)).filter((payee) => payee.name === "Chipotle")).toEqual([]);

  // Say what is missing: a form with no name says so, in a summary that moves focus to the field.
  await dialog.getByLabel("Name", { exact: true }).fill("");
  await dialog.getByRole("button", { name: "Name this payee" }).click();
  const summary = dialog.getByRole("region", { name: "Fix these before saving" });
  await expect(summary).toBeFocused();
  await summary.getByRole("link", { name: "Give the payee a name." }).click();
  await expect(dialog.getByLabel("Name", { exact: true })).toBeFocused();
  await dialog.getByLabel("Name", { exact: true }).fill("Chipotle");

  // The service gets the request and its reply is lost on the way back.
  let sent = 0;
  await page.route("**/v1/payees.save", async (route) => {
    sent += 1;
    if (sent === 1) {
      await route.fetch();
      await route.abort();
    } else await route.continue();
  });
  await dialog.getByRole("button", { name: "Name this payee" }).click();
  await expect(
    dialog.getByRole("status").filter({ hasText: "The reply to the save was lost" }),
  ).toBeVisible();
  // The payee is there already: the service did what it was asked.
  expect((await listed(request)).filter((payee) => payee.name === "Chipotle")).toHaveLength(1);
  // Saving again sends the same request, which is answered as the first was and not done twice.
  await dialog.getByRole("button", { name: "Name this payee" }).click();
  await expect(dialog).toHaveCount(0);
  expect(sent).toBe(2);
  await page.unroute("**/v1/payees.save");
  const chipotle = (await listed(request)).filter((payee) => payee.name === "Chipotle");
  expect(chipotle).toHaveLength(1);
  expect(chipotle[0]?.version).toBe(1);
  await expect(payeesTable(page).getByRole("row").filter({ hasText: "Chipotle" })).toContainText(
    shown.money("38.00"),
  );
});

test("the report and its transactions are files, and a name that a spreadsheet would run is not run", async ({
  page,
  request,
}) => {
  // A payee whose name is a formula, and a text that looks like markup: each is data, never an instruction.
  await post(request, daysAgo(2), "FORMULA TEST 5", "-3.00", "6400");
  await post(request, daysAgo(2), "<img src=x onerror=alert(1)> MARKUP 9", "-4.00", "6400");
  await api(request, "payees.save", { name: "=1+1", words: ["formula test"] }, crypto.randomUUID());
  await api(
    request,
    "payees.save",
    { name: "<b onmouseover=alert(2)>Bold</b> Ltd", words: ["markup"] },
    crypto.randomUUID(),
  );
  const alerts: string[] = [];
  page.on("dialog", async (dialog) => {
    alerts.push(dialog.message());
    await dialog.dismiss();
  });
  await openReport(page);
  // Shown as the text it is.
  await expect(page.getByRole("button", { name: "Open =1+1" })).toBeVisible();
  await expect(
    page.getByRole("button", { name: "Open <b onmouseover=alert(2)>Bold</b> Ltd" }),
  ).toBeVisible();
  await expect(page.locator(".rt-payees-link b, .rt-payees-link img")).toHaveCount(0);

  await page.getByRole("button", { name: "Export" }).click();
  const [summary] = await Promise.all([
    page.waitForEvent("download"),
    page.getByRole("menuitem", { name: "Download the report (CSV)" }).click(),
  ]);
  expect(summary.suggestedFilename()).toBe(`money-by-payee-${FROM}-to-${TO}.csv`);
  const bytes = readFileSync(await summary.path());
  // UTF-8 with a byte order mark, so a spreadsheet reads accented names.
  expect([...bytes.subarray(0, 3)]).toEqual([0xef, 0xbb, 0xbf]);
  const csv = bytes.subarray(3).toString("utf8");
  expect(csv).toContain("Report,Money by payee");
  expect(csv).toContain(`Period start,${FROM}`);
  expect(csv).toContain("payee,Blue Bottle,");
  // A cell that begins with = + - or @ is made text before it is written.
  expect(csv).toContain("payee,'=1+1,");
  expect(csv).not.toMatch(/(^|\n)payee,=1\+1/);
  const said = await totals(request);
  expect(csv).toContain(
    `profit and loss,Total income and total expenses of the same range,,${said.tieOut.profitLossIncome},${said.tieOut.profitLossExpenses},`,
  );

  await page.getByRole("button", { name: "Export" }).click();
  const [lines] = await Promise.all([
    page.waitForEvent("download"),
    page.getByRole("menuitem", { name: "Download every transaction (CSV)" }).click(),
  ]);
  const every = readFileSync(await lines.path())
    .subarray(3)
    .toString("utf8");
  expect(every).toContain(
    "Date,Journal ID,Row,Payee,Text matched,Words matched,Accounts,Received,Spent",
  );
  expect(every).toContain(",payee,Blue Bottle,");
  expect(every).toContain("'=1+1,");
  await expect(
    page
      .getByRole("status")
      .filter({ hasText: /\S/ })
      .filter({ hasText: /^Saved .*\.csv\.$/ })
      .last(),
  ).toBeVisible();
  expect(alerts).toEqual([]);
});

test("a payee changed by someone else since the form was opened is not overwritten, and the form says so", async ({
  page,
  request,
}) => {
  await openReport(page);
  await page.getByRole("button", { name: "Open Moon Pie" }).click();
  await sheetOf(page, "Moon Pie").getByRole("button", { name: "Change this payee" }).click();
  const dialog = sheetOf(page, "Change this payee");
  await expect(dialog.getByLabel("Name", { exact: true })).toHaveValue("Moon Pie");
  // An agent changes the payee while the form is open.
  const moon = (await listed(request)).find((payee) => payee.name === "Moon Pie");
  expect(moon).toBeDefined();
  await api(
    request,
    "payees.save",
    { payeeId: moon?.id, expectedVersion: moon?.version, note: "changed elsewhere" },
    crypto.randomUUID(),
  );
  await dialog.getByLabel("Name", { exact: true }).fill("Moon Pie Cafe");
  await dialog.getByRole("button", { name: "Save" }).click();
  await expect(dialog.getByRole("alert")).toContainText("was changed since you opened it");
  // What was typed stays, and what the other change made is not lost.
  await expect(dialog.getByLabel("Name", { exact: true })).toHaveValue("Moon Pie Cafe");
  const after = (await listed(request)).find((payee) => payee.id === moon?.id);
  expect(after).toMatchObject({ name: "Moon Pie", version: (moon?.version ?? 0) + 1 });
  // Opened again, it is the current version and the change can be made.
  await dialog.getByRole("button", { name: "Cancel" }).click();
  await expect(dialog).toHaveCount(0);
  await page.getByRole("button", { name: "Open Moon Pie" }).click();
  await sheetOf(page, "Moon Pie").getByRole("button", { name: "Change this payee" }).click();
  const again = sheetOf(page, "Change this payee");
  await expect(again.getByLabel("Note")).toHaveValue("changed elsewhere");
  await again.getByRole("button", { name: "Cancel" }).click();
  await expect(again).toHaveCount(0);
});

test("a link to a payee this book does not have says so, and closing the sheet takes it out of the address", async ({
  page,
}) => {
  await page.goto(`${ADDRESS}&payee=pay_not_here`);
  const sheet = sheetOf(page, "Payee");
  await expect(sheet.getByRole("alert")).toContainText("This book has no payee with that address.");
  // What the service says in programs' words is not what the page says.
  await expect(sheet).not.toContainText("payees.list");
  await page.keyboard.press("Escape");
  await expect(sheet).toHaveCount(0);
  await expect(page).not.toHaveURL(/payee=/);
  await expect(page.locator(".rt-payees-summary")).toBeVisible();
});

test("a 1099 vendor is a payee, and the vendors lead to it", async ({ page, request }) => {
  // The 1099 threshold is verified for 2025 and 2026 only (packages/application/src/tax/thresholds.ts); a
  // later year's list is refused until it is.
  test.skip(![2025, 2026].includes(YEAR), "The 1099 threshold is not verified for this year");
  await api(
    request,
    "taxVendors.save",
    { name: "Northwind Design", payeeKeys: ["northwind"], reporting: "yes" },
    crypto.randomUUID(),
  );
  await page.goto(`/tax?tab=vendors&year=${YEAR}`);
  const link = page.getByRole("link", { name: "See Northwind Design in Money by payee" });
  await link.scrollIntoViewIfNeeded();
  await expect(link).toBeVisible();
  await shot(page, "tax-vendors-link");
  await link.click();
  await expect(page).toHaveURL(/\/reports\/payees\?.*payee=/);
  // The vendor opened as the payee it is, with the money it was paid.
  const sheet = sheetOf(page, "Northwind Design");
  await expect(sheet).toBeVisible();
  await expect(sheet).toContainText("This payee is also a 1099 vendor.");
  await expect(sheet.getByRole("link", { name: "Open the 1099 vendors" })).toBeVisible();
  await expect(sheet).toContainText(shown.money("4000.00"));
  await expect(sheet.getByText("northwind", { exact: true })).toBeVisible();
  // The vendor and the payee are one: the same id, and a change in either is the other's.
  const payee = (await listed(request)).find((entry) => entry.name === "Northwind Design");
  expect(payee).toBeDefined();
  const vendors = await api(request, "taxVendors.list", { taxYear: YEAR });
  expect(vendors.vendors.map((row: { vendor: { id: string } }) => row.vendor.id)).toContain(
    payee?.id,
  );
  await sheet.getByRole("button", { name: "Change this payee" }).click();
  const dialog = sheetOf(page, "Change this payee");
  await expect(dialog).toContainText("also a 1099 vendor");
  await dialog.getByLabel("Name", { exact: true }).fill("Northwind Studio");
  await dialog.getByRole("button", { name: "Save" }).click();
  await expect(dialog).toHaveCount(0);
  const again = await api(request, "taxVendors.list", { taxYear: YEAR });
  expect(again.vendors.map((row: { vendor: { name: string } }) => row.vendor.name)).toContain(
    "Northwind Studio",
  );
});

for (const theme of ["light", "dark"] as const) {
  for (const size of [
    { width: 1440, height: 900 },
    { width: 390, height: 844 },
  ]) {
    test(`the report, the sheet that names a payee and the one that shows its transactions fit ${size.width} px and pass the accessibility scan in the ${theme} theme`, async ({
      page,
    }) => {
      await page.setViewportSize(size);
      await openReport(page);
      await inTheme(page, theme);
      expect(await fitsWidth(page), "the report").toBe(true);
      await scan(page, `the report at ${size.width} (${theme})`);
      await shot(page, `report-${size.width}-${theme}`);

      // The sheet that names a payee, opened the way a keyboard opens it.
      const button = nameButton(page, /^Name this payee, ZELLE PAYMENT/);
      await button.focus();
      await page.keyboard.press("Enter");
      const dialog = sheetOf(page, "Name this payee");
      await expect(dialog).toBeVisible();
      await expect(found(dialog)).toContainText("These words find");
      const naming = await dialog.boundingBox();
      expect(naming?.x ?? -1).toBeGreaterThanOrEqual(0);
      expect((naming?.x ?? 0) + (naming?.width ?? 0)).toBeLessThanOrEqual(size.width);
      expect(await fitsWidth(page), "the sheet that names").toBe(true);
      await scan(page, `the naming sheet at ${size.width} (${theme})`);
      await shot(page, `drawer-${size.width}-${theme}`);
      await page.keyboard.press("Escape");
      await expect(dialog).toHaveCount(0);

      // The sheet that shows what a row is made of.
      await page.getByRole("button", { name: "Open Blue Bottle" }).click();
      const sheet = sheetOf(page, "Blue Bottle");
      await expect(sheet.getByRole("table")).toBeVisible();
      const shownBox = await sheet.boundingBox();
      expect(shownBox?.x ?? -1).toBeGreaterThanOrEqual(0);
      expect((shownBox?.x ?? 0) + (shownBox?.width ?? 0)).toBeLessThanOrEqual(size.width);
      expect(await fitsWidth(page), "the sheet of transactions").toBe(true);
      await scan(page, `the transactions sheet at ${size.width} (${theme})`);
      await shot(page, `sheet-${size.width}-${theme}`);
      await page.keyboard.press("Escape");
    });
  }
}

test("a long list of payees is read a page at a time, and the proof is the same on every page", async ({
  page,
  request,
}) => {
  test.setTimeout(240_000);
  // More payees than a page holds, each with one transaction, the largest first by the amount.
  for (let index = 0; index < 105; index++) {
    const label = String(index).padStart(3, "0");
    const cents = 20_000 - index * 7;
    await post(
      request,
      daysAgo(1),
      `PAGED PAYEE ${label} 77`,
      `-${Math.floor(cents / 100)}.${String(cents % 100).padStart(2, "0")}`,
      "6400",
    );
    await api(
      request,
      "payees.save",
      { name: `Paged Payee ${label}`, words: [`paged payee ${label}`] },
      crypto.randomUUID(),
    );
  }
  // And more texts nobody has named than the list holds: every one has its own words, so none is a digit
  // away from another.
  const letters = (index: number) =>
    `${String.fromCharCode(97 + Math.floor(index / 26))}${String.fromCharCode(97 + (index % 26))}`;
  for (let index = 0; index < 105; index++)
    await post(request, daysAgo(1), `STRANGER ROW${letters(index)} 5`, "-3.00", "6400");
  const said = await totals(request);
  expect(said.rowCount).toBeGreaterThan(105);
  expect(said.unnamedCount).toBeGreaterThan(105);
  expect(said.unnamed).toHaveLength(100);
  const second = said.rowCount - 100;

  await openReport(page);
  const rows = payeesTable(page).getByRole("row");
  await expect(rows).toHaveCount(1 + 100);
  // What the list of texts leaves out is said, with what it adds up to, so nothing disappears without a word.
  await expect(unnamedTable(page).getByRole("row")).toHaveCount(1 + 100);
  await expect(
    page.getByText(`${said.unnamedRest.groups} smaller rows are not listed`, { exact: false }),
  ).toBeVisible();
  await expect(
    page.locator(".rt-payees-proof").getByText("Adds up.", { exact: true }).first(),
  ).toBeVisible();
  const pager = page.getByRole("navigation", { name: "Pagination" });
  await expect(pager).toContainText("Page 1 of 2");
  await expect(page.getByText(`100 of ${said.rowCount} payees`)).toBeVisible();
  await expect(page.getByRole("button", { name: "Open Paged Payee 000" })).toBeVisible();
  const figures = await page.locator(".rt-payees-summary").innerText();

  // The next page is in the address, holds what is left, and is the same report: the figures and the proof.
  await pager.getByRole("button", { name: "Next page" }).click();
  await expect(page).toHaveURL(/page=2/);
  await expect(rows).toHaveCount(1 + second);
  await expect(page.getByText(`${second} of ${said.rowCount} payees`)).toBeVisible();
  await expect(page.getByRole("button", { name: "Open Paged Payee 000" })).toHaveCount(0);
  expect(await page.locator(".rt-payees-summary").innerText()).toBe(figures);
  await expect(
    page.locator(".rt-payees-proof").getByText("Adds up.", { exact: true }).first(),
  ).toBeVisible();
  await expect(page.locator(".rt-payees-proof").getByText(/^Adds up\./)).toHaveCount(2);

  // A reload on the second page stays on it, and the way back is on the screen.
  await page.reload();
  await expect(rows).toHaveCount(1 + second);
  await pager.getByRole("button", { name: "Previous page" }).click();
  await expect(rows).toHaveCount(1 + 100);
  await expect(page).not.toHaveURL(/page=/);
  // Changing what is listed starts again at the first page.
  await pager.getByRole("button", { name: "Next page" }).click();
  await pick(page, page.getByLabel("Show"), { value: "received" });
  await expect(page).not.toHaveURL(/page=/);
  await expect(page).toHaveURL(/show=received/);
});
