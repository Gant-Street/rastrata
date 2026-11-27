import { expect, test } from "@playwright/test";
import { shown } from "./support/shown";
// Transactions (For review) against fictional transactions in Storybook: the switch under the title, the
// account select, the category and Accept on each row, the pane with the reason and its action bar, Undo, a
// payout and the transactions it books, and the keyboard. (The whole flow against the real service is in
// apps/web, tests/browser/inbox.spec.ts, and every story is scanned in both themes by lane-stories.spec.ts.)
const story = (id: string) => `/iframe.html?id=lanes-ingest-inbox--${id}&viewMode=story`;
const rows = (page: import("@playwright/test").Page) => page.locator(".rt-inbox-table tbody tr");
const note = (page: import("@playwright/test").Page) => page.locator(".rt-inbox-note");
const pane = (page: import("@playwright/test").Page) => page.locator(".rt-inbox-detail");
/** Where a thing is on the screen: it has to be on it. */
async function box(locator: import("@playwright/test").Locator) {
  const found = await locator.boundingBox();
  if (!found) throw new Error("not on the screen");
  return found;
}
/** The category on a row: filled in and quiet where one is suggested, a field that asks where none is. */
const category = (row: import("@playwright/test").Locator) =>
  row.locator(".rt-inbox-col-category").getByRole("combobox");

test("a payout says how many transactions it books and can show just those", async ({ page }) => {
  await page.goto(story("payout-and-its-lines"));
  await expect(page.getByText(/Books 4 transactions\./)).toBeVisible();
  await expect(rows(page)).toHaveCount(8);

  await page.getByRole("button", { name: "Show the transactions it books" }).click();
  await expect(page.getByText("Showing only the transactions booked by")).toBeVisible();
  await expect(rows(page)).toHaveCount(4);
  for (const row of await rows(page).all()) {
    await expect(row).toContainText("Covered by po_1QZ9");
    await expect(row).toContainText("Nothing to decide");
    await expect(row.getByText("Covered", { exact: true })).toBeVisible();
  }

  await page.getByRole("button", { name: "Back to the list" }).click();
  await expect(page.getByText("Showing only the transactions booked by")).toHaveCount(0);
  await expect(rows(page)).toHaveCount(8);
});

test("a covered transaction says it follows its payout and offers nothing of its own", async ({
  page,
}) => {
  await page.goto(story("covered-line"));
  await expect(
    page.getByText(
      "This transaction is booked together with po_1QZ9. Decide that one and this follows it.",
    ),
  ).toBeVisible();
  // Its own pane has no decision to make, and its row has no button.
  await expect(
    pane(page).getByRole("button", { name: /^(Accept|Categorize|Exclude)/ }),
  ).toHaveCount(0);
  await expect(
    rows(page)
      .nth(1)
      .getByRole("button", { name: /^(Accept|Categorize)/ }),
  ).toHaveCount(0);

  // Ticking covered transactions does not offer to decide them.
  await rows(page).nth(1).locator(".rt-inbox-checkbox").locator("xpath=ancestor::label[1]").click();
  const bar = page.getByRole("region", { name: "Actions for the selected transactions" });
  await expect(bar).toContainText("1 transaction selected on this page.");
  await expect(bar.getByRole("button", { name: /^Accept/ })).toHaveCount(0);
  await expect(bar.getByRole("button", { name: /^Categorize/ })).toHaveCount(0);
  await expect(bar.getByRole("button", { name: /^Exclude/ })).toHaveCount(0);
  await expect(bar.getByRole("button", { name: /^Post/ })).toHaveCount(0);
});

test("a posted transaction says it is on a reconciliation, and one after the statement does not", async ({
  page,
}) => {
  await page.goto(story("posted-and-reconciled"));
  await expect(rows(page)).toHaveCount(2);
  // The word and the statement, in the list (the date is read out, not shown) and in the pane.
  await expect(rows(page).nth(0)).toContainText("Reconciled");
  await expect(rows(page).nth(0)).toContainText(`to the statement of ${shown.date("2026-09-30")}`);
  await expect(rows(page).nth(1)).not.toContainText("Reconciled");
  await expect(
    pane(page).getByText(
      `This transaction is on the reconciliation to the statement of ${shown.date("2026-09-30")}.`,
    ),
  ).toBeVisible();
  await expect(pane(page).getByRole("link", { name: "View the reconciliation" })).toHaveAttribute(
    "href",
    "#reconciliation-rec_2026_09",
  );
  // The one dated after the statement is posted and says nothing of reconciling.
  await page.goto(story("posted-not-yet-reconciled"));
  await expect(pane(page)).toContainText("STATIONERY PLUS #208");
  await expect(pane(page)).not.toContainText("Reconciled");
  await expect(page.getByRole("link", { name: "View the reconciliation" })).toHaveCount(0);
});

test("the keyboard moves between transactions, ticks them, and clears the selection", async ({
  page,
}) => {
  await page.goto(story("default"));
  const boxes = page.locator(".rt-inbox-table tbody .rt-inbox-checkbox");
  await boxes.first().focus();
  await page.keyboard.press("x");
  const bar = page.getByRole("region", { name: "Actions for the selected transactions" });
  await expect(bar).toContainText("1 transaction selected on this page.");
  await page.keyboard.press("j");
  await expect(boxes.nth(1)).toBeFocused();
  await page.keyboard.press("x");
  await expect(bar).toContainText("2 transactions selected on this page.");
  await page.keyboard.press("k");
  await expect(boxes.first()).toBeFocused();
  await page.keyboard.press("Escape");
  await expect(bar).toHaveCount(0);
});

test("a press with Shift held ticks every transaction from the last press to this one", async ({
  page,
}) => {
  await page.goto(story("default"));
  const boxes = page.locator(".rt-inbox-table tbody .rt-inbox-checkbox");
  const press = (index: number, shift = false) =>
    boxes
      .nth(index)
      .locator("xpath=ancestor::label[1]")
      .click(shift ? { modifiers: ["Shift"] } : {});
  await press(0);
  await press(2, true);
  for (const index of [0, 1, 2]) await expect(boxes.nth(index)).toBeChecked();
  await expect(boxes.nth(3)).not.toBeChecked();
  // The same press again clears the same run.
  await press(0);
  await press(2, true);
  for (const index of [0, 1, 2]) await expect(boxes.nth(index)).not.toBeChecked();
});

test("the exclude key opens a dialog that Escape closes, and focus goes back to the transaction", async ({
  page,
}) => {
  await page.goto(story("default"));
  const first = page.locator(".rt-inbox-table tbody .rt-inbox-checkbox").first();
  await first.focus();
  await page.keyboard.press("e");
  const dialog = page.getByRole("dialog");
  await expect(dialog).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(dialog).toHaveCount(0);
  // Focus returns to the transaction that was being worked on.
  await expect(first).toBeFocused();
});

test("a post refused for its date says why, and nothing beside it asks for a step the book takes itself", async ({
  page,
}) => {
  await page.goto(story("posting-refused-for-its-date"));
  await expect(note(page)).toContainText(
    "Posted 11 transactions. 2 could not be posted and are still drafts.",
  );
  await expect(note(page)).toContainText("is past the last fiscal year Rastrata supports");
  // The calendar grows by itself up to that year, so there is no button to extend it.
  await expect(page.locator(".rt-inbox-note-extra")).toHaveCount(0);
  await expect(page.getByRole("button", { name: /Extend the calendar/ })).toHaveCount(0);
});

test("the list has Spent and Received columns, a Category, and no confidence percentage", async ({
  page,
}) => {
  await page.goto(story("default"));
  const head = page.locator(".rt-inbox-table thead");
  for (const name of ["Date", "Description", "Category", "Spent", "Received"])
    await expect(head.getByRole("columnheader", { name, exact: true })).toBeVisible();
  // Money out is in Spent and money in is in Received, each as a plain figure without a sign.
  const github = rows(page).filter({ hasText: "GITHUB INC" }).first();
  await expect(github.locator(".rt-inbox-col-spent")).toHaveText(shown.moneyAbsolute("-4.00"));
  await expect(github.locator(".rt-inbox-col-received")).toHaveText("");
  const credit = rows(page).filter({ hasText: "BRIGHT LABS" }).first();
  await expect(credit.locator(".rt-inbox-col-received")).toHaveText(shown.moneyAbsolute("1200.00"));
  await expect(credit.locator(".rt-inbox-col-spent")).toHaveText("");
  // The category is on the row: where the money would go, filled in; a transaction with no suggestion has a
  // field that asks for one.
  await expect(category(github)).toHaveValue("Software and subscriptions");
  await expect(category(rows(page).filter({ hasText: "STAPLES" }))).toHaveValue("");
  await expect(category(rows(page).filter({ hasText: "STAPLES" }))).toHaveAttribute(
    "placeholder",
    "Choose a category",
  );
  await expect(page.locator(".rt-inbox-table")).not.toContainText("%");
});

test("the whole reason is in the pane, with the rule it came from, and the row has no second control for it", async ({
  page,
}) => {
  await page.goto(story("default"));
  const github = rows(page).filter({ hasText: "GITHUB INC" }).first();
  await expect(github.getByRole("button", { name: /^Why/ })).toHaveCount(0);
  await github.locator(".rt-inbox-description").click();
  await expect(pane(page)).toContainText(
    "Rule “GitHub” matched: the description contains “GITHUB”",
  );
  await expect(pane(page).getByRole("link", { name: "Open rule" })).toHaveAttribute(
    "href",
    "#rule-42",
  );
  // A suggestion that did not come from a rule says who made it.
  await rows(page)
    .filter({ hasText: "SWEETGREEN" })
    .first()
    .locator(".rt-inbox-description")
    .click();
  await expect(pane(page)).toContainText("14 earlier transactions");
});

test("Accept is on the row and says what it did; a row with no suggestion needs a category first; the bar accepts every suggestion", async ({
  page,
}) => {
  await page.goto(story("default"));
  await rows(page)
    .filter({ hasText: "GITHUB INC" })
    .first()
    .getByRole("button", { name: /^Accept GITHUB INC/ })
    .click();
  await expect(note(page)).toContainText("Posted the transactions (preview: nothing was stored).");
  // A transaction with no suggestion has a field that asks, and Accept waits for the answer.
  const staples = rows(page).filter({ hasText: "STAPLES" }).first();
  const accept = staples.getByRole("button", { name: /^Accept STAPLES/ });
  await expect(accept).toBeDisabled();
  await category(staples).click();
  await page.getByRole("option", { name: /^Meals/ }).click();
  await expect(category(staples)).toHaveValue(/Meals/);
  await expect(accept).toBeEnabled();
  await accept.click();
  await expect(note(page)).toContainText("Posted the transactions");
  // One button above the list acts on every suggestion, and says how many.
  const bar = page.getByRole("region", { name: "Accept 6 suggested" });
  await expect(bar).toContainText("6 have a suggested category.");
  await bar.getByRole("button", { name: "Accept 6 suggested" }).click();
  await expect(note(page)).toContainText("Posted the transactions");
});

test("the switch says what waits, and Ready to post and Excluded show only while they hold something", async ({
  page,
}) => {
  await page.goto(story("default"));
  const views = page.getByRole("navigation", { name: "Show transactions" });
  await expect(views.getByRole("link", { name: /^For review/ })).toHaveAttribute(
    "aria-current",
    "page",
  );
  await expect(views.getByRole("link", { name: "All" })).toHaveAttribute("href", "#all");
  // Excluded is a view only while it is open, and Ready to post only while something is in it.
  await expect(views.getByRole("link", { name: /^Excluded/ })).toHaveCount(0);
  await page.goto(story("ready-to-post"));
  await expect(views.getByRole("link", { name: /^Ready to post/ })).toHaveAttribute(
    "aria-current",
    "page",
  );
  await page.goto(story("excluded"));
  await expect(views.getByRole("link", { name: /^Excluded/ })).toHaveAttribute(
    "aria-current",
    "page",
  );
  await page.goto(story("empty-inbox"));
  await expect(views.getByRole("link", { name: /^Ready to post/ })).toHaveCount(0);
  // The header has the two things to do beside the list: the rules, and a statement to import.
  await expect(page.getByRole("link", { name: "Rules" })).toHaveAttribute("href", "#rules");
  await expect(page.getByRole("link", { name: "Import a statement" })).toHaveAttribute(
    "href",
    "#import",
  );
});

test("a question mark opens the keyboard shortcuts in a dialog, and Escape closes it", async ({
  page,
}) => {
  await page.goto(story("default"));
  // The key is heard once the page has drawn its list.
  await expect(rows(page).first()).toBeVisible();
  const dialog = page.getByRole("dialog", { name: "Keyboard shortcuts" });
  await expect(dialog).toHaveCount(0);
  await page.keyboard.press("?");
  await expect(dialog).toBeVisible();
  await expect(dialog).toContainText("Accept");
  await page.keyboard.press("Escape");
  await expect(dialog).toHaveCount(0);
});

test("a book that keeps drafts says so where a category is chosen", async ({ page }) => {
  await page.goto(story("saves-drafts"));
  await rows(page).filter({ hasText: "STAPLES" }).first().locator(".rt-inbox-description").click();
  await expect(pane(page).locator("#rt-inbox-categorize")).toContainText(
    "Saved as a draft, because that is how you chose to accept.",
  );
});

test("the account is one select, and is said on a row only while every account is shown", async ({
  page,
}) => {
  await page.goto(story("default"));
  const select = page.getByRole("combobox", { name: "Account", exact: true });
  await expect(select).toContainText("All accounts");
  await expect(rows(page).first().locator(".rt-inbox-source")).toContainText("Business card");
  await select.click();
  await expect(page.getByRole("option")).toHaveText([
    "All accounts",
    "Operating checking",
    "Savings",
    "Business card",
  ]);
  await page.getByRole("option", { name: "Operating checking" }).click();
  await expect(select).toContainText("Operating checking");
  await expect(rows(page).first()).toBeVisible();
  await expect(page.locator(".rt-inbox-table tbody .rt-inbox-source").first()).not.toContainText(
    "Operating checking",
  );
  await expect(page.locator(".rt-inbox-table tbody")).not.toContainText("Business card");
});

test("with no account to choose between there is no select", async ({ page }) => {
  await page.goto(story("empty-inbox"));
  // The page is there first: a count of none is true of a page that has not been drawn yet, which is how this
  // passed while the story still offered three accounts (found on the runners' WebKit, 2026-11-20).
  await expect(page.getByText("Nothing here yet")).toBeVisible();
  await expect(page.getByRole("combobox", { name: "Account", exact: true })).toHaveCount(0);
});

test("the pane is closed until a transaction is opened, and its action bar stays with it", async ({
  page,
}) => {
  await page.goto(story("default"));
  await expect(pane(page)).toHaveCount(0);
  await rows(page)
    .filter({ hasText: "GITHUB INC" })
    .first()
    .locator(".rt-inbox-description")
    .click();
  await expect(pane(page)).toBeVisible();
  const bar = pane(page).getByRole("toolbar", { name: "Actions for this transaction" });
  for (const name of ["Accept", "Categorize", "Split", "Exclude", "Close"])
    await expect(bar.getByRole("button", { name, exact: true })).toBeVisible();
  // It says what accepting would do to the books, in plain words, with each account's movement.
  const record = pane(page).getByRole("region", { name: "This will record" });
  await expect(record).toContainText("Software and subscriptions");
  await expect(record).toContainText("Business card");
  // Scrolled far down, the bar is still in view.
  await expect(bar).toBeInViewport();
  await bar.getByRole("button", { name: "Close", exact: true }).click();
  await expect(pane(page)).toHaveCount(0);
});

test("Enter on a row opens its pane and Escape closes it, without a mouse", async ({ page }) => {
  await page.goto(story("default"));
  const first = page.locator(".rt-inbox-table tbody .rt-inbox-checkbox").first();
  await first.focus();
  await page.keyboard.press("Enter");
  await expect(pane(page)).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(pane(page)).toHaveCount(0);
});

test("categorizing from the pane asks for the category and says what it will do", async ({
  page,
}) => {
  await page.goto(story("default"));
  await rows(page).filter({ hasText: "STAPLES" }).first().locator(".rt-inbox-description").click();
  // Nothing is suggested for it, so the pane asks in its own field, instead of a dialog.
  const section = pane(page).locator("#rt-inbox-categorize");
  const field = section.getByRole("combobox", { name: "Category" });
  const confirm = section.getByRole("button", { name: "Categorize", exact: true });
  await expect(field).toBeVisible();
  await expect(confirm).toBeDisabled();
  // Choosing one says what will be recorded, and the button follows.
  await field.fill("meals");
  await page.getByRole("option", { name: /^Meals/ }).click();
  await expect(confirm).toBeEnabled();
  await expect(pane(page).getByRole("region", { name: "This will record" })).toContainText("Meals");
});

test("posted transactions can be taken back from the row and from the pane, reconciled or not", async ({
  page,
}) => {
  await page.goto(story("posted-with-undo"));
  const first = rows(page).first();
  await first.getByRole("button", { name: /^Undo / }).click();
  await expect(note(page)).toContainText("Undone: 1 waiting for review again");

  // One on a finished reconciliation is taken back all the same: the page that hears of it says what that
  // means for the statement afterwards (the web test reads that sentence off the real service).
  await page.goto(story("posted-and-reconciled"));
  await rows(page)
    .nth(0)
    .getByRole("button", { name: /^Undo / })
    .click();
  await expect(note(page)).toContainText("Undone: 1 waiting for review again");
  // The pane has Undo too, and it works.
  const undo = pane(page).getByRole("button", { name: "Undo", exact: true });
  await expect(undo).toBeVisible();
  await undo.click();
  await expect(note(page)).toContainText("Undone: 1 waiting for review again");
});

test("without a way to take things back, a posted transaction has no Undo", async ({ page }) => {
  await page.goto(story("posted-without-undo"));
  await expect(rows(page).first()).toBeVisible();
  await expect(page.getByRole("button", { name: /^Undo/ })).toHaveCount(0);
});

test("an empty list says only what is true, with the way forward", async ({ page }) => {
  // A book nobody has imported into says so and offers a bank (the header has the statement); it is never
  // "caught up".
  await page.goto(story("empty-inbox"));
  await expect(page.getByText("Nothing here yet")).toBeVisible();
  const list = page.locator(".rt-inbox-list");
  await expect(list.getByRole("link", { name: "Connect a bank" })).toHaveAttribute(
    "href",
    "#connect",
  );
  await expect(page.getByRole("link", { name: "Import a statement" })).toHaveAttribute(
    "href",
    "#import",
  );
  await expect(page.getByText("You are caught up")).toHaveCount(0);
  // Caught up is said only when there were transactions and every one is decided.
  await page.goto(story("caught-up"));
  await expect(page.getByText("You are caught up")).toBeVisible();
  // A search that finds nothing is not "caught up" either.
  await page.goto(story("no-matches"));
  await expect(page.getByText("No transactions match")).toBeVisible();
  await expect(page.getByText("You are caught up")).toHaveCount(0);
});

test("on a phone a transaction is two lines: the description and amount, then the category and Accept", async ({
  page,
}) => {
  for (const width of [390, 360]) {
    await page.setViewportSize({ width, height: 844 });
    await page.goto(story("default"));
    const github = rows(page).filter({ hasText: "GITHUB INC" }).first();
    await expect(github.getByRole("button", { name: /^Accept GITHUB INC/ })).toBeVisible();
    await expect(category(github)).toBeVisible();
    await expect(github.locator(".rt-inbox-col-spent")).toBeHidden();
    await expect(github.locator(".rt-inbox-col-amount")).toBeVisible();
    // The boxes are for a wide screen; a phone accepts many with the button above the list.
    await expect(github.locator(".rt-inbox-checkbox")).toBeHidden();
    // The first line (description and amount) is above the second (category and Accept), and the button
    // keeps the end of its line.
    const description = await box(github.locator(".rt-inbox-description"));
    const field = await box(category(github));
    const button = await box(github.getByRole("button", { name: /^Accept GITHUB INC/ }));
    expect(field.y).toBeGreaterThan(description.y + description.height - 1);
    expect(Math.abs(button.y - field.y)).toBeLessThan(20);
    expect(button.x + button.width).toBeGreaterThan(width - 40);
    // Nothing scrolls sideways.
    expect(
      await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth),
    ).toBe(true);
  }
});
