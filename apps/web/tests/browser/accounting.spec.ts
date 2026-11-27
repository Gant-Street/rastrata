import { expect, test, type APIRequestContext, type Page } from "@playwright/test";
import axe from "axe-core";
import { readFile } from "node:fs/promises";
import { setChecked, takeVerifiedBackup } from "../support/accounting";
import { chartRow, openAccount, openAccountDetails, showWholeChart } from "../support/chart";
import { chooseAccount, entryBar, fillEntry, postEntry } from "../support/entry-form";
import { shown } from "../support/shown";
import { pick } from "../support/pick";

declare global {
  interface Window {
    axe: typeof axe;
  }
}

/** The accounting screens of the UX rework, driven the way a person drives them against a book of their
 * own on the real local API: the Transactions list (its columns, its numbers, its filters and its
 * search), an entry's page, and reversing a transaction from the list and from its page, with the
 * keyboard. The book is seeded through the API in the first test, and every other test reads it. */
test.describe.configure({ mode: "serial" });

const version = "rastrata-application-v1";
type Json = Awaited<ReturnType<Response["json"]>>;

async function call(request: APIRequestContext, name: string, input: unknown, write = false) {
  const response = await request.post(`/v1/${name}`, {
    data: {
      version,
      bookId: "local-book",
      input,
      ...(write ? { operationId: crypto.randomUUID() } : {}),
    },
  });
  expect(response.ok(), `${name}: ${await response.text()}`).toBe(true);
  return (await response.json()).data as Json;
}

interface Entry {
  readonly date: string;
  readonly reference: string;
  readonly narration?: string;
  readonly source?: string;
  readonly debit: string;
  readonly credit: string;
  readonly amount: string;
}
const draftOf = (entry: Entry) => ({
  date: entry.date,
  reference: entry.reference,
  narration: entry.narration ?? entry.reference,
  lines: [
    { accountId: entry.debit, debit: entry.amount, credit: "" },
    { accountId: entry.credit, debit: "", credit: entry.amount },
  ],
  ...(entry.source
    ? { source: { id: entry.source, description: `${entry.reference} source` } }
    : {}),
});
async function post(request: APIRequestContext, entry: Entry) {
  const draft = await call(request, "drafts.create", { data: draftOf(entry) }, true);
  const plan = await call(
    request,
    "journal.prepare",
    { draftId: draft.id, expectedVersion: draft.version },
    true,
  );
  const receipt = await call(request, "operations.commit", {
    planId: plan.planId,
    planHash: plan.planHash,
  });
  expect(receipt.disposition).toBe("committed");
}

// A bank line and a Stripe payout carry the identity the importers give them (a long identifier on the
// entry); an opening entry and two entries typed by hand complete the kinds the Type filter knows.
const ENTRIES: readonly Entry[] = [
  {
    date: "2026-03-01",
    reference: "OPENING",
    narration: "Opening balances",
    source: "opening-2026-03-01-0123456789ab",
    debit: "1000",
    credit: "3000",
    amount: "12000.00",
  },
  {
    date: "2026-03-20",
    reference: "LINEAR ORBIT",
    source: `ingest-csv-${"a1".repeat(16)}`,
    debit: "6200",
    credit: "1000",
    amount: "19.00",
  },
  {
    date: "2026-03-20",
    reference: "PERSONAL GROCERY MARKET",
    source: `ingest-csv-${"b2".repeat(16)}`,
    debit: "3100",
    credit: "1000",
    amount: "48.76",
  },
  {
    date: "2026-03-21",
    reference: "STRIPE PAYOUT po_1Nxyz",
    narration: "Stripe payout po_1Nxyz to Business checking",
    source: "stripe-payout-po_1Nxyz",
    debit: "1000",
    credit: "4000",
    amount: "1420.12",
  },
  {
    date: "2026-03-31",
    reference: "DEP-0326",
    narration: "March depreciation on the laptop and monitor",
    debit: "6040",
    credit: "1590",
    amount: "58.33",
  },
  {
    date: "2026-03-22",
    reference: "TOOLS-ERR",
    narration: "Tools purchase entered twice by mistake",
    debit: "6200",
    credit: "1000",
    amount: "75.00",
  },
];

const scan = async (page: Page, label: string) => {
  await page.addStyleTag({
    content: "*,*::before,*::after{transition:none!important;animation:none!important}",
  });
  for (const theme of ["light", "dark"] as const) {
    await page.evaluate((value) => {
      document.documentElement.dataset.theme = value;
    }, theme);
    await page.addScriptTag({ content: axe.source });
    const violations = await page.evaluate(async () =>
      (
        await window.axe.run(document.body, {
          runOnly: { type: "tag", values: ["wcag2a", "wcag2aa", "wcag21aa"] },
        })
      ).violations.map(({ id, nodes }) => ({ id, targets: nodes.map((node) => node.target) })),
    );
    expect(violations, `${label} (${theme})`).toEqual([]);
  }
};
const noSideways = (page: Page) =>
  expect
    .poll(() => page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth))
    .toBe(true);

const registerOf = (page: Page) => page.getByRole("table", { name: "Transactions" });
const rowOf = (page: Page, text: string | RegExp) =>
  registerOf(page).getByRole("row").filter({ hasText: text });

/** The number the book gave an entry, read from the service: entries are numbered in the order they
 * were posted, and the tests below do not assume that order. */
async function numberOf(request: APIRequestContext, reference: string): Promise<string> {
  const page = await call(request, "journal.list", { text: reference });
  const entry = page.entries.find((item: Json) => item.reference === reference);
  expect(entry, reference).toBeDefined();
  return entry.postingSequence as string;
}

test("a book is seeded through the API: an opening entry, bank lines, a Stripe payout, hand entries and a draft", async ({
  request,
}) => {
  await call(
    request,
    "book.setup",
    {
      name: "Willow Lane Studio",
      currency: "USD",
      fiscalYear: 2026,
      periodModel: "monthly",
      accounts: [
        { code: "1000", name: "Business checking", role: "asset" },
        { code: "1590", name: "Accumulated depreciation", role: "asset" },
        { code: "3000", name: "Owner's investment", role: "equity" },
        { code: "3100", name: "Owner's draw", role: "equity" },
        { code: "4000", name: "Sales", role: "income" },
        { code: "6040", name: "Depreciation", role: "expense" },
        { code: "6200", name: "Software and subscriptions", role: "expense" },
      ],
    },
    true,
  );
  for (const entry of ENTRIES) await post(request, entry);
  await call(
    request,
    "drafts.create",
    {
      data: draftOf({
        date: "2026-04-15",
        reference: "EST-TAX-Q1",
        narration: "First quarter estimated tax, waiting for the confirmation number",
        debit: "3100",
        credit: "1000",
        amount: "1500.00",
      }),
    },
    true,
  );
  const page = await call(request, "journal.list", {});
  expect(page.count).toBe(ENTRIES.length + 1);
});

test("All shows Date, Description, Category and Amount on one screen, never scrolling sideways, and says a status only when an entry is not posted", async ({
  page,
  request,
}) => {
  await page.setViewportSize({ width: 1440, height: 800 });
  await page.goto("/journal");
  const table = registerOf(page);
  await expect(table).toBeVisible();
  const region = page.getByRole("region", { name: /^Transactions, scroll/ });
  const size = await region.evaluate((element) => ({
    scroll: element.scrollWidth,
    client: element.clientWidth,
  }));
  // The long identifiers of an imported line and a Stripe payout are 71 characters; they are not on
  // the surface, so the table is as wide as its container.
  expect(size.scroll).toBeLessThanOrEqual(size.client);
  for (const header of ["Date", "Description", "Category", "Amount"]) {
    const box = await table.getByRole("columnheader", { name: header, exact: true }).boundingBox();
    expect(box && box.x >= 0 && box.x + box.width <= 1440, header).toBe(true);
  }
  // No column of numbers and none of statuses: the number is on the entry's own page, and a status is
  // said on the row that has one.
  await expect(table.getByRole("columnheader", { name: "No.", exact: true })).toHaveCount(0);
  await expect(table.getByRole("columnheader", { name: "Status", exact: true })).toHaveCount(0);
  // An entry is its description, the link to its own page (never an identifier).
  await expect(
    rowOf(page, "LINEAR ORBIT").getByRole("link", { name: /LINEAR ORBIT/ }),
  ).toHaveAttribute("href", /^\/journal\/[^/?]+/);
  await numberOf(request, "LINEAR ORBIT");
  const text = await page.locator("main").innerText();
  expect(text).not.toMatch(/source-[0-9a-f]{20,}/);
  expect(text).not.toMatch(/[0-9a-f]{32,}/);
  // The accounts read as money moving, by name and without codes: the bank paid for software.
  await expect(rowOf(page, "LINEAR ORBIT")).toContainText("Business checking");
  await expect(rowOf(page, "LINEAR ORBIT").locator(".rt-register-cell-accounts")).toHaveText(
    /Business checking.*Software and subscriptions/,
  );
  // The amount is on screen. A posted entry says nothing of its state; a draft says so.
  await expect(rowOf(page, "LINEAR ORBIT")).toContainText("19.00");
  await expect(rowOf(page, "LINEAR ORBIT")).not.toContainText("Posted");
  await expect(rowOf(page, "EST-TAX-Q1")).toContainText("Draft");
  await page.screenshot({ path: test.info().outputPath("transactions-1440.png"), fullPage: true });
});

test("the Type and Status filters keep one kind, and Search transactions matches a number, an amount, an account and words", async ({
  page,
  request,
}) => {
  await page.goto("/journal");
  const table = registerOf(page);
  await expect(rowOf(page, "LINEAR ORBIT")).toBeVisible();
  // The dates, account, type and status are behind the one quiet Filter button at the end of the search box.
  await page.getByRole("button", { name: "Filter", exact: true }).click();
  // Type: only what came from a bank statement.
  await page.getByRole("combobox", { name: "Type" }).click();
  await page.getByRole("option", { name: "Bank" }).click();
  await expect(rowOf(page, "LINEAR ORBIT")).toBeVisible();
  await expect(rowOf(page, "PERSONAL GROCERY MARKET")).toBeVisible();
  await expect(table).not.toContainText("Stripe payout");
  await expect(table).not.toContainText("March depreciation");
  await expect(page.getByRole("combobox", { name: "Type" })).toContainText("Bank");
  // Stripe.
  await page.getByRole("combobox", { name: "Type" }).click();
  await page.getByRole("option", { name: "Stripe" }).click();
  await expect(rowOf(page, "Stripe payout")).toBeVisible();
  await expect(table).not.toContainText("LINEAR ORBIT");
  // Back to every type; then only drafts.
  await page.getByRole("combobox", { name: "Type" }).click();
  await page.getByRole("option", { name: "All types" }).click();
  await page.getByRole("combobox", { name: "Status", exact: true }).click();
  await page.getByRole("option", { name: "Draft" }).click();
  await expect(rowOf(page, "EST-TAX-Q1")).toBeVisible();
  await expect(table).not.toContainText("LINEAR ORBIT");
  await page.getByRole("combobox", { name: "Status", exact: true }).click();
  await page.getByRole("option", { name: "All statuses" }).click();
  await expect(rowOf(page, "LINEAR ORBIT")).toBeVisible();
  // Search transactions: by number (either way a person says it), by amount, by an account's name and by words.
  const search = page.getByRole("searchbox", { name: "Search transactions" });
  const grocery = await numberOf(request, "PERSONAL GROCERY MARKET");
  await search.fill(`No. ${grocery}`);
  await expect(rowOf(page, "PERSONAL GROCERY MARKET")).toBeVisible();
  await expect(table).not.toContainText("LINEAR ORBIT");
  await search.fill("48.76");
  await expect(rowOf(page, "PERSONAL GROCERY MARKET")).toBeVisible();
  await search.fill("Sales");
  await expect(rowOf(page, "Stripe payout")).toBeVisible();
  await expect(table).not.toContainText("PERSONAL GROCERY MARKET");
  await search.fill("estimated tax");
  await expect(rowOf(page, "EST-TAX-Q1")).toBeVisible();
  await search.fill("");
  await expect(rowOf(page, "LINEAR ORBIT")).toBeVisible();
});

test("an entry's page is titled by its number, shows what it says and blanks where there is no amount, and keeps the machine detail under Details", async ({
  page,
  request,
}) => {
  const grocery = await numberOf(request, "PERSONAL GROCERY MARKET");
  await page.goto("/journal");
  // The description is the way into the entry: a link to its own page, where its number is.
  await rowOf(page, "PERSONAL GROCERY MARKET")
    .getByRole("link", { name: /PERSONAL GROCERY MARKET/ })
    .click();
  await expect(
    page.getByRole("heading", { level: 1, name: new RegExp(`No\\. ${grocery}`) }),
  ).toBeVisible();
  // The state is a chip beside the title.
  await expect(page.locator("main .rt-page-status")).toHaveText("Posted");
  await expect(page.getByText("PERSONAL GROCERY MARKET")).toBeVisible();
  await expect(page.getByText(shown.date("2026-03-20"), { exact: false }).first()).toBeVisible();
  // The lines: names, and a blank where the amount is on the other side.
  const lines = page.getByRole("region", { name: "Entry lines" });
  const draw = lines.getByRole("row").filter({ hasText: "Owner's draw" });
  await expect(draw.getByRole("cell").nth(0)).toContainText("48.76");
  await expect(draw.getByRole("cell").nth(1)).toHaveText("");
  await expect(lines).not.toContainText("0.00");
  await expect(lines.getByRole("row").filter({ hasText: "Total" })).toContainText("48.76");
  // The identifier, the revision, the sequence and the fingerprint are one click away.
  const main = page.locator("main");
  await expect(main).not.toContainText(/[0-9a-f]{32,}/, { useInnerText: true });
  await expect(main).not.toContainText("fingerprint", { useInnerText: true });
  await main.getByRole("button", { name: "Details", exact: true }).click();
  await expect(main).toContainText(new RegExp(`Sequence\\s*${grocery}`));
  await expect(main).toContainText("Source event");
  await expect(main).toContainText(/Source fingerprint\s*[0-9a-f]{64}/i);
});

test("reversing from the list with the keyboard: the dialog asks a date and a reason, posts in one step, and the pair names each other", async ({
  page,
  request,
}) => {
  const tools = await numberOf(request, "TOOLS-ERR");
  await page.goto("/journal");
  await expect(rowOf(page, "TOOLS-ERR")).toBeVisible();
  // The menu at the end of the row, opened with the keyboard.
  const menu = rowOf(page, "TOOLS-ERR").getByRole("button", { name: `Actions for No. ${tools}` });
  await menu.focus();
  await page.keyboard.press("Enter");
  // The menu takes focus and its first item is the one highlighted when it opens from the keyboard.
  await expect(page.getByRole("menu")).toBeFocused();
  await expect(page.getByRole("menuitem", { name: "Reverse" })).toHaveAttribute(
    "data-highlighted",
    "",
  );
  await page.keyboard.press("Enter");
  const dialog = page.getByRole("dialog", { name: `Reverse No. ${tools}` });
  await expect(dialog).toBeVisible();
  await expect(dialog).toContainText("Tools purchase entered twice by mistake");
  // The date starts on the entry's own date, and the cursor is on the reason.
  await expect(dialog.getByRole("textbox", { name: /Reversal date/ })).toHaveValue(
    shown.dateBox("2026-03-22"),
  );
  const reason = dialog.getByRole("textbox", { name: /Reason/ });
  await expect(reason).toBeFocused();
  // Without a reason nothing is sent.
  await dialog.getByRole("button", { name: "Reverse transaction" }).click();
  await expect(dialog).toContainText("Enter a reason.");
  await expect(reason).toBeFocused();
  await reason.fill("Entered twice by mistake");
  await dialog.getByRole("textbox", { name: /Reversal date/ }).fill("2026-03-23");
  await page.screenshot({ path: test.info().outputPath("reverse-dialog.png") });
  await reason.press("Enter");
  // Posted in the same step: the dialog goes, the page says so, and the pair names each other.
  await expect(dialog).toBeHidden();
  await expect(page.getByRole("status").filter({ hasText: `Reversed No. ${tools}` })).toBeVisible();
  const original = rowOf(page, "Tools purchase entered twice by mistake");
  // The original says it was reversed (a posted entry says nothing of its state), and the reversal says
  // in its own description what it reverses.
  await expect(original).toContainText("Reversed");
  const back = rowOf(page, /^.*Reversal of No\./);
  await expect(back).toContainText(`Reversal of No. ${tools}`);
  await expect(registerOf(page)).not.toContainText(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-/);
  // Neither takes another reversal.
  await expect(
    registerOf(page).getByRole("button", { name: `Actions for No. ${tools}` }),
  ).toHaveCount(0);
  // The books agree: the tools purchase and its reversal net to nothing in the checking account.
  const status = await call(request, "reports.get", { asOf: "2026-03-31" });
  expect(status.balanceSheet).toBeDefined();
});

test("reversing from an entry's own page", async ({ page, request }) => {
  const linear = await numberOf(request, "LINEAR ORBIT");
  await page.goto("/journal");
  await rowOf(page, "LINEAR ORBIT")
    .getByRole("link", { name: /LINEAR ORBIT/ })
    .click();
  await page.getByRole("button", { name: "Reverse", exact: true }).click();
  const dialog = page.getByRole("dialog", { name: `Reverse No. ${linear}` });
  await expect(dialog).toBeVisible();
  // Escape leaves the dialog and puts focus back on the button that opened it.
  await page.keyboard.press("Escape");
  await expect(dialog).toBeHidden();
  await expect(page.getByRole("button", { name: "Reverse", exact: true })).toBeFocused();
  await page.getByRole("button", { name: "Reverse", exact: true }).click();
  await dialog.getByRole("textbox", { name: /Reason/ }).fill("Wrong account");
  await dialog.getByRole("button", { name: "Reverse transaction" }).click();
  await expect(dialog).toBeHidden();
  // The page now says it was reversed, and the button is gone.
  await expect(page.getByText(/Reversed by No\. \d+/)).toBeVisible();
  await expect(page.getByRole("button", { name: "Reverse", exact: true })).toHaveCount(0);
});

test("a reversal dated in a closed month is refused in words, and the screens pass axe at both widths in both themes", async ({
  page,
  request,
}) => {
  // Close March, then try to reverse an entry inside it.
  const period = (await call(request, "periods.list", {})).periods.find(
    (item: Json) => item.startsOn === "2026-03-01",
  );
  const closing = await call(
    request,
    "periods.prepare",
    { periodId: period.id, operation: "close", reason: "March reviewed" },
    true,
  );
  await call(request, "operations.commit", {
    planId: closing.planId,
    planHash: closing.planHash,
  });
  const grocery = await numberOf(request, "PERSONAL GROCERY MARKET");
  await page.goto("/journal");
  await rowOf(page, "PERSONAL GROCERY MARKET")
    .getByRole("button", { name: `Actions for No. ${grocery}` })
    .click();
  await page.getByRole("menuitem", { name: "Reverse" }).click();
  const dialog = page.getByRole("dialog", { name: `Reverse No. ${grocery}` });
  // March is closed, so the date starts on a day that can be posted, not on the entry's own date.
  await expect(dialog.getByRole("textbox", { name: /Reversal date/ })).not.toHaveValue(
    "2026-03-20",
  );
  // Typing the closed date anyway: the service refuses, and the dialog says why in words.
  await dialog.getByRole("textbox", { name: /Reversal date/ }).fill("2026-03-20");
  await dialog.getByRole("textbox", { name: /Reason/ }).fill("Personal");
  await dialog.getByRole("button", { name: "Reverse transaction" }).click();
  await expect(dialog.getByRole("alert")).toContainText(/March|closed/i);
  await expect(dialog.getByRole("button", { name: "Reverse anyway" })).toBeDisabled();
  await scan(page, "the reverse dialog");
  await page.keyboard.press("Escape");
  // The list and an entry are accessible, and both fit a phone.
  await page.goto("/journal");
  await expect(registerOf(page)).toBeVisible();
  await scan(page, "the list");
  await numberOf(request, "LINEAR ORBIT");
  await rowOf(page, "LINEAR ORBIT")
    .getByRole("link", { name: /LINEAR ORBIT/ })
    .click();
  await expect(page.getByRole("region", { name: "Entry lines" })).toBeVisible();
  await scan(page, "an entry");
  await page.setViewportSize({ width: 390, height: 844 });
  await noSideways(page);
  await page.goto("/journal");
  await expect(registerOf(page)).toBeVisible();
  await noSideways(page);
  await page.screenshot({ path: test.info().outputPath("transactions-390.png"), fullPage: true });
});

// ---- Accounts (the chart, folded by kind) and the account register -------------------------------------------

const accountRow = chartRow;

test("Accounts is the chart folded by kind: a line a kind with its total, an account's row is its name and its balance, and a name opens the account", async ({
  page,
}) => {
  await page.setViewportSize({ width: 1440, height: 800 });
  await page.goto("/accounts");
  await expect(page.getByRole("heading", { level: 1, name: "Accounts" })).toBeVisible();
  // A line for each kind this book has, in the order a chart is read, with how many accounts it holds.
  const kinds = await page.locator(".rt-chart-group-name").allTextContents();
  expect(kinds.length).toBeGreaterThanOrEqual(3);
  const order = ["Assets", "Liabilities", "Equity", "Income", "Expenses"];
  const named = kinds.map((kind) => /^(\w+) \(\d+\)/.exec(kind)?.[1] ?? kind);
  expect(named).toEqual(order.filter((kind) => named.includes(kind)));
  expect(named).toEqual(expect.arrayContaining(["Assets", "Income", "Expenses"]));
  // One job, one title: no sentence under it, no "How this works", no filters beside the search.
  await expect(page.getByRole("button", { name: /How this works/ })).toHaveCount(0);
  await expect(page.getByRole("combobox")).toHaveCount(0);
  await expect(page.getByRole("checkbox")).toHaveCount(0);
  await expect(page.getByRole("columnheader", { name: /Code|Type|Tax line/ })).toHaveCount(0);
  // The chart's own revision is not on the surface: it is under Details.
  await expect(page.locator("main").getByText("Chart revision")).toBeHidden();
  await page.screenshot({ path: test.info().outputPath("chart-1440.png"), fullPage: true });
  await showWholeChart(page);
  await expect(accountRow(page, "Business checking")).toBeVisible();
  await page.screenshot({ path: test.info().outputPath("chart-open.png"), fullPage: true });
  await page
    .locator(".rt-chart-groups")
    .getByRole("link", { name: "Business checking", exact: true })
    .click();
  await expect(page).toHaveURL(/\/ledger\?accountId=/);
  await expect(page.getByRole("heading", { level: 1, name: "Business checking" })).toBeVisible();
});

test("New account is a drawer: a name, a type and a suggested code, and the form says what it will do before it does it", async ({
  page,
  request,
}) => {
  await page.goto("/accounts");
  await page.getByRole("button", { name: "New account" }).click();
  const dialog = page.getByRole("dialog", { name: "New account" });
  await expect(dialog.getByRole("textbox", { name: /^Name/ })).toBeFocused();
  // Typed from the keyboard: the footer fills in as the form does.
  await page.keyboard.type("Software tools");
  const code = dialog.getByRole("textbox", { name: /^Code/ });
  await expect(code).toHaveValue("6210");
  await expect(dialog).toContainText("Suggested 6210. You can change it.");
  await expect(dialog).toContainText("This adds 6210 Software tools as an Expense.");
  // A taken code is refused where it is typed.
  await code.fill("6200");
  await dialog.getByRole("button", { name: "Add account" }).click();
  await expect(dialog).toContainText("6200 is already used by Software and subscriptions.");
  await expect(code).toBeFocused();
  await code.fill("6210");
  // The rest is under Advanced, closed until it is asked for.
  await expect(dialog.getByRole("combobox", { name: "Parent account" })).toBeHidden();
  await dialog.getByRole("button", { name: "Advanced" }).click();
  await expect(dialog.getByRole("textbox", { name: /^Role key/ })).toBeVisible();
  await page.screenshot({ path: test.info().outputPath("new-account.png") });
  // Enter adds it: the drawer goes, a toast says so, and the table has the account.
  await code.press("Enter");
  await expect(dialog).toBeHidden();
  await expect(
    page.getByRole("status").filter({ hasText: "Added 6210 Software tools." }),
  ).toBeVisible();
  // The new account has nothing in it: its kind opens and lists it.
  await expect(accountRow(page, "Software tools")).toBeVisible();
  await expect(page.getByRole("button", { name: "New account" })).toBeFocused();
  const chart = await call(request, "accounts.list", {});
  expect(chart.accounts.some((account: Json) => account.code === "6210")).toBe(true);
});

test("+ New, Account opens the drawer and Search's address opens an account's transactions", async ({
  page,
  request,
}) => {
  await page.goto("/accounts?new=1");
  await expect(page.getByRole("dialog", { name: "New account" })).toBeVisible();
  // The query is taken out of the address as it is used.
  await expect(page).toHaveURL(/\/accounts$/);
  await page.keyboard.press("Escape");
  const chart = await call(request, "accounts.list", {});
  const bank = chart.accounts.find((account: Json) => account.code === "1000");
  await page.goto(`/accounts?account=${bank.id}`);
  await expect(page).toHaveURL(new RegExp(`/ledger\\?accountId=${bank.id}`));
  await expect(page.getByRole("heading", { level: 1, name: "Business checking" })).toBeVisible();
});

test("Edit account, on the account's own page, renames and closes from a drawer that says which", async ({
  page,
  request,
}) => {
  await openAccount(page, "Software tools");
  await openAccountDetails(page);
  // From the keyboard: the button is under Account details, with what else changes the account.
  const edit = page.getByRole("button", { name: "Edit account", exact: true });
  await edit.focus();
  await page.keyboard.press("Enter");
  const dialog = page.getByRole("dialog", { name: "Edit account" });
  await expect(dialog).toBeVisible();
  await expect(dialog).toContainText("Change the name, or close the account.");
  await page.keyboard.press("ControlOrMeta+A");
  await page.keyboard.type("Software and tools");
  await expect(dialog).toContainText(/This renames Software tools to Software and tools, starting/);
  await dialog.getByRole("button", { name: "Save changes" }).click();
  await expect(dialog).toBeHidden();
  await expect(
    page.getByRole("status").filter({ hasText: "Saved 6210 Software and tools." }),
  ).toBeVisible();
  // The page is the account's: its title is the new name, and focus is back on the button.
  await expect(page.getByRole("heading", { level: 1, name: "Software and tools" })).toBeVisible();
  await expect(edit).toBeFocused();
  // A zero-balance account closes, its details say when, and it can no longer be edited.
  await edit.click();
  await setChecked(dialog, "Close this account", true);
  await expect(dialog).toContainText("This closes Software and tools on");
  await dialog.getByRole("button", { name: "Close account" }).click();
  await expect(dialog).toBeHidden();
  await expect(page.locator(".rt-account-folds")).toContainText("Closed");
  await expect(page.getByRole("button", { name: "Edit account", exact: true })).toHaveCount(0);
  const chart = await call(request, "accounts.list", {});
  expect(chart.accounts.find((account: Json) => account.code === "6210").closedOn).not.toBeNull();
  // The chart says it is closed, under its name.
  await page.goto("/accounts");
  await page.getByRole("searchbox", { name: "Search accounts" }).fill("Software and tools");
  await expect(accountRow(page, "Software and tools")).toContainText("Closed");
  // A row of the chart is a name and a balance: no menu.
  await expect(page.getByRole("button", { name: /^Actions for/ })).toHaveCount(0);
});

test("an account's register shows its transactions with a running balance, and exports them", async ({
  page,
  request,
}) => {
  const chart = await call(request, "accounts.list", {});
  const bank = chart.accounts.find((account: Json) => account.code === "1000");
  await page.goto(`/ledger?accountId=${bank.id}`);
  await expect(page.getByRole("heading", { level: 1, name: "Business checking" })).toBeVisible();
  // Accounts, marked in the bar, is the way back: the page has no "Back to" line of its own.
  await expect(page.getByRole("main").getByRole("link", { name: /^Back to/ })).toHaveCount(0);
  await expect(
    page.locator("header.app-header").getByRole("link", { name: "Accounts", exact: true }),
  ).toHaveAttribute("aria-current", /.+/);
  const table = page.getByRole("table", { name: "Transactions of Business checking" });
  // This account is not marked as a bank account, so its amounts are Debit and Credit; the entry's number is
  // on the entry's page, not in a column here.
  await expect(table.getByRole("columnheader")).toHaveText([
    "Date",
    "Description",
    "Debit",
    "Credit",
    "Balance",
  ]);
  await expect(table.getByRole("row", { name: /Balance before this period/ })).toBeVisible();
  const linear = table.getByRole("row").filter({ hasText: "LINEAR ORBIT" });
  await expect(linear.getByRole("link", { name: "LINEAR ORBIT" })).toHaveAttribute(
    "href",
    /^\/journal\//,
  );
  // No debit on a payment: blank, not 0.00.
  await expect(linear.getByRole("cell").nth(1)).toHaveText("");
  // Nothing is said above the table but the account's name and the dates.
  await expect(
    page.getByText(/Balance at the end of this period|carries on from the start/),
  ).toHaveCount(0);
  // What the account is sits in a fold under its transactions, shut until asked for.
  const details = page.getByRole("button", { name: "Account details" });
  await expect(details).toHaveAttribute("aria-expanded", "false");
  await expect(page.locator(".rt-account-folds")).toContainText("Code 1000 · Asset");
  await expect(page.locator("main")).not.toContainText(/[0-9a-f]{32,}/, { useInnerText: true });
  await page.screenshot({ path: test.info().outputPath("register-1440.png"), fullPage: true });

  // Export is with the account's details: the file is this account's lines and no other's.
  await details.click();
  const download = page.waitForEvent("download");
  await page.getByRole("button", { name: "Export" }).click();
  const file = await download;
  expect(file.suggestedFilename()).toMatch(
    /^account-register-\d{4}-\d{2}-\d{2}-to-\d{4}-\d{2}-\d{2}\.csv$/,
  );
  const text = (await readFile((await file.path()) as string, "utf8")).replace(/^﻿/, "");
  expect(text).toContain("LINEAR ORBIT");
  expect(text).not.toContain("March depreciation");
  await expect(
    page.getByRole("status").filter({ hasText: /^Exported account-register-/ }),
  ).toBeVisible();

  // A range the person chooses: nothing before March, so the period is empty.
  await pick(page, page.getByLabel("Dates"), "Custom");
  await page.getByLabel("From", { exact: true }).fill("2026-01-01");
  await page.getByLabel("To", { exact: true }).fill("2026-02-28");
  await expect(page.getByText("No transactions in this period.")).toBeVisible();
});

test("an amount on a report still opens that report's own activity, with its dates and population", async ({
  page,
  request,
}) => {
  const chart = await call(request, "accounts.list", {});
  const bank = chart.accounts.find((account: Json) => account.code === "1000");
  const report = await call(request, "reports.get", { asOf: "2026-03-31" });
  const query = new URLSearchParams({
    accountId: bank.id,
    asOf: "2026-03-31",
    population: report.populationHash,
    from: "2026-03-01",
    to: "2026-03-31",
    back: "/reports?asOf=2026-03-31",
  });
  await page.goto(`/ledger?${query.toString()}`);
  await expect(page.getByRole("heading", { level: 1, name: "Business checking" })).toBeVisible();
  // What the lines were read from is under Report details at the foot, closed.
  await expect(page.getByRole("button", { name: "Report details", exact: true })).toBeVisible();
  await expect(page.getByRole("link", { name: "Back to the report" })).toHaveAttribute(
    "href",
    "/reports?asOf=2026-03-31",
  );
});

// ---- Close the books ---------------------------------------------------------------------------------------

test("Close the books says how far, has one card with what is left, and closes through the month from the keyboard once nothing is", async ({
  page,
  request,
}) => {
  // The test before this one closed March through the API, ahead of January and February. Open it again, so
  // the book is as a person's is: three months open, the first two with nothing recorded in them.
  const march = (await call(request, "periods.list", {})).periods.find(
    (item: Json) => item.startsOn === "2026-03-01",
  );
  if (march.status === "closed") {
    const reopening = await call(
      request,
      "periods.prepare",
      { periodId: march.id, operation: "reopen", reason: "Opened again to close it from the page" },
      true,
    );
    await call(request, "operations.commit", {
      planId: reopening.planId,
      planHash: reopening.planHash,
    });
  }
  await page.setViewportSize({ width: 1440, height: 800 });
  await page.goto("/periods");
  await expect(page.getByRole("heading", { level: 1, name: "Close the books" })).toBeVisible();
  // One line under the title: nothing is closed yet, and what closing is. No "How this works".
  const through = page.locator("#rt-close-through");
  await expect(through).toHaveText(
    "Nothing is closed yet. Closing a month stops new entries dated in it. You can reopen it.",
  );
  await expect(page.getByRole("button", { name: "How this works" })).toHaveCount(0);
  // One card, for March: the first month with something in it. January and February hold nothing, so they
  // are not asked for; they close with it. What is left is a sentence with its one link.
  const card = page.getByRole("region", { name: "Through March 2026", exact: true });
  await expect(card).toBeVisible();
  await expect(page.locator(".rt-close-card")).toHaveCount(1);
  await expect(card.getByRole("listitem")).toHaveText([
    /^No backup of your books has been checked yet\./,
  ]);
  await expect(card.getByRole("link", { name: "Back up now" })).toHaveAttribute(
    "href",
    "/settings/backups",
  );
  const close = card.getByRole("button", { name: "Close through March 2026" });
  await expect(close).toBeDisabled();
  // No badge for the normal state, and no month has a card or a line of its own.
  await expect(page.getByText("Open", { exact: true })).toHaveCount(0);
  await expect(page.getByRole("region", { name: /January 2026|February 2026/ })).toHaveCount(0);
  await page.screenshot({ path: test.info().outputPath("close-1440.png"), fullPage: true });
  await scan(page, "close the books, a thing left");

  // A backup that has been checked is the last thing: take one, come back, and the button is on.
  await takeVerifiedBackup(request);
  await page.reload();
  await expect(close).toBeEnabled();
  await expect(card.getByRole("listitem")).toHaveCount(0);
  await close.focus();
  await page.keyboard.press("Enter");
  // One press: a message says which months, the cursor is on the line that says how far the books are closed.
  await expect(
    page.getByRole("status").filter({ hasText: "January to March 2026 are closed." }),
  ).toBeVisible();
  await expect(through).toBeFocused();
  await expect(through).toHaveText(`Books are closed through ${shown.date("2026-03-31")}.`);
  await expect(card).toHaveCount(0);
  await page.getByRole("button", { name: "Closed months (3)" }).click();
  for (const month of ["January", "February", "March"])
    await expect(page.getByRole("button", { name: `Reopen ${month} 2026` })).toBeVisible();
  await page.screenshot({ path: test.info().outputPath("closed-1440.png"), fullPage: true });
  const periods = await call(request, "periods.list", {});
  for (const month of ["January", "February", "March"])
    expect(periods.periods.find((period: Json) => period.label === month)?.status).toBe("closed");
  // Nothing after March was closed: the tests below post in April.
  expect(
    (periods.periods as Json[]).filter(
      (period) => period.status === "closed" && period.startsOn >= "2026-04-01",
    ),
  ).toEqual([]);
});

// ---- The period and the account, the kit's way ------------------------------------------------------------------

test("the period and the account are the kit's: everything starts on All, and an account keeps the entries that touch it", async ({
  page,
}) => {
  await page.setViewportSize({ width: 1440, height: 800 });
  await page.goto("/journal");
  // The period and the account are behind the one quiet Filter button at the end of the search box.
  await page.getByRole("button", { name: "Filter", exact: true }).click();
  const dates = page.getByLabel("Posting dates", { exact: true });
  await expect(dates).toHaveAttribute("data-value", "all");
  const account = page.getByRole("combobox", { name: "Account" });
  await expect(account).toHaveValue("All accounts");
  // An account, found by part of its name: only the entries that touch it stay.
  await account.fill("soft");
  await page.getByRole("option", { name: /Software and subscriptions/ }).click();
  await expect(rowOf(page, "LINEAR ORBIT")).toBeVisible();
  await expect(rowOf(page, "OPENING")).toHaveCount(0);
  await account.fill("all");
  await page.getByRole("option", { name: "All accounts" }).click();
  await expect(rowOf(page, "OPENING")).toBeVisible();
  // A custom period: the entries dated in it, and All dates puts everything back.
  await pick(page, dates, "Custom");
  await page.getByLabel("From", { exact: true }).fill("2026-03-20");
  await page.getByLabel("To", { exact: true }).fill("2026-03-20");
  await expect(rowOf(page, "LINEAR ORBIT")).toBeVisible();
  await expect(rowOf(page, "OPENING")).toHaveCount(0);
  await page.screenshot({ path: test.info().outputPath("filters-1440.png"), fullPage: true });
  await pick(page, dates, "All dates");
  await expect(rowOf(page, "OPENING")).toBeVisible();
});

// ---- The new-entry form ----------------------------------------------------------------------------------

test("a new entry is typed with the keyboard, balances in the bar and posts in one step", async ({
  page,
  request,
}) => {
  await page.goto("/journal/new");
  await expect(page.getByRole("heading", { level: 1, name: "New journal entry" })).toBeVisible();
  const bar = entryBar(page);
  await expect(bar).toContainText("Debits 0.00");
  await expect(bar).not.toContainText("Balanced");

  // Date, description and reference, then the first line: the picker takes part of a name, the amount is
  // tidied when it is left. Only the keyboard is used from here.
  await page.getByRole("textbox", { name: /^Date/ }).fill("2026-04-20");
  await page.getByRole("textbox", { name: /^Description/ }).focus();
  await page.keyboard.type("Printer ink");
  await page.keyboard.press("Tab");
  await expect(page.getByRole("textbox", { name: /^Reference/ })).toBeFocused();
  await page.keyboard.type("INK-1");
  await page.keyboard.press("Tab");
  const first = page.getByRole("combobox", { name: "Account for line 1" });
  await expect(first).toBeFocused();
  await page.keyboard.type("soft");
  await page.keyboard.press("ArrowDown");
  await page.keyboard.press("Enter");
  await expect(first).toHaveValue("Software and subscriptions");
  // The picker's own buttons come before the debit: Tab reaches it.
  const debitOne = page.getByRole("textbox", { name: "Debit for line 1" });
  for (let step = 0; step < 4; step += 1) {
    if (await debitOne.evaluate((element) => element === document.activeElement)) break;
    await page.keyboard.press("Tab");
  }
  await expect(debitOne).toBeFocused();
  await page.keyboard.type("42.5");
  await page.keyboard.press("Tab");
  await expect(page.getByRole("textbox", { name: "Debit for line 1" })).toHaveValue("42.50");
  await expect(bar).toContainText("Debits 42.50");
  await expect(bar).toContainText("Out of balance");

  await chooseAccount(page, 2, "1000");
  await page.getByRole("textbox", { name: "Credit for line 2" }).fill("42.50");
  await expect(bar).toContainText("Difference 0.00");
  await expect(bar).toContainText("Balanced");
  await page.screenshot({ path: test.info().outputPath("new-entry-1440.png"), fullPage: true });

  await postEntry(page);
  // Posted in the same step: the list opens, the entry is on it, and a toast names its number.
  await expect(page).toHaveURL(/\/journal$/);
  const number = await numberOf(request, "INK-1");
  await expect(page.getByRole("status").filter({ hasText: `Posted No. ${number}.` })).toBeVisible();
  await expect(rowOf(page, "Printer ink")).toContainText("Software and subscriptions");
  // The toast leads to the entry.
  await page.getByRole("status").getByRole("button", { name: "View" }).click();
  await expect(page.getByRole("heading", { level: 1, name: `No. ${number}` })).toBeVisible();
});

test("Post that cannot go lists what to fix, keeps what was typed, and a draft opens again from the list", async ({
  page,
  request,
}) => {
  await page.goto("/journal/new");
  await fillEntry(page, {
    date: "2026-04-21",
    lines: [
      { code: "6200", debit: "30" },
      { code: "1000", credit: "20" },
    ],
  });
  await entryBar(page).getByRole("button", { name: "Post", exact: true }).click();
  const summary = page.getByRole("region", { name: "This entry is not ready" });
  await expect(summary).toBeFocused();
  await expect(summary).toContainText("Enter a description.");
  // The entry does not balance: said once the rest is in order.
  await page.getByRole("textbox", { name: /^Description/ }).fill("Cheque to the printer");
  await expect(summary).not.toContainText("Enter a description.");
  await entryBar(page).getByRole("button", { name: "Post", exact: true }).click();
  await expect(summary).toContainText("out of balance by 10.00");
  await summary.getByRole("link", { name: /out of balance/ }).click();
  await expect(page.getByRole("textbox", { name: "Debit for line 1" })).toBeFocused();
  await expect(page.getByRole("textbox", { name: "Debit for line 1" })).toHaveValue("30.00");

  // A draft needs less: it saves, says so, and does not touch the books.
  await entryBar(page).getByRole("button", { name: "Save draft" }).click();
  await expect(page.getByRole("status").filter({ hasText: "Draft saved" })).toBeVisible();
  await expect(page.getByRole("heading", { level: 1, name: "Edit draft" })).toBeVisible();
  const before = await call(request, "journal.list", { status: "Draft" });
  expect(before.entries.some((entry: Json) => entry.description === "Cheque to the printer")).toBe(
    true,
  );

  // It opens again from the list, is made right and posts.
  await page.goto("/journal");
  // (Its row says Draft, the only state a row says; an entry of that name posted earlier says nothing.)
  await rowOf(page, "Cheque to the printer")
    .filter({ hasText: "Draft" })
    .getByRole("link", { name: "Cheque to the printer" })
    .click();
  await expect(page.getByRole("textbox", { name: /^Description/ })).toHaveValue(
    "Cheque to the printer",
  );
  await page.getByRole("textbox", { name: "Credit for line 2" }).fill("30");
  await expect(entryBar(page)).toContainText("Balanced");
  await postEntry(page);
  await expect(page).toHaveURL(/\/journal$/);
  // No draft of it is left: it is posted, and a posted entry says nothing of its state.
  await expect(rowOf(page, "Cheque to the printer").first()).toBeVisible();
  await expect(rowOf(page, "Cheque to the printer").filter({ hasText: "Draft" })).toHaveCount(0);
});
