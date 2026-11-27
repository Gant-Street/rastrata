import { expect, test, type Page } from "@playwright/test";
import axe from "axe-core";
import { pick } from "./support/pick";

declare global {
  interface Window {
    axe: typeof axe;
  }
}

// The rules components are driven from the keyboard, so the keys are tested here, against the
// components in Storybook: reordering with Alt and the arrows, the buttons at the ends, switching a
// rule off, editing conditions and a split, and inserting a narration field. Every Rules story is
// also scanned in both themes and at a phone's width. (The whole flow against the real service is
// in apps/web.)
const story = (id: string) => `/iframe.html?id=lanes-rules-${id}&viewMode=story`;
// Waits for the list to be on the page: a story that has not rendered yet has no rows, and an empty
// answer would be read as an empty list. (Under load the first read used to come too early.)
const names = async (page: Page) => {
  await page.locator("tbody tr th a").first().waitFor();
  return page.locator("tbody tr th a").allTextContents();
};

test("Alt with an arrow moves a rule, says so, and keeps focus on the same control", async ({
  page,
}) => {
  await page.goto(story("list--default"));
  const before = await names(page);
  expect(before.slice(0, 3)).toEqual(["Stripe payouts", "GitHub subscriptions", "AWS"]);
  const down = page.getByRole("button", { name: "Move GitHub subscriptions down" });
  await down.focus();
  await page.keyboard.press("Alt+ArrowDown");
  expect((await names(page)).slice(0, 3)).toEqual([
    "Stripe payouts",
    "AWS",
    "GitHub subscriptions",
  ]);
  await expect(page.getByText("Moved GitHub subscriptions to position 3 of 7.")).toBeAttached();
  // The row's nodes moved, and focus came back to the control that was used.
  await expect(down).toBeFocused();
  await page.keyboard.press("Alt+ArrowUp");
  await page.keyboard.press("Alt+ArrowUp");
  expect((await names(page)).slice(0, 3)).toEqual([
    "GitHub subscriptions",
    "Stripe payouts",
    "AWS",
  ]);
  // At the top the up button is disabled, so focus passes to the other move button.
  await expect(page.getByRole("button", { name: "Move GitHub subscriptions down" })).toBeFocused();
  await expect(page.getByRole("button", { name: "Move GitHub subscriptions up" })).toBeDisabled();
});

test("the first rule cannot move up and the last cannot move down", async ({ page }) => {
  await page.goto(story("list--default"));
  await expect(page.getByRole("button", { name: "Move Stripe payouts up" })).toBeDisabled();
  await expect(page.getByRole("button", { name: "Move Personal transfers down" })).toBeDisabled();
  await expect(page.getByRole("button", { name: "Move Personal transfers up" })).toBeEnabled();
});

test("the move buttons work with a pointer, and the order is the position column", async ({
  page,
}) => {
  await page.goto(story("list--default"));
  await page.getByRole("button", { name: "Move AWS up" }).click();
  expect((await names(page)).slice(0, 3)).toEqual([
    "Stripe payouts",
    "AWS",
    "GitHub subscriptions",
  ]);
  const positions = await page.locator("tbody tr .rt-rules-position").allTextContents();
  expect(positions).toEqual(["1", "2", "3", "4", "5", "6", "7"]);
});

test("a rule is switched off and on in place, with a pointer or the keyboard, and says so in words", async ({
  page,
}) => {
  await page.goto(story("list--default"));
  const row = page.locator("tbody tr", { hasText: "AWS" }).first();
  const toggle = row.getByRole("switch", { name: "AWS" });
  await expect(toggle).toBeChecked();
  await expect(row.getByText("On", { exact: true })).toBeVisible();
  await row.locator(".rt-rules-switch-control").click();
  await expect(toggle).not.toBeChecked();
  await expect(row.getByText("Off", { exact: true })).toBeVisible();
  await toggle.focus();
  await page.keyboard.press("Space");
  await expect(toggle).toBeChecked();
  await expect(row.getByText("On", { exact: true })).toBeVisible();
});

test("each rule says when it applies and what it then suggests, in words, and who made it", async ({
  page,
}) => {
  await page.goto(story("list--default"));
  const head = page.locator("thead");
  for (const name of ["Order", "Name", "When", "Then", "Used", "On or off"])
    await expect(head.getByRole("columnheader", { name, exact: true })).toBeVisible();
  const github = page.locator("tbody tr", { hasText: "GitHub subscriptions" }).first();
  await expect(github.locator(".rt-rules-when")).toContainText("Description contains “GITHUB”");
  await expect(github.locator(".rt-rules-then")).toHaveText("Software");
  // A person who wrote it is "You"; an agent is named. A rule limited to accounts says which.
  await expect(page.locator("tbody tr", { hasText: "Stripe payouts" }).first()).toContainText(
    "You ·",
  );
  await expect(github).toContainText("Agent: Claude");
  await expect(
    page.locator("tbody tr", { hasText: "Personal transfers" }).locator(".rt-rules-when"),
  ).toContainText("On Checking");
  await expect(page.getByRole("table", { name: "Rules in priority order" })).not.toContainText(
    "Book to",
  );
});

test("how a rule is doing is in a disclosure in its row, and the counts are the page's one line", async ({
  page,
}) => {
  await page.goto(story("list--default"));
  const aws = page.locator("tbody tr", { hasText: "AWS" }).first();
  // The row says how often it was used; the rest is one click away.
  await expect(aws.locator(".rt-rules-used")).toContainText("24");
  await expect(aws.getByText("Matched", { exact: true })).toBeHidden();
  await aws.getByRole("button", { name: "Performance" }).click();
  await expect(aws.getByText("Matched", { exact: true })).toBeVisible();
  await expect(aws.getByText("Overridden", { exact: true })).toBeVisible();
  await expect(aws.getByText("Last matched")).toBeVisible();

  await page.goto(story("list--figure-ready"));
  await expect(page.getByText(/63%/)).toBeVisible();
  await expect(
    page.getByText(
      "134 of 212 recent transactions are decided by a rule (waiting for review or posted in the last 90 days).",
    ),
  ).toBeVisible();
  // The facts behind it are under a disclosure.
  await expect(page.getByText("Waiting for review", { exact: true })).toBeHidden();
  await page.getByRole("button", { name: "How the rules are doing" }).click();
  await expect(page.getByText("Waiting for review", { exact: true })).toBeVisible();
});

test("no rules says what to do, and leaves the one action to the page's head", async ({ page }) => {
  await page.goto(story("list--empty"));
  await expect(page.getByText("No rules yet")).toBeVisible();
  // The page's head has the one "New rule": the empty list does not offer it a second time.
  await expect(page.getByRole("link", { name: "New rule" })).toHaveCount(0);
});

test("a book with nothing posted is the list alone: no figure, no facts, no classifier", async ({
  page,
}) => {
  await page.goto(story("list--empty-book"));
  await expect(page.getByText("No rules yet")).toBeVisible();
  await expect(page.getByText(/decided by a rule/)).toHaveCount(0);
  await expect(page.getByText(/to measure/)).toHaveCount(0);
  await expect(page.getByRole("button", { name: "How the rules are doing" })).toHaveCount(0);
  await expect(page.getByRole("heading", { name: "Suggested accounts" })).toHaveCount(0);
  await expect(page.getByText(/trained/)).toHaveCount(0);
  await expect(page.getByRole("button", { name: "Train now" })).toHaveCount(0);
  await expect(page.getByRole("button", { name: "Advanced" })).toHaveCount(0);
});

test("the classifier has nothing to press, except when a history is too long to learn from on its own", async ({
  page,
}) => {
  // The card is a fold, shut at rest: the page is the list of rules.
  const open = () => page.getByRole("button", { name: "Suggested accounts" }).click();
  await page.goto(story("classifier--ready"));
  await open();
  await expect(page.getByText(/Learned from 1,204 transactions across 14 accounts/)).toBeVisible();
  await expect(page.getByRole("heading", { name: "How well it does on your books" })).toBeVisible();
  await expect(page.getByRole("button", { name: "Train now" })).toHaveCount(0);
  await page.goto(story("classifier--not-ready"));
  await open();
  // Too little to score: the measurement is not shown, and nothing says it is missing.
  await expect(page.getByText(/Learned from 2 transactions/)).toBeVisible();
  await expect(page.getByRole("heading", { name: "How well it does on your books" })).toHaveCount(
    0,
  );
  await expect(page.getByText(/nothing to measure/)).toHaveCount(0);
  await page.goto(story("classifier--long-history"));
  await open();
  await expect(page.getByText(/more than it learns from on its own at once/)).toBeVisible();
  await expect(page.getByRole("button", { name: "Train now" })).toBeVisible();
  await expect(page.getByText(/trained/)).toHaveCount(0);
});

test("a rule that cannot be applied is flagged in words", async ({ page }) => {
  await page.goto(story("list--default"));
  const row = page.locator("tbody tr", { hasText: "Old vendor" });
  await expect(row.getByText("Needs attention")).toBeVisible();
  await expect(row.getByText("Subscriptions is closed").first()).toBeVisible();
});

test("conditions are added, changed and removed, and an amount test shows its boxes", async ({
  page,
}) => {
  await page.goto(story("editor--new-rule"));
  await page.getByRole("button", { name: "Add a condition" }).first().click();
  // The new row's first control has focus.
  await expect(page.getByLabel("Condition 2: What to test")).toBeFocused();
  await pick(page, page.getByLabel("Condition 2: What to test"), { value: "amount" });
  // "is between" shows two boxes; "is at least" shows one.
  await expect(page.getByLabel("Condition 2: At least")).toBeVisible();
  await expect(page.getByLabel("Condition 2: At most")).toBeVisible();
  await pick(page, page.getByLabel("Condition 2: How"), { value: "atLeast" });
  await expect(page.getByLabel("Condition 2: At least")).toBeVisible();
  await expect(page.getByLabel("Condition 2: At most")).toHaveCount(0);
  await pick(page, page.getByLabel("Condition 2: How"), { value: "exactly" });
  await expect(page.getByLabel("Condition 2: Amount")).toBeVisible();
  // With two conditions the rule says how they combine.
  await expect(page.getByLabel("Match")).toBeVisible();
  await page.getByRole("button", { name: "Remove condition 2" }).click();
  await expect(page.getByLabel("Condition 2: What to test")).toHaveCount(0);
  await expect(page.getByLabel("Match")).toHaveCount(0);
  // Focus goes to a control that is still there.
  await expect(page.getByRole("button", { name: "Add a condition" }).first()).toBeFocused();
});

test("a text test offers the negated operators in words", async ({ page }) => {
  await page.goto(story("editor--new-rule"));
  const how = page.getByLabel("Condition 1: How");
  await expect(how).toBeVisible();
  await how.click();
  await expect(page.getByRole("option").first()).toBeVisible();
  const labels = await page.getByRole("option").allTextContents();
  expect(labels).toContain("does not contain");
  expect(labels).toContain("contains the word");
  expect(labels).toContain("does not start with");
});

test("a group holds its own conditions and can be removed", async ({ page }) => {
  await page.goto(story("editor--new-rule"));
  await page.getByRole("button", { name: "Add a group" }).click();
  await expect(page.getByLabel("Group 1, condition 1: What to test")).toBeFocused();
  await page.getByRole("button", { name: "Add a condition to group 1" }).click();
  await expect(page.getByLabel("Group 1, condition 2: What to test")).toBeFocused();
  await page.getByRole("button", { name: "Remove group 1", exact: true }).click();
  await expect(page.getByLabel("Group 1, condition 1: What to test")).toHaveCount(0);
});

test("only one part of a split can take the rest", async ({ page }) => {
  await page.goto(story("editor--split"));
  const first = page.getByLabel("Part 1: Takes");
  const second = page.getByLabel("Part 2: Takes");
  await expect(second).toHaveAttribute("data-value", "rest");
  await pick(page, first, { value: "rest" });
  await expect(first).toHaveAttribute("data-value", "rest");
  await expect(second).toHaveAttribute("data-value", "percent");
  // The part that takes the rest has no number of its own.
  await expect(page.getByLabel("Part 1: Percent")).toHaveCount(0);
  await expect(page.getByLabel("Part 2: Percent")).toBeVisible();
});

test("a description field is inserted where the cursor is", async ({ page }) => {
  await page.goto(story("editor--categorize"));
  const narration = page.getByLabel("Description for the entry");
  await narration.fill("Software: ");
  await narration.focus();
  await page.keyboard.press("End");
  await page.getByRole("button", { name: "Insert {date}" }).click();
  await expect(narration).toHaveValue("Software: {date}");
  await expect(narration).toBeFocused();
});

test("Enter in the try-a-transaction box tries it instead of saving the rule", async ({ page }) => {
  await page.goto(story("editor--categorize"));
  await page.getByLabel("Description", { exact: true }).last().fill("GITHUB 1");
  let submitted = false;
  await page.exposeFunction("markSubmitted", () => {
    submitted = true;
  });
  await page.evaluate(() => {
    document.querySelector("form")?.addEventListener("submit", () => {
      (window as unknown as { markSubmitted: () => void }).markSubmitted();
    });
  });
  await page.getByLabel("Description", { exact: true }).last().press("Enter");
  expect(submitted).toBe(false);
});

test("every Rules story passes the accessibility scan in both themes and fits a phone", async ({
  context,
  request,
}) => {
  test.setTimeout(600_000);
  const index = await request.get("/index.json");
  const entries = (await index.json()).entries as Record<string, { type: string }>;
  const ids = Object.keys(entries)
    .filter((id) => entries[id]?.type === "story" && id.startsWith("lanes-rules-"))
    .sort();
  expect(ids.length).toBeGreaterThan(30);
  const errors: string[] = [];
  for (const theme of ["light", "dark"] as const) {
    for (const width of [1280, 390]) {
      // A page of its own for each theme and width: over two hundred stories in one page wear a browser's
      // renderer out, and a crash would be taken for a failing story.
      const page = await context.newPage();
      page.on("pageerror", (error) => errors.push(error.message));
      await page.setViewportSize({ width, height: 900 });
      for (const id of ids) {
        await page.goto(`/iframe.html?id=${id}&viewMode=story&globals=theme:${theme}`);
        await expect(page.locator("#storybook-root > *").first()).toBeAttached();
        await page.addScriptTag({ content: axe.source });
        const result = await page.evaluate(() =>
          window.axe.run(document.querySelector("#storybook-root") as HTMLElement, {
            runOnly: { type: "tag", values: ["wcag2a", "wcag2aa", "wcag21aa"] },
          }),
        );
        expect(
          result.violations.map(({ id: rule, nodes }) => ({
            id: rule,
            targets: nodes.map((node) => node.target),
          })),
          `${id} (${theme}, ${width}px)`,
        ).toEqual([]);
        if (width === 390) {
          const overflow = await page.evaluate(
            () => document.documentElement.scrollWidth - document.documentElement.clientWidth,
          );
          expect(
            overflow,
            `${id} (${theme}) is wider than a phone by ${overflow}px`,
          ).toBeLessThanOrEqual(0);
        }
      }
      await page.close();
    }
  }
  expect(errors).toEqual([]);
});
