import { expect, type Page, test } from "@playwright/test";
import axe from "axe-core";

declare global {
  interface Window {
    axe: typeof axe;
  }
}

// One fresh book, driven the way a person would: backed up, checked with progress, tested, exported,
// with a lost reply and the settings. Every write goes through the real local API, whose first answer
// to a long job is "running" (RASTRATA_SAFETY_WAIT_MS=0), so the page's polling is what is tested.
const version = "rastrata-application-v1";
test.describe.configure({ mode: "serial" });

const setup = {
  name: "Safety Co",
  currency: "USD",
  fiscalYear: 2026,
  periodModel: "monthly",
  accounts: [
    { code: "1000", name: "Checking", role: "asset" },
    { code: "3000", name: "Capital", role: "equity" },
    { code: "4000", name: "Sales", role: "income" },
  ],
};

// biome-ignore lint/suspicious/noExplicitAny: tests read untyped JSON answers
type Api = (name: string, input: unknown, operationId?: string) => Promise<any>;

async function scan(page: Page, label: string) {
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

const theme = (page: Page, value: "light" | "dark") =>
  page.evaluate((chosen) => {
    document.documentElement.dataset.theme = chosen;
  }, value);

/** What the service answers while a replay is still going, for the operation identity asked about. */
const running = (operationId: string, kind: string, done: number) => ({
  version,
  bookId: "local-book",
  ok: true,
  operationId,
  data: {
    state: "running",
    kind,
    startedAt: new Date().toISOString(),
    stage: "Replaying the ledger",
    done,
    total: 1204,
    elapsedMs: 9000,
    remainingMs: 31_000,
  },
});

test("a book with no backup says so; backing up, checking, testing a restore and exporting each report what happened", async ({
  page,
  request,
}) => {
  test.setTimeout(120_000);
  const errors: string[] = [];
  page.on("pageerror", (error) => errors.push(error.message));
  const api: Api = async (name, input, operationId) => {
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

  // Home says there is no backup, and the way in.
  await page.goto("/");
  const need = page.locator('[data-need="backup"]');
  await expect(need).toContainText("Your books have never been backed up.");
  await need.getByRole("link", { name: /^Back up now/ }).click();
  await expect(page).toHaveURL(/\/settings\/backups$/);
  await expect(page.getByRole("heading", { name: "Backups and export", level: 1 })).toBeVisible();

  // The summary is the worst thing, in words, with what to do.
  await expect(
    page.getByRole("heading", { name: "Your books are not safely backed up" }),
  ).toBeVisible();
  await expect(page.getByText("This book has never been backed up.")).toBeVisible();
  await expect(page.getByText("No backups yet")).toBeVisible();
  await expect(page.getByRole("button", { name: "Check the newest backup" })).toBeDisabled();
  await expect(page.getByText("Back up first: there is no backup to use.")).toBeVisible();
  await scan(page, "no backup (light)");

  // Back up now, from the keyboard: the answer takes focus.
  await page.getByRole("button", { name: "Back up now", exact: true }).focus();
  await page.keyboard.press("Enter");
  const made = page.getByRole("region", { name: /Backup made/ });
  await expect(made).toBeVisible({ timeout: 30_000 });
  await expect(made.getByRole("heading", { name: "Backup made" })).toBeFocused();
  await expect(
    page.getByRole("table", { name: "Backups, newest first" }).getByRole("row"),
  ).toHaveCount(2);
  await expect(page.getByRole("table")).toContainText("By you");
  await expect(page.getByRole("table")).toContainText("Not checked");
  // The screen no longer calls the books unsafe: there is a backup, which is not yet checked.
  await expect(page.getByRole("heading", { name: "Your backups need attention" })).toBeVisible();
  await expect(page.getByText("No backup has passed verification.")).toBeVisible();

  // Checking shows progress and an honest estimate. The first two answers are the replay in
  // progress; the third reaches the real job.
  let asked = 0;
  await page.route("**/v1/backup.verify", async (route) => {
    asked += 1;
    const body = route.request().postDataJSON() as { operationId: string };
    if (asked <= 2)
      await route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify(running(body.operationId, "verify", 340 * asked)),
      });
    else await route.continue();
  });
  await page.getByRole("button", { name: "Check the newest backup" }).click();
  const progress = page.getByRole("region", { name: "Checking a backup" });
  await expect(progress).toBeVisible();
  await expect(progress.getByRole("progressbar")).toBeVisible();
  await expect(progress).toContainText("Replaying the ledger");
  await expect(progress).toContainText("340 of 1,204");
  await expect(progress).toContainText("about 31 s left (an estimate)");
  await expect(progress).toContainText("about a second for every thousand entries");
  await expect(progress).toContainText("Your books stay usable while this runs.");
  // While it runs the other actions wait, and say why.
  await expect(page.getByRole("button", { name: "Back up now", exact: true })).toBeDisabled();
  await page.screenshot({ path: test.info().outputPath("backups-checking.png"), fullPage: true });
  const checked = page.getByRole("region", { name: /The backup passed every check/ });
  await expect(checked).toBeVisible({ timeout: 60_000 });
  await expect(
    checked.getByRole("heading", { name: "The backup passed every check" }),
  ).toBeFocused();
  await expect(
    checked.getByRole("list", { name: "What was checked" }).getByRole("listitem"),
  ).toHaveCount(6);
  await expect(checked).toContainText("Every entry replays to the result it had");
  expect(asked).toBeGreaterThanOrEqual(3);
  await page.unroute("**/v1/backup.verify");
  await expect(
    page.getByRole("heading", { name: "Your books are backed up and the backup has been checked" }),
  ).toBeVisible();
  await expect(page.getByRole("table")).toContainText("Passed");
  await checked.getByRole("button", { name: "Dismiss" }).click();
  await expect(checked).toHaveCount(0);

  // A restore test compares the restored copy with the live books and says what it compared.
  await page.getByRole("button", { name: "Test a restore", exact: true }).click();
  const drilled = page.getByRole("region", { name: /The restore test passed/ });
  await expect(drilled).toBeVisible({ timeout: 60_000 });
  await expect(drilled).toContainText("Compared 3 accounts with your books");
  await expect(drilled).toContainText("Every account balance matches your books");
  await expect(page.getByText("Passed just now")).toBeVisible();

  // The export names where the files are.
  await page.getByRole("button", { name: "Export my books" }).click();
  const exported = page.getByRole("region", { name: "Export written" });
  await expect(exported).toBeVisible({ timeout: 60_000 });
  await expect(exported).toContainText("exports");
  await expect(page.getByRole("list").filter({ hasText: "2 entries, 3 accounts" })).toBeVisible();
  await expect(page.getByText("shasum -a 256 -c SHA256SUMS")).toBeVisible();

  // Both themes pass the accessibility scan, with the checks and the table on screen.
  await theme(page, "light");
  await scan(page, "backups (light)");
  await theme(page, "dark");
  await scan(page, "backups (dark)");
  await theme(page, "light");
  await page.screenshot({
    path: test.info().outputPath("backups-desktop-light.png"),
    fullPage: true,
  });
  await theme(page, "dark");
  await page.screenshot({
    path: test.info().outputPath("backups-desktop-dark.png"),
    fullPage: true,
  });
  await theme(page, "light");

  // Home no longer asks for a backup: the book says a backup was verified.
  await page.goto("/");
  await expect(page.locator(".rt-today")).toHaveAttribute("data-read", "");
  await expect(page.locator('[data-need="backup"]')).toHaveCount(0);
  expect(errors).toEqual([]);
});

test("a lost reply keeps the job: reconnecting reaches the same one and never makes a second backup", async ({
  page,
  request,
}) => {
  test.setTimeout(90_000);
  const api: Api = async (name, input, operationId) => {
    const response = await request.post(`/v1/${name}`, {
      data: { version, bookId: "local-book", input, ...(operationId ? { operationId } : {}) },
    });
    const body = await response.json();
    expect(body.ok, JSON.stringify(body.error)).toBe(true);
    return body.data;
  };
  // Something to back up that the newest backup does not hold.
  const draft = await api(
    "drafts.create",
    {
      data: {
        date: "2026-01-09",
        reference: "Late sale",
        narration: "Late sale",
        lines: [
          { accountId: "1000", debit: "75.00", credit: "" },
          { accountId: "4000", debit: "", credit: "75.00" },
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

  await page.goto("/settings/backups");
  await expect(page.getByRole("heading", { name: "Backups and export", level: 1 })).toBeVisible();
  const rows = page.getByRole("table", { name: "Backups, newest first" }).getByRole("row");
  const before = await rows.count();
  await expect(page.getByText("1 change since")).toBeVisible();

  // The service does the work but the reply is lost.
  await page.route("**/v1/backup.create", async (route) => {
    await route.fetch();
    await route.abort("failed");
  });
  await page.getByRole("button", { name: "Back up now", exact: true }).click();
  await expect(page.getByText("The connection dropped")).toBeVisible();
  await expect(page.getByRole("button", { name: "Reconnect" })).toBeVisible();
  await page.unroute("**/v1/backup.create");
  await page.reload();
  // A reload reaches the retained job by itself.
  const made = page.getByRole("region", { name: "Backup made" });
  await expect(made).toBeVisible({ timeout: 30_000 });
  // The lost reply and the reload made exactly one backup between them, never a second.
  await expect(rows).toHaveCount(before + 1);
  await page.waitForTimeout(1500);
  await expect(rows).toHaveCount(before + 1);
  // Asking again on purpose makes another one: a person who asks for a backup gets one.
  await made.getByRole("button", { name: "Dismiss" }).click();
  await page.getByRole("button", { name: "Back up now", exact: true }).click();
  await expect(page.getByRole("region", { name: "Backup made" })).toBeVisible({ timeout: 30_000 });
  await expect(rows).toHaveCount(before + 2);
});

test("settings: an invalid answer is named beside its field and in a summary that links to it; a valid one is saved and kept", async ({
  page,
}) => {
  await page.goto("/settings/backups");
  const daily = page.getByLabel("Daily backups to keep");
  await expect(daily).toHaveValue("7");
  await daily.fill("");
  await page.getByRole("button", { name: "Save settings" }).click();
  const summary = page.getByRole("region", { name: "There is a problem" });
  await expect(summary).toBeFocused();
  await summary
    .getByRole("link", { name: /Daily backups to keep must be a whole number from 1 to 365/ })
    .click();
  await expect(daily).toBeFocused();
  await expect(page.getByText("must be a whole number from 1 to 365").first()).toBeVisible();

  // Warn must be at least as long as the interval.
  await daily.fill("5");
  await page.getByLabel("Back up every (hours)").fill("48");
  await page.getByLabel("Warn me when no backup has been checked for (hours)").fill("24");
  await page.getByRole("button", { name: "Save settings" }).click();
  await expect(
    page.getByRole("link", { name: /The warning time must be at least as long/ }),
  ).toBeVisible();

  await page.getByLabel("Back up every (hours)").fill("12");
  await page.getByLabel("Warn me when no backup has been checked for (hours)").fill("36");
  // Keeping fewer than before warns, because older automatic backups are then deleted.
  await expect(
    page.getByText("Keeping fewer backups deletes older automatic backups"),
  ).toBeVisible();
  await page.getByRole("button", { name: "Save settings" }).click();
  await expect(page.getByText("Settings saved")).toBeVisible();
  await page.reload();
  await expect(page.getByLabel("Daily backups to keep")).toHaveValue("5");
  await expect(page.getByLabel("Back up every (hours)")).toHaveValue("12");
});

test("narrow screens: nothing scrolls the page sideways and the table scrolls inside itself, in both themes", async ({
  page,
}) => {
  await page.setViewportSize({ width: 390, height: 844 });
  for (const value of ["light", "dark"] as const) {
    await page.goto("/settings/backups");
    await expect(page.getByRole("heading", { name: "Backups and export", level: 1 })).toBeVisible();
    await theme(page, value);
    await expect
      .poll(() => page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth))
      .toBe(true);
    await scan(page, `backups phone (${value})`);
    if (value === "light")
      await page.screenshot({
        path: test.info().outputPath("backups-phone-light.png"),
        fullPage: true,
      });
  }
  await page.goto("/");
  await expect
    .poll(() => page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth))
    .toBe(true);
});
