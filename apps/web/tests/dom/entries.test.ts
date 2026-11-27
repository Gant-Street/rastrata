import {
  expect,
  test,
  type APIRequestContext,
  type Locator,
  type Page,
} from "./support/playwright";
import type axe from "axe-core";
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

test("the owner presets fill in the category, and are the owner's money and not an expense or income", async ({
  page,
  request,
}) => {
  const out = await opened(page, "spend", "Spend money");
  await out.getByRole("button", { name: "Owner took money out" }).click();
  await expect(out.getByRole("combobox", { name: "Category" })).toHaveValue("Owner's draw");
  await expect(out.getByLabel("Description")).toHaveValue("Owner took money out");
  await expect(out.getByRole("button", { name: "Owner took money out" })).toHaveAttribute(
    "aria-pressed",
    "true",
  );
  await choose(out, "Paid from", "Business check");
  await out.getByLabel("Amount").fill("100");
  await expect(saying(out).first()).toContainText("Owner's draw");
  await out.getByRole("button", { name: "Post" }).click();
  await expect(out).toBeHidden();

  const into = await opened(page, "receive", "Receive money");
  await into.getByRole("button", { name: "Owner put money in" }).click();
  await expect(into.getByRole("combobox", { name: "Category" })).toHaveValue("Owner's investment");
  await choose(into, "Deposit to", "Business check");
  await into.getByLabel("Amount").fill("2000");
  await into.getByRole("button", { name: "Post" }).click();
  await expect(into).toBeHidden();
  // Equity, not expense and not income: the owner's draw is a debit, the investment a credit.
  expect(await balances(request)).toMatchObject({ "3000": "-2000.00", "3100": "100.00" });
  expect(await entryFor(request, "2000.00")).toMatchObject({ description: "Owner put money in" });
  expect(linesOf(await entryFor(request, "100.00"))).toEqual([
    ["3100", "100.00", null],
    ["1000", null, "100.00"],
  ]);
});

test("Save draft keeps the books as they are, and the draft opens where an entry is edited", async ({
  page,
  request,
}) => {
  const before = await balances(request);
  const dialog = await opened(page, "spend", "Spend money");
  await choose(dialog, "Paid from", "Business check");
  await choose(dialog, "Category", "Meals");
  await dialog.getByLabel("Amount").fill("42.50");
  await dialog.getByLabel("Description").fill("Team lunch");
  await dialog.getByRole("button", { name: "Save draft" }).click();
  await expect(dialog).toBeHidden();
  await expect(page.getByText("Draft saved. Nothing in your books has changed.")).toBeVisible();
  expect(await balances(request)).toEqual(before);
  const drafts = await entries(request, "Draft");
  expect(drafts).toHaveLength(1);
  expect(drafts[0]).toMatchObject({ reference: "Team lunch", status: "Draft" });
  // It holds the same two lines Post would have made.
  const saved = await api(request, "drafts.get", { draftId: drafts[0]?.id });
  expect(saved.data).toMatchObject({
    reference: "Team lunch",
    narration: "Team lunch",
    lines: [
      { accountId: "5100", debit: "42.50", credit: "" },
      { accountId: "1000", debit: "", credit: "42.50" },
    ],
  });
  // The toast's action opens it where an entry is edited.
  await page.getByRole("button", { name: "Open draft" }).click();
  await expect(page).toHaveURL(/\/journal\/new\?draft=/);
  // The field is called "Reference (optional)" on the new-entry form: match its name, not the whole label.
  await expect(page.getByLabel(/^Reference\b/)).toHaveValue("Team lunch");
});

test("an empty form says what is missing, links to each field and keeps what was typed", async ({
  page,
}) => {
  const dialog = await opened(page, "spend", "Spend money");
  await dialog.getByLabel("Description").fill("Kept");
  await dialog.getByRole("button", { name: "Post" }).click();
  const summary = dialog.getByRole("region", { name: "Fix these before you continue" });
  await expect(summary).toBeFocused();
  await expect(summary).toContainText("Choose the account you paid from.");
  await expect(summary).toContainText("Choose a category.");
  await expect(summary).toContainText("Enter an amount.");
  await summary.getByRole("link", { name: "Enter an amount." }).click();
  await expect(dialog.getByLabel("Amount")).toBeFocused();
  await summary.getByRole("link", { name: "Choose the account you paid from." }).click();
  await expect(dialog.getByRole("combobox", { name: "Paid from" })).toBeFocused();
  await expect(dialog.getByLabel("Description")).toHaveValue("Kept");

  // A minus sign is refused where it is typed, with what to do about it.
  await dialog.getByLabel("Amount").fill("-5");
  await dialog.getByRole("button", { name: "Post" }).click();
  await expect(
    dialog.getByText("Use dollars and cents, such as 25.00, without a minus sign.").first(),
  ).toBeVisible();
  await dialog.getByRole("button", { name: "Cancel" }).click();
  await expect(dialog).toBeHidden();
});

/** Close or reopen one month through the ordinary prepare and commit path. */
async function changeMonth(
  request: APIRequestContext,
  periodId: string,
  operation: "close" | "reopen",
) {
  const plan = await api(
    request,
    "periods.prepare",
    { periodId, operation, reason: "Reviewed" },
    crypto.randomUUID(),
  );
  const receipt = await api(request, "operations.commit", {
    planId: plan.planId,
    planHash: plan.planHash,
  });
  expect(receipt.disposition).toBe("committed");
}

test("a closed month is refused in the books' words with nothing posted, and posts once it is reopened", async ({
  page,
  request,
}) => {
  await changeMonth(request, "period-03", "close");
  const before = await balances(request);
  const posted = (await entries(request)).length;
  const dialog = await opened(page, "spend", "Spend money");
  await dialog.getByLabel("Date").fill("2026-03-10");
  await choose(dialog, "Paid from", "Business check");
  await choose(dialog, "Category", "Office");
  await dialog.getByLabel("Amount").fill("9.99");
  await dialog.getByRole("button", { name: "Post" }).click();
  const refusal = dialog.getByRole("alert").filter({ hasText: /closed/i });
  await expect(refusal).toBeVisible();
  // The sentence reads whole for a person: the way to reopen is the screen, not an operation name, and its
  // dates read the way every date on a screen does.
  await expect(refusal).not.toContainText("periods.prepare");
  await expect(refusal).toContainText(shown.date("2026-03-31"));
  await expect(refusal).not.toContainText(/\d{4}-\d{2}-\d{2}/);
  expect(await balances(request)).toEqual(before);
  expect(await entries(request)).toHaveLength(posted);

  await changeMonth(request, "period-03", "reopen");
  await dialog.getByRole("button", { name: "Post" }).click();
  await expect(dialog).toBeHidden();
  expect(await entries(request)).toHaveLength(posted + 1);
  expect(await entryFor(request, "9.99")).toMatchObject({ isoDate: "2026-03-10" });
  // The refused attempt left no second draft behind: the entry is the one that was prepared first, and
  // the only draft is still the team lunch.
  expect(await entries(request, "Draft")).toHaveLength(1);
});

test("a date past the calendar posts, and the calendar grows to hold it", async ({
  page,
  request,
}) => {
  const posted = (await entries(request)).length;
  const dialog = await opened(page, "spend", "Spend money");
  await dialog.getByLabel("Date").fill("2027-02-10");
  await choose(dialog, "Paid from", "Business check");
  await choose(dialog, "Category", "Office");
  await dialog.getByLabel("Amount").fill("8.88");
  await dialog.getByRole("button", { name: "Post" }).click();
  // No button to press, no second step: the entry posts, and the calendar now reaches its year.
  await expect(dialog).toBeHidden();
  expect(await entries(request)).toHaveLength(posted + 1);
  expect(await entryFor(request, "8.88")).toMatchObject({ isoDate: "2027-02-10" });
  const { calendar } = (await api(request, "periods.list", {})) as {
    calendar: { lastDate: string };
  };
  expect(calendar.lastDate).toBe("2027-12-31");
});

test("a reply that is lost is resumed once, and the entry is recorded once", async ({
  page,
  request,
}) => {
  const count = (await entries(request)).length;
  const dialog = await opened(page, "spend", "Spend money");
  await choose(dialog, "Paid from", "Business check");
  await choose(dialog, "Category", "Meals");
  await dialog.getByLabel("Amount").fill("12.40");
  // The books commit, and the answer never arrives. A Post is one request, journal.post.
  let dropped = false;
  await page.route("**/v1/journal.post", async (route) => {
    if (dropped) return route.continue();
    dropped = true;
    await route.fetch();
    await route.abort("connectionreset");
  });
  await dialog.getByRole("button", { name: "Post" }).click();
  await expect(dialog.getByText("may not have finished")).toBeVisible();
  await page.unroute("**/v1/journal.post");
  await dialog.getByRole("button", { name: "Resume original request" }).click();
  await expect(dialog).toBeHidden();
  expect(await entries(request)).toHaveLength(count + 1);
  expect(await entryFor(request, "12.40")).toMatchObject({ status: "Posted" });
});

test("a reply lost before a reload is found again in a new dialog and resumed", async ({
  page,
  request,
}) => {
  const count = (await entries(request)).length;
  const dialog = await opened(page, "receive", "Receive money");
  await choose(dialog, "Deposit to", "Business check");
  await choose(dialog, "Category", "Sales");
  await dialog.getByLabel("Amount").fill("75");
  await page.route("**/v1/journal.post", async (route) => {
    await route.fetch();
    await route.abort("connectionreset");
  });
  await dialog.getByRole("button", { name: "Post" }).click();
  await expect(dialog.getByText("may not have finished")).toBeVisible();
  await page.unroute("**/v1/journal.post");
  // Reload: the form is gone, the request is not. A new dialog says so and offers to finish it.
  const again = await opened(page, "receive", "Receive money");
  await expect(again.getByText("may not have finished")).toBeVisible();
  await again.getByRole("button", { name: "Resume original request" }).click();
  await expect(again).toBeHidden();
  expect(await entries(request)).toHaveLength(count + 1);
  expect(await entryFor(request, "75.00")).toMatchObject({ status: "Posted" });
});

test("the page behind the dialog shows the entry once it is posted, without a reload", async ({
  page,
}) => {
  await page.goto("/journal");
  const table = page.getByRole("main").getByRole("table");
  await expect(table).toBeVisible();
  await expect(table).not.toContainText("Behind the dialog");
  const chart = page.waitForResponse((response) => response.url().includes("/v1/accounts.list"));
  await page.getByRole("button", { name: /New/ }).click();
  await page.getByRole("menuitem", { name: "Transaction", exact: true }).click();
  // It opens on Spend money.
  const dialog = page.getByRole("dialog", { name: "New transaction" });
  await expect(dialog).toBeVisible();
  await chart;
  await choose(dialog, "Paid from", "Business check");
  await choose(dialog, "Category", "Office");
  await dialog.getByLabel("Amount").fill("6.66");
  await dialog.getByLabel("Description").fill("Behind the dialog");
  await dialog.getByRole("button", { name: "Post" }).click();
  await expect(dialog).toBeHidden();
  await expect(table).toContainText("Behind the dialog");
});

test("Business settings: the name, the date format, account numbers and what Accept does", async ({
  page,
  request,
}) => {
  await page.goto("/settings");
  await expect(page.getByRole("heading", { level: 1, name: "Business" })).toBeVisible();
  const name = page.getByLabel("Business name");
  await expect(name).toHaveValue("Entries Co");
  const save = page.getByRole("button", { name: "Save changes" });
  // Nothing changed, nothing to save.
  await expect(save).toBeDisabled();
  await name.fill("Willow Lane Studio");
  await expect(save).toBeEnabled();
  // Each choice that needs one shows what it looks like, written by the formatter every screen uses; the
  // year-first choice says what it is in words, because a year-month-day date is not shown as text.
  await page.getByRole("combobox", { name: "Date format" }).click();
  for (const format of ["medium", "numeric"] as const)
    await expect(
      page.getByRole("option", { name: shown.dateAs(format, "2026-03-20"), exact: false }),
    ).toBeVisible();
  await expect(page.getByRole("option", { name: "Year first: year-month-day" })).toBeVisible();
  await page
    .getByRole("option", { name: new RegExp(`Numbers.*${shown.dateAs("numeric", "2026-03-20")}`) })
    .click();
  // The checkbox is a custom control: a person clicks its label.
  await page.getByText("Show account numbers beside account names in lists").click();
  await expect(page.getByRole("checkbox", { name: /Show account numbers/ })).toBeChecked();
  await page.getByRole("combobox", { name: "When I accept a suggestion" }).click();
  await page.getByRole("option", { name: /draft/ }).click();
  await save.click();
  await expect(page.getByRole("status").filter({ hasText: "Saved." })).toBeVisible();
  // The header carries the new name without a reload, and the book holds it.
  await expect(page.getByText("Willow Lane Studio").first()).toBeVisible();
  const book = await api(request, "book.get", {});
  expect(book.setup.name).toBe("Willow Lane Studio");
  expect(book.settings).toEqual({
    dateFormat: "numeric",
    showAccountNumbers: true,
    acceptMode: "draft",
  });
  // It is the book's: a reload shows the same.
  await page.reload();
  await expect(page.getByLabel("Business name")).toHaveValue("Willow Lane Studio");
  await expect(page.getByRole("checkbox", { name: /Show account numbers/ })).toBeChecked();
  await expect(page.getByRole("button", { name: "Save changes" })).toBeDisabled();
  // And every date in the app is written the way it chose: the closed-month test's entry is dated March 10.
  await page.goto("/journal");
  await expect(page.getByRole("main").getByRole("table")).toContainText(
    shown.dateAs("numeric", "2026-03-10"),
  );
});

test("a name that is too short is refused where it is typed, and nothing is sent", async ({
  page,
  request,
}) => {
  await page.goto("/settings");
  await page.getByLabel("Business name").fill("A");
  await page.getByRole("button", { name: "Save changes" }).click();
  await expect(page.getByText("Enter a name of at least two characters.").first()).toBeVisible();
  expect((await api(request, "book.get", {})).setup.name).toBe("Willow Lane Studio");
});
