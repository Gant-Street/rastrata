import { expect, test, type Page } from "@playwright/test";
import { shown } from "./support/shown";

// The reconcile workspace is something you drive from the keyboard, so the keys are tested here,
// against the component in Storybook: movement, ticking, runs, ranges, the one tab stop per
// column, and the find box. (The whole flow against the real service is in apps/web.)
const story = (id: string) => `/iframe.html?id=lanes-reconcile-workspace--${id}&viewMode=story`;
const parts = (id: string) => `/iframe.html?id=lanes-reconcile-parts--${id}&viewMode=story`;
const difference = (page: Page) => page.locator(".rt-recon-difference-figure");

test("one tab stop per column, and the keys move, tick, extend and jump", async ({ page }) => {
  await page.goto(story("many-lines"));
  const out = page.getByRole("region", { name: "Money out" });
  const boxes = out.locator("tbody input[type=checkbox]");
  await expect(boxes.first()).toBeVisible();
  expect(await boxes.count()).toBeGreaterThan(50);
  // Only one row of the column can be reached with Tab; the rest are reached with the arrow keys.
  const stops = await out.locator("tbody input[type=checkbox]:not([tabindex='-1'])").count();
  expect(stops).toBe(1);

  await boxes.nth(0).focus();
  await page.keyboard.press("j");
  await expect(boxes.nth(1)).toBeFocused();
  await page.keyboard.press("ArrowDown");
  await expect(boxes.nth(2)).toBeFocused();
  await page.keyboard.press("k");
  await expect(boxes.nth(1)).toBeFocused();
  await page.keyboard.press("End");
  await expect(boxes.last()).toBeFocused();
  await page.keyboard.press("Home");
  await expect(boxes.first()).toBeFocused();
  await page.keyboard.press("PageDown");
  await expect(boxes.nth(10)).toBeFocused();
  // The single tab stop follows focus.
  expect(await out.locator("tbody input[type=checkbox]:not([tabindex='-1'])").count()).toBe(1);
  await expect(boxes.nth(10)).toHaveAttribute("tabindex", "0");

  // x ticks, and so does space; the count and the exact total update at once.
  await page.keyboard.press("x");
  await expect(boxes.nth(10)).toBeChecked();
  await page.keyboard.press("Space");
  await expect(boxes.nth(10)).not.toBeChecked();
  await expect(out.getByText(/^0 of \d+ selected/)).toBeVisible();

  // Shift with an arrow ticks a run, carrying the state of the transaction it started from.
  await boxes.nth(20).focus();
  await page.keyboard.press("x");
  await page.keyboard.press("Shift+ArrowDown");
  await page.keyboard.press("Shift+ArrowDown");
  await page.keyboard.press("Shift+ArrowDown");
  for (const index of [20, 21, 22, 23]) await expect(boxes.nth(index)).toBeChecked();
  await expect(boxes.nth(24)).not.toBeChecked();
  await expect(out.getByText(/^4 of \d+ selected/)).toBeVisible();

  // Shift-click ticks everything between the last click and this one.
  await boxes.nth(30).locator("xpath=ancestor::label[1]").click();
  await boxes
    .nth(34)
    .locator("xpath=ancestor::label[1]")
    .click({ modifiers: ["Shift"] });
  for (const index of [30, 31, 32, 33, 34]) await expect(boxes.nth(index)).toBeChecked();
  await expect(out.getByText(/^9 of \d+ selected/)).toBeVisible();
});

test("the header box selects and clears the whole column, and shows a partial selection", async ({
  page,
}) => {
  await page.goto(story("many-lines"));
  const out = page.getByRole("region", { name: "Money out" });
  const header = out.getByRole("checkbox", { name: /Select all money out shown/ });
  const boxes = out.locator("tbody input[type=checkbox]");
  await boxes.nth(3).locator("xpath=ancestor::label[1]").click();
  expect(await header.evaluate((element: HTMLInputElement) => element.indeterminate)).toBe(true);
  await header.locator("xpath=ancestor::label[1]").click();
  expect(
    await boxes.evaluateAll((all) => all.every((box) => (box as HTMLInputElement).checked)),
  ).toBe(true);
  await header.locator("xpath=ancestor::label[1]").click();
  expect(
    await boxes.evaluateAll((all) => all.some((box) => (box as HTMLInputElement).checked)),
  ).toBe(false);
});

test("find narrows both columns by amount or text, and Enter ticks a single match", async ({
  page,
}) => {
  await page.goto(story("default"));
  await expect(difference(page)).toHaveText("1,190.00");
  const find = page.getByLabel("Find a transaction");
  await find.fill("40.1");
  await expect(page.getByRole("checkbox", { name: /Office supplies/ })).toBeVisible();
  await expect(page.getByRole("checkbox", { name: /Software subscription/ })).toHaveCount(0);
  await find.press("Enter");
  await expect(find).toHaveValue("");
  await expect(page.getByRole("checkbox", { name: /Office supplies/ })).toBeChecked();
  await expect(difference(page)).toHaveText("1,230.10");
  // Text matches the description anywhere, without regard to case.
  await find.fill("alder");
  await expect(page.getByRole("checkbox", { name: /Invoice 1042/ })).toBeVisible();
  await expect(page.getByRole("checkbox", { name: /Owner contribution/ })).toHaveCount(0);
  await find.press("Escape");
  await expect(find).toHaveValue("");
  await expect(page.getByRole("checkbox", { name: /Owner contribution/ })).toBeVisible();
  // No match is said, not silent; the slash key finds from anywhere on the page.
  await find.fill("no such transaction");
  await find.press("Enter");
  await expect(page.getByText("No transaction matches.")).toBeAttached();
  await find.fill("");
  await page.locator("body").click({ position: { x: 5, y: 5 } });
  await page.keyboard.press("/");
  await expect(find).toBeFocused();
});

test("Finish is available at exactly 0.00 and never one cent away", async ({ page }) => {
  await page.goto(story("default"));
  const finish = page.getByRole("button", { name: "Finish reconciliation" });
  await expect(finish).toBeDisabled();
  for (const name of [/Owner contribution/, /Invoice 1042/, /Office supplies/])
    await page.getByRole("checkbox", { name }).locator("xpath=ancestor::label[1]").click();
  await expect(difference(page)).toHaveText("\u221219.90");
  await expect(finish).toBeDisabled();
  await page
    .getByRole("checkbox", { name: /Software subscription/ })
    .locator("xpath=ancestor::label[1]")
    .click();
  await expect(difference(page)).toHaveText("0.00");
  await expect(page.getByText("Balanced. Ready to finish.")).toBeVisible();
  await expect(finish).toBeEnabled();
  await page.getByRole("button", { name: "Clear all" }).click();
  await expect(difference(page)).toHaveText("1,190.00");
  await expect(finish).toBeDisabled();
});

test("an imported statement's balance fills the form, says so, and never overwrites typing", async ({
  page,
}) => {
  await page.goto(parts("start-dialog-with-imported-balance"));
  const dialog = page.getByRole("dialog");
  const date = dialog.getByLabel("Statement end date");
  const balance = dialog.getByLabel("Statement ending balance");
  await expect(date).toHaveValue(shown.dateBox("2026-01-31"));
  await expect(balance).toHaveValue("1190.00");
  await expect(dialog.getByText(/Filled in from the statement file you imported/)).toBeVisible();
  // The person may change it; the suggestion is then offered, not forced.
  await balance.fill("1190.50");
  await expect(dialog.getByText(/Filled in from the statement file/)).toHaveCount(0);
  await dialog.getByRole("button", { name: "Use these" }).click();
  await expect(balance).toHaveValue("1190.00");
});

test("the small form opens on the date for an account's row, and on the account when none is chosen", async ({
  page,
}) => {
  await page.goto(parts("start-dialog-for-an-account"));
  const dialog = page.getByRole("dialog", { name: "Reconcile Checking" });
  await expect(dialog).toBeVisible();
  await expect(dialog.getByLabel("Statement end date")).toBeFocused();
  // Asking with nothing typed says what is missing, in a summary that links to each field.
  await dialog.getByRole("button", { name: "Start reconciling" }).click();
  const summary = dialog.getByRole("heading", { name: "Check the statement details" });
  await expect(summary).toBeVisible();
  await expect(
    dialog.getByRole("link", { name: "Enter the date the statement ends." }),
  ).toBeVisible();
  await expect(
    dialog.getByRole("link", { name: /Enter the statement ending balance/ }),
  ).toBeVisible();

  await page.goto(parts("start-dialog-choosing-an-account"));
  const open = page.getByRole("dialog", { name: "Reconcile an account" });
  await expect(open.getByRole("combobox", { name: /^Account/ })).toBeFocused();
  // Enter in the balance field starts it, the same as the button.
  await open.getByRole("combobox", { name: /^Account/ }).fill("Savings");
  await page.getByRole("option", { name: /Savings/ }).click();
  // The box takes focus back a frame after the choice: wait for that frame, or the next field's text is typed
  // into the box on a busy machine.
  await page.evaluate(
    () =>
      new Promise<void>((resolve) =>
        requestAnimationFrame(() => requestAnimationFrame(() => resolve())),
      ),
  );
  await open.getByLabel("Statement end date").fill("2026-02-28");
  await open.getByLabel("Statement ending balance").fill("5000.00");
  await open.getByLabel("Statement ending balance").press("Enter");
  await expect(open.getByRole("heading", { name: "Check the statement details" })).toHaveCount(0);
});

test("a start whose reply was lost is resumed, and starting another waits", async ({ page }) => {
  await page.goto(parts("start-dialog-with-a-lost-reply"));
  const dialog = page.getByRole("dialog");
  await expect(dialog.getByText("An original request is retained")).toBeVisible();
  await expect(dialog.getByRole("button", { name: "Resume original request" })).toBeEnabled();
  await expect(dialog.getByRole("button", { name: "Start reconciling" })).toBeDisabled();
});

test("the accounts come first, each with one button, and a book with none says what to do", async ({
  page,
}) => {
  await page.goto(parts("status-table"));
  const table = page.getByRole("table", { name: "Accounts" });
  await expect(table.getByRole("columnheader", { name: "Not yet on a statement" })).toBeVisible();
  const checking = table.getByRole("row", { name: /^Checking/ });
  await expect(checking).toContainText(shown.date("2026-01-31"));
  await expect(checking).toContainText("3 transactions");
  await expect(checking.getByRole("button", { name: "Reconcile Checking" })).toBeVisible();
  // A draft in progress is continued, not started again.
  await expect(
    table.getByRole("row", { name: /^Card/ }).getByRole("link", { name: /Continue/ }),
  ).toHaveAttribute("href", "/reconcile/d-1");
  // Nothing on a statement is a fact, said once, with a check mark.
  await expect(table.getByRole("row", { name: /^Savings/ })).toContainText(
    "Everything is on a statement.",
  );

  await page.goto(parts("status-table-empty"));
  await expect(page.getByText("No accounts to reconcile yet")).toBeVisible();
  await expect(page.getByRole("link", { name: "Import statement" })).toHaveAttribute(
    "href",
    "/import",
  );
  await expect(page.getByText("All reconciled")).toHaveCount(0);
});

test("the figures stay in view while the transactions scroll under them", async ({ page }) => {
  await page.goto(story("many-lines"));
  const summary = page.getByRole("region", { name: "Reconciliation figures" });
  await expect(summary).toBeInViewport();
  await page.mouse.wheel(0, 1600);
  await expect(
    page.getByRole("region", { name: "Money out" }).locator("tbody tr").last(),
  ).toBeAttached();
  await expect(summary).toBeInViewport();
  const top = await summary.evaluate((element) => element.getBoundingClientRect().top);
  expect(top).toBeLessThan(40);
});

test("an unsaved or uncertain change freezes the controls and says why", async ({ page }) => {
  await page.goto(story("save-uncertain"));
  await expect(page.getByText("The last change may not have been saved")).toBeVisible();
  await expect(page.getByRole("button", { name: "Resume original request" })).toBeVisible();
  await expect(page.getByRole("button", { name: "Select all transactions" })).toBeDisabled();
  await expect(page.getByRole("checkbox", { name: /Owner contribution/ })).toBeDisabled();
  await expect(page.getByText("All changes saved.")).toHaveCount(0);
});

// The report on a finished reconciliation: what was not yet on the statement, and the button that saves it.
const record = (id: string) => `/iframe.html?id=lanes-reconcile-report--${id}&viewMode=story`;

test("the report is downloaded from the keyboard alone, one press is one file, and the page says what became of it", async ({
  page,
  browserName,
}) => {
  await page.goto(record("downloading-the-report"));
  const button = page.getByRole("button", { name: "Download report" });
  // The next stop after the way back to the list is the button. Nothing else is in the way. (Safari on a Mac
  // does not Tab to buttons and links unless asked to; Option-Tab is its way through everything.)
  const tab = browserName === "webkit" && process.platform === "darwin" ? "Alt+Tab" : "Tab";
  await page.getByRole("link", { name: /Back to Reconcile/ }).focus();
  await page.keyboard.press(tab);
  await expect(button).toBeFocused();
  await page.keyboard.press("Enter");
  // While the file is made the button says so, is busy and ignores a second press; focus stays where it was.
  const busy = page.getByRole("button", { name: "Preparing the report…" });
  await expect(busy).toHaveAttribute("aria-busy", "true");
  await expect(busy).toBeFocused();
  await expect(
    page.getByRole("status").filter({ hasText: "Preparing the report…" }),
  ).toBeAttached();
  await page.keyboard.press("Enter");
  // Saved is said once the file is there, where a person looks and in the live region that is always present.
  await expect(page.locator(".rt-recon-report-saved")).toHaveText(
    "Saved reconciliation-1000-2026-01-31.csv. It opens in any spreadsheet.",
  );
  await expect(
    page.getByRole("status").filter({ hasText: "Saved reconciliation-1000-2026-01-31.csv" }),
  ).toBeAttached();
  await expect(page.getByRole("button", { name: "Download report" })).toBeFocused();
  await expect(page.getByRole("button", { name: "Download report" })).not.toHaveAttribute(
    "aria-busy",
    "true",
  );
});

test("a file that could not be made says why, says nothing in the books changed, and the button can be pressed again", async ({
  page,
}) => {
  await page.goto(record("file-could-not-be-made"));
  const failed = page.getByRole("alert").filter({ hasText: "The report could not be made" });
  await expect(failed).toBeVisible();
  await expect(failed).toContainText("The service could not be reached.");
  await expect(failed).toContainText("Nothing in your books has changed. Try again.");
  await expect(page.getByRole("button", { name: "Download report" })).toBeEnabled();
  await expect(page.locator(".rt-recon-report-saved")).toHaveCount(0);
});

test("what was not yet on the statement has a sum above it, a table under it, and says so when there is nothing", async ({
  page,
}) => {
  await page.goto(record("finished-with-one-not-yet-on-the-statement"));
  const section = page.getByRole("region", { name: "Not yet on the statement" });
  await expect(section.getByText("Statement balance", { exact: true })).toBeVisible();
  await expect(section.getByText("Plus 1 transaction not yet on it")).toBeVisible();
  await expect(section.getByText(`Your books on ${shown.date("2026-01-31")}`)).toBeVisible();
  await expect(section.getByRole("row", { name: /Software subscription/ })).toContainText("19.90");
  await expect(section.getByRole("link", { name: /View entry/ })).toHaveAttribute(
    "href",
    "/journal/o1?revision=19",
  );

  await page.goto(record("nothing-outstanding"));
  const none = page.getByRole("region", { name: "Not yet on the statement" });
  await expect(
    none.getByText(
      `Nothing was outstanding: every transaction in your books on or before ${shown.date("2026-01-31")} is on this statement.`,
    ),
  ).toBeVisible();
  await expect(none.getByRole("table")).toHaveCount(0);

  await page.goto(record("working-it-out"));
  await expect(
    page.getByRole("status").filter({ hasText: "Working out what was not yet on the statement…" }),
  ).toBeVisible();
  // The record above it is already there to read.
  await expect(page.getByRole("region", { name: "Reconciliation figures" })).toBeVisible();

  await page.goto(record("could-not-be-worked-out"));
  const alert = page.getByRole("alert").filter({
    hasText: "What was not yet on the statement could not be worked out",
  });
  await expect(alert).toContainText("is not in the books as they stood at revision 19");
  await expect(alert.getByRole("button", { name: "Try again" })).toBeVisible();
});

test("many transactions scroll inside their own box, awkward text stays text, and a phone has no sideways scroll", async ({
  page,
}) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto(record("many-transactions"));
  const section = page.getByRole("region", { name: "Not yet on the statement" });
  await expect(section.getByRole("row")).toHaveCount(401);
  const box = section.locator(".rt-recon-scroll");
  expect(await box.evaluate((element) => element.scrollHeight > element.clientHeight)).toBe(true);
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(
    true,
  );

  await page.goto(record("long-and-awkward-text"));
  const rows = page.getByRole("region", { name: "Not yet on the statement" }).getByRole("row");
  await expect(rows.filter({ hasText: "=HYPERLINK" })).toHaveCount(1);
  await expect(rows.filter({ hasText: "<b>Bold</b>" })).toHaveCount(1);
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(
    true,
  );
  expect(await page.locator("b").count()).toBe(0); // markup in a memo is text, not an element
});
