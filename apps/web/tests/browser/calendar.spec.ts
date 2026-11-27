import { expect, test, type APIRequestContext, type Locator, type Page } from "@playwright/test";
import axe from "axe-core";
import { fillReverse, openReverse } from "../support/accounting";
import { fillEntry, postEntry } from "../support/entry-form";
import { shown } from "../support/shown";
import { putAway } from "../support/pick";
declare global {
  interface Window {
    axe: typeof axe;
  }
}

// Close the books, driven the way a person would, against a fresh book on the real local API: an
// October cash book that began in fiscal year 2024, so a fiscal year is not a calendar year and the
// book's own fiscal years 2024 and 2025 are both over. The calendar is extended through the screen,
// a year is closed in order, one period is reopened (and the closes after it are shown as
// superseded), the year is closed again, and a reply lost while a year is being closed is resumed
// rather than repeated. Every status the screen shows is checked against what the API says.
const version = "rastrata-application-v1";
test.describe.configure({ mode: "serial" });

const setup = {
  name: "Harbor Studio",
  currency: "USD",
  fiscalYear: 2024,
  // One fiscal year, the calendar these tests describe, whatever day they run on.
  calendarThrough: 2024,
  fiscalYearStartMonth: 10,
  basis: "cash",
  periodModel: "monthly",
  accounts: [
    { code: "1000", name: "Operating cash", role: "asset", tags: { cashFlowClass: "cash" } },
    { code: "1100", name: "Equipment", role: "asset", tags: { cashFlowClass: "investing" } },
    { code: "3000", name: "Owner capital", role: "equity", tags: { cashFlowClass: "financing" } },
    { code: "4000", name: "Design fees", role: "income" },
    { code: "5000", name: "Supplies", role: "expense" },
  ],
};

async function api(request: APIRequestContext, name: string, input: unknown, operationId?: string) {
  const response = await request.post(`/v1/${name}`, {
    data: { version, bookId: "local-book", input, ...(operationId ? { operationId } : {}) },
  });
  const body = await response.json();
  expect(body.ok, JSON.stringify(body.error)).toBe(true);
  return body.data;
}

async function post(
  request: APIRequestContext,
  date: string,
  narration: string,
  lines: [string, string, string][],
) {
  const draft = await api(
    request,
    "drafts.create",
    {
      data: {
        date,
        reference: narration.slice(0, 40),
        narration,
        lines: lines.map(([accountId, debit, credit]) => ({ accountId, debit, credit })),
      },
    },
    crypto.randomUUID(),
  );
  const planId = crypto.randomUUID();
  const plan = await api(
    request,
    "journal.prepare",
    { draftId: draft.id, expectedVersion: 1 },
    planId,
  );
  await api(request, "operations.commit", { planId, planHash: plan.planHash });
}

type Listed = {
  calendar: {
    today: string;
    firstDate: string;
    lastDate: string;
    fiscalYears: { fiscalYear: number; status: string }[];
  };
  periods: {
    id: string;
    label: string;
    fiscalYear: number;
    status: string;
    closeSuperseded: boolean;
  }[];
  history: { periodId: string; kind: string; reason: string }[];
};
const listed = (request: APIRequestContext): Promise<Listed> => api(request, "periods.list", {});

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
const settle = async (page: Page, theme: "light" | "dark") => {
  await page.evaluate((value) => {
    document.documentElement.dataset.theme = value;
  }, theme);
  await page.addStyleTag({
    content: "*,*::before,*::after{transition:none!important;animation:none!important}",
  });
};
/** Scan the page as it is now, in both themes, and leave it in the light one. */
const scanBothThemes = async (page: Page, label: string) => {
  for (const theme of ["light", "dark"] as const) {
    await settle(page, theme);
    await scan(page, `${label} (${theme})`);
  }
  await settle(page, "light");
};
const noSideways = (page: Page) =>
  expect
    .poll(() => page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth))
    .toBe(true);
/** The card of Close the books, named by the month it closes through: "Through October 2024". */
const monthCard = (page: Page, label: string): Locator =>
  page.getByRole("region", { name: `Through ${label}`, exact: true });
/** The calendar's line and the history of closes are in a fold at the foot. */
const openCalendar = async (page: Page) => {
  const toggle = page.getByRole("button", { name: "Calendar and history" });
  if ((await toggle.getAttribute("aria-expanded")) !== "true") await toggle.click();
};
/** The months already closed are in a list that is shut until it is asked for. */
const openClosedMonths = async (page: Page) => {
  const toggle = page.getByRole("button", { name: /^Closed months/ });
  if ((await toggle.getAttribute("aria-expanded")) !== "true") await toggle.click();
};
const closedMonth = (page: Page, label: string): Locator =>
  page.locator(".rt-close-closed-list li").filter({ hasText: label });
const shot = (page: Page, name: string) =>
  page.screenshot({ path: test.info().outputPath(`${name}.png`), fullPage: true });
const checklistSettled = (page: Page) =>
  expect(page.getByRole("list", { name: "Before you close" }).getByText("Checking…")).toHaveCount(
    0,
  );

test("Home says what the first month still open waits for, and the year is one address away", async ({
  page,
  request,
}) => {
  const errors: string[] = [];
  page.on("pageerror", (error) => errors.push(error.message));
  await api(request, "book.setup", setup, crypto.randomUUID());
  await post(request, "2024-10-05", "Owner contribution", [
    ["1000", "5000.00", ""],
    ["3000", "", "5000.00"],
  ]);
  await post(request, "2024-11-10", "November design fees", [
    ["1000", "1200.00", ""],
    ["4000", "", "1200.00"],
  ]);
  await post(request, "2025-01-20", "Laptop", [
    ["1100", "2000.00", ""],
    ["1000", "", "2000.00"],
  ]);
  await post(request, "2025-03-03", "March design fees", [
    ["1000", "900.00", ""],
    ["4000", "", "900.00"],
  ]);

  // Home says what the first month still open waits for, as rows a person can act on: its account is
  // checked against the statement. The month itself is named once it can be closed.
  await page.goto("/");
  const reconcile = page.locator('[data-need="reconcile"]');
  await expect(reconcile).toContainText(/is ready to check against its October statement\./);
  await expect(page.locator('[data-need="close"]')).toHaveCount(0);
  await shot(page, "home");
  await reconcile.getByRole("link", { name: "Reconcile", exact: true }).click();
  await expect(page).toHaveURL(/\/reconcile\?account=/);
  // The year's own closing is one address away, and the heading takes focus.
  await page.goto("/periods?year=2024&flow=year-end");
  await expect(
    page.getByRole("heading", { name: "Close fiscal year 2024", level: 2 }),
  ).toBeFocused();
  expect(errors).toEqual([]);
});

test("the calendar is shown for the book's own fiscal year, and grows without a control on the page", async ({
  page,
  request,
}) => {
  const errors: string[] = [];
  page.on("pageerror", (error) => errors.push(error.message));
  await page.goto("/periods");
  await expect(page.getByRole("heading", { name: "Close the books", level: 1 })).toBeVisible();
  await openCalendar(page);
  await expect(page.getByText(`Covers ${shown.range("2024-10-01", "2025-09-30")}.`)).toBeVisible();
  await expect(page.getByText("Later years are added as your entries need them.")).toBeVisible();
  await expect(page.getByText("Each fiscal year starts in October")).toBeVisible();
  // Nothing on the page extends the calendar: a posting grows it itself.
  await expect(page.getByRole("button", { name: /^Extend/ })).toHaveCount(0);
  // The year has ended with every month open, so its fold is open without being asked.
  await expect(page.getByRole("heading", { name: "Fiscal year 2024", level: 2 })).toBeVisible();
  await expect(page.getByText("0 of 12 periods closed")).toBeVisible();
  // How far the books are closed, then one card: the first month that has ended with something in it, and
  // what is left for it. No other month has a card or a line; they close in order after it.
  await expect(page.getByText("Nothing is closed yet.")).toBeVisible();
  await expect(monthCard(page, "October 2024")).toBeVisible();
  await expect(monthCard(page, "October 2024")).toContainText(
    `Operating cash is not reconciled through ${shown.date("2024-10-31")}.`,
  );
  await expect(
    monthCard(page, "October 2024").getByRole("button", { name: "Close through October 2024" }),
  ).toBeDisabled();
  await expect(page.locator(".rt-close-card")).toHaveCount(1);
  await expect(page.getByText(/more open months/)).toHaveCount(0);
  await shot(page, "periods-overview");
  await scanBothThemes(page, "periods overview");

  // The next fiscal year is added ahead of time the way an agent or the command line does it (periods.extend,
  // prepared and committed); the page shows the longer calendar and the second year.
  const plan = await api(request, "periods.extend", { through: 2025 }, crypto.randomUUID());
  await api(request, "operations.commit", { planId: plan.planId, planHash: plan.planHash });
  await page.reload();
  await openCalendar(page);
  await expect(page.getByText(`Covers ${shown.range("2024-10-01", "2026-09-30")}.`)).toBeVisible();
  await page.getByLabel("Fiscal year", { exact: true }).click();
  await expect(page.getByRole("option")).toHaveCount(2);
  await putAway(page);
  const after = await listed(request);
  expect(after.calendar.lastDate).toBe("2026-09-30");
  expect(after.periods).toHaveLength(24);
  expect(errors).toEqual([]);
});

test("a fiscal year is closed in order from a checklist, with a reason, and shows as closed", async ({
  page,
  request,
}) => {
  const errors: string[] = [];
  page.on("pageerror", (error) => errors.push(error.message));
  await page.goto("/periods?year=2024");
  await expect(page.getByRole("heading", { name: "Fiscal year 2024", level: 2 })).toBeVisible();

  // Keyboard only: the button is reached and pressed from the keyboard, focus lands on the heading.
  await page.getByRole("button", { name: "Close fiscal year 2024", exact: true }).focus();
  await page.keyboard.press("Enter");
  const heading = page.getByRole("heading", { name: "Close fiscal year 2024", level: 2 });
  await expect(heading).toBeFocused();
  await expect(page).toHaveURL(/flow=year-end/);

  // The checklist reads the books, Reconcile, the month-end checklist and the Inbox through their own
  // operations, and says so for each line; nothing here blocks the close.
  await checklistSettled(page);
  const checklist = page.getByRole("list", { name: "Before you close" });
  await expect(checklist.getByRole("listitem")).not.toHaveCount(0);
  await expect(checklist).toContainText("Bank and card accounts are reconciled");
  await expect(checklist).toContainText("The month-end checklist for September 2025");
  await expect(checklist).toContainText("Nothing from this year is waiting for review");
  await expect(checklist).toContainText("Every period has ended");
  await expect(page.getByRole("heading", { name: "The year's figures", level: 3 })).toBeVisible();
  await expect(page.getByText("Net income", { exact: true })).toBeVisible();

  // A year cannot be reviewed without a reason: the summary names the field and links to it.
  await page.getByRole("button", { name: "Review the year-end" }).click();
  await expect(page.getByText("Say why you are closing the year.").first()).toBeVisible();
  await page.getByRole("link", { name: "Say why you are closing the year." }).click();
  await expect(page.getByRole("textbox", { name: /Reason for closing the year/ })).toBeFocused();

  await page.keyboard.type("FY2024 reviewed with the accountant");
  await page.keyboard.press("Enter");
  const planHeading = page.getByRole("heading", { name: "The year-end, in order", level: 3 });
  await expect(planHeading).toBeFocused();
  const plan = page.getByRole("table", { name: "The year-end, in order" });
  await expect(plan.getByRole("row")).toHaveCount(13);
  await expect(plan.getByRole("row", { name: /October/ })).toContainText("Close");
  await expect(page.getByText("12 periods close.")).toBeVisible();
  const confirm = page.getByRole("button", { name: "Close fiscal year 2024" });
  await expect(confirm).toBeEnabled();
  await shot(page, "year-end-plan");
  await scanBothThemes(page, "year-end flow");

  // The plan is only committed while it is the plan for the reason on screen.
  await page.getByRole("textbox", { name: /Reason for closing the year/ }).fill("Changed my mind");
  await expect(confirm).toBeDisabled();
  await expect(
    page.getByText("Inputs changed. Review a new plan before committing."),
  ).toBeVisible();
  await page
    .getByRole("textbox", { name: /Reason for closing the year/ })
    .fill("FY2024 reviewed with the accountant");
  await expect(confirm).toBeEnabled();

  await confirm.click();
  await expect(page.getByText("Fiscal year 2024 is closed")).toBeVisible();
  await expect(page.getByText(/12 periods closed, each with its own record/)).toBeVisible();
  await expect(page.getByRole("heading", { name: "The year-end, in order" })).toHaveCount(0);
  await page.getByRole("button", { name: "Back to the periods" }).last().click();
  // The year is closed, so the button that opened the flow is off: focus returns to the year.
  await expect(page.getByRole("heading", { name: "Fiscal year 2024", level: 2 })).toBeFocused();
  await expect(page.getByText("12 of 12 periods closed")).toBeVisible();
  // The books are closed through the end of the year; each closed month is in the shut list with its report.
  await expect(
    page.getByText(`Books are closed through ${shown.date("2025-09-30")}.`),
  ).toBeVisible();
  await page.getByRole("button", { name: "Closed months (12)" }).click();
  for (const label of ["October 2024", "January 2025", "September 2025"])
    await expect(closedMonth(page, label)).toBeVisible();
  await expect(page.getByRole("link", { name: "Closing report" })).toHaveCount(12);

  // What the screen says is what the book says: twelve closes, each with the year-end reason.
  const book = await listed(request);
  const year = book.periods.filter((period) => period.fiscalYear === 2024);
  expect(year.every((period) => period.status === "closed" && !period.closeSuperseded)).toBe(true);
  const closes = book.history.filter((entry) => entry.reason.startsWith("Year end FY2024"));
  expect(closes).toHaveLength(12);
  expect(closes.every((entry) => entry.kind === "close")).toBe(true);
  expect(errors).toEqual([]);
});

test("reopening a period names the closes it supersedes, and closing the year again puts them right", async ({
  page,
  request,
}) => {
  const errors: string[] = [];
  page.on("pageerror", (error) => errors.push(error.message));
  await page.goto("/periods?year=2024");
  await openClosedMonths(page);
  await page.getByRole("button", { name: "Reopen November 2024" }).click();
  const heading = page.getByRole("heading", { name: "Reopen November", level: 2 });
  await expect(heading).toBeFocused();
  const consequence = page.getByText(
    "Reopening this period supersedes the closes of 10 later periods",
  );
  await expect(consequence).toBeVisible();
  await expect(page.getByText(/December 2024, January 2025/)).toBeVisible();

  // A reopening needs a reason before anything is prepared.
  await page.getByRole("button", { name: "Review change" }).click();
  await expect(page.getByText("Say why you are making this change.").first()).toBeVisible();
  await page.getByLabel("Reason for change").fill("Late November invoice found");
  await page.getByRole("button", { name: "Review change" }).click();
  await expect(page.getByRole("heading", { name: "Review change", level: 2 })).toBeFocused();
  await expect(consequence).toBeVisible();
  await shot(page, "reopen-review");
  await scanBothThemes(page, "reopen review");
  await page.getByRole("button", { name: "Commit period change" }).click();
  await expect(
    page.getByRole("status").filter({ hasText: "November 2024 is open again." }),
  ).toBeVisible();
  await expect(page.locator("#rt-close-through")).toBeFocused();

  // November is open again, so it is the next month to close; every close after it is still locked but no
  // longer matches the books.
  await expect(monthCard(page, "November 2024")).toBeVisible();
  await openClosedMonths(page);
  await expect(closedMonth(page, "October 2024")).toBeVisible();
  await expect(closedMonth(page, "October 2024")).not.toContainText("no longer matches the books");
  await expect(closedMonth(page, "December 2024")).toContainText("no longer matches the books");
  await expect(closedMonth(page, "September 2025")).toContainText("no longer matches the books");
  await expect(page.getByText(/10 closes were superseded by a reopening/)).toBeVisible();
  await openCalendar(page);
  await expect(page.getByRole("list", { name: "Period change history" })).toContainText(
    "Late November invoice found",
  );
  await shot(page, "periods-superseded");
  await scanBothThemes(page, "superseded year");
  await settle(page, "dark");
  await shot(page, "periods-superseded-dark");
  await settle(page, "light");
  const mid = await listed(request);
  expect(mid.periods.filter((p) => p.fiscalYear === 2024 && p.closeSuperseded)).toHaveLength(10);
  expect(mid.periods.find((p) => p.fiscalYear === 2024 && p.label === "November")?.status).toBe(
    "open",
  );

  // Closing the year again reopens nothing by hand: November is closed, and each superseded period is
  // reopened and closed again, in order.
  await page.getByRole("button", { name: "Close fiscal year 2024 again" }).click();
  await checklistSettled(page);
  await page
    .getByRole("textbox", { name: /Reason for closing the year/ })
    .fill("FY2024 closed again");
  await page.getByRole("button", { name: "Review the year-end" }).click();
  const plan = page.getByRole("table", { name: "The year-end, in order" });
  await expect(plan.getByRole("row", { name: /November/ })).toContainText("Close");
  await expect(plan.getByRole("row", { name: /December/ })).toContainText("Reopen, then close");
  await expect(plan.getByRole("row", { name: /October/ })).toContainText("Already closed");
  await page.getByRole("button", { name: "Close fiscal year 2024" }).click();
  await expect(page.getByText("Fiscal year 2024 is closed")).toBeVisible();
  await expect(page.getByText(/11 periods closed/)).toBeVisible();
  await page.getByRole("button", { name: "Back to the periods" }).last().click();
  await expect(page.getByText("12 of 12 periods closed")).toBeVisible();
  const done = await listed(request);
  expect(
    done.periods
      .filter((p) => p.fiscalYear === 2024)
      .every((p) => p.status === "closed" && !p.closeSuperseded),
  ).toBe(true);
  expect(errors).toEqual([]);
});

test("a reply lost while a year is being closed is resumed after a reload, and nothing closes twice", async ({
  page,
  request,
}) => {
  const errors: string[] = [];
  page.on("pageerror", (error) => errors.push(error.message));
  await page.goto("/periods?year=2025&flow=year-end");
  await expect(
    page.getByRole("heading", { name: "Close fiscal year 2025", level: 2 }),
  ).toBeVisible();
  await checklistSettled(page);
  await page.getByRole("textbox", { name: /Reason for closing the year/ }).fill("FY2025 closed");
  await page.getByRole("button", { name: "Review the year-end" }).click();
  await expect(page.getByRole("button", { name: "Close fiscal year 2025" })).toBeEnabled();

  // The book commits every close and the reply never arrives.
  await page.route("**/v1/periods.commitYearEnd", async (route) => {
    await route.fetch();
    await route.abort("failed");
  });
  await page.getByRole("button", { name: "Close fiscal year 2025" }).click();
  await expect(page.getByText("The result is uncertain")).toBeVisible();
  await expect(page.getByRole("button", { name: "Resume original request" })).toBeVisible();
  await expect(page.getByRole("button", { name: "Close fiscal year 2025" })).toBeDisabled();
  await page.unroute("**/v1/periods.commitYearEnd");

  // A reload comes back to the same place with the same retained request, and resuming it reports
  // what the book did the first time.
  await page.reload();
  await expect(
    page.getByRole("heading", { name: "Close fiscal year 2025", level: 2 }),
  ).toBeVisible();
  await expect(page.getByText("The result is uncertain")).toBeVisible();
  await page.getByRole("button", { name: "Resume original request" }).click();
  await expect(page.getByText("Fiscal year 2025 is closed")).toBeVisible();
  await expect(page.getByText(/12 periods closed/)).toBeVisible();
  await expect(page.getByRole("button", { name: "Resume original request" })).toHaveCount(0);

  const book = await listed(request);
  const closes = book.history.filter((entry) => entry.reason.startsWith("Year end FY2025"));
  expect(closes).toHaveLength(12);
  expect(new Set(closes.map((entry) => entry.periodId)).size).toBe(12);
  expect(errors).toEqual([]);
});

test("the screens hold at a phone's width and Home reads the closed books", async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto("/periods?year=2024");
  await expect(page.getByText("12 of 12 periods closed")).toBeVisible();
  await noSideways(page);
  // The top of the screen as a phone shows it: how far the books are closed, and the year.
  await page.screenshot({ path: test.info().outputPath("periods-390.png") });
  await scanBothThemes(page, "periods at 390");
  await openClosedMonths(page);
  await page.getByRole("button", { name: "Reopen November 2024" }).click();
  await expect(page.getByRole("heading", { name: "Reopen November", level: 2 })).toBeFocused();
  await noSideways(page);
  await shot(page, "reopen-390");
  await page.getByRole("button", { name: "Cancel" }).click();
  await expect(page.getByRole("button", { name: "Reopen November 2024" })).toBeFocused();

  // The same review from the keyboard alone: Enter on the button, Tab to the reason, Enter to review.
  await page.keyboard.press("Enter");
  await expect(page.getByRole("heading", { name: "Reopen November", level: 2 })).toBeFocused();
  await page.keyboard.press("Tab");
  await expect(page.getByRole("textbox", { name: /Reason for change/ })).toBeFocused();
  await page.keyboard.type("Keyboard only");
  await page.keyboard.press("Enter");
  await expect(page.getByRole("heading", { name: "Review change", level: 2 })).toBeFocused();
  await page.getByRole("button", { name: "Cancel" }).click();
  await expect(page.getByRole("button", { name: "Reopen November 2024" })).toBeFocused();

  // A year with nothing left to close says so, and offers no form to fill in.
  await page.goto("/periods?year=2024&flow=year-end");
  await expect(
    page.getByRole("heading", { name: "Close fiscal year 2024", level: 2 }),
  ).toBeFocused();
  await expect(
    page.getByText("Every period of this year already has a current close"),
  ).toBeVisible();
  await expect(page.getByRole("button", { name: "Review the year-end" })).toBeHidden();
  await noSideways(page);
  await shot(page, "year-end-390");
  await scanBothThemes(page, "year-end at 390");
  await page.getByRole("button", { name: "Back to the periods" }).click();
  await expect(page.getByRole("heading", { name: "Fiscal year 2024", level: 2 })).toBeFocused();

  await page.goto("/");
  // Every ended period is closed, so there is no month to close; a calendar that has run out is not a
  // chore either, since a posting grows it itself.
  await expect(page.getByRole("heading", { name: "Needs you" })).toBeVisible();
  await expect(page.locator('[data-need="close"]')).toHaveCount(0);
  await expect(page.locator('[data-need="calendar"]')).toHaveCount(0);
  await noSideways(page);
  await scanBothThemes(page, "home");
});

test("an entry dated after the calendar's end posts and the calendar grows with it; one before the first day cannot", async ({
  page,
  request,
}) => {
  const errors: string[] = [];
  page.on("pageerror", (error) => errors.push(error.message));
  await page.goto("/journal/new");
  // A new entry starts today, held inside the book's calendar so the date can always be posted: this
  // October book ended before today, so it starts on the calendar's last day (and never on a date
  // before the book began).
  const { calendar } = await listed(request);
  const startsOn =
    calendar.today < calendar.firstDate
      ? calendar.firstDate
      : calendar.today > calendar.lastDate
        ? calendar.lastDate
        : calendar.today;
  const date = page.getByRole("textbox", { name: /^Date/ });
  await expect(date).toHaveValue(shown.dateBox(startsOn));
  await fillEntry(page, {
    reference: "EXT-1",
    description: "Entry outside the calendar",
    lines: [
      { code: "1000", debit: "10.00" },
      { code: "4000", credit: "10.00" },
    ],
  });

  // Before the book's first day nothing can help, and the screen says so in the books' words; the entry
  // is kept as typed.
  await date.fill("2024-09-30");
  await postEntry(page);
  await expect(
    page.getByText(/before the first day of the book's fiscal calendar/).first(),
  ).toBeVisible();
  await expect(page.getByText(`post on or after ${shown.date("2024-10-01")}`)).toBeVisible();
  await expect(page.getByRole("button", { name: /Extend the calendar through/ })).toHaveCount(0);
  await expect(date).toHaveValue(shown.dateBox("2024-09-30"));
  await expect(page.getByRole("textbox", { name: /^Reference/ })).toHaveValue("EXT-1");
  await scanBothThemes(page, "posting before the calendar");

  // After the last day, the entry posts in the one step, and the calendar now reaches its fiscal year.
  await date.fill("2026-10-15");
  await postEntry(page);
  await expect(page.getByRole("heading", { name: "Transactions", exact: true })).toBeVisible();
  await expect(page.getByRole("table")).toContainText("EXT-1");
  const book = await listed(request);
  expect(book.calendar.lastDate).toBe("2027-09-30");
  expect(errors).toEqual([]);
});

test("a reversal dated after the calendar's end posts, and the calendar grows with it", async ({
  page,
  request,
}) => {
  const errors: string[] = [];
  page.on("pageerror", (error) => errors.push(error.message));
  const before = await listed(request);
  await page.goto("/journal");
  // The first entry on the list (every entry of this book is posted, and a row says nothing of it), reversed
  // from its row.
  const reversing = await openReverse(page, /./, { first: true });
  // Well after the last day of the calendar: two fiscal years past the end, added as the reversal posts.
  await fillReverse(reversing, { date: "2029-03-15", reason: "Entered twice" });
  await reversing.getByRole("button", { name: "Reverse transaction" }).click();
  await expect(reversing).toBeHidden();
  await expect(page.getByRole("status").filter({ hasText: "Reversed" })).toBeVisible();
  await expect(page.getByText("That date is outside your calendar")).toHaveCount(0);
  const after = await listed(request);
  expect(after.calendar.lastDate > before.calendar.lastDate).toBe(true);
  expect(after.calendar.lastDate).toBe("2029-09-30");
  expect(errors).toEqual([]);
});
