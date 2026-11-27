import { expect, test, type APIRequestContext, type Locator, type Page } from "@playwright/test";
import axe from "axe-core";
import { shown } from "../support/shown.ts";

/** Parsed JSON, typed the way `Response.json()` types it, so tests can read fields freely. */
type Json = Awaited<ReturnType<Response["json"]>>;

declare global {
  interface Window {
    axe: typeof axe;
  }
}

/** The entry screens against the real local API and a fresh book: Spend money, Receive money and Transfer
 * from "+ New", the owner presets, Save draft, an empty form, a closed month, a lost reply, and the
 * Business settings. Every figure is invented, and each test posts amounts of its own so an entry is found
 * by its amount. The tests share the book and run one after another. */
test.describe.configure({ mode: "serial" });
// An action that cannot be done fails in seconds and says why, not at the end of the test's two minutes.
test.use({ actionTimeout: 20_000 });

const version = "rastrata-application-v1";
const BOOK_OPERATION = "6b7c8d9e-0f1a-4b2c-9d3e-4f5a6b7c8d9e";
const setup = {
  name: "Entries Co",
  currency: "USD",
  fiscalYear: 2026,
  periodModel: "monthly",
  accounts: [
    { code: "1000", name: "Business checking", role: "asset", tags: { cashFlowClass: "cash" } },
    { code: "1100", name: "Business savings", role: "asset", tags: { cashFlowClass: "cash" } },
    { code: "2000", name: "Business credit card", role: "liability" },
    { code: "3000", name: "Owner's investment", role: "equity" },
    { code: "3100", name: "Owner's draw", role: "equity" },
    { code: "4000", name: "Sales", role: "income" },
    { code: "5000", name: "Software and subscriptions", role: "expense" },
    { code: "5100", name: "Meals", role: "expense" },
    { code: "5200", name: "Office supplies", role: "expense" },
  ],
};

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

/** The entries in the books with one status. */
const entries = async (request: APIRequestContext, status = "Posted"): Promise<Json[]> =>
  (await api(request, "journal.list", { status })).entries as Json[];

/** The entry for an amount: each test posts amounts of its own. */
async function entryFor(
  request: APIRequestContext,
  amount: string,
  status = "Posted",
): Promise<Json> {
  const found = (await entries(request, status)).find((entry) => entry.amount === amount);
  expect(found, `an entry for ${amount}`).toBeDefined();
  return found as Json;
}

const balances = async (request: APIRequestContext): Promise<Record<string, string>> =>
  Object.fromEntries(
    ((await api(request, "accounts.list", {})).accounts as Json[]).map((account) => [
      account.id,
      account.balance,
    ]),
  );

/** What an entry's lines say, as [account, debit, credit]. */
const linesOf = (entry: Json): (string | null)[][] =>
  entry.lines.map((line: Json) => [line.accountId, line.debit, line.credit]);

/** Choose an account in the dialog's picker from the keyboard: focus it, type, move to the match, choose it. */
async function choose(dialog: Locator, label: string, text: string) {
  const input = dialog.getByRole("combobox", { name: label });
  await input.focus();
  await input.fill(text);
  await input.press("ArrowDown");
  await input.press("Enter");
  // The list closes and the box takes focus back a moment after the choice; wait for that, or the next
  // field's text would be typed into this one.
  await expect(input).toHaveAttribute("aria-expanded", "false");
  await expect(input).toBeFocused();
}

/** Open one of the dialogs the way a link to it does, and wait until the chart has been read. */
async function opened(page: Page, action: "spend" | "receive" | "transfer", title: string) {
  const chart = page.waitForResponse((response) => response.url().includes("/v1/accounts.list"));
  await page.goto(`/?new=${action}`);
  // The three are one form, "New transaction", with a switch at its top: it opens on the kind asked for.
  const dialog = page.getByRole("dialog", { name: "New transaction" });
  await expect(dialog).toBeVisible();
  await expect(
    dialog
      .getByRole("radiogroup", { name: "Kind of transaction" })
      .getByRole("radio", { name: title, exact: true }),
  ).toBeChecked();
  await chart;
  return dialog;
}

/** What the entry will record, line by line, as the dialog says it. */
const saying = (dialog: Locator) =>
  dialog.getByRole("region", { name: "This will record" }).getByRole("listitem");

test("the book is set up, and Spend money is recorded from the keyboard", async ({
  page,
  request,
}) => {
  const errors: string[] = [];
  page.on("pageerror", (error) => errors.push(error.message));
  await api(request, "book.setup", setup, BOOK_OPERATION);

  // "+ New" lists one thing for money, Transaction: the form for money out, in or between accounts.
  await page.goto("/");
  await page.getByRole("button", { name: /New/ }).click();
  // What opens a form over the page is an item with no address; what goes to a page is a link.
  const money = page.getByRole("menu").locator('[role="menuitem"]:not([href])');
  await expect(money.first()).toBeVisible();
  expect(await money.allInnerTexts()).toEqual(["Transaction"]);
  await page.keyboard.press("Escape");

  const dialog = await opened(page, "spend", "Spend money");
  // Focus starts in the dialog, on the date, and the date starts today (or the calendar's last day).
  await expect(dialog.getByLabel("Date")).toBeFocused();
  await expect(dialog.getByLabel("Date")).not.toHaveValue("");
  await choose(dialog, "Paid from", "Business check");
  await dialog.getByLabel("Paid to").fill("Notion Labs");
  await choose(dialog, "Category", "Software");
  await dialog.getByLabel("Amount").fill("25");
  await expect(saying(dialog)).toHaveText(
    [
      `Software and subscriptions +${shown.money("25.00")}`,
      `Business checking ${shown.money("-25.00")}`,
    ],
    { useInnerText: true },
  );
  // Enter in the last field posts, as it does in any form.
  await dialog.getByLabel("Description").fill("Notion, monthly");
  await dialog.getByLabel("Description").press("Enter");

  // The dialog closes, a toast says what was posted, and the books hold an ordinary two-line entry.
  await expect(dialog).toBeHidden();
  await expect(
    page.getByText(`Posted: ${shown.money("25.00")} spent on Software and subscriptions.`),
  ).toBeVisible();
  const entry = await entryFor(request, "25.00");
  expect(entry).toMatchObject({
    status: "Posted",
    reference: "Notion Labs",
    description: "Notion, monthly",
  });
  expect(linesOf(entry)).toEqual([
    ["5000", "25.00", null],
    ["1000", null, "25.00"],
  ]);
  expect(await balances(request)).toMatchObject({ "1000": "-25.00", "5000": "25.00" });
  expect(errors).toEqual([]);
});
test("Receive money and Transfer are ordinary entries too, and read back in plain words", async ({
  page,
  request,
}) => {
  const received = await opened(page, "receive", "Receive money");
  await choose(received, "Deposit to", "Business check");
  await received.getByLabel("Received from").fill("Northwind LLC");
  await choose(received, "Category", "Sales");
  await received.getByLabel("Amount").fill("1,250.5");
  // The amount is read as typed and shown the way every figure is; the bank and the income both go up.
  await expect(saying(received)).toHaveText(
    [`Business checking +${shown.money("1250.50")}`, `Sales +${shown.money("1250.50")}`],
    { useInnerText: true },
  );
  await received.getByRole("button", { name: "Post" }).click();
  await expect(received).toBeHidden();
  const income = await entryFor(request, "1250.50");
  expect(income).toMatchObject({ reference: "Northwind LLC" });
  expect(linesOf(income)).toEqual([
    ["1000", "1250.50", null],
    ["4000", null, "1250.50"],
  ]);

  const transfer = await opened(page, "transfer", "Transfer");
  await choose(transfer, "From", "Business check");
  await choose(transfer, "To", "Business sav");
  await transfer.getByLabel("Amount").fill("500");
  await expect(saying(transfer)).toHaveText(
    [`Business savings +${shown.money("500.00")}`, `Business checking ${shown.money("-500.00")}`],
    { useInnerText: true },
  );
  await transfer.getByRole("button", { name: "Post" }).click();
  await expect(transfer).toBeHidden();
  expect(await entryFor(request, "500.00")).toMatchObject({
    description: "Transfer from Business checking to Business savings",
  });
  expect(await balances(request)).toMatchObject({
    "1000": "725.50",
    "1100": "500.00",
    "4000": "-1250.50",
    "5000": "25.00",
  });
});

test("a stray click outside the dialog keeps what was typed, and Escape closes it and gives focus back to + New", async ({
  page,
}) => {
  await page.goto("/");
  await page.getByRole("button", { name: /New/ }).click();
  await page.getByRole("menuitem", { name: "Transaction", exact: true }).click();
  // It opens on Spend money.
  const dialog = page.getByRole("dialog", { name: "New transaction" });
  await expect(dialog).toBeVisible();
  await dialog.getByLabel("Amount").fill("5");
  await page.mouse.click(4, 4);
  await expect(dialog).toBeVisible();
  // The field lost focus, so the amount reads the way the books will see it.
  await expect(dialog.getByLabel("Amount")).toHaveValue("5.00");
  await page.keyboard.press("Escape");
  await expect(dialog).toBeHidden();
  await expect(page.getByRole("button", { name: /New/ })).toBeFocused();
});

for (const theme of ["light", "dark"] as const)
  for (const size of [
    { width: 1440, height: 800 },
    { width: 390, height: 844 },
  ])
    test(`the dialog and the Business form pass the accessibility scan: ${theme}, ${size.width} px`, async ({
      page,
    }) => {
      await page.setViewportSize(size);
      await page.emulateMedia({ colorScheme: theme });
      await page.addInitScript((value) => localStorage.setItem("rastrata-theme", value), theme);
      const dialog = await opened(page, "spend", "Spend money");
      await scan(page, `Spend money (${theme}, ${size.width})`);
      await dialog.getByRole("button", { name: "Post" }).click();
      await expect(
        dialog.getByRole("region", { name: "Fix these before you continue" }),
      ).toBeVisible();
      await scan(page, `Spend money with its errors (${theme}, ${size.width})`);
      await dialog.getByRole("button", { name: "Cancel" }).click();
      await page.goto("/settings");
      await expect(page.getByLabel("Business name")).toBeVisible();
      await scan(page, `Business settings (${theme}, ${size.width})`);
    });
