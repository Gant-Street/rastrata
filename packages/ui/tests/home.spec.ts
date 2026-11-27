import { expect, type Page, test } from "@playwright/test";

// The Home components against fictional data in Storybook. (Every story is also swept for axe in both
// themes by lane-stories.spec.ts; the page against the real service is in apps/web, tests/browser.)
const story = (group: string, id: string) =>
  `/iframe.html?id=lanes-uxhome-${group}--${id}&viewMode=story`;
const start = (id: string) => story("start-of-a-new-book", id);
const needs = (id: string) => story("needs-you", id);
const money = (id: string) => story("money-in-and-out", id);
const home = (id: string) => story("home", id);

const fits = (page: Page) =>
  page.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth);

// ---- The start of a new book ---------------------------------------------------------------------

test("the start is one thing to do: a title, a sentence, one button, and the other way in beside it", async ({
  page,
}) => {
  await page.goto(start("connect-a-bank"));
  await expect(page.getByRole("heading", { name: "Add your bank to start" })).toBeVisible();
  await expect(page.getByText("Its transactions come in for you to review.")).toBeVisible();
  const connect = page.getByRole("link", { name: "Connect a bank", exact: true });
  await expect(connect).toHaveAttribute("href", "#banks");
  await expect(connect).toHaveAttribute("data-variant", "primary");
  const other = page.getByRole("link", { name: "Import a statement", exact: true });
  await expect(other).toHaveAttribute("href", "#import");
  // The other way in is a second, quieter button on the main one's line: a way to do something is a button.
  await expect(page.locator(".rt-start .rt-button")).toHaveCount(2);
  await expect(other).toHaveAttribute("data-variant", "secondary");
  const button = await connect.boundingBox();
  const link = await other.boundingBox();
  expect(link?.x).toBeGreaterThan((button?.x ?? 0) + (button?.width ?? 0));
  expect(
    Math.abs(
      (link?.y ?? 0) + (link?.height ?? 0) / 2 - ((button?.y ?? 0) + (button?.height ?? 0) / 2),
    ),
  ).toBeLessThan(4);
  // No list of steps, and nothing ticked.
  await expect(page.getByText("Finish setting up")).toHaveCount(0);
  await expect(page.getByRole("list", { name: "Setup steps" })).toHaveCount(0);
});

test("under the start, one row for each person it might be for, and the row is the link", async ({
  page,
}) => {
  await page.goto(start("connect-a-bank"));
  const lines = page.locator(".rt-start-lines").getByRole("listitem");
  await expect(lines).toHaveCount(2);
  await expect(lines.nth(0)).toContainText("Moving from another system");
  await expect(lines.nth(1)).toContainText("For the agent you already use");
  // No sentence carries a link: each row holds one link, and it is the whole row.
  await expect(page.locator(".rt-start-lines li > a.rt-start-row")).toHaveCount(2);
  await expect(
    page.getByRole("link", { name: "Bring in your books", exact: true }),
  ).toHaveAttribute("href", "#bring-in");
  await expect(page.getByRole("link", { name: "Connect an agent", exact: true })).toHaveAttribute(
    "href",
    "#agent",
  );
  // With no line to say, there is no list and no rule over nothing.
  await page.goto(start("no-quiet-lines"));
  await expect(page.getByRole("heading", { name: "Add your bank to start" })).toBeVisible();
  await expect(page.locator(".rt-start-lines")).toHaveCount(0);
});

test("where no bank can be connected the statement file is the one way in", async ({ page }) => {
  await page.goto(start("import-a-statement"));
  await expect(page.getByRole("heading", { name: "Import a statement to start" })).toBeVisible();
  await expect(page.getByRole("link", { name: "Import a statement", exact: true })).toHaveAttribute(
    "data-variant",
    "primary",
  );
  await expect(page.locator(".rt-start .rt-button")).toHaveCount(1);
});

test("on a phone the start fits, with both ways in", async ({ page }) => {
  await page.setViewportSize({ width: 360, height: 800 });
  await page.goto(start("at-phone-width"));
  await expect(page.getByRole("heading", { name: "Add your bank to start" })).toBeVisible();
  await expect(page.getByRole("link", { name: "Connect a bank", exact: true })).toBeVisible();
  await expect(page.getByRole("link", { name: "Import a statement", exact: true })).toBeVisible();
  expect(await fits(page)).toBe(true);
});

// ---- Needs you ------------------------------------------------------------------------------------

test("each row is one sentence and one verb, in the order given, and the heading counts them", async ({
  page,
}) => {
  await page.goto(needs("three-things"));
  await expect(page.getByRole("heading", { name: /^Needs you/ })).toBeVisible();
  const list = page.getByRole("list", { name: "Things that need you" });
  const items = list.getByRole("listitem");
  await expect(items).toHaveCount(3);
  await expect(items.nth(0)).toContainText("8 transactions to review.");
  await expect(items.nth(1)).toContainText("5 things stand in the way of closing March 2026.");
  await expect(items.nth(2)).toContainText("Your books have never been backed up.");
  // The first row is the next step: its verb is the one main button. The others are quieter buttons.
  const review = items.nth(0).getByRole("link", { name: "Review", exact: true });
  await expect(review).toHaveAttribute("href", "#inbox");
  await expect(review).toHaveAttribute("data-variant", "primary");
  await expect(list.locator('.rt-button[data-variant="primary"]')).toHaveCount(1);
  await expect(items.nth(1).getByRole("link")).toContainText("See what's left");
  await expect(items.nth(1).locator('a.rt-button[data-variant="secondary"]')).toHaveCount(1);
  await expect(items.nth(2).getByRole("link")).toContainText("Back up now");
  // The count is the chip beside the heading; a screen reader hears it in the heading.
  await expect(page.locator(".rt-needs-count")).toHaveText("3");
  await expect(page.getByRole("heading", { name: /^Needs you\s*, 3$/ })).toBeAttached();
  // The tone is said in words as well as drawn.
  await expect(items.nth(0)).toContainText("Needs attention:");
});

test("a verb is described by its sentence, so a list of links still says what each one is for", async ({
  page,
}) => {
  await page.goto(needs("three-things"));
  const describedBy = (name: RegExp) =>
    page
      .getByRole("link", { name })
      .evaluate((element) =>
        document
          .getElementById(element.getAttribute("aria-describedby") ?? "")
          ?.textContent?.trim(),
      );
  expect(await describedBy(/^Back up now/)).toContain("Your books have never been backed up.");
  // The main button too.
  expect(await describedBy(/^Review$/)).toContain("8 transactions to review.");
});

test("a failure has its own marker and says so in words", async ({ page }) => {
  await page.goto(needs("a-problem"));
  const first = page.getByRole("listitem").first();
  await expect(first.locator(".rt-tone-marker")).toHaveAttribute("data-tone", "problem");
  await expect(first).toContainText("Problem:");
  await expect(first).toContainText("2 Stripe payouts do not add up.");
});

test("five rows is the most, and what does not fit is counted and said", async ({ page }) => {
  await page.goto(needs("more-than-fit"));
  await expect(page.getByRole("listitem")).toHaveCount(5);
  await expect(page.locator(".rt-needs-count")).toHaveText("7");
  await expect(page.getByText("2 more things after these.")).toBeVisible();
});

test("nothing to do is said once every check was read; a new book says nothing needs it yet; reading says checking", async ({
  page,
}) => {
  await page.goto(needs("nothing-needs-you"));
  await expect(page.getByText("Nothing needs you right now.")).toBeVisible();
  await expect(page.locator(".rt-needs-count")).toHaveCount(0);
  await page.goto(needs("new-book"));
  await expect(page.getByText("Nothing needs you yet.")).toBeVisible();
  await page.goto(needs("checking"));
  await expect(page.getByRole("status").filter({ hasText: "Checking…" })).toBeVisible();
  await expect(page.locator("section.rt-needs")).toHaveAttribute("aria-busy", "true");
  await expect(page.getByText("Nothing needs you")).toHaveCount(0);
});

test("a check that could not be read is said, with a way to try again, and never reads as all clear", async ({
  page,
}) => {
  await page.goto(needs("something-could-not-be-checked"));
  await expect(page.getByRole("alert")).toContainText("Backups and Stripe could not be checked.");
  await expect(page.getByRole("button", { name: "Try again" })).toBeVisible();
  await expect(page.getByText("8 transactions to review.")).toBeVisible();
  await page.goto(needs("nothing-could-be-checked"));
  await expect(page.getByText("Nothing needs you right now.")).toHaveCount(0);
  await expect(page.getByRole("alert")).toContainText("What needs you could not be checked.");
});

test("on a narrow row a long sentence wraps and its verb stays beside it, on one line", async ({
  page,
}) => {
  for (const width of [390, 360]) {
    await page.setViewportSize({ width, height: 844 });
    await page.goto(needs("long-sentence-at-phone-width"));
    for (const row of await page.getByRole("listitem").all()) {
      const text = await row.locator(".rt-need-text").boundingBox();
      const verb = await row.getByRole("link").boundingBox();
      expect(verb?.x).toBeGreaterThan((text?.x ?? 0) + (text?.width ?? 0) - 1);
      // A verb is never broken over two lines.
      expect(verb?.height).toBeLessThan(40);
      // The sentence keeps room to be read: at least half the row.
      expect(text?.width).toBeGreaterThan(width * 0.35);
    }
    expect(await fits(page)).toBe(true);
  }
});

// ---- Money in and out -----------------------------------------------------------------------------

test("six months are drawn as two bars a month, to a scale whose top is an easy number", async ({
  page,
}) => {
  await page.goto(money("six-months"));
  await expect(page.getByRole("heading", { name: "Money in and out" })).toBeVisible();
  // The axis names the months: nothing else says how many there are.
  await expect(page.getByText("Last 6 months")).toHaveCount(0);
  const chart = page.getByRole("img", { name: /Bar chart of money in and money out/ });
  await expect(chart).toBeVisible();
  await expect(chart.locator(".rt-inout-col")).toHaveCount(6);
  await expect(chart.locator(".rt-inout-bar")).toHaveCount(12);
  await expect(chart.getByText("10,000")).toBeVisible();
  await expect(chart.getByText("5,000")).toBeVisible();
  await expect(chart.locator(".rt-inout-month")).toHaveText([
    "May",
    "Jun",
    "Jul",
    "Aug",
    "Sep",
    "Oct",
  ]);
  // September took in 9,360.00 on a scale that tops out at 10,000: the bar stands 93.6% of the plot.
  const plot = (await chart.locator(".rt-inout-plot").boundingBox())?.height ?? 0;
  const bar =
    (await chart.locator(".rt-inout-col").nth(4).locator('[data-series="in"]').boundingBox())
      ?.height ?? 0;
  expect(Math.abs(bar / plot - 0.936)).toBeLessThan(0.02);
  // The legend says which is which, and the second is hatched so no meaning rests on colour.
  const legend = page.locator(".rt-inout-legend");
  await expect(legend).toContainText("Money in");
  await expect(legend).toContainText("Money out");
  const hatch = await chart
    .locator('.rt-inout-bar[data-series="out"]')
    .first()
    .evaluate((element) => getComputedStyle(element).backgroundImage);
  expect(hatch).toContain("repeating-linear-gradient");
});

test("the same figures are a table for a screen reader, and no button swaps the drawing away", async ({
  page,
}) => {
  await page.goto(money("six-months"));
  const table = page.getByRole("table", { name: /Money in and out by month/ });
  await expect(table).toBeAttached();
  await expect(table.getByRole("row")).toHaveCount(7);
  const first = table.getByRole("row").nth(1);
  await expect(first.getByRole("rowheader")).toHaveText("May 2026");
  await expect(first.getByRole("cell").nth(0)).toHaveText("6,300.00");
  await expect(first.getByRole("cell").nth(1)).toHaveText("2,100.00");
  // The table is out of sight, the drawing says the table has its figures, and the section has no control.
  await expect(table).toHaveClass(/rt-sr-only/);
  await expect(
    page.getByRole("img", { name: /The table after it has the figures\.$/ }),
  ).toBeVisible();
  await expect(page.locator(".rt-inout").getByRole("button")).toHaveCount(0);
});

test("one line under the chart: the year's profit, or the figures of the month pointed at, in the same place", async ({
  page,
}) => {
  await page.goto(money("six-months"));
  const facts = page.locator(".rt-inout-facts");
  await expect(facts).toHaveText(/^This year so far\s*Profit 3,278\.41$/);
  await expect(facts.locator("dt")).toHaveCount(1);
  const before = await facts.boundingBox();
  await page.locator(".rt-inout-col").nth(2).hover();
  await expect(facts).toContainText("July 2026");
  await expect(facts).toContainText("In 5,200.00");
  await expect(facts).toContainText("Out 4,870.20");
  await expect(facts).not.toContainText("This year so far");
  // The month's line takes the year's place: nothing under it moves.
  expect(await facts.boundingBox()).toEqual(before);
  await page.mouse.move(0, 0);
  await expect(facts).toContainText("Profit 3,278.41");
});

test("a tap shows a month's figures and they stay; a second tap puts the year back", async ({
  browser,
}) => {
  const context = await browser.newContext({
    hasTouch: true,
    viewport: { width: 390, height: 844 },
  });
  const page = await context.newPage();
  await page.goto(money("at-phone-width"));
  const facts = page.locator(".rt-inout-facts");
  await expect(facts).toContainText("This year so far");
  const column = page.locator(".rt-inout-col").nth(4);
  await column.tap();
  await expect(facts).toContainText("September 2026");
  await expect(facts).toContainText("In 9,360.00");
  await column.tap();
  await expect(facts).toContainText("This year so far");
  await context.close();
});

test("an accrual book says income and expenses, not money", async ({ page }) => {
  await page.goto(money("accrual-book"));
  await expect(page.getByRole("heading", { name: "Income and expenses" })).toBeVisible();
  await expect(page.getByText("Money in", { exact: true })).toHaveCount(0);
  await expect(page.locator(".rt-inout-legend")).toContainText("Income");
  await expect(page.locator(".rt-inout-legend")).toContainText("Expenses");
});

test("a month before the books began is not a zero, and one that could not be read says so", async ({
  page,
}) => {
  await page.goto(money("books-began-recently"));
  const table = page.getByRole("table");
  await expect(table.getByText("Before your books began")).toHaveCount(3);
  await page.goto(money("one-month-could-not-be-read"));
  await expect(page.getByRole("table").getByText("Could not be read")).toHaveCount(1);
});

test("nothing recorded is one sentence, not an empty plot; reading and failing say so", async ({
  page,
}) => {
  await page.goto(money("nothing-recorded"));
  await expect(page.getByText("Nothing recorded in these months yet.")).toBeVisible();
  await expect(page.locator(".rt-inout-chart")).toHaveCount(0);
  await page.goto(money("reading"));
  await expect(
    page.getByRole("status").filter({ hasText: "Reading the last six months…" }),
  ).toBeVisible();
  await page.goto(money("failed"));
  await expect(page.getByRole("alert")).toContainText("Money in and out could not be read");
  await expect(page.getByRole("button", { name: "Try again" })).toBeVisible();
});

test("a loss keeps its sign, and seven-figure months do not widen the page", async ({ page }) => {
  await page.goto(money("a-loss-so-far"));
  await expect(page.locator(".rt-inout-facts")).toContainText("Profit −1,204.55");
  await page.goto(money("big-numbers"));
  expect(await fits(page)).toBe(true);
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto(money("at-phone-width"));
  expect(await fits(page)).toBe(true);
  await expect(page.locator(".rt-inout-col")).toHaveCount(6);
});

// ---- The page --------------------------------------------------------------------------------------

test("on a wide page what needs you and the money sit side by side, and on a phone they stack", async ({
  page,
}) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto(home("working-day"));
  const needsBox = await page.locator("section.rt-needs").boundingBox();
  const moneyBox = await page.locator("section.rt-inout").boundingBox();
  expect(Math.abs((needsBox?.y ?? 0) - (moneyBox?.y ?? 99))).toBeLessThan(2);
  expect(moneyBox?.x).toBeGreaterThan((needsBox?.x ?? 0) + (needsBox?.width ?? 0) - 1);
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto(home("at-phone-width"));
  const stackedNeeds = await page.locator("section.rt-needs").boundingBox();
  const stackedMoney = await page.locator("section.rt-inout").boundingBox();
  expect(stackedMoney?.y).toBeGreaterThan((stackedNeeds?.y ?? 0) + (stackedNeeds?.height ?? 0) - 1);
  expect(await fits(page)).toBe(true);
});

test("a new book's page is the start alone: no section with nothing to say", async ({ page }) => {
  await page.goto(home("new-book"));
  await expect(page.getByRole("heading", { level: 1, name: "Today" })).toBeVisible();
  await expect(page.getByRole("heading", { name: "Add your bank to start" })).toBeVisible();
  await expect(page.getByRole("heading", { level: 2 })).toHaveCount(1);
  await expect(page.locator(".rt-needs, .rt-inout, .rt-tiles, .rt-need")).toHaveCount(0);
  await expect(page.getByText(/Nothing (needs you|recorded)/)).toHaveCount(0);
  await expect(page.locator('.rt-today .rt-button[data-variant="primary"]')).toHaveCount(1);
  for (const width of [390, 360]) {
    await page.setViewportSize({ width, height: 800 });
    await page.goto(home("new-book-at-phone-width"));
    await expect(page.getByRole("heading", { name: "Add your bank to start" })).toBeVisible();
    expect(await fits(page)).toBe(true);
  }
});

test("a working day is what needs you, the money, then the accounts, with one main button on the page", async ({
  page,
}) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto(home("working-day"));
  await expect(page.getByRole("heading", { level: 2 })).toHaveText([
    /^Needs you/,
    "Money in and out",
    "Accounts",
  ]);
  const needsBox = await page.locator("section.rt-needs").boundingBox();
  const tilesBox = await page.locator(".rt-tiles").boundingBox();
  expect(tilesBox?.y).toBeGreaterThan((needsBox?.y ?? 0) + (needsBox?.height ?? 0) - 1);
  await expect(page.locator('.rt-today .rt-button[data-variant="primary"]')).toHaveCount(1);
  // Nothing about the book under the title, and no list of setup steps.
  await expect(page.getByText(/Cash basis|Fiscal year/)).toHaveCount(0);
  await expect(page.getByText("Finish setting up")).toHaveCount(0);
});

test("before anything is posted there is no chart, and what needs you keeps its column", async ({
  page,
}) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto(home("first-import"));
  await expect(page.locator(".rt-inout")).toHaveCount(0);
  const needsBox = await page.locator("section.rt-needs").boundingBox();
  const whole = await page.locator(".rt-home-columns").boundingBox();
  expect(needsBox?.width).toBeLessThan((whole?.width ?? 0) * 0.6);
});

test("a book with everything done says nothing needs it, once", async ({ page }) => {
  await page.goto(home("all-quiet"));
  await expect(page.getByText("Nothing needs you right now.")).toBeVisible();
  // Nothing asks to be done: no main button. (A tile may still offer a quiet one, to connect Stripe.)
  await expect(page.locator('.rt-today .rt-button[data-variant="primary"]')).toHaveCount(0);
});
