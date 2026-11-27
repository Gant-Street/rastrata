import { readFileSync } from "node:fs";
import { expect, test, type Page } from "@playwright/test";
import axe from "axe-core";
import { fillReverse, openReverse } from "../support/accounting";
import { shown } from "../support/shown";
declare global {
  interface Window {
    axe: typeof axe;
  }
}

// One fresh book, driven the way a person would: a bank statement, reconciled from the keyboard,
// finished, voided. Every write goes through the real local API.
const version = "rastrata-application-v1";
test.describe.configure({ mode: "serial" });

const setup = {
  name: "Reconcile Co",
  currency: "USD",
  fiscalYear: 2026,
  periodModel: "monthly",
  accounts: [
    { code: "1000", name: "Checking", role: "asset" },
    { code: "3000", name: "Capital", role: "equity" },
    { code: "4000", name: "Sales", role: "income" },
    { code: "5000", name: "Expense", role: "expense" },
  ],
};

test("a statement is reconciled from the keyboard, finished, then voided with a reason", async ({
  page,
  request,
}) => {
  const errors: string[] = [];
  page.on("pageerror", (error) => errors.push(error.message));
  const api = async (name: string, input: unknown, operationId?: string) => {
    const response = await request.post(`/v1/${name}`, {
      data: { version, bookId: "local-book", input, ...(operationId ? { operationId } : {}) },
    });
    const body = await response.json();
    expect(body.ok, JSON.stringify(body.error)).toBe(true);
    return body.data;
  };
  const post = async (date: string, narration: string, lines: [string, string, string][]) => {
    const draft = await api(
      "drafts.create",
      {
        data: {
          date,
          reference: narration,
          narration,
          lines: lines.map(([accountId, debit, credit]) => ({ accountId, debit, credit })),
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
    return draft.id as string;
  };
  await api("book.setup", setup, crypto.randomUUID());
  await post("2026-01-02", "Owner contribution", [
    ["1000", "1000.00", ""],
    ["3000", "", "1000.00"],
  ]);
  await post("2026-01-05", "Invoice 1042 paid", [
    ["1000", "250.00", ""],
    ["4000", "", "250.00"],
  ]);
  await post("2026-01-09", "Office supplies", [
    ["5000", "40.10", ""],
    ["1000", "", "40.10"],
  ]);
  await post("2026-01-20", "Software subscription", [
    ["5000", "19.90", ""],
    ["1000", "", "19.90"],
  ]);

  // Nothing reconciled yet. (The account is not marked as a bank account, so Home asks for nothing: an
  // account becomes one to reconcile once it is reconciled, connected or imported into.) Reconcile is
  // reached from Accounts, and offers to start.
  await page.goto("/");
  await expect(page.locator(".rt-today")).toHaveAttribute("data-read", "");
  await expect(page.locator('[data-need="reconcile"]')).toHaveCount(0);
  await page.goto("/reconcile");
  await expect(page.getByRole("heading", { name: "Reconcile", level: 1 })).toBeVisible();
  await expect(page.getByText("No accounts to reconcile yet")).toBeVisible();
  await expect(page.getByText("All reconciled")).toHaveCount(0);
  await expect(
    page.getByText("Check an account against the statement your bank sent.", { exact: true }),
  ).toBeVisible();

  // "Reconcile an account" opens a small form. Starting with a bad balance explains itself and keeps
  // what was typed.
  await page.getByRole("button", { name: "Reconcile an account" }).click();
  const form = page.getByRole("dialog", { name: "Reconcile an account" });
  const account = form.getByRole("combobox", { name: /^Account/ });
  await expect(account).toBeFocused();
  // The whole form is filled from the keyboard: type to find the account, arrow and Enter to choose it,
  // and Enter in the balance field starts it.
  await page.keyboard.type("Checking");
  await page.keyboard.press("ArrowDown");
  await page.keyboard.press("Enter");
  await expect(account).toHaveValue(/Checking/);
  // The box takes focus back a frame after the choice: wait for that frame, or the next field's text is typed
  // into the box on a busy machine.
  await page.evaluate(
    () =>
      new Promise<void>((resolve) =>
        requestAnimationFrame(() => requestAnimationFrame(() => resolve())),
      ),
  );
  await form.getByLabel("Statement end date").fill("2026-01-31");
  await form.getByLabel("Statement ending balance").click();
  await page.keyboard.type("1209.9");
  await page.keyboard.press("Enter");
  await expect(form.getByRole("heading", { name: "Check the statement details" })).toBeVisible();
  await expect(form.getByLabel("Statement ending balance")).toHaveValue("1209.9");
  // The statement shows 1,209.90: it leaves out the software subscription still outstanding.
  await form.getByLabel("Statement ending balance").fill("1209.90");
  await form.getByLabel("Statement ending balance").press("Enter");
  await expect(page).toHaveURL(/\/reconcile\/[0-9a-f-]{36}$/);
  // The title names the account, nothing more; the figures stay in view while the transactions scroll.
  await expect(page.getByRole("heading", { name: "Checking", level: 1 })).toBeFocused();
  await expect(page.getByRole("region", { name: "Reconciliation figures" })).toBeInViewport();

  const difference = page.locator(".rt-recon-difference-figure");
  await expect(difference).toHaveText("1,209.90");
  await expect(page.getByRole("button", { name: "Finish reconciliation" })).toBeDisabled();
  await expect(page.getByText("You can finish when the difference is exactly 0.00.")).toBeVisible();
  const moneyOut = page.getByRole("region", { name: "Money out" });
  const moneyIn = page.getByRole("region", { name: "Money in" });
  await expect(moneyOut.getByRole("row")).toHaveCount(3); // header and two lines
  await expect(moneyIn.getByRole("row")).toHaveCount(3);

  // The keyboard does everything. "/" finds a line; with one match, Enter ticks it.
  await page.locator("body").press("/");
  await expect(page.getByLabel("Find a transaction")).toBeFocused();
  await page.keyboard.type("40.10");
  await page.keyboard.press("Enter");
  await expect(difference).toHaveText("1,250.00");
  await expect(
    page.getByRole("status").filter({ hasText: "Ticked 40.10 Office supplies" }),
  ).toBeAttached();
  await page.keyboard.type("1000.00");
  await page.keyboard.press("Enter");
  await expect(difference).toHaveText("250.00");
  // Move through a column with j and k, tick with space (the native checkbox) and with x.
  const incomeBox = moneyIn.getByRole("checkbox", { name: /Invoice 1042 paid/ });
  await incomeBox.focus();
  await page.keyboard.press("x");
  await expect(difference).toHaveText("0.00");
  await expect(page.getByText("Balanced. Ready to finish.")).toBeVisible();
  // The saved state is honest: Finish waits until the ticks are stored.
  await expect(page.getByText("All changes saved.")).toBeVisible();
  await expect(page.getByRole("button", { name: "Finish reconciliation" })).toBeEnabled();
  await page.screenshot({ path: test.info().outputPath("reconcile-balanced.png"), fullPage: true });

  // One cent in either direction cannot finish: untick, then the difference is that line exactly.
  await moneyIn.getByRole("checkbox", { name: /Invoice 1042 paid/ }).focus();
  await page.keyboard.press("Space");
  await expect(difference).toHaveText("250.00");
  await expect(page.getByRole("button", { name: "Finish reconciliation" })).toBeDisabled();
  await page.keyboard.press("Space");
  await expect(difference).toHaveText("0.00");
  await expect(page.getByText("All changes saved.")).toBeVisible();

  // The ticks are stored: a reload shows the same lines ticked and the same difference.
  await page.reload();
  await expect(page.locator(".rt-recon-difference-figure")).toHaveText("0.00");
  await expect(page.getByRole("checkbox", { name: /Invoice 1042 paid/ })).toBeChecked();
  await expect(page.getByRole("checkbox", { name: /Software subscription/ })).not.toBeChecked();

  // Finishing asks first; Cancel, the safe choice, has focus.
  await page.getByRole("button", { name: "Finish reconciliation" }).click();
  const dialog = page.getByRole("alertdialog", { name: "Finish this reconciliation?" });
  await expect(dialog).toBeVisible();
  await expect(dialog.getByRole("button", { name: "Cancel" })).toBeFocused();
  await expect(dialog).toContainText("3 transactions add up to the statement balance of 1,209.90");
  await page.keyboard.press("Escape");
  await expect(dialog).toBeHidden();
  await page.getByRole("button", { name: "Finish reconciliation" }).click();
  await dialog.getByRole("button", { name: "Finish reconciliation" }).click();
  await expect(
    page.getByRole("status").filter({ hasText: "Reconciliation completed." }),
  ).toBeVisible();
  await expect(page.getByRole("heading", { name: "Money out" })).toBeVisible();
  await expect(page.getByRole("checkbox")).toHaveCount(0); // a record is read-only
  // The record's fingerprint is machine detail: it is under Details, readable and copyable.
  await expect(page.locator(".rt-recon-hash")).toHaveCount(0);
  await page.getByRole("button", { name: "Details" }).click();
  await expect(page.getByText(/^[0-9a-f]{64}$/)).toBeVisible();
  // Under Details too: the books' own count of changes the record was finished against.
  await expect(page.getByText("Book revision", { exact: true })).toBeVisible();

  // What the statement did not show yet is on the page, with the sum that gets from the statement to the books.
  const notYet = page.getByRole("region", { name: "Not yet on the statement" });
  await expect(notYet).toBeVisible();
  await expect(notYet.getByRole("row", { name: /Software subscription/ })).toContainText("19.90");
  await expect(notYet.getByText("Statement balance", { exact: true })).toBeVisible();
  await expect(notYet.getByText("Plus 1 transaction not yet on it")).toBeVisible();
  await expect(notYet.getByText(`Your books on ${shown.date("2026-01-31")}`)).toBeVisible();
  await expect(notYet).toContainText("1,209.90");
  await expect(notYet).toContainText("1,190.00");
  await expect(notYet.getByRole("link", { name: /View entry/ })).toHaveAttribute(
    "href",
    /^\/journal\/.+\?revision=\d+$/,
  );

  // Download report, from the keyboard alone: the file is the service's, with a byte order mark added so that
  // a spreadsheet reads it right.
  await page.getByRole("button", { name: "Download report" }).focus();
  const saving = page.waitForEvent("download");
  await page.keyboard.press("Enter");
  const file = await saving;
  expect(file.suggestedFilename()).toBe("reconciliation-1000-2026-01-31.csv");
  const saved = readFileSync(await file.path(), "utf8");
  expect(saved.startsWith("\ufeffReport,Reconciliation report")).toBe(true);
  for (const row of [
    "Statement balance,1209.90",
    "Outstanding total,-19.90",
    "Books on the statement date,1190.00",
    "Difference,0.00",
    "Status,completed",
  ])
    expect(saved).toContain(row);
  expect(saved).toContain("outstanding,2026-01-20,");
  // Said where a person looks, and announced politely once, from the live region that is always there.
  await expect(page.locator(".rt-recon-report-saved")).toHaveText(
    "Saved reconciliation-1000-2026-01-31.csv. It opens in any spreadsheet.",
  );
  await expect(
    page.getByRole("status").filter({ hasText: "Saved reconciliation-1000-2026-01-31.csv" }),
  ).toBeAttached();
  await page.screenshot({ path: test.info().outputPath("reconcile-record.png"), fullPage: true });

  // Reconcile now says when the account was last checked, and what is left.
  await page.goto("/reconcile");
  const row = page.getByRole("table", { name: "Accounts" }).getByRole("row", { name: /^Checking/ });
  await expect(row).toContainText(shown.date("2026-01-31"));
  await expect(row).toContainText("1 transaction");
  // Home now shows the account, which is one to reconcile from here on, and does not ask for January's.
  await page.getByRole("link", { name: "Home", exact: true }).click();
  await expect(page.locator(".rt-today")).toHaveAttribute("data-read", "");
  await expect(
    page.locator(".rt-bank-tile").getByRole("link", { name: "Checking", exact: true }),
  ).toBeVisible();
  await expect(page.locator('[data-need="reconcile"]')).toHaveCount(0);
  await page.screenshot({ path: test.info().outputPath("home.png"), fullPage: true });

  // The reversal of a reconciled entry carries a warning in its review, and can still be posted.
  await page.goto("/journal");
  const reversing = await openReverse(page, "Office supplies");
  await fillReverse(reversing, { date: "2026-02-02", reason: "Entered twice" });
  await reversing.getByRole("button", { name: "Reverse transaction" }).click();
  await expect(reversing.getByText("Check before you reverse")).toBeVisible();
  await expect(
    reversing.getByText(
      `already reconciled: 1000 Checking, statement ending ${shown.date("2026-01-31")}`,
    ),
  ).toBeVisible();
  await expect(reversing.getByRole("button", { name: "Reverse anyway" })).toBeEnabled();

  // Voiding needs a reason, appends a record and keeps the history.
  await page.goto("/reconcile");
  await page
    .getByRole("link", { name: shown.date("2026-01-31") })
    .first()
    .click();
  await page.getByRole("button", { name: "Void reconciliation" }).click();
  const voidDialog = page.getByRole("dialog", { name: "Void this reconciliation?" });
  await voidDialog.getByRole("button", { name: "Void reconciliation" }).click();
  await expect(voidDialog.getByText("Enter a reason.")).toBeVisible();
  await voidDialog.getByRole("textbox", { name: /Reason/ }).fill("Wrong statement balance");
  await voidDialog.getByRole("button", { name: "Void reconciliation" }).click();
  await expect(page.getByText("This reconciliation was voided")).toBeVisible();
  await expect(page.getByText("Wrong statement balance", { exact: true })).toBeVisible();
  await page.screenshot({ path: test.info().outputPath("voided-record.png"), fullPage: true });
  // A voided record is still reported on: the page still says what was not yet on the statement, and the file
  // says it was voided, and why.
  await expect(
    page.getByRole("region", { name: "Not yet on the statement" }).getByRole("row", {
      name: /Software subscription/,
    }),
  ).toBeVisible();
  const voidedSave = page.waitForEvent("download");
  await page.getByRole("button", { name: "Download report" }).click();
  const voidedFile = readFileSync(await (await voidedSave).path(), "utf8");
  expect(voidedFile).toContain("Status,voided");
  expect(voidedFile).toContain("Void reason,Wrong statement balance");
  expect(voidedFile).toContain("Outstanding total,-19.90");
  await page.goto("/reconcile");
  await expect(page.getByRole("table", { name: "Reconciliations" })).toContainText("Voided");
  expect(errors).toEqual([]);
});

async function scan(page: Page, label: string) {
  // Each navigation starts a new document, so settle colours on this one: axe reads the colours a
  // theme change is still transitioning through otherwise.
  await page.addStyleTag({
    content: "*,*::before,*::after{transition:none!important;animation:none!important}",
  });
  await page.addScriptTag({ content: axe.source });
  const violations = await page.evaluate(async () =>
    (
      await window.axe.run(document.body, {
        runOnly: { type: "tag", values: ["wcag2a", "wcag2aa", "wcag21aa"] },
      })
    ).violations.map(({ id, nodes }) => ({ id, targets: nodes.map((node) => node.target) })),
  );
  expect(violations, label).toEqual([]);
}

test("a lost reply stops the screen and resuming sends the original request, never a new one", async ({
  page,
  request,
}) => {
  // The book from the first test is still here: start another statement for the same account.
  const draft = await (
    await request.post("/v1/reconcile.start", {
      data: {
        version,
        bookId: "local-book",
        operationId: crypto.randomUUID(),
        input: { accountId: "1000", statementDate: "2026-01-31", statementBalance: "1209.90" },
      },
    })
  ).json();
  expect(draft.ok).toBe(true);
  await page.goto(`/reconcile/${draft.data.id}`);
  await expect(page.locator(".rt-recon-difference-figure")).toHaveText("1,209.90");
  let sent = 0;
  await page.route("**/v1/reconcile.setCleared", async (route) => {
    sent += 1;
    await route.fetch();
    await route.abort("failed");
  });
  await page.getByRole("button", { name: "Select all transactions" }).click();
  await expect(page.getByText("The last change may not have been saved")).toBeVisible();
  await expect(page.getByRole("button", { name: "Finish reconciliation" })).toBeDisabled();
  await expect(page.getByRole("button", { name: "Select all transactions" })).toBeDisabled();
  await expect(page.getByText("All changes saved.")).toHaveCount(0);
  await page.unroute("**/v1/reconcile.setCleared");
  await page.reload();
  // After a reload the retained request is still there, exactly as it was.
  await expect(page.getByText("The last change may not have been saved")).toBeVisible();
  await page.getByRole("button", { name: "Resume original request" }).click();
  await expect(page.getByText("The last change may not have been saved")).toHaveCount(0);
  await expect(page.getByText("All changes saved.")).toBeVisible();
  expect(sent).toBe(1);
  // The service applied it once: all four lines are ticked (they add up to 1,190.00), so the
  // statement, which leaves out the outstanding subscription, is 19.90 higher.
  await expect(page.locator(".rt-recon-difference-figure")).toHaveText("19.90");
  await expect(page.getByRole("checkbox", { name: /Software subscription/ })).toBeChecked();
});

test("a second window that changed the draft is a conflict, not a silent overwrite", async ({
  browser,
  page,
}) => {
  await page.goto("/reconcile");
  await page
    .getByRole("link", { name: /^Continue/ })
    .first()
    .click();
  await expect(page.locator(".rt-recon-difference-figure")).toBeVisible();
  const other = await browser.newPage();
  await other.goto(page.url());
  await expect(other.locator(".rt-recon-difference-figure")).toBeVisible();
  await other.getByRole("button", { name: "Clear all" }).click();
  await expect(other.getByText("All changes saved.")).toBeVisible();
  await page.getByRole("checkbox", { name: /Software subscription/ }).focus();
  await page.keyboard.press("Space");
  await expect(page.getByText(/Your last change was not saved/)).toBeVisible();
  // The screen shows what the service holds: the other window's choice.
  await expect(page.getByRole("checkbox", { name: /Invoice 1042 paid/ })).not.toBeChecked();
  await other.close();
});

/** From the list of reconciliations to the one the first test voided. */
async function openVoidedRecord(page: Page) {
  await page
    .getByRole("link", { name: new RegExp(`${shown.date("2026-01-31")}.*Voided`) })
    .first()
    .click();
  await expect(page.getByRole("region", { name: "Not yet on the statement" })).toBeVisible();
  await expect(page.getByRole("row", { name: /Software subscription/ })).toBeVisible();
}

for (const theme of ["light", "dark"] as const) {
  test(`the reconcile screens pass the accessibility scan, fit a phone and stay in their own scroll boxes (${theme})`, async ({
    page,
  }) => {
    await page.goto("/reconcile");
    await page
      .getByRole("link", { name: /^Continue/ })
      .first()
      .click();
    await expect(page.locator(".rt-recon-difference-figure")).toBeVisible();
    await page.evaluate((value) => {
      document.documentElement.dataset.theme = value;
    }, theme);
    await page.addStyleTag({
      content: "*,*::before,*::after{transition:none!important;animation:none!important}",
    });
    await scan(page, `draft (${theme})`);
    await page.goto("/reconcile");
    await expect(page.getByRole("heading", { name: "Reconcile", level: 1 })).toBeVisible();
    await page.evaluate((value) => {
      document.documentElement.dataset.theme = value;
    }, theme);
    await scan(page, `reconcile (${theme})`);
    // A finished record (the first test voided one, and it is still reported on): the page says what was not yet
    // on the statement, and passes the same scan.
    await openVoidedRecord(page);
    await page.evaluate((value) => {
      document.documentElement.dataset.theme = value;
    }, theme);
    await scan(page, `record (${theme})`);
    if (theme === "light")
      await page.screenshot({
        path: test.info().outputPath("reconcile-record-desktop.png"),
        fullPage: true,
      });
    await page.setViewportSize({ width: 390, height: 844 });
    for (const route of ["/reconcile"]) {
      await page.goto(route);
      await expect
        .poll(() => page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth))
        .toBe(true);
    }
    await openVoidedRecord(page);
    await expect
      .poll(() => page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth))
      .toBe(true);
    await expect(page.getByRole("button", { name: "Download report" })).toBeVisible();
    if (theme === "light")
      await page.screenshot({
        path: test.info().outputPath("reconcile-record-phone.png"),
        fullPage: true,
      });
    await page.goto("/reconcile");
    await page
      .getByRole("link", { name: /^Continue/ })
      .first()
      .click();
    await expect(page.locator(".rt-recon-difference-figure")).toBeVisible();
    await expect
      .poll(() => page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth))
      .toBe(true);
    if (theme === "light")
      await page.screenshot({
        path: test.info().outputPath("reconcile-phone.png"),
        fullPage: true,
      });
  });
}
