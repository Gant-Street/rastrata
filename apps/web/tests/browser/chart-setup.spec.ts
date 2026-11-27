import { expect, type Page, test } from "@playwright/test";
import axe from "axe-core";
import { chartRow, openAccount, openAccountDetails, showWholeChart } from "../support/chart";
import { shown } from "../support/shown";
import { pick, putAway } from "../support/pick";
import { chooseRadio } from "../support/accounting";
declare global {
  interface Window {
    axe: typeof axe;
  }
}

// The second test uses the book the first one creates, so the file runs in order in one worker.
test.describe.configure({ mode: "serial" });

const calm = (page: Page) =>
  page.addStyleTag({
    content: "*,*::before,*::after{transition:none!important;animation:none!important}",
  });
const setTheme = (page: Page, value: "light" | "dark") =>
  page.evaluate((theme) => {
    document.documentElement.dataset.theme = theme;
  }, value);

/** Every step, holding real data, passes the automated accessibility scan in both themes. */
async function scan(page: Page, label: string) {
  await calm(page);
  for (const theme of ["light", "dark"] as const) {
    await setTheme(page, theme);
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
  await setTheme(page, "light");
}

const fitsWidth = (page: Page) =>
  page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth);

/** The review step's one Create book, at the foot after the folded chart. */
const createBook = (page: Page) => page.getByRole("button", { name: "Create book", exact: true });

/** The chart is folded under its heading on the review step: open it to look at or edit the accounts. */
async function openChart(page: Page): Promise<void> {
  const toggle = page.getByRole("button", { name: /^Chart of accounts \(\d+ accounts\)$/ });
  if ((await toggle.getAttribute("aria-expanded")) !== "true") await toggle.click();
  await expect(toggle).toHaveAttribute("aria-expanded", "true");
}

test("the setup wizard builds a Schedule C online business, with the keyboard, and the book keeps every tag", async ({
  page,
  request,
  browserName,
}) => {
  test.setTimeout(180_000);
  // The books start in the year the clock gives and nothing asks for it, so the clock is what pins 2026.
  await page.clock.setFixedTime(new Date("2026-04-02T12:00:00"));
  const api = async (name: string, input: unknown = {}) => {
    const response = await request.post(`/v1/${name}`, {
      data: { version: "rastrata-application-v1", bookId: "local-book", input },
    });
    return (await response.json()) as {
      ok: boolean;
      data: Record<string, unknown> & {
        templates: { id: string }[];
        setup: Record<string, unknown>;
        accounts: {
          code: string;
          name: string;
          role: string;
          tags: Record<string, string>;
        }[];
      };
      error?: { code: string };
    };
  };

  await test.step("the templates are readable before any book exists", async () => {
    const list = await api("templates.list");
    expect(list.ok).toBe(true);
    expect(list.data.templates.map((item: { id: string }) => item.id)).toEqual([
      "sole-proprietor",
      "s-corporation",
      "partnership",
      "generic",
    ]);
    expect((await api("accounts.list")).error?.code).toBe("book_not_configured");
  });

  await page.goto("/");
  await expect(page.getByRole("heading", { name: "Set up your books" })).toBeVisible();
  await expect(page.getByRole("heading", { name: "Step 1 of 4: Your business" })).toBeVisible();
  // Before a book exists the header is only the wordmark: no sections, no Search, no New.
  await expect(page.getByRole("link", { name: "Rastrata" })).toBeVisible();
  await expect(page.getByRole("navigation", { name: "Main navigation" })).toHaveCount(0);
  const name = page.getByRole("textbox", { name: "Business name" });

  await test.step("step 1: a missing name is explained, linked from a summary, and keeps what was typed", async () => {
    await name.focus();
    await page.keyboard.press("Enter");
    const summary = page.getByRole("heading", { name: "There is a problem" });
    await expect(summary).toBeVisible();
    await expect(page.getByRole("heading", { name: /Step 1 of 4/ })).toBeVisible();
    await page.getByRole("link", { name: /Enter your business name/ }).click();
    await expect(name).toBeFocused();
    await name.fill("Example Studio LLC");
    await scan(page, "step 1");
    await page.setViewportSize({ width: 390, height: 844 });
    expect(await fitsWidth(page)).toBe(true);
    await page.setViewportSize({ width: 1280, height: 900 });
    // Tab order: the name, the currency, then Continue. Safari does not Tab to buttons unless the person turns
    // that on, and the currency is Ark's select, whose trigger is a button: only the other engines are asked.
    if (browserName !== "webkit") {
      await name.focus();
      await page.keyboard.press("Tab");
      await expect(page.getByRole("combobox", { name: "Currency" })).toBeFocused();
      await page.keyboard.press("Tab");
      await expect(page.getByRole("button", { name: "Continue", exact: true })).toBeFocused();
    }
    await name.focus();
    await page.keyboard.press("Enter");
  });

  await test.step("step 2: the type of business, with the Stripe accounts as an add-on", async () => {
    const heading = page.getByRole("heading", { name: "Step 2 of 4: Type of business" });
    await expect(heading).toBeFocused();
    // The setup's own choices: the theme switch in the footer is a group of radios too.
    const kinds = page.locator("#main").getByRole("radio");
    await expect(kinds).toHaveCount(4);
    // The first choice is selected. The choices are only named: the tax lines are shown, with
    // their notice, on the review step.
    await expect(
      page.getByRole("radio", { name: "Sole proprietor or single-member LLC" }),
    ).toBeChecked();
    for (const name of ["S corporation", "Partnership or multi-member LLC", "Other business"]) {
      await expect(page.getByRole("radio", { name })).not.toBeChecked();
    }
    await expect(page.getByText("Tax form:")).toHaveCount(0);
    const stripe = page.getByRole("checkbox", { name: "I take payments through Stripe" });
    await expect(stripe).not.toBeChecked();
    await stripe.focus();
    await page.keyboard.press("Space");
    await expect(stripe).toBeChecked();
    await scan(page, "step 2");
    await page.getByRole("button", { name: "Continue", exact: true }).click();
  });

  await test.step("step 3: a basis that cannot be changed later, and nothing asked about the calendar", async () => {
    await expect(
      page.getByRole("heading", { name: "Step 3 of 4: Accounting method" }),
    ).toBeFocused();
    await expect(page.getByRole("radio", { name: "Cash" })).toBeChecked();
    await expect(
      page.getByText("Income counts when money arrives and expenses when money leaves."),
    ).toBeVisible();
    await expect(
      page.getByText("You record invoices and bills yourself, as journal entries."),
    ).toBeVisible();
    await expect(
      page.getByText("This cannot be changed after the book is created", { exact: true }),
    ).toBeVisible();
    // The fiscal year is not a question: no field, and no mention of it, on this step.
    await expect(page.getByRole("spinbutton", { name: "First fiscal year" })).toHaveCount(0);
    await expect(page.getByText(/fiscal year/i)).toHaveCount(0);
    await scan(page, "step 3");
    await page.getByRole("button", { name: "Continue", exact: true }).click();
  });

  await test.step("going back and changing the basis rebuilds the chart", async () => {
    await expect(
      page.getByRole("heading", { name: "Step 4 of 4: Review and create" }),
    ).toBeFocused();
    const row = (text: string) => page.locator(".rt-chart-preview-row", { hasText: text });
    await openChart(page);
    await expect(row("1100")).toContainText("Stripe balance");
    await expect(row("1200")).toHaveCount(0);
    await page.getByRole("button", { name: "Back", exact: true }).click();
    await chooseRadio(page, "Accrual");
    await page.getByRole("button", { name: "Continue", exact: true }).click();
    await openChart(page);
    await expect(row("1200")).toContainText("Accounts receivable");
    await expect(row("6000")).toContainText("Advertising and marketing");
    // And back to cash: the receivable has no place in a cash book.
    await page.getByRole("button", { name: "Back", exact: true }).click();
    await chooseRadio(page, "Cash");
    await page.getByRole("button", { name: "Continue", exact: true }).click();
    await openChart(page);
    await expect(row("1200")).toHaveCount(0);
    // No bank or card line is in a chart: those are made from what the person brings.
    await expect(row("1000")).toHaveCount(0);
    await expect(row("2000")).toHaveCount(0);
  });

  await test.step("step 4: the review says when the books start, and nothing about the calendar was asked", async () => {
    await expect(page.getByRole("spinbutton", { name: "First fiscal year" })).toHaveCount(0);
    await expect(page.getByRole("button", { name: /Change/ })).toHaveCount(0);
    await expect(page.getByText("January 2026", { exact: true })).toBeVisible();
    await expect(
      page.getByText("The currency and basis cannot be changed after the book is created."),
    ).toBeVisible();
  });

  await test.step("step 4: the chart is a list to read, each account with its tax line, nothing to edit and nothing internal", async () => {
    await openChart(page);
    const fold = page.locator(".rt-details-body");
    // Two short sentences and the list: which form the lines are on, and that nothing here is final.
    await expect(fold).toContainText(
      "Tax lines are from Schedule C. You can change any account later.",
    );
    await expect(fold).not.toContainText("draft");
    await expect(fold).not.toContainText("tax year");
    await expect(fold).not.toContainText("advice");
    // Nothing to type into, and no internal name: a role key is the program's, never shown to a person.
    await expect(fold.getByRole("textbox")).toHaveCount(0);
    await expect(fold.getByRole("combobox")).toHaveCount(0);
    await expect(page.getByText(/Role: /)).toHaveCount(0);
    const row = (text: string) => page.locator(".rt-chart-preview-row", { hasText: text });
    // 2026 is the year Schedule C splits interest: "Other" interest is line 16c, not 16b.
    await expect(row("Interest expense")).toContainText("Line 16c · Interest: Other");
    await expect(row("Stripe fees")).toContainText("Line 10 · Commissions and fees");
    await expect(row("Software and subscriptions")).toContainText("Line 27b · Other expenses");
    // A balance-sheet account reports on no line.
    await expect(row("Stripe balance")).not.toContainText("Line ");
    await scan(page, "step 4");
    await page.setViewportSize({ width: 390, height: 844 });
    expect(await fitsWidth(page)).toBe(true);
    await page.setViewportSize({ width: 1280, height: 900 });
  });

  await test.step("step 4 is kind to a keyboard: the chart is folded, so Create book is three stops from the heading", async () => {
    const button = createBook(page);
    await expect(button).toHaveCount(1);
    await expect(button).toBeEnabled();
    // Fold the chart again, as a person first sees it: the accounts are out of the way.
    const toggle = page.getByRole("button", { name: /^Chart of accounts/ });
    await toggle.click();
    await expect(toggle).toHaveAttribute("aria-expanded", "false");
    await expect(page.locator(".rt-chart-preview")).toBeHidden();
    // Safari does not Tab to buttons unless the person turns that on.
    if (browserName === "webkit") return;
    await page.getByRole("heading", { name: "Step 4 of 4: Review and create" }).focus();
    let stops = 0;
    while (stops < 5 && !(await button.evaluate((el) => el === document.activeElement))) {
      await page.keyboard.press("Tab");
      stops += 1;
    }
    // The stops between are the chart's heading and Back; nothing in the chart is reached.
    await expect(button).toBeFocused();
    expect(stops).toBeLessThanOrEqual(3);
    await expect(button).toBeInViewport();
    await page.keyboard.press("Shift+Tab");
    await expect(page.getByRole("button", { name: "Back", exact: true })).toBeFocused();
  });

  await test.step("a refusal from the service is shown on the review step, and nothing is retained", async () => {
    await page.route("**/v1/book.setup", async (route) => {
      const body = route.request().postDataJSON() as { operationId: string };
      await route.fulfill({
        status: 400,
        contentType: "application/json",
        body: JSON.stringify({
          version: "rastrata-application-v1",
          bookId: "local-book",
          operationId: body.operationId,
          ok: false,
          error: {
            code: "invalid_tag",
            message: "Account 4000: Gross receipts or sales (line 1) takes an income account.",
            details: [],
            retryable: false,
          },
        }),
      });
    });
    // From the foot, so the refusal that appears above the chart has to be brought into view.
    await createBook(page).click();
    await expect(page.getByText("The book was not created")).toBeVisible();
    await expect(
      page.getByText("Account 4000: Gross receipts or sales (line 1) takes an income account."),
    ).toBeVisible();
    await expect(page.getByText("The book was not created")).toBeInViewport();
    await expect(page.getByRole("button", { name: "Resume original request" })).toHaveCount(0);
    // The person's choices are all still there.
    await expect(page.getByText("Example Studio LLC", { exact: true })).toBeVisible();
    await page.unroute("**/v1/book.setup");
  });

  await test.step("creating the book: a lost reply is resumed, never replaced", async () => {
    await page.route("**/v1/book.setup", async (route) => {
      await route.fetch();
      await route.abort("failed");
    });
    await createBook(page).click();
    await expect(page.getByRole("button", { name: "Resume original request" })).toBeVisible();
    await expect(page.getByRole("heading", { name: "Set up your books" })).toHaveCount(0);
    await page.unroute("**/v1/book.setup");
    await page.reload();
    await page.getByRole("button", { name: "Resume original request" }).click();
    await expect(page.getByRole("heading", { level: 1, name: "Today" })).toBeVisible();
    await expect(page.getByRole("button", { name: "Resume original request" })).toHaveCount(0);
    // With the book made the header grows the sections and says which book this is, without a reload.
    await expect(page.getByRole("navigation", { name: "Main navigation" })).toBeVisible();
    await expect(page.locator(".app-book-name")).toHaveText("Example Studio LLC");
  });

  await test.step("the book has exactly the chart that was reviewed, with every tag", async () => {
    const book = await api("book.get");
    expect(book.data.setup).toMatchObject({
      name: "Example Studio LLC",
      currency: "USD",
      // The calendar starts in 2000 for every book made here; the books begin on the first day of the year.
      fiscalYear: 2000,
      booksStartOn: "2026-01-01",
      fiscalYearStartMonth: 1,
      basis: "cash",
      periodModel: "monthly",
    });
    const list = (await api("accounts.list")).data;
    const rows = new Map(list.accounts.map((account) => [account.code, account] as const));
    const tags = (code: string) => rows.get(code)?.tags;
    // No bank or card account yet: a template carries none, and the person brings theirs.
    expect(rows.has("1000")).toBe(false);
    expect(rows.has("2000")).toBe(false);
    expect(rows.get("6010")?.name).toBe("Car and truck expenses");
    expect(rows.has("6300")).toBe(false);
    expect(tags("1100")).toEqual({ cashFlowClass: "cash", roleKey: "stripe.balance" });
    expect(tags("1110")).toEqual({ cashFlowClass: "cash", roleKey: "payouts.in-transit" });
    expect(tags("2500")).toEqual({ cashFlowClass: "operating", roleKey: "tax.sales" });
    expect(tags("4000")).toEqual({ taxLine: "scheduleC.line1", roleKey: "revenue.sales" });
    expect(tags("4100")).toEqual({ taxLine: "scheduleC.line2", roleKey: "refunds" });
    expect(tags("6025")).toEqual({ taxLine: "scheduleC.line10", roleKey: "stripe.fees" });
    expect(tags("6026")).toEqual({ taxLine: "scheduleC.line27b", roleKey: "chargebacks" });
    expect(tags("5000")).toEqual({ taxLine: "scheduleC.line36" });
    expect(tags("6070")).toEqual({ taxLine: "scheduleC.line16c" });
    expect(tags("6200")).toEqual({ taxLine: "scheduleC.line27b" });
    expect(tags("3000")).toEqual({ cashFlowClass: "financing" });
    expect(tags("3100")).toEqual({ cashFlowClass: "financing" });
    expect(rows.get("3000")?.name).toBe("Owner's investment");
    expect(rows.get("3100")?.name).toBe("Owner's draw");
    // The roles the Stripe connection will map by, each on exactly one account, and the two accounts the book
    // keeps for what fits nowhere else (Other expenses, Other income), which Close the books watches.
    const keys = list.accounts.flatMap((account: { tags: { roleKey?: string } }) =>
      account.tags.roleKey ? [account.tags.roleKey] : [],
    );
    expect([...keys].sort()).toEqual(
      [
        "catchall.expense",
        "catchall.income",
        "chargebacks",
        "payouts.in-transit",
        "refunds",
        "revenue.sales",
        "stripe.balance",
        "stripe.fees",
        "tax.sales",
      ].sort(),
    );
    // Every balance-sheet account is classified and no income or expense account is.
    for (const account of list.accounts as {
      role: string;
      code: string;
      tags: Record<string, string>;
    }[]) {
      const balanceSheet = ["asset", "liability", "equity"].includes(account.role);
      expect(account.tags.cashFlowClass !== undefined, account.code).toBe(balanceSheet);
    }
    const codes = list.accounts.map((account: { code: string }) => account.code);
    expect(codes).toEqual([...codes].sort((a, b) => a.localeCompare(b, "en", { numeric: true })));
  });

  await test.step("a second book cannot be set up over the first", async () => {
    const again = await request.post("/v1/book.setup", {
      data: {
        version: "rastrata-application-v1",
        bookId: "local-book",
        operationId: crypto.randomUUID(),
        input: {
          name: "Different Co",
          currency: "USD",
          fiscalYear: 2026,
          periodModel: "monthly",
          accounts: [
            { code: "1000", name: "Cash", role: "asset" },
            { code: "3000", name: "Capital", role: "equity" },
          ],
        },
      },
    });
    expect(again.status()).toBe(409);
  });

  await test.step("Home is the start of a new book: one thing to do, and every link leads somewhere", async () => {
    await page.reload();
    await expect(page.locator(".rt-today")).toHaveAttribute("data-read", "");
    const start = page.locator(".rt-start");
    // Nothing has come in yet: adding the bank is the one thing to do, with one main button, and the way in
    // for a person moving from another system is one quiet line.
    await expect(start.getByRole("heading", { level: 2 })).toBeVisible();
    await expect(page.locator("#main .rt-button[data-variant='primary']")).toHaveCount(1);
    await expect(
      start.getByRole("link", { name: "Bring in your books", exact: true }),
    ).toHaveAttribute("href", "/settings/bring-in");
    // No list of setup steps, no empty section, and a new book is not a list of warnings.
    await expect(page.getByText("Finish setting up")).toHaveCount(0);
    await expect(page.locator(".rt-need, .rt-inout, .rt-tiles")).toHaveCount(0);
    // Every link of the start leads to a screen that exists in this version, never to "not found".
    const hrefs = await Promise.all(
      (await start.getByRole("link").all()).map(
        async (link) => (await link.getAttribute("href")) ?? "",
      ),
    );
    expect(hrefs.length).toBeGreaterThanOrEqual(3);
    for (const href of new Set(hrefs)) {
      await page.goto(href);
      await expect(page.getByRole("heading", { level: 1 }).first()).toBeVisible();
      await expect(page.getByRole("heading", { name: "Page not found" }), href).toHaveCount(0);
    }
    await page.goto("/");
    await expect(start).toBeVisible();
    await scan(page, "home at the start of a new book");
    await page.setViewportSize({ width: 390, height: 844 });
    expect(await fitsWidth(page)).toBe(true);
    await page.setViewportSize({ width: 1280, height: 900 });
  });

  await test.step("the person's own bank accounts and card are added on the chart, with their kind", async () => {
    await page.goto("/accounts");
    const add = async (kind: "bank" | "card", code: string, name: string) => {
      await page.getByRole("button", { name: "New account" }).click();
      const drawer = page.getByRole("dialog", { name: "New account" });
      await drawer.getByRole("textbox", { name: "Name" }).fill(name);
      await pick(page, drawer.getByLabel("Type"), { value: kind });
      await drawer.getByRole("textbox", { name: "Code" }).fill(code);
      await drawer.getByRole("button", { name: "Add account" }).click();
      await expect(
        page.getByRole("status").filter({ hasText: `Added ${code} ${name}.` }),
      ).toBeVisible();
    };
    await add("bank", "1000", "Operating account");
    await add("bank", "1010", "Payroll account");
    await add("card", "2000", "Travel card");
    const list = (await api("accounts.list")).data;
    const tags = (code: string) => list.accounts.find((account) => account.code === code)?.tags;
    expect(tags("1000")).toEqual({ cashFlowClass: "cash", kind: "bank" });
    expect(tags("2000")).toEqual({ cashFlowClass: "operating", kind: "card" });
  });
});

test("the Accounts screen shows every tag, finds accounts, and edits tags from a date", async ({
  page,
  request,
}) => {
  test.setTimeout(180_000);
  const api = async (name: string, input: unknown = {}, operationId?: string) => {
    const response = await request.post(`/v1/${name}`, {
      data: {
        version: "rastrata-application-v1",
        bookId: "local-book",
        input,
        ...(operationId ? { operationId } : {}),
      },
    });
    return (await response.json()) as {
      ok: boolean;
      data: {
        planId: string;
        planHash: string;
        disposition: string;
        accounts: { code: string; tags: object }[];
        events: { tag: string; value: string | null; effectiveOn: string; source: string }[];
      };
      error?: { code: string; message: string };
    };
  };
  // The chart lists an account by its name; its code and its tags are in its tag editor and in the books.
  const NAMES: Readonly<Record<string, string>> = {
    "1000": "Operating account",
    "1100": "Stripe balance",
    "4000": "Sales",
    "6000": "Advertising and marketing",
    "6025": "Stripe fees",
    "6200": "Software and subscriptions",
    "6400": "Podcast hosting",
    "6500": "Miscellaneous",
  };
  const row = (code: string) => chartRow(page, NAMES[code] ?? code);
  const tagsOf = async (code: string) =>
    ((await api("accounts.list")).data.accounts as { code: string; tags: object }[]).find(
      (account) => account.code === code,
    )?.tags;
  /** The tag editor of an account: its own page, Account details, then Edit tags. */
  const editTags = async (name: string) => {
    await openAccount(page, name);
    await openAccountDetails(page);
    await page.getByRole("button", { name: "Edit tags", exact: true }).click();
  };
  const history = async (id: string) =>
    (await api("accounts.tagHistory", { accountId: id })).data.events as {
      tag: string;
      value: string | null;
      effectiveOn: string;
      source: string;
    }[];

  await page.goto("/accounts");
  await expect(page.getByRole("heading", { level: 1, name: "Accounts" })).toBeVisible();

  await test.step("the chart is one line a kind, and an account's row is its name and its balance", async () => {
    await expect(page.locator(".rt-chart-group-name")).toHaveText([
      /^Assets \(\d+\)/,
      /^Liabilities \(\d+\)/,
      /^Equity \(\d+\)/,
      /^Income \(\d+\)/,
      /^Expenses \(\d+\)/,
    ]);
    // No column of codes, types or tax lines, and no switch for more columns.
    await expect(page.getByRole("columnheader", { name: /Code|Type|Tax line/ })).toHaveCount(0);
    await expect(page.getByRole("checkbox")).toHaveCount(0);
    await showWholeChart(page);
    await expect(row("1100")).toContainText("Stripe balance");
    await expect(row("1100")).not.toContainText("stripe.balance");
    // Nothing under the chart names a form's year or its draft status, and nothing disclaims.
    await expect(page.getByText(/Tax lines are named/)).toHaveCount(0);
    await expect(page.getByText(/not tax advice|draft form/)).toHaveCount(0);
    // Money is right-aligned, in tabular figures.
    const balance = row("1100").locator("td.amount");
    expect(await balance.evaluate((cell) => getComputedStyle(cell).textAlign)).toMatch(/end|right/);
    expect(await balance.evaluate((cell) => getComputedStyle(cell).fontVariantNumeric)).toContain(
      "tabular-nums",
    );
  });

  await test.step("every tag is in words in the account's tag editor, and in the books", async () => {
    await editTags("Stripe balance");
    const dialog = page.getByRole("dialog", { name: "Edit tags" });
    await expect(dialog.getByLabel("Cash-flow class")).toHaveAttribute("data-value", "cash");
    await expect(dialog.getByLabel("Role key")).toHaveValue("stripe.balance");
    await page.keyboard.press("Escape");
    await expect(dialog).toHaveCount(0);
    expect(await tagsOf("1590")).toMatchObject({ cashFlowClass: "noncash" });
    expect(await tagsOf("6000")).toMatchObject({ taxLine: "scheduleC.line8" });
    expect(await tagsOf("6070")).toMatchObject({ taxLine: "scheduleC.line16c" });
    expect(await tagsOf("6200")).toMatchObject({ taxLine: "scheduleC.line27b" });
    expect(await tagsOf("4000")).toMatchObject({ taxLine: "scheduleC.line1" });
  });

  await test.step("a search finds accounts by name, code and tax line, and says when nothing matches", async () => {
    await page.goto("/accounts");
    await expect(page.locator(".rt-chart-groups")).toBeVisible();
    const search = page.getByRole("searchbox", { name: "Search accounts" });
    await page.locator("body").click({ position: { x: 5, y: 5 } });
    await page.keyboard.press("/");
    await expect(search).toBeFocused();
    await search.fill("stripe");
    await expect(row("1100")).toBeVisible();
    await expect(row("6025")).toBeVisible();
    await expect(row("1000")).toHaveCount(0);
    // By the words of its tax line, and by its code.
    await search.fill("advertising");
    await expect(row("6000")).toBeVisible();
    await expect(row("6025")).toHaveCount(0);
    await search.fill("4000");
    await expect(row("4000")).toBeVisible();
    await expect(row("6000")).toHaveCount(0);
    await search.fill("zzzz");
    await expect(page.getByText("No accounts match")).toBeVisible();
    await expect(page.locator(".rt-chart-groups")).toHaveCount(0);
    await search.fill("");
    await expect(page.locator(".rt-chart-group-head")).toHaveCount(5);
  });

  await test.step("a new account is added in a drawer with its tags, and an untagged one says so", async () => {
    const add = async (code: string, name: string, taxLine?: string) => {
      await page.getByRole("button", { name: "New account" }).click();
      const drawer = page.getByRole("dialog", { name: "New account" });
      await drawer.getByRole("textbox", { name: "Name" }).fill(name);
      await pick(page, drawer.getByLabel("Type"), { value: "expense" });
      await drawer.getByRole("textbox", { name: "Code" }).fill(code);
      if (taxLine) await pick(page, drawer.getByLabel("Tax line (optional)"), { value: taxLine });
      await drawer.getByRole("button", { name: "Advanced" }).click();
      await drawer.getByLabel("Starts on").fill("2026-02-01");
      // The form is the review: it says what adding will do, and the button adds the account.
      await expect(drawer).toContainText(`This adds ${code} ${name} as an Expense.`);
      await drawer.getByRole("button", { name: "Add account" }).click();
      await expect(
        page.getByRole("status").filter({ hasText: `Added ${code} ${name}.` }),
      ).toBeVisible();
    };
    // A new account has nothing in it: its kind opens and lists it, so it is seen where it now lives.
    await add("6400", "Podcast hosting", "scheduleC.line18");
    await expect(row("6400")).toBeVisible();
    expect(await tagsOf("6400")).toEqual({ taxLine: "scheduleC.line18" });
    // One with no tags.
    await add("6500", "Miscellaneous");
    await expect(row("6500")).toBeVisible();
    expect(await tagsOf("6500")).toEqual({});
  });

  await test.step("editing tags from a date, with the keyboard, keeps the earlier tag for earlier dates", async () => {
    // On the account's own page, under Account details, from the keyboard.
    await openAccount(page, "Software and subscriptions");
    await openAccountDetails(page);
    const open = page.getByRole("button", { name: "Edit tags", exact: true });
    await open.focus();
    await page.keyboard.press("Enter");
    const dialog = page.getByRole("dialog", { name: "Edit tags" });
    await expect(dialog).toBeVisible();
    await expect(
      dialog.getByRole("heading", { name: "History of this account's tags" }),
    ).toBeVisible();
    await expect(dialog.getByText(/Tax line: Schedule C line 27b · Other expenses/)).toBeVisible();
    await expect(dialog.getByText("Set when the book was created.")).toBeVisible();
    // Only the tag that applies to an expense is offered, and only lines that take an expense.
    await expect(dialog.getByLabel("Cash-flow class")).toHaveCount(0);
    await dialog.getByLabel("Tax line", { exact: true }).click();
    await expect(page.getByRole("option").first()).toBeVisible();
    const lines = await page.getByRole("option").allTextContents();
    expect(lines.some((text) => text.startsWith("Line 27b"))).toBe(true);
    expect(lines.some((text) => text.startsWith("Line 1 ·"))).toBe(false);
    await putAway(page);
    await pick(page, dialog.getByLabel("Tax line", { exact: true }), { value: "scheduleC.line18" });
    await dialog.getByLabel("Effective from").fill("2026-07-01");
    await dialog.getByRole("button", { name: "Save tags" }).click();
    await expect(dialog.getByText("Tags saved")).toBeVisible();
    await expect(
      dialog.getByText(`The tags apply from ${shown.date("2026-07-01")}.`),
    ).toBeVisible();
    await expect(dialog.getByText(/Tax line: Schedule C line 18 · Office expense/)).toBeVisible();
    expect(
      (await history("6200")).map((event) => [event.source, event.value, event.effectiveOn]),
    ).toEqual([
      // The tags a book is created with take effect from the first day of its calendar (2000 here), so
      // an entry from any year since can use them.
      ["setup", "scheduleC.line27b", "2000-01-01"],
      ["change", "scheduleC.line18", "2026-07-01"],
    ]);
    // Saving what is already in force is said plainly, and records nothing.
    await dialog.getByRole("button", { name: "Save tags" }).click();
    await expect(dialog.getByText("Nothing changed")).toBeVisible();
    expect(await history("6200")).toHaveLength(2);
    await scan(page, "tag editor");
    await page.keyboard.press("Escape");
    await expect(dialog).toHaveCount(0);
    // Focus returns to the button that opened it, and the books hold the new tag.
    await expect(open).toBeFocused();
    expect(await tagsOf("6200")).toMatchObject({ taxLine: "scheduleC.line18" });
  });

  await test.step("a role key is held by one account, and a refusal changes nothing", async () => {
    await editTags("Operating account");
    const dialog = page.getByRole("dialog", { name: "Edit tags" });
    await expect(dialog.getByLabel("Cash-flow class")).toHaveAttribute("data-value", "cash");
    await dialog.getByLabel("Role key").fill("Not A Key");
    await dialog.getByRole("button", { name: "Save tags" }).click();
    await expect(
      dialog.getByRole("link", { name: /Use lower-case words joined by dots or hyphens/ }),
    ).toBeVisible();
    await dialog.getByLabel("Role key").fill("stripe.balance");
    await dialog.getByRole("button", { name: "Save tags" }).click();
    await expect(dialog.getByText("The tags were not saved")).toBeVisible();
    await expect(dialog.getByText(/Role key stripe\.balance is on account 1100/)).toBeVisible();
    await expect(dialog.getByRole("button", { name: "Resume original request" })).toHaveCount(0);
    expect(await tagsOf("1000")).toEqual({ cashFlowClass: "cash", kind: "bank" });
    await page.keyboard.press("Escape");
  });

  await test.step("a lost reply is resumed, never replaced, and applies exactly once", async () => {
    await editTags("Advertising and marketing");
    const dialog = page.getByRole("dialog", { name: "Edit tags" });
    await pick(page, dialog.getByLabel("Tax line", { exact: true }), { value: "scheduleC.line22" });
    await dialog.getByLabel("Effective from").fill("2026-08-01");
    await page.route("**/v1/accounts.setTags", async (route) => {
      await route.fetch();
      await route.abort("failed");
    });
    await dialog.getByRole("button", { name: "Save tags" }).click();
    await expect(dialog.getByText("The result of the last save is not known")).toBeVisible();
    await expect(dialog.getByRole("button", { name: "Save tags" })).toBeDisabled();
    await page.unroute("**/v1/accounts.setTags");
    await page.reload();
    const waiting = page.getByRole("status").filter({ hasText: "A tag change is waiting" });
    await expect(waiting).toBeVisible();
    await waiting.getByRole("button", { name: "Resume original request" }).click();
    await expect(page.getByText("Tag change saved.")).toBeVisible();
    expect(await tagsOf("6000")).toMatchObject({ taxLine: "scheduleC.line22" });
    expect(
      (await history("6000")).filter((event) => event.effectiveOn === "2026-08-01"),
    ).toHaveLength(1);
  });

  await test.step("a change that reaches a closed period is warned about before and after saving", async () => {
    const close = await api(
      "periods.prepare",
      { periodId: "period-2026-01", operation: "close", reason: "January reviewed" },
      crypto.randomUUID(),
    );
    expect(close.ok).toBe(true);
    const committed = await api("operations.commit", {
      planId: close.data.planId,
      planHash: close.data.planHash,
    });
    expect(committed.data.disposition).toBe("committed");
    await page.reload();
    await editTags("Advertising and marketing");
    const dialog = page.getByRole("dialog", { name: "Edit tags" });
    // A different line from the one in force then (8), so the change is real and reaches January.
    await pick(page, dialog.getByLabel("Tax line", { exact: true }), { value: "scheduleC.line18" });
    await dialog.getByRole("button", { name: /Use the date the account opened/ }).click();
    await expect(dialog.getByLabel("Effective from")).toHaveValue(shown.dateBox("2026-01-01"));
    await expect(dialog.getByText("This date reaches a closed period")).toBeVisible();
    await expect(
      dialog.getByText(`January (${shown.range("2026-01-01", "2026-01-31")})`),
    ).toBeVisible();
    await dialog.getByRole("button", { name: "Save tags" }).click();
    await expect(dialog.getByText(/closed period/).last()).toBeVisible();
    await expect(dialog.getByText("Tags saved")).toBeVisible();
    // A date after the closed period carries no warning.
    await dialog.getByRole("button", { name: "Use today" }).click();
    await expect(dialog.getByText("This date reaches a closed period")).toHaveCount(0);
    await scan(page, "tag editor with a closed period");
    await page.keyboard.press("Escape");
  });

  await test.step("the screens pass the accessibility scan and fit a phone", async () => {
    await page.goto("/accounts");
    await showWholeChart(page);
    await scan(page, "accounts");
    await page.setViewportSize({ width: 390, height: 844 });
    expect(await fitsWidth(page)).toBe(true);
    await editTags("Stripe balance");
    await scan(page, "an account's page with its tag editor open");
    await expect(page.getByRole("dialog", { name: "Edit tags" })).toBeVisible();
    expect(await fitsWidth(page)).toBe(true);
    await page.keyboard.press("Escape");
    await page.setViewportSize({ width: 1280, height: 900 });
  });
});

test("Close the books asks nothing of months that hold nothing", async ({ page, request }) => {
  // The book has nothing posted and January was closed by the test before; every ended month after it holds
  // nothing. A month nothing was recorded in is not something to close: it closes with the next month that
  // holds something, or with the year. So the page has no card and no button for them.
  const listed = await request.post("/v1/periods.list", {
    data: { version: "rastrata-application-v1", bookId: "local-book", input: {} },
  });
  const { periods } = (await listed.json()).data as {
    periods: {
      label: string;
      status: string;
      ended: boolean;
      empty: boolean;
      beforeBooks?: boolean;
    }[];
  };
  const run = periods.filter(
    (period) => period.status === "open" && !period.beforeBooks && period.ended,
  );
  expect(run.length).toBeGreaterThan(1);
  expect(run.every((period) => period.empty)).toBe(true);

  await page.goto("/periods");
  await expect(page.locator("#rt-close-through")).toHaveText(
    `Books are closed through ${shown.date("2026-01-31")}.`,
  );
  await expect(page.locator(".rt-close-card")).toHaveCount(0);
  await expect(page.getByRole("button", { name: /^Close (through )?[A-Z]/ })).toHaveCount(0);
  await expect(page.getByRole("button", { name: "Closed months (1)" })).toBeVisible();
  await scan(page, "close the books, nothing to close");
});
