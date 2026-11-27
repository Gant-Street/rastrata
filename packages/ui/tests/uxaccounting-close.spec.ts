import { expect, test } from "@playwright/test";

/** Close the books (Lanes/UXAccounting/Close the books), step 6 of Simpler Rastrata. One page says how far the
 * books are closed and has one card for the months that can be closed now: what is left, each line with its
 * one button, and "Close through <month>", which works when nothing is left. The year, the closed months and
 * the calendar are three folds under it. */
const story = (name: string) =>
  `/iframe.html?id=lanes-uxaccounting-close-the-books--${name}&viewMode=story`;

const card = (page: import("@playwright/test").Page, month: string) =>
  page.getByRole("region", { name: `Through ${month}`, exact: true });

test("the line under the title says how far the books are closed, and what closing is only until something is", async ({
  page,
}) => {
  await page.goto(story("things-left"));
  await expect(page.locator(".rt-close-through")).toHaveText(
    "Nothing is closed yet. Closing a month stops new entries dated in it. You can reopen it.",
  );
  await page.goto(story("ready-to-close"));
  await expect(page.locator(".rt-close-through")).toHaveText(
    "Books are closed through Sep 30, 2026.",
  );
  // A book with nothing to close says so once, and has no card.
  await page.goto(story("nothing-to-close-yet"));
  await expect(page.locator(".rt-close-through")).toContainText("Nothing to close yet.");
  await expect(page.locator(".rt-close-card")).toHaveCount(0);
  await page.goto(story("everything-closed"));
  await expect(page.locator(".rt-close-through")).toHaveText(
    "Books are closed through Oct 31, 2026.",
  );
  await expect(page.locator(".rt-close-card")).toHaveCount(0);
});

test("the card lists only what is left, each line a sentence with one link that names what it does", async ({
  page,
}) => {
  await page.goto(story("things-left"));
  const october = card(page, "October 2026");
  const lines = october.getByRole("listitem");
  await expect(lines).toHaveCount(2);
  await expect(lines.nth(0)).toContainText("8 transactions to review.");
  await expect(lines.nth(1)).toContainText(
    "Chase checking is not reconciled through Oct 31, 2026.",
  );
  await expect(october.getByRole("link", { name: "Review transactions" })).toHaveAttribute(
    "href",
    "/inbox",
  );
  await expect(october.getByRole("link", { name: "Reconcile Chase checking" })).toHaveAttribute(
    "href",
    "/reconcile?account=checking",
  );
  // No tick, no badge and no hint: what is done is not listed, and the list is the reason the button waits.
  await expect(october.getByText("Open", { exact: true })).toHaveCount(0);
  await expect(october.getByText(/Closing needs/)).toHaveCount(0);
  // Every kind of thing the service can say is left has its line and its place.
  await page.goto(story("every-kind-of-thing-left"));
  const every = card(page, "October 2026");
  for (const name of [
    "Review transactions",
    "Reconcile Business credit card",
    "Reconcile Business checking",
    "Back up now",
  ])
    await expect(every.getByRole("link", { name, exact: true })).toBeVisible();
});

test("Close through <month> works only when nothing is left", async ({ page }) => {
  await page.goto(story("things-left"));
  await expect(page.getByRole("button", { name: "Close through October 2026" })).toBeDisabled();
  await page.goto(story("ready-to-close"));
  const october = card(page, "October 2026");
  await expect(october.getByRole("listitem")).toHaveCount(0);
  const close = october.getByRole("button", { name: "Close through October 2026" });
  await expect(close).toBeEnabled();
  // It is the page's one main button.
  await expect(page.locator('.rt-button[data-variant="primary"]')).toHaveCount(1);
  await close.click();
  await expect(
    page.getByRole("status").filter({ hasText: "Closing through October 2026 in this preview." }),
  ).toBeVisible();
});

test("what is worth a look is one fold in the card, and a note never stands in the way", async ({
  page,
}) => {
  await page.goto(story("ready-with-things-to-look-at"));
  const october = card(page, "October 2026");
  const look = october.getByRole("button", { name: "1 thing to look at first" });
  await expect(look).toHaveAttribute("aria-expanded", "false");
  await look.click();
  await expect(october).toContainText("A restore drill has not been run.");
  await expect(october.getByRole("heading", { name: /Money is collecting in/ })).toBeVisible();
  await expect(october.getByRole("button", { name: "Close through October 2026" })).toBeEnabled();
});

test("a check that failed says nothing is current and offers to try again", async ({ page }) => {
  await page.goto(story("check-failed"));
  const october = card(page, "October 2026");
  await expect(october.getByRole("alert")).toContainText("could not be checked");
  await expect(october.getByRole("button", { name: /^Close through/ })).toHaveCount(0);
  await october.getByRole("button", { name: "Try again" }).click();
  await expect(page.getByRole("status").filter({ hasText: "Checking again" })).toBeVisible();
  await page.goto(story("checking"));
  await expect(card(page, "October 2026").getByRole("status")).toHaveText("Checking…");
});

test("a close that stopped short says which month would not close, above what is left for it", async ({
  page,
}) => {
  await page.goto(story("stopped-short"));
  const september = card(page, "September 2026");
  await expect(september.getByRole("alert")).toHaveText(
    "September 2026 was not closed. July to August 2026 stayed closed.",
  );
  await expect(september.getByRole("listitem")).toHaveCount(1);
});

test("a member who may not close sees what is left and who closes, and no button", async ({
  page,
}) => {
  await page.goto(story("member-who-cannot-close"));
  const october = card(page, "October 2026");
  await expect(october.getByRole("listitem")).toHaveCount(2);
  await expect(october.getByRole("button", { name: /^Close through/ })).toHaveCount(0);
  await expect(october).toContainText(
    "An owner or an administrator of the workspace closes the books.",
  );
  await page.getByRole("button", { name: "Closed months (9)" }).click();
  await expect(page.getByRole("link", { name: "Closing report" })).toHaveCount(9);
  await expect(page.getByRole("button", { name: /^Reopen/ })).toHaveCount(0);
});

test("closed months are a fold with Reopen, which opens by itself when a close no longer matches the books", async ({
  page,
}) => {
  await page.goto(story("ready-to-close"));
  const toggle = page.getByRole("button", { name: "Closed months (9)" });
  await expect(toggle).toHaveAttribute("aria-expanded", "false");
  await expect(page.getByRole("button", { name: "Reopen September 2026" })).toBeHidden();
  await toggle.click();
  // The row names the month, so the button says Reopen; its own name still says which month.
  const reopen = page.getByRole("button", { name: "Reopen September 2026" });
  await expect(reopen).toBeVisible();
  await expect(reopen).toHaveText("Reopen");
  await expect(page.getByRole("link", { name: "Closing report" })).toHaveCount(9);
  await reopen.click();
  await expect(page.getByRole("status").filter({ hasText: "Reopening period-9" })).toBeVisible();

  await page.goto(story("year-to-close-again"));
  await expect(page.getByRole("button", { name: "Closed months (12)" })).toHaveAttribute(
    "aria-expanded",
    "true",
  );
  await expect(
    page.locator(".rt-close-closed-list li").filter({ hasText: "May 2026" }),
  ).toContainText("Its close no longer matches the books");
});

test("Close the year is a fold that says when the year ends, and holds the way into closing it", async ({
  page,
}) => {
  await page.goto(story("things-left"));
  const fold = page.getByRole("button", { name: "Close the year", exact: true });
  await expect(fold).toHaveAttribute("aria-expanded", "false");
  await expect(page.getByText("Fiscal year 2026 ends Dec 31, 2026")).toBeVisible();
  await fold.click();
  const year = page.getByRole("region", { name: "Fiscal year 2026" });
  await expect(year).toContainText("0 of 12 periods closed");
  // The year has not ended: no button, one sentence that says when it does, and no badge.
  await expect(year.getByRole("button")).toHaveCount(0);
  await expect(year).toContainText("This year ends on Dec 31, 2026.");
  await expect(year.getByText("Open", { exact: true })).toHaveCount(0);

  // A year that has ended is open, with its button; while a month can still be closed, the card's button
  // is the page's main one.
  await page.goto(story("year-ended"));
  const ended = page.getByRole("region", { name: "Fiscal year 2026" });
  const closeYear = ended.getByRole("button", { name: "Close fiscal year 2026", exact: true });
  await expect(closeYear).toBeEnabled();
  await expect(closeYear).toHaveAttribute("data-variant", "secondary");
  await expect(page.locator('.rt-button[data-variant="primary"]')).toHaveText([
    "Close through December 2026",
  ]);
  // With no month left to close, closing the year is the main button.
  await page.goto(story("year-to-close-again"));
  await expect(page.locator('.rt-button[data-variant="primary"]')).toHaveText([
    "Close fiscal year 2026 again",
  ]);
  await page.getByRole("button", { name: "Close fiscal year 2026 again" }).click();
  await expect(
    page.getByRole("status").filter({ hasText: "Year-end in this preview." }),
  ).toBeVisible();
  // A closed year says so beside the fold, and the button is off with its reason.
  await page.goto(story("year-closed"));
  await expect(page.getByText("Fiscal year 2026 is closed")).toBeVisible();
  // A book of several years chooses the year inside the fold.
  await page.goto(story("several-years"));
  await page.getByLabel("Fiscal year", { exact: true }).click();
  await expect(page.getByRole("option")).toHaveCount(2);
});

test("the calendar and the history of closes are one fold at the foot", async ({ page }) => {
  await page.goto(story("ready-to-close"));
  const fold = page.getByRole("button", { name: "Calendar and history" });
  await expect(fold).toHaveAttribute("aria-expanded", "false");
  await fold.click();
  await expect(page.getByText("Later years are added as your entries need them.")).toBeVisible();
  await expect(page.getByRole("list", { name: "Period change history" })).toContainText(
    "A supplier restated March",
  );
});

test("a book whose periods are quarters never says month", async ({ page }) => {
  await page.goto(story("quarters"));
  await expect(page.locator(".rt-close-through")).toContainText(
    "Closing a quarter stops new entries dated in it.",
  );
  await expect(page.getByRole("button", { name: "Close through Q3 2026" })).toBeVisible();
  await expect(page.locator(".rt-close-page")).not.toContainText(/month/i);
});

test("what is left can be reached and used from the keyboard", async ({ page, browserName }) => {
  await page.goto(story("things-left"));
  const link = page.getByRole("link", { name: "Review transactions" });
  await link.focus();
  await expect(link).toBeFocused();
  // WebKit on a Mac tabs to text fields only; Option-Tab is Safari's way to the links and buttons.
  const tab = browserName === "webkit" && process.platform === "darwin" ? "Alt+Tab" : "Tab";
  await page.keyboard.press(tab);
  await expect(page.getByRole("link", { name: "Reconcile Chase checking" })).toBeFocused();
  // The button that waits is skipped; the next stop is the year's fold, which Enter opens.
  await page.keyboard.press(tab);
  const fold = page.getByRole("button", { name: "Close the year", exact: true });
  await expect(fold).toBeFocused();
  await page.keyboard.press("Enter");
  await expect(fold).toHaveAttribute("aria-expanded", "true");
});

test("at a phone's width a line keeps its button beside it and nothing scrolls sideways", async ({
  page,
}) => {
  for (const width of [390, 360]) {
    await page.setViewportSize({ width, height: 844 });
    for (const name of [
      "things-left",
      "ready-to-close",
      "every-kind-of-thing-left",
      "year-to-close-again",
      "long-text",
    ]) {
      await page.goto(story(name));
      await expect(page.locator(".rt-close-page")).toBeVisible();
      expect(
        await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth),
        `${name} at ${width}`,
      ).toBe(true);
    }
  }
  await page.goto(story("things-left"));
  const line = page.locator(".rt-close-line").first();
  const text = await line.locator(".rt-close-text").boundingBox();
  const button = await line.getByRole("link").boundingBox();
  expect(text && button && button.x >= text.x + text.width - 1).toBe(true);
});
