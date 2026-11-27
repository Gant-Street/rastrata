import { expect, test, type Page } from "@playwright/test";
import axe from "axe-core";
import { chooseRadio, fillReverse, openReverse, setChecked } from "../support/accounting";
import { entryBar, fillEntry, postEntry } from "../support/entry-form";
import { shown } from "../support/shown";
import { pick } from "../support/pick";
declare global {
  interface Window {
    axe: typeof axe;
  }
}

/** The list of all transactions is a tab of Transactions, the Chart of accounts is where Accounts opens,
 * and Close the books is a page of Settings: open the place (on a phone, from the Menu), then the tab or
 * the entry of the Settings list. Reports is a place of its own. */
async function openFromNav(page: Page, name: "Journal" | "Accounts" | "Periods") {
  const nav = page.getByRole("navigation", { name: "Main navigation" });
  const menu = nav.getByRole("button", { name: "Menu" });
  if (await menu.isVisible()) await menu.click();
  if (name === "Accounts") {
    await nav.getByRole("link", { name: "Accounts", exact: true }).click();
    return;
  }
  if (name === "Journal") {
    // The place carries the number waiting for review beside its name when there is one.
    await nav.getByRole("link", { name: /^Transactions/ }).click();
    await page
      .getByRole("navigation", { name: "Show transactions" })
      .getByRole("link", { name: "All", exact: true })
      .click();
    return;
  }
  await nav.getByRole("link", { name: "Settings", exact: true }).click();
  await page
    .getByRole("navigation", { name: "Settings", exact: true })
    .getByRole("link", { name: "Close the books", exact: true })
    .click();
}

/** A journal entry starts from "+ New", the one place that starts things from any page. On a phone the Menu
 * holds the same list, so that is what opens first. */

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

async function newJournalEntry(page: Page) {
  const nav = page.getByRole("navigation", { name: "Main navigation" });
  const menu = nav.getByRole("button", { name: "Menu" });
  // On a phone it is a link in the Menu; on a wide screen, an item of the New menu.
  if (await menu.isVisible()) {
    await menu.click();
    await nav.getByRole("link", { name: "Journal entry", exact: true }).click();
  } else {
    await nav.getByRole("button", { name: "New", exact: true }).click();
    await nav.getByRole("menuitem", { name: "Journal entry", exact: true }).click();
  }
  await expect(page).toHaveURL(/\/journal\/new$/);
}

test("a fresh local book is created through the browser and remains after reload", async ({
  page,
  request,
}) => {
  // It drives a book through every screen and takes about 25 s alone; give it room on a shared machine.
  test.setTimeout(90_000);
  /** The application's API, the way an import or an agent uses it beside the browser. */
  const api = async (name: string, input: unknown, operationId?: string) => {
    const response = await request.post(`/v1/${name}`, {
      data: {
        version: "rastrata-application-v1",
        bookId: "local-book",
        input,
        ...(operationId ? { operationId } : {}),
      },
    });
    expect(response.ok()).toBe(true);
    return (await response.json()).data;
  };
  // The books start in the year the clock gives and nothing asks for it: this book is dated in 2026, whatever today is.
  await page.clock.setFixedTime(new Date("2026-04-02T12:00:00"));
  await page.goto("/");
  // The setup wizard: the generic chart has 3000, 4000 and 5000; the bank account 1000 this flow posts to is
  // added on the chart once the book exists, as a person adds their own.
  await expect(page.getByRole("heading", { name: "Set up your books" })).toBeVisible();
  await page.getByRole("textbox", { name: "Business name" }).fill("Example Co");
  await page.getByRole("button", { name: "Continue", exact: true }).click();
  await chooseRadio(page, "Other business");
  await page.getByRole("button", { name: "Continue", exact: true }).click();
  await page.getByRole("button", { name: "Continue", exact: true }).click();
  await expect(page.getByRole("heading", { name: /Step 4 of 4/ })).toBeVisible();
  // Every browser workflow retains an exact write before dispatch.
  const loseReply = async (path: string, action: () => Promise<void>) => {
    await page.route(`**/v1/${path}`, async (route) => {
      await route.fetch();
      await route.abort("failed");
    });
    await action();
    await expect(page.getByRole("button", { name: "Resume original request" })).toBeVisible();
    await page.unroute(`**/v1/${path}`);
    await page.reload();
    await page.getByRole("button", { name: "Resume original request" }).click();
    await expect(page.getByRole("button", { name: "Resume original request" })).toHaveCount(0);
  };
  await loseReply("book.setup", () =>
    page.getByRole("button", { name: "Create book", exact: true }).first().click(),
  );
  await expect(page.locator(".app-book-name")).toHaveText("Example Co");
  // The bank account this flow posts to: a template carries none, so it is added on the chart, as a person adds their own.
  await page.goto("/accounts");
  await page.getByRole("button", { name: "New account" }).click();
  const newAccount = page.getByRole("dialog", { name: "New account" });
  await newAccount.getByRole("textbox", { name: "Name" }).fill("Cash");
  await pick(page, newAccount.getByLabel("Type"), { value: "bank" });
  await newAccount.getByRole("textbox", { name: "Code" }).fill("1000");
  await newAccount.getByRole("button", { name: "Add account" }).click();
  await expect(page.getByRole("status").filter({ hasText: "Added 1000 Cash." })).toBeVisible();
  await page.goto("/");
  await page.reload();
  await expect(page.locator(".app-book-name")).toHaveText("Example Co");
  await page.route("**/v1/journal.list", (route) =>
    route.fulfill({
      status: 503,
      contentType: "application/json",
      body: '{"error":"Unavailable"}',
    }),
  );
  await openFromNav(page, "Journal");
  await expect(page.getByRole("heading", { name: "Transactions", exact: true })).toBeVisible();
  await expect(page.getByText("Transactions are unavailable")).toBeVisible();
  await page.unroute("**/v1/journal.list");
  await page.getByRole("button", { name: "Try again" }).click();
  // An empty list offers a link to the form.
  await page.getByRole("link", { name: "New journal entry" }).click();
  await fillEntry(page, {
    reference: "TEMP-1",
    lines: [
      { code: "1000", debit: "5.00" },
      { code: "3000", credit: "5.00" },
    ],
  });
  await entryBar(page).getByRole("button", { name: "Save draft" }).click();
  await expect(page.getByRole("status").filter({ hasText: "Draft saved" })).toBeVisible();
  await openFromNav(page, "Journal");
  await page.getByRole("link", { name: "TEMP-1" }).first().click();
  await expect(page.getByRole("textbox", { name: /^Reference/ })).toHaveValue("TEMP-1");
  await page.getByRole("textbox", { name: /^Reference/ }).fill("TEMP-EDIT");
  await entryBar(page).getByRole("button", { name: "Save draft" }).click();
  await expect(page.getByRole("status").filter({ hasText: "Draft saved" })).toBeVisible();
  await entryBar(page).getByRole("button", { name: "Discard draft" }).click();
  await expect(page.getByRole("heading", { name: "Transactions", exact: true })).toBeVisible();
  await expect(page.getByRole("link", { name: "TEMP-EDIT" })).toHaveCount(0);
  await page.goto("/journal/new?opening=1");
  await expect(page.getByRole("heading", { name: "Record opening balances" })).toBeVisible();
  // An entry typed by hand records nothing that happened elsewhere: the form has no fold for a source.
  await expect(
    page.getByRole("button", { name: /Where this entry came from|duplicate protection/i }),
  ).toHaveCount(0);
  await fillEntry(page, {
    reference: "OPEN-1",
    description: "Owner contribution",
    lines: [
      { code: "1000", debit: "1000.00" },
      { code: "3000", credit: "1000.00" },
    ],
  });
  await postEntry(page);
  await expect(page.getByRole("heading", { name: "Transactions", exact: true })).toBeVisible();
  await expect(page.getByRole("table")).toContainText("OPEN-1");
  await page.reload();
  await expect(page.getByRole("table")).toContainText("OPEN-1");
  // An entry that records an event the books know (a bank transaction, an invoice) carries its source;
  // an import or an agent makes it so, through the API. The ledger then refuses to book the event twice.
  const accounts = (await api("accounts.list", {})).accounts as { id: string; code: string }[];
  const idOf = (code: string) => accounts.find((account) => account.code === code)?.id ?? code;
  const draft = await api(
    "drafts.create",
    {
      data: {
        date: "2026-01-15",
        reference: "OWNER-1",
        narration: "Owner contribution from the bank",
        source: {
          id: "owner-contribution-browser",
          description: "Owner contributed USD 1000 on 2026-01-15",
          evidenceReference: "receipt-browser",
        },
        lines: [
          { accountId: idOf("1000"), debit: "1000.00", credit: "" },
          { accountId: idOf("3000"), debit: "", credit: "1000.00" },
        ],
      },
    },
    crypto.randomUUID(),
  );
  const plan = await api(
    "journal.prepare",
    { draftId: draft.id, expectedVersion: 1 },
    crypto.randomUUID(),
  );
  await api("operations.commit", { planId: plan.planId, planHash: plan.planHash });
  await page.reload();
  await expect(page.getByRole("table")).toContainText("OWNER-1");
  // The description is the way into the entry.
  await page
    .getByRole("row", { name: /OWNER-1/ })
    .getByRole("link")
    .first()
    .click();
  // The machine detail (the source event and its fingerprint) is under Details.
  await page.getByRole("button", { name: "Details", exact: true }).click();
  await expect(page.getByRole("region", { name: "Source provenance" })).toContainText(
    "owner-contribution-browser",
  );
  await page.screenshot({ path: test.info().outputPath("source-provenance.png") });
  // From there the form opens for the source: where the entry came from, in the source's own words,
  // with its record; nothing to type.
  await page.getByRole("link", { name: "Inspect source event" }).click();
  await expect(page.getByRole("button", { name: "Where this entry came from" })).toHaveAttribute(
    "aria-expanded",
    "true",
  );
  await expect(page.getByRole("region", { name: "Source record" })).toContainText(
    "Source status: posted",
  );
  await expect(page.getByText("receipt-browser")).toBeVisible();
  await expect(page.getByRole("textbox", { name: /Source|Evidence/ })).toHaveCount(0);
  await page
    .locator(".rt-entry-source-fold")
    .screenshot({ path: test.info().outputPath("source-inspector.png") });
  await fillEntry(page, {
    reference: "DUPLICATE-OWNER",
    description: "The same event again",
    lines: [
      { code: "1000", debit: "1000.00" },
      { code: "3000", credit: "1000.00" },
    ],
  });
  await entryBar(page).getByRole("button", { name: "Post", exact: true }).click();
  await expect(page.getByRole("alert")).toContainText("already posted");
  // The refused draft was saved on the way, so the record is read again on request.
  await page.getByRole("button", { name: "Inspect source", exact: true }).click();
  await expect(page.getByRole("region", { name: "Source record" })).toContainText(
    "Source status: posted",
  );
  await entryBar(page).getByRole("button", { name: "Discard draft" }).click();
  for (const entry of [
    { reference: "REV-1", first: "1000", second: "4000", debit: "200.00", credit: "200.00" },
    { reference: "EXP-1", first: "5000", second: "1000", debit: "50.00", credit: "50.00" },
  ]) {
    await newJournalEntry(page);
    // A new entry starts today; these are dated on the book's first day, which the steps below use.
    await fillEntry(page, {
      date: "2026-01-01",
      reference: entry.reference,
      description: entry.reference,
      lines: [
        { code: entry.first, debit: entry.debit },
        { code: entry.second, credit: entry.credit },
      ],
    });
    await postEntry(page);
    await expect(page.getByRole("table")).toContainText(entry.reference);
  }
  await page.getByRole("searchbox", { name: "Search transactions" }).fill("EXP-1");
  await expect(page.getByRole("table", { name: "Transactions" })).toContainText("EXP-1");
  await expect(page.getByRole("table", { name: "Transactions" })).not.toContainText("REV-1");
  await page.getByRole("searchbox", { name: "Search transactions" }).fill("");
  await expect(page.getByRole("table", { name: "Transactions" })).toContainText("REV-1");
  // Reports: one statement at a time, each from the same pinned population. Cash holds the two
  // contributions of 1,000.00 (OPEN-1 by hand, OWNER-1 from the API) plus the sale less the expense.
  await page.getByRole("link", { name: "Reports" }).click();
  await page.getByRole("link", { name: "Profit and loss", exact: true }).click();
  await expect(page.getByRole("heading", { name: "Profit and loss", level: 1 })).toBeVisible();
  await expect(page.getByRole("region", { name: /^Profit and loss/ })).toContainText("150.00");
  await openReport(page, "Balance sheet");
  await expect(page.getByRole("region", { name: /^Balance sheet/ })).toContainText("2,150.00");
  await openReport(page, "Trial balance");
  await expect(
    page.getByRole("region", { name: /^Trial balance/ }).getByRole("row", { name: /1000\s+Cash/ }),
  ).toContainText("2,150.00");
  await openFromNav(page, "Journal");
  // Reversing is a row action: a date and a reason, and it is posted in the same step.
  const reversing = await openReverse(page, "EXP-1");
  await fillReverse(reversing, { date: "2026-01-17", reason: "Entered in error" });
  await loseReply("operations.commit", () =>
    reversing.getByRole("button", { name: "Reverse transaction" }).click(),
  );
  await expect(page.getByRole("status").filter({ hasText: /\S/ })).toContainText("Reversal posted");
  await page.getByRole("link", { name: "Reports" }).click();
  await page.getByRole("link", { name: "Profit and loss", exact: true }).click();
  await expect(page.getByRole("region", { name: /^Profit and loss/ })).toContainText("200.00");
  await openReport(page, "Trial balance");
  await expect(
    page.getByRole("region", { name: /^Trial balance/ }).getByRole("row", { name: /1000\s+Cash/ }),
  ).toContainText("2,200.00");
  await openFromNav(page, "Accounts");
  await page.getByRole("button", { name: "New account" }).click();
  const adding = page.getByRole("dialog", { name: "New account" });
  await adding.getByRole("textbox", { name: "Name" }).fill("Savings");
  await pick(page, adding.getByLabel("Type"), { value: "bank" });
  await adding.getByRole("textbox", { name: "Code" }).fill("1100");
  // The form is the review: Add account has the service check the account and adds it in the same step. The
  // reply to the check is lost; the original request is resumed after a reload, and the account is added once.
  await loseReply("accounts.prepareCreate", () =>
    adding.getByRole("button", { name: "Add account" }).click(),
  );
  await expect(page.getByRole("status").filter({ hasText: "Added 1100 Savings." })).toBeVisible();
  // The chart is folded by kind, and an account with nothing in it is counted under its kind: a search finds it.
  const chart = page.locator(".rt-chart-groups");
  const searchAccounts = page.getByRole("searchbox", { name: "Search accounts" });
  await searchAccounts.fill("Savings");
  await expect(chart).toContainText("Savings");
  // Rename it and close it on its own page; the reply to the commit is lost this time, and resumed there.
  await chart.getByRole("link", { name: "Savings", exact: true }).click();
  await expect(page.getByRole("heading", { level: 1, name: "Savings" })).toBeVisible();
  await page.getByRole("button", { name: "Account details", exact: true }).click();
  await page.getByRole("button", { name: "Edit account", exact: true }).click();
  const editing = page.getByRole("dialog", { name: "Edit account" });
  await editing.getByRole("textbox", { name: "Name" }).fill("Reserve cash");
  await setChecked(editing, "Close this account", true);
  await editing.getByRole("button", { name: "Advanced" }).click();
  await editing.getByLabel("Takes effect on").fill("2026-01-19");
  await loseReply("operations.commit", () =>
    editing.getByRole("button", { name: "Close account" }).click(),
  );
  await page.goto("/accounts");
  await searchAccounts.fill("Reserve cash");
  await expect(chart).toContainText("Reserve cash");
  await expect(chart).toContainText(`Closed ${shown.date("2026-01-19")}`);
  await openFromNav(page, "Periods");
  await expect(page.getByText("Nothing is closed yet.")).toBeVisible();
  // Close the books asks for what stands in the way of January first (a reconciliation this book has not had,
  // a backup that has been checked), so this month is closed through the service, as another client would.
  const service = async (name: string, input: unknown) => {
    const response = await request.post(`/v1/${name}`, {
      data: {
        version: "rastrata-application-v1",
        bookId: "local-book",
        input,
        operationId: crypto.randomUUID(),
      },
    });
    expect(response.ok(), `${name}: ${await response.text()}`).toBe(true);
    return (await response.json()).data;
  };
  const closing = await service("periods.prepare", {
    periodId: "period-2026-01",
    operation: "close",
    reason: "January reviewed",
  });
  await service("operations.commit", { planId: closing.planId, planHash: closing.planHash });
  await page.reload();
  await expect(
    page.getByText(`Books are closed through ${shown.date("2026-01-31")}.`),
  ).toBeVisible();
  await openFromNav(page, "Journal");
  await newJournalEntry(page);
  await fillEntry(page, {
    date: "2026-01-20",
    reference: "LATE-1",
    description: "Late receipt",
    lines: [
      { code: "1000", debit: "10.00" },
      { code: "4000", credit: "10.00" },
    ],
  });
  await postEntry(page);
  // The month is closed: it is said, with the way forward, and nothing was posted.
  await expect(page.getByRole("alert")).toContainText(/period|closed/i);
  await expect(page).toHaveURL(/\/journal\/new/);
  await openFromNav(page, "Periods");
  await page.getByRole("button", { name: /^Closed months/ }).click();
  await page.getByRole("button", { name: "Reopen January 2026" }).click();
  await page.getByLabel("Reason for change").fill("Late receipt found");
  // Reopening is reviewed: the reply to each of its two requests is lost, and each is resumed after a reload.
  await loseReply("periods.prepare", () =>
    page.getByRole("button", { name: "Review change" }).click(),
  );
  await expect(page.getByRole("button", { name: "Commit period change" })).toBeEnabled();
  await loseReply("operations.commit", () =>
    page.getByRole("button", { name: "Commit period change" }).click(),
  );
  await expect(
    page.getByRole("status").filter({ hasText: "January 2026 is open again." }),
  ).toBeVisible();
  await page.getByRole("button", { name: "Calendar and history" }).click();
  await expect(page.getByRole("list", { name: "Period change history" })).toContainText(
    "Late receipt found",
  );
  await page.getByRole("link", { name: "Reports" }).click();
  await openReport(page, "Trial balance");
  await page
    .getByRole("region", { name: /^Trial balance/ })
    .getByRole("link", { name: /activity for 1000 Cash/ })
    .first()
    .click();
  await expect(page.getByRole("heading", { level: 1, name: "Cash" })).toBeVisible();
  await expect(page.getByRole("row", { name: /Totals for this period/ })).toBeVisible();
  await expect(page.getByRole("region", { name: /^Transactions of / })).toContainText("2,200.00");
  await page
    .getByRole("region", { name: /^Transactions of / })
    .getByRole("link")
    .first()
    .click();
  await expect(page.getByRole("heading", { level: 1, name: /^No\. \d+/ })).toBeVisible();
  // The header, the two lines and the total.
  await expect(page.getByRole("region", { name: "Entry lines" }).getByRole("row")).toHaveCount(4);
  // Every real page, holding real data, passes the automated accessibility scan in both themes.
  const scan = async (label: string) => {
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
  for (const theme of ["light", "dark"] as const) {
    for (const route of [
      "/",
      "/journal",
      "/journal/new",
      "/accounts",
      "/periods",
      "/reports?asOf=2026-01-31",
    ]) {
      await page.goto(route);
      await expect(page.getByRole("heading", { level: 1 })).toBeVisible();
      await page.evaluate((value) => {
        document.documentElement.dataset.theme = value;
      }, theme);
      // A scan must not sample colors in the middle of the theme change's short transition.
      await page.addStyleTag({
        content: "*,*::before,*::after{transition:none!important;animation:none!important}",
      });
      await scan(`${route} (${theme})`);
    }
  }
  await page.setViewportSize({ width: 320, height: 844 });
  for (const destination of ["Accounts", "Periods", "Reports", "Journal"] as const) {
    // On a phone every section is in the Menu, and the tabs of a section are a row under the header.
    if (destination === "Reports") {
      await page.getByRole("button", { name: "Menu" }).click();
      await page.getByRole("link", { name: "Reports", exact: true }).click();
    } else {
      await openFromNav(page, destination);
    }
    await expect
      .poll(() => page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth))
      .toBe(true);
  }
  // The pointer rests where the last click was, and a button lifts by two pixels when it is hovered, so a
  // button that appears under the edge of the pointer never holds still. Park the pointer out of the way.
  await page.mouse.move(0, 0);
  await newJournalEntry(page);
  await expect
    .poll(() => page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth))
    .toBe(true);
  const csv = await request.post("/v1/reports.export", {
    data: {
      version: "rastrata-application-v1",
      bookId: "local-book",
      input: { statement: "trial-balance", asOf: "2026-12-31" },
    },
  });
  expect(csv.ok()).toBe(true);
  const file = (await csv.json()).data;
  expect(file.mediaType).toContain("text/csv");
  expect(file.content).toContain("2200.00");
  const status = await request.get("/api/book");
  expect(status.ok()).toBe(true);
  const created = (await status.json()).setup.accounts as { code: string; name: string }[];
  // The book was set up from the template alone: the bank account came afterwards, as a person adds their own.
  expect(created.some((account) => account.code === "1000")).toBe(false);
  expect(created.some((account) => account.code === "6999")).toBe(false);
  expect(created.length).toBeGreaterThan(20);
  const second = await request.post("/api/book/setup", {
    data: {
      name: "Different Co",
      currency: "USD",
      fiscalYear: 2026,
      periodModel: "monthly",
      accounts: [
        { code: "1000", name: "Cash", role: "asset" },
        { code: "3000", name: "Owner capital", role: "equity" },
      ],
    },
  });
  expect(second.status()).toBe(409);

  // A second client advances the book between browser review and commit.
  const pinned = await api("reports.get", { asOf: "2026-01-31" });
  await page.goto("/journal/new");
  // A new entry starts today; this one is dated inside the pinned report's window.
  await fillEntry(page, {
    date: "2026-01-12",
    reference: "RECOVERY-1",
    description: "Recovery entry",
    lines: [
      { code: "1000", debit: "3.00" },
      { code: "3000", credit: "3.00" },
    ],
  });
  // Post saves the entry, has the ledger check it and commits it in one step. Hold the commit, so another
  // client can advance the book between the plan and its commit, as it can between a person's look and click.
  let release: () => void = () => undefined;
  const held = new Promise<void>((resolve) => {
    release = resolve;
  });
  await page.route("**/v1/operations.commit", async (route) => {
    await held;
    await route.continue();
  });
  const preparing = page.waitForResponse("**/v1/journal.prepare");
  await postEntry(page);
  const oldPlan = (await (await preparing).json()).data;
  const draftId = new URL(page.url()).searchParams.get("draft");
  const otherDraft = await api(
    "drafts.create",
    {
      data: {
        date: "2026-01-15",
        reference: "CONCURRENT",
        narration: "Other client",
        lines: [
          { accountId: "1000", debit: "1.00", credit: "" },
          { accountId: "3000", debit: "", credit: "1.00" },
        ],
      },
    },
    crypto.randomUUID(),
  );
  const otherPlan = await api(
    "journal.prepare",
    { draftId: otherDraft.id, expectedVersion: otherDraft.version },
    crypto.randomUUID(),
  );
  await api("operations.commit", { planId: otherPlan.planId, planHash: otherPlan.planHash });
  release();
  await expect(page.getByRole("button", { name: "Recover for editing" })).toBeVisible();
  await page.unroute("**/v1/operations.commit");
  const rejected = await api("operations.commit", {
    planId: oldPlan.planId,
    planHash: oldPlan.planHash,
  });
  expect(rejected.disposition).toBe("rejected");
  // Drop replies after dispatch, then reload and resume their original requests.
  await page.route("**/v1/drafts.recover", async (route) => {
    await route.fetch();
    await route.abort("failed");
  });
  await page.getByRole("button", { name: "Recover for editing" }).click();
  await expect(page.getByRole("button", { name: "Resume original request" })).toBeVisible();
  await page.unroute("**/v1/drafts.recover");
  await page.reload();
  await page.getByRole("button", { name: "Resume original request" }).click();
  await expect(page.getByRole("status").filter({ hasText: "Draft recovered" })).toBeVisible();
  expect((await api("drafts.get", { draftId })).version).toBe(2);
  // The recovered entry is changed and posted again; the commit's reply is lost and the request is resumed.
  await page.getByRole("textbox", { name: /^Description/ }).fill("Reviewed recovered entry");
  await loseReply("operations.commit", () => postEntry(page));
  await expect(page.getByRole("heading", { name: "Transactions", exact: true })).toBeVisible();
  const posted = await api("journal.list", { status: "Posted", text: "RECOVERY-1" });
  expect(posted.count).toBe(1);
  expect(
    await api("operations.commit", { planId: oldPlan.planId, planHash: oldPlan.planHash }),
  ).toEqual(rejected);
  expect((await api("reports.get", { asOf: "2026-01-31" })).balanceSheet.assets).toBe("2204.00");
  expect(
    (await api("reports.get", { asOf: pinned.asOf, revision: pinned.bookRevision })).populationHash,
  ).toBe(pinned.populationHash);
});
