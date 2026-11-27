import { createHash } from "node:crypto";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type APIRequestContext, expect, type Page, test } from "@playwright/test";
import axe from "axe-core";
import { shown } from "../support/shown";
declare global {
  interface Window {
    axe: typeof axe;
  }
}

// The Tax screen, driven the way a person would, against a fresh book on the real local API: a sole
// proprietor's 2026 on the real chart template with the online-business add-on (so the sales tax account is
// tagged), a few entries, and an account with no tax line. Every figure the screen shows is checked against
// what the API itself says, every file it saves is read back, and nothing is posted by anything the screen does.
const version = "rastrata-application-v1";
test.describe.configure({ mode: "serial" });

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
const theme = async (page: Page, value: "light" | "dark") => {
  await page.evaluate((next) => {
    document.documentElement.dataset.theme = next;
  }, value);
  await page.addStyleTag({
    content: "*,*::before,*::after{transition:none!important;animation:none!important}",
  });
};

/** The files of a stored zip, by name: read here from the format's own description, so a zip the screen
 * wrote is checked by something that is not the code that wrote it. */
function readZip(bytes: Buffer): Map<string, Buffer> {
  const end = bytes.length - 22;
  expect(bytes.readUInt32LE(end)).toBe(0x06054b50);
  const count = bytes.readUInt16LE(end + 10);
  let at = bytes.readUInt32LE(end + 16);
  const files = new Map<string, Buffer>();
  for (let index = 0; index < count; index++) {
    expect(bytes.readUInt32LE(at)).toBe(0x02014b50);
    expect(bytes.readUInt16LE(at + 10)).toBe(0);
    const size = bytes.readUInt32LE(at + 24);
    const nameLength = bytes.readUInt16LE(at + 28);
    const extraLength = bytes.readUInt16LE(at + 30);
    const commentLength = bytes.readUInt16LE(at + 32);
    const offset = bytes.readUInt32LE(at + 42);
    const name = bytes.subarray(at + 46, at + 46 + nameLength).toString("utf8");
    const localName = bytes.readUInt16LE(offset + 26);
    const localExtra = bytes.readUInt16LE(offset + 28);
    const start = offset + 30 + localName + localExtra;
    files.set(name, bytes.subarray(start, start + size));
    at += 46 + nameLength + extraLength + commentLength;
  }
  return files;
}

const sha = (data: Buffer | string) => createHash("sha256").update(data).digest("hex");

/** True when the page itself does not scroll sideways: a table may scroll inside its own region, the page may not. */
const fitsWidth = (page: Page) =>
  page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth);

async function download(page: Page, click: () => Promise<void>): Promise<Buffer> {
  const [saved] = await Promise.all([page.waitForEvent("download"), click()]);
  const path = await saved.path();
  return readFileSync(path);
}

const TODAY_YEAR = 2026;

test("before there is a book, the Tax screen says so plainly instead of erroring", async ({
  page,
}) => {
  const problems: string[] = [];
  page.on("pageerror", (error) => problems.push(error.message));
  // The browser's own line for a request the service answers with a status (a screen asking about a book
  // that does not exist yet) is not a broken page; any other console error is.
  page.on("console", (message) => {
    if (message.type() === "error" && !/^Failed to load resource/.test(message.text()))
      problems.push(message.text());
  });
  await page.goto("/tax");
  await expect(page.getByRole("heading", { level: 1, name: "Tax worksheet" })).toBeVisible();
  const notice = page.getByRole("status").filter({ hasText: "No book connected" });
  await expect(notice).toBeVisible();
  await expect(notice).toContainText("Set up a book first");
  await expect(notice.getByRole("link", { name: "Go to Home" })).toHaveAttribute("href", "/");
  // It is a state of the books, not a failure: no alert, no retry, none of the tools.
  await expect(page.getByRole("alert")).toHaveCount(0);
  await expect(page.getByRole("button", { name: "Try again" })).toHaveCount(0);
  await expect(page.getByRole("tab")).toHaveCount(0);
  expect(problems).toEqual([]);
});

test("a fresh book is set up with a year of entries", async ({ request }) => {
  const template = await api(request, "templates.get", {
    templateId: "sole-proprietor",
    basis: "cash",
    taxYear: TODAY_YEAR,
    addOns: ["online-business"],
  });
  // A template carries no bank or card line; the studio's bank account is added as a first import would add it.
  const accounts = [
    ...(template.accounts as Record<string, unknown>[]).map((account) => ({
      code: account.code,
      name: account.name,
      role: account.role,
      ...(account.parentCode ? { parentCode: account.parentCode } : {}),
      tags: account.tags,
    })),
    {
      code: "1000",
      name: "Studio Bank 1000",
      role: "asset",
      tags: { cashFlowClass: "cash", kind: "bank" },
    },
  ];
  await api(
    request,
    "book.setup",
    {
      name: "Fieldnote Studio",
      currency: "USD",
      fiscalYear: TODAY_YEAR,
      periodModel: "monthly",
      basis: "cash",
      accounts,
    },
    crypto.randomUUID(),
  );
  await post(request, "2026-01-15", "Owner investment", [
    ["1000", "20000.00", ""],
    ["3000", "", "20000.00"],
  ]);
  await post(request, "2026-02-10", "Design work for Northwind", [
    ["1000", "4000.00", ""],
    ["4000", "", "4000.00"],
  ]);
  await post(request, "2026-02-12", "Sale with sales tax", [
    ["1000", "108.00", ""],
    ["4000", "", "100.00"],
    ["2500", "", "8.00"],
  ]);
  await post(request, "2026-03-05", "Ads", [
    ["6000", "400.00", ""],
    ["1000", "", "400.00"],
  ]);
  await post(request, "2026-03-20", "Sales tax paid to the state", [
    ["2500", "5.00", ""],
    ["1000", "", "5.00"],
  ]);
  await post(request, "2026-05-10", "Lunch with a client", [
    ["6170", "171.00", ""],
    ["1000", "", "171.00"],
  ]);
  await post(request, "2026-06-10", "Pens and paper", [
    ["6140", "60.00", ""],
    ["1000", "", "60.00"],
  ]);
  // Supplies has a tax line from the template; take it away so the account has activity and no line.
  await api(
    request,
    "accounts.setTags",
    { accountId: "6140", effectiveOn: "2026-01-01", tags: { taxLine: null } },
    crypto.randomUUID(),
  );
});

test("the Tax screen opens on the year the book covers, with the checks first and the worksheet tied to the API", async ({
  page,
  request,
}) => {
  const errors: string[] = [];
  page.on("pageerror", (error) => errors.push(error.message));
  await page.goto("/tax");
  await expect(page.getByRole("heading", { level: 1, name: "Tax worksheet" })).toBeVisible();
  // One sentence under the title says what the tool is. Nothing explains the page: there is no "How this
  // works", and the dates of a calendar year are not said.
  await expect(
    page.getByText("Your books arranged by the lines of your return, for whoever prepares it."),
  ).toBeVisible();
  await expect(page.getByText("How this works")).toHaveCount(0);
  await expect(page.getByText(/Verify every figure/)).toHaveCount(0);
  await expect(page.getByRole("combobox", { name: "Tax year" })).toBeVisible();
  const checksRegion = page.getByRole("region", { name: "Checks on these figures" });
  await expect(checksRegion).toBeVisible();
  const checks = await api(request, "taxChecks.get", { taxYear: TODAY_YEAR });
  const entries = checks.checks as { key: string; title: string; status: string }[];
  // The service says six things need a look on this book, as it did before; the screen sorts them by what
  // each asks of the person. Orange is only for what would change the figures: here the account that has
  // activity and no tax line (its amount is on no line). The months, the reconciliations and the 1099
  // list are good practice, and the early release is a plain note. That the year is not over is not said.
  expect(entries.filter((entry) => entry.status !== "ok").map((entry) => entry.key)).toEqual(
    expect.arrayContaining(["periods", "unmapped", "draft", "year_not_ended"]),
  );
  const orange = checksRegion.locator('[data-severity="attention"]');
  await expect(orange).toHaveCount(1);
  // What it found is said once: the sentence, with no title above it that says the same.
  await expect(orange).toContainText("1 account has activity and no line from Schedule C");
  await expect(orange.getByText("Accounts with no tax line", { exact: true })).toHaveCount(0);
  // The link names what it fixes.
  await expect(orange.getByRole("link")).toHaveText("Add the missing tax line");
  await expect(orange.getByRole("link")).toHaveAttribute("href", "/accounts");
  // The facts about the figures are plain notes, not warnings.
  const notes = checksRegion.getByRole("list", { name: "About these figures" });
  await expect(notes).toContainText("IRS early-release draft");
  await expect(page.getByText("These are the figures so far.")).toHaveCount(0);
  await expect(notes.locator("[data-severity]")).toHaveCount(0);
  // Good practice is grey and closed behind a line that says how much of it is done.
  const goodPractice = checksRegion.getByRole("button", { name: "Good practice before you file" });
  await expect(goodPractice).toHaveAttribute("aria-expanded", "false");
  // Everything that is neither a note nor orange is good practice; the line says how much of it is done.
  const goodPractice_ = entries.filter(
    (entry) =>
      !["draft", "books_start", "year_not_ended"].includes(entry.key) &&
      !(["inbox", "unmapped", "sales"].includes(entry.key) && entry.status === "attention"),
  );
  const done = goodPractice_.filter((entry) => entry.status === "ok").length;
  await expect(checksRegion.locator(".rt-details-preview")).toHaveText(
    `${done} of ${goodPractice_.length} done`,
  );
  await expect(checksRegion.getByText("Months closed", { exact: true })).toBeHidden();
  await goodPractice.click();
  await expect(goodPractice).toHaveAttribute("aria-expanded", "true");
  for (const title of ["Months closed", "Accounts reconciled", "1099 vendors"])
    await expect(checksRegion.getByText(title, { exact: true })).toBeVisible();
  // A check that could not be made is not reported as done, and what is not done says what to do.
  const vendorsRow = checksRegion.locator('[data-check="vendors"]');
  await expect(vendorsRow).toContainText("Could not be checked");
  await expect(vendorsRow.getByRole("link")).toHaveText(
    "Mark the accounts that hold contractor payments",
  );
  const months = checksRegion.locator('[data-check="periods"]');
  await expect(months.getByRole("link")).toHaveText("Close the books");
  await expect(months.getByRole("link")).toHaveAttribute("href", "/periods");
  // No two links say the same thing, and none says "fix it".
  const names = await checksRegion.getByRole("link").allInnerTexts();
  expect(new Set(names).size).toBe(names.length);
  expect(names.some((name) => /fix it/i.test(name))).toBe(false);
  // The same facts are not said twice: the worksheet does not repeat the notes above it.
  await expect(page.getByText("An early-release IRS form")).toHaveCount(0);
  await expect(page.getByText("The year is not over", { exact: true })).toHaveCount(0);

  // The worksheet: every figure is the API's.
  const worksheet = await api(request, "taxWorksheet.get", { taxYear: TODAY_YEAR });
  const table = page.getByRole("table", { name: /Schedule C \(Form 1040\), 2026/ });
  await expect(table).toBeVisible();
  const lines = (
    worksheet.parts as {
      lines: { key: string; number: string; label: string; booked: string; amount: string }[];
    }[]
  ).flatMap((part) => part.lines);
  const gross = lines.find((line) => line.key === "scheduleC.line1");
  expect(gross?.amount).toBe("4100.00");
  await expect(table.getByRole("row", { name: /Gross receipts or sales/ })).toContainText(
    shown.money("4100.00"),
  );
  // Meals: booked at the full cost, on the form at half, and the screen says what it took off.
  const meals = lines.find((line) => line.key === "scheduleC.line24b");
  expect([meals?.booked, meals?.amount]).toEqual(["171.00", "85.50"]);
  const mealsRow = table.getByRole("row", { name: /Deductible meals/ });
  await expect(mealsRow).toContainText("171.00");
  await expect(mealsRow).toContainText("85.50");
  await expect(mealsRow).toContainText("50% taken");
  // The net line sits under the double rule and is the API's net profit.
  await expect(table.locator("tfoot")).toContainText(
    shown.money(worksheet.reconciliation.netProfit),
  );
  // The account that has activity and no line is listed with its amount, never guessed into a line.
  const unmapped = page.getByRole("region", {
    name: "Accounts with no line on this form",
    exact: true,
  });
  await expect(unmapped).toContainText("6140");
  await expect(unmapped).toContainText("60.00");
  await expect(unmapped).toContainText("It has no tax line.");
  // The worksheet ties to the profit and loss, row by row: the last row is the profit and loss's own net.
  const tie = page.getByRole("region", { name: "Ties to the profit and loss" });
  await expect(tie.getByRole("row").last()).toContainText(
    shown.money(worksheet.reconciliation.netIncomeBooks),
  );
  // What the service wrote about the figures, with where each rule was read, is one fold at the foot.
  const notesFold = page.getByRole("button", { name: "Notes and sources", exact: true });
  await expect(notesFold).toHaveAttribute("aria-expanded", "false");
  await expect(page.getByText(/^Business meals \(line 24b\)/)).toBeHidden();
  await notesFold.click();
  await expect(page.getByText(/^Business meals \(line 24b\)/)).toBeVisible();
  await expect(page.getByText(/^What this is:/)).toHaveCount(0);
  expect(errors).toEqual([]);
});

test("the accounts behind a line open from the keyboard and lead to the activity behind the amount", async ({
  page,
}) => {
  await page.goto("/tax");
  const toggle = page.getByRole("button", { name: /1 account/ }).first();
  await expect(toggle).toBeVisible();
  await toggle.focus();
  await expect(toggle).toHaveAttribute("aria-expanded", "false");
  await page.keyboard.press("Enter");
  await expect(toggle).toHaveAttribute("aria-expanded", "true");
  const list = page.locator(".rt-tax-accountlist").first();
  await expect(list).toContainText("4000");
  await expect(list).toContainText("Sales");
  // The amount is a link to the account's activity in the population the figure was read from.
  const link = list.getByRole("link").first();
  await expect(link).toHaveAttribute("href", /^\/ledger\?accountId=/);
  await link.click();
  await expect(page.getByRole("heading", { level: 1, name: "Sales" })).toBeVisible();
  await page.goBack();
  await expect(page.getByRole("heading", { level: 1, name: "Tax worksheet" })).toBeVisible();
});

test("the meals percentage and the form are kept in the address, and the figures stay in place while they are read again", async ({
  page,
  request,
}) => {
  await page.goto("/tax");
  const table = page.getByRole("table", { name: /Schedule C/ });
  await expect(table).toBeVisible();
  const select = page.getByRole("combobox", { name: /Business meals taken/ });
  await select.focus();
  const placed = await page.evaluate(() => {
    const kept = document.querySelector(".rt-tax-worksheet");
    (window as unknown as { detached: number }).detached = 0;
    new MutationObserver((records) => {
      for (const record of records)
        for (const node of record.removedNodes)
          if (kept && (node === kept || node.contains(kept)))
            (window as unknown as { detached: number }).detached += 1;
    }).observe(document.body, { childList: true, subtree: true });
    return kept !== null;
  });
  expect(placed).toBe(true);
  await select.click();
  await page.getByRole("option", { name: /80%/ }).click();
  await expect(page).toHaveURL(/meals=80/);
  const worksheet = await api(request, "taxWorksheet.get", {
    taxYear: TODAY_YEAR,
    mealsPercent: 80,
  });
  const meals = (worksheet.parts as { lines: { key: string; amount: string }[] }[])
    .flatMap((part) => part.lines)
    .find((line) => line.key === "scheduleC.line24b");
  expect(meals?.amount).toBe("136.80");
  await expect(table.getByRole("row", { name: /Deductible meals/ })).toContainText("136.80");
  // The page was never taken out and put back: the focus a person had is where they left it.
  expect(await page.evaluate(() => (window as unknown as { detached: number }).detached)).toBe(0);
  await page.goto("/tax?meals=80");
  await expect(
    page.getByRole("table", { name: /Schedule C/ }).getByRole("row", { name: /Deductible meals/ }),
  ).toContainText("136.80");
  await page.goto("/tax");
});

test("a year the book's calendar does not cover is said plainly, nothing of the other year is left under it, and the way back is on the screen", async ({
  page,
}) => {
  await page.goto("/tax");
  await expect(page.getByRole("table", { name: /Schedule C/ })).toBeVisible();
  await page.getByRole("combobox", { name: "Tax year" }).click();
  await page.getByRole("option", { name: "2025" }).click();
  const notice = page.getByRole("status").filter({ hasText: "does not cover this tax year" });
  await expect(notice).toBeVisible();
  // The service's own words say which date, and what range the book covers.
  await expect(notice).toContainText("outside the book's fiscal calendar");
  await expect(notice).toContainText(shown.date("2026-01-01"));
  // The calendar grows with the entries, so the notice sends nobody to extend it: it says so, and offers the year.
  await expect(notice).toContainText("a later one is covered once something is recorded in it");
  await expect(notice.getByRole("link")).toHaveCount(0);
  await expect(page).toHaveURL(/year=2025/);
  // The 2026 figures are not left on the screen under a 2025 heading.
  await expect(page.getByRole("table", { name: /Schedule C/ })).toHaveCount(0);
  await expect(page.getByRole("region", { name: "Checks on these figures" })).toHaveCount(0);
  await expect(page.getByRole("alert")).toHaveCount(0);
  await notice.getByRole("button", { name: "Let Rastrata choose the year" }).click();
  await expect(page.getByRole("table", { name: /Schedule C/ })).toBeVisible();
  await expect(page).not.toHaveURL(/year=/);
  // A link to a year the calendar does not cover lands on the same plain notice, not on an error.
  await page.goto("/tax?year=2025");
  await expect(
    page.getByRole("status").filter({ hasText: "does not cover this tax year" }),
  ).toBeVisible();
  await page.goto("/tax");
});

test("the worksheet is saved as a spreadsheet file exactly as the service made it", async ({
  page,
  request,
}) => {
  await page.goto("/tax");
  const saved = await download(page, () =>
    page.getByRole("button", { name: "Download the worksheet (CSV)" }).click(),
  );
  const exported = await api(request, "taxWorksheet.export", {
    taxYear: TODAY_YEAR,
    mealsPercent: 50,
  });
  // The download has a byte order mark for spreadsheets; the rest is the service's own file.
  expect(saved.subarray(0, 3).toString("hex")).toBe("efbbbf");
  expect(saved.subarray(3).toString("utf8")).toBe(exported.content);
  await expect(page.getByText(/^Saved schedule-c-worksheet-2026\.csv\.$/)).toBeVisible();
});

test("the year-end pack is built, shown file by file and saved as a zip whose every file is the one the manifest lists", async ({
  page,
  request,
}) => {
  await page.goto("/tax?tab=pack");
  await expect(page.getByRole("heading", { level: 1, name: "Year-end pack" })).toBeVisible();
  await page.getByRole("button", { name: "Build the pack" }).click();
  const built = await api(request, "taxPack.build", { taxYear: TODAY_YEAR, mealsPercent: 50 });
  await expect(
    page.getByText(`${built.files.length} files, all from one version of your books.`),
  ).toBeVisible();
  // What proves the pack is under Pack details, which says only its name until it is opened: then the book
  // revision and the manifest's SHA-256, with a Copy button on its row.
  await expect(page.locator(".rt-tax-pack-proof .rt-details-preview")).toHaveCount(0);
  expect(await page.locator("main").innerText()).not.toContain(built.manifestSha256);
  await page.getByRole("button", { name: "Pack details", exact: true }).click();
  await expect(page.locator(".rt-tax-pack-proof .rt-details-value[data-mono]")).toHaveText(
    built.manifestSha256,
  );
  await expect(
    page.locator(".rt-tax-pack-proof").getByRole("button", { name: /^Copy manifest SHA-256/ }),
  ).toBeVisible();
  const files = page.getByRole("region", { name: /Year-end pack/ }).first();
  for (const path of [
    "README.md",
    "statements/profit-and-loss.csv",
    "tax/schedule-c-worksheet.csv",
    "manifest.json",
  ])
    await expect(files).toContainText(path);
  // How final it is: nothing is closed yet, and the pack says so.
  await expect(page.getByText("No period in this range is closed")).toBeVisible();
  // The built pack, its file table and the sentence about how final it is, in both themes.
  await scan(page, "built pack (light)");
  await theme(page, "dark");
  await scan(page, "built pack (dark)");
  await theme(page, "light");
  await page.setViewportSize({ width: 390, height: 800 });
  expect(await fitsWidth(page), "the built pack at 390 px").toBe(true);
  await expect(files.locator(".rt-tax-files").getByText("README.md")).toBeVisible();
  await page.setViewportSize({ width: 1280, height: 720 });
  const saved = await download(page, () =>
    page.getByRole("button", { name: "Download the pack (zip)" }).click(),
  );
  const zip = readZip(saved);
  expect([...zip.keys()].every((name) => name.startsWith("rastrata-year-end-2026/"))).toBe(true);
  const manifest = JSON.parse(
    zip.get("rastrata-year-end-2026/manifest.json")?.toString("utf8") ?? "{}",
  );
  expect(manifest.files.length).toBe(built.files.length - 1);
  for (const entry of manifest.files as { path: string; bytes: number; sha256: string }[]) {
    const data = zip.get(`rastrata-year-end-2026/${entry.path}`);
    expect(data, entry.path).toBeDefined();
    expect(data?.length, entry.path).toBe(entry.bytes);
    expect(sha(data as Buffer), entry.path).toBe(entry.sha256);
  }
  // The same bytes as the service built.
  for (const file of built.files as { path: string; content: string }[])
    expect(zip.get(`rastrata-year-end-2026/${file.path}`)?.toString("utf8"), file.path).toBe(
      file.content,
    );
  await expect(page.getByText("Saved rastrata-year-end-2026.zip.")).toBeVisible();
});

test("1099 vendors: mark an account, add a vendor from the keyboard, change it, and every change is a version", async ({
  page,
  request,
}) => {
  await page.goto("/tax?tab=vendors");
  // With no account marked the page is its accounts to mark: no notice says so a second time, the form's
  // draft status is not said here, and there is no list of payees or line of totals with nothing in them.
  await expect(
    page.getByRole("heading", { name: "Accounts that hold these payments" }),
  ).toBeVisible();
  await expect(page.locator(".rt-tax-panel").getByText(/No account is marked/)).toHaveCount(0);
  await expect(page.getByText(/IRS early-release draft/).filter({ visible: true })).toHaveCount(0);
  await expect(page.getByRole("heading", { name: "Paid, and not a vendor yet" })).toHaveCount(0);
  await expect(page.locator(".rt-tax-totals")).toHaveCount(0);
  await expect(page.getByText("Reporting threshold for payments made in 2026")).toBeVisible();
  await expect(page.getByText(/2,000\.00/)).toBeVisible();
  const contract = page.getByRole("checkbox", { name: "Contract labor" });
  // A person presses the visible choice, not the hidden input behind it.
  await page.getByText("Contract labor", { exact: true }).click();
  await expect(contract).toBeChecked();
  // The box shows the choice at once; the book has it when the write is done.
  await expect
    .poll(async () =>
      (await api(request, "taxVendors.list", { taxYear: TODAY_YEAR })).accounts
        .filter((account: { marked: boolean }) => account.marked)
        .map((account: { code: string }) => account.code),
    )
    .toEqual(["6030"]);
  await expect(contract).toBeEnabled();

  await page.getByRole("button", { name: "Add a vendor" }).first().click();
  const dialog = page.getByRole("dialog");
  await expect(dialog).toBeVisible();
  // A form with a problem says so beside the field and in a summary, and keeps what was typed.
  await dialog.getByRole("button", { name: "Save" }).click();
  await expect(dialog.getByRole("link", { name: "Give the vendor a name." })).toBeVisible();
  await dialog.getByLabel("Name").fill("Jane Doe Design");
  await dialog.getByLabel("Payee texts").fill("jane doe");
  await dialog.getByRole("combobox", { name: /Does it need a 1099/ }).click();
  await page.getByRole("option", { name: "Needs a 1099" }).click();
  await dialog.getByRole("combobox", { name: "W-9", exact: true }).click();
  await page.getByRole("option", { name: "Received" }).click();
  await dialog.getByLabel("W-9 date").fill("2026-02-10");
  await dialog.getByRole("button", { name: "Save" }).click();
  await expect(dialog).toBeHidden();
  await expect(page.getByText("Saved Jane Doe Design.")).toBeVisible();
  const row = page.getByRole("row", { name: /Jane Doe Design/ });
  await expect(row).toContainText("Needs a 1099");
  await expect(row).toContainText("Received");
  let list = await api(request, "taxVendors.list", { taxYear: TODAY_YEAR });
  expect(list.vendors).toHaveLength(1);
  expect(list.vendors[0].vendor).toMatchObject({
    name: "Jane Doe Design",
    payeeKeys: ["jane doe"],
    reporting: "yes",
    w9: "received",
    w9On: "2026-02-10",
    version: 1,
    principal: "owner",
  });

  // Change it: the form opens on the vendor with its history, and a change is a new version.
  await page.getByRole("button", { name: "Edit Jane Doe Design" }).click();
  await expect(dialog).toBeVisible();
  await expect(dialog.getByLabel("Name")).toHaveValue("Jane Doe Design");
  await dialog.getByLabel("Notes").fill("Referred by a client");
  await dialog.getByRole("button", { name: "Save" }).click();
  await expect(dialog).toBeHidden();
  list = await api(request, "taxVendors.list", { taxYear: TODAY_YEAR });
  expect(list.vendors[0].vendor.version).toBe(2);
  expect(list.vendors[0].vendor.notes).toBe("Referred by a client");
  await page.getByRole("button", { name: "Edit Jane Doe Design" }).click();
  await expect(dialog.getByText("Version 1")).toBeVisible();
  // Escape closes it and changes nothing.
  await page.keyboard.press("Escape");
  await expect(dialog).toBeHidden();
  expect(
    (await api(request, "taxVendors.list", { taxYear: TODAY_YEAR })).vendors[0].vendor.version,
  ).toBe(2);

  // The vendor list is saved as a spreadsheet file exactly as the service made it.
  const saved = await download(page, () =>
    page.getByRole("button", { name: "Download the vendor list (CSV)" }).click(),
  );
  const exported = await api(request, "taxVendors.export", { taxYear: TODAY_YEAR });
  expect(saved.subarray(3).toString("utf8")).toBe(exported.content);
});

test("sales tax: the account's months, the plain statement and the files", async ({
  page,
  request,
}) => {
  await page.goto("/tax?tab=sales");
  await expect(page.getByText("What your books recorded as sales tax, by period.")).toBeVisible();
  await expect(page.locator(".rt-tax-panel").getByText(/Rastrata does not know/)).toHaveCount(0);
  await expect(page.getByText("2500", { exact: false }).first()).toBeVisible();
  const summary = await api(request, "taxSales.get", { taxYear: TODAY_YEAR });
  expect([summary.collected, summary.remitted, summary.closing]).toEqual(["8.00", "5.00", "3.00"]);
  const table = page.getByRole("table", { name: /Sales tax/ });
  const february = table.getByRole("row", { name: /February 2026/ });
  await expect(february).toContainText("8.00");
  const march = table.getByRole("row", { name: /March 2026/ });
  await expect(march).toContainText("5.00");
  await expect(table.locator("tfoot")).toContainText("3.00");
  // Quarters, kept in the address.
  await page.getByRole("combobox", { name: "Periods" }).click();
  await page.getByRole("option", { name: "Quarters" }).click();
  await expect(page).toHaveURL(/period=quarter/);
  await expect(table.getByRole("row", { name: /2026 Q1/ })).toContainText("8.00");
  const saved = await download(page, () =>
    page.getByRole("button", { name: "Download the summary (CSV)" }).click(),
  );
  const exported = await api(request, "taxSales.export", {
    taxYear: TODAY_YEAR,
    period: "quarter",
  });
  expect(saved.subarray(3).toString("utf8")).toBe(exported.content);
});

test("the accountant's pack is saved as a zip, and an adjusting-entry file is checked and imported as drafts, never posted", async ({
  page,
  request,
}) => {
  await page.goto("/tax?tab=accountant");
  await page.getByRole("button", { name: "Build the accountant pack" }).click();
  const accountant = await api(request, "taxAccountant.build", { taxYear: TODAY_YEAR });
  await expect(
    page.getByText(`${accountant.files.length} files, all from one version of your books.`),
  ).toBeVisible();
  const saved = await download(page, () =>
    page.getByRole("button", { name: "Download the accountant pack (zip)" }).click(),
  );
  const zip = readZip(saved);
  for (const path of [
    "journal.csv",
    "chart-of-accounts.csv",
    "adjusting-entries-template.csv",
    "manifest.json",
  ])
    expect(zip.has(`rastrata-accountant-2026/${path}`), path).toBe(true);
  const template = await download(page, () =>
    page.getByRole("button", { name: "Download the template (CSV)" }).click(),
  );
  expect(template.subarray(3).toString("utf8")).toBe(
    "Entry,Date,Narration,Account,Debit,Credit\r\n",
  );

  const folder = mkdtempSync(join(tmpdir(), "rastrata-tax-"));
  const bad = join(folder, "from-the-accountant.csv");
  writeFileSync(
    bad,
    [
      "Entry,Date,Narration,Account,Debit,Credit",
      "B1,2026-12-31,No such account,9999,50.00,",
      "B1,2026-12-31,No such account,1000,,50.00",
      "B2,31/12/2026,Wrong date format,6080,50.00,",
      "B2,31/12/2026,Wrong date format,1000,,50.00",
    ].join("\r\n"),
  );
  const good = join(folder, "year-end-adjustments.csv");
  writeFileSync(
    good,
    [
      "Entry,Date,Narration,Account,Debit,Credit",
      "AJE-1,2026-12-31,Accrue the year-end legal fee,6080,250.00,",
      ",,,1000,,250.00",
      "AJE-2,2026-12-31,Owner paid a contractor personally,6030,100.00,",
      "AJE-2,2026-12-31,Owner paid a contractor personally,3000,,100.00",
    ].join("\r\n"),
  );
  const before = (await api(request, "reports.get", { asOf: "2026-12-31" })).bookRevision;

  // A file with problems is shown with every problem and its row, and cannot be imported.
  await page.locator('input[type="file"]').setInputFiles(bad);
  const preview = page.getByRole("region", { name: "What importing would do", exact: true });
  await expect(preview).toBeVisible();
  await expect(preview).toContainText("Row 2");
  await expect(preview).toContainText('"9999" is not an account code');
  await expect(preview).toContainText('"31/12/2026" is not a date');
  await expect(page.getByRole("button", { name: /^Import \d+ entr/ })).toHaveCount(0);
  // The preview, with its statuses and problems, is readable in both themes and passes the scan.
  await scan(page, "adjusting entries preview (light)");
  await theme(page, "dark");
  await scan(page, "adjusting entries preview (dark)");
  await theme(page, "light");
  // At a phone's width the page does not scroll sideways, and the entry's status is still said.
  await page.setViewportSize({ width: 390, height: 800 });
  expect(await fitsWidth(page), "the preview at 390 px").toBe(true);
  await expect(preview.getByText("Has a problem").first()).toBeVisible();
  await page.setViewportSize({ width: 1280, height: 720 });

  // A good file is checked and then imported, and the drafts are for the owner to review.
  await page.locator('input[type="file"]').setInputFiles(good);
  await expect(preview).toContainText("AJE-1");
  await expect(preview).toContainText("2 entries, 4 lines.");
  await page.getByRole("button", { name: "Import 2 entries as drafts" }).click();
  await expect(page.getByText("2 drafts were saved.")).toBeVisible();
  await expect(page.getByText("Nothing has been posted.")).toBeVisible();
  const drafts = await api(request, "drafts.list", {});
  expect(drafts.count).toBe(2);
  expect(
    drafts.drafts.map((draft: { data: { reference: string } }) => draft.data.reference).sort(),
  ).toEqual(["AJE-1", "AJE-2"]);
  expect((await api(request, "reports.get", { asOf: "2026-12-31" })).bookRevision).toBe(before);
  await expect(page.getByRole("link", { name: "Open Transactions" })).toHaveAttribute(
    "href",
    "/journal",
  );

  // The same file again is recognised: nothing new is offered.
  await page.locator('input[type="file"]').setInputFiles(good);
  await expect(page.getByText("Everything in this file was imported before")).toBeVisible();
  await expect(page.getByRole("button", { name: /^Import \d+ entr/ })).toHaveCount(0);
  expect((await api(request, "drafts.list", {})).count).toBe(2);
});

test("the screen works from the keyboard alone, in both themes and at a phone's width, and passes the accessibility scan", async ({
  page,
}) => {
  await page.goto("/tax");
  await expect(page.getByRole("table", { name: /Schedule C/ })).toBeVisible();
  // Each tool is a page of its own, opened from the list of reports with the keyboard: the list is links.
  await page
    .locator("header.app-header")
    .getByRole("link", { name: "Reports", exact: true })
    .focus();
  await page.keyboard.press("Enter");
  await expect(page).toHaveURL(/\/reports$/);
  await page.getByRole("link", { name: "Year-end pack", exact: true }).focus();
  await page.keyboard.press("Enter");
  await expect(page).toHaveURL(/tab=pack/);
  await expect(page.getByRole("heading", { level: 1, name: "Year-end pack" })).toBeVisible();
  await expect(page.getByRole("tab")).toHaveCount(0);
  for (const value of ["light", "dark"] as const) {
    for (const tab of ["worksheet", "pack", "vendors", "sales", "accountant"]) {
      await page.goto(`/tax?tab=${tab}`);
      await expect(page.getByRole("heading", { level: 1 })).toBeVisible();
      await expect(page.locator("[aria-busy='true']")).toHaveCount(0);
      await theme(page, value);
      await scan(page, `${tab} (${value})`);
    }
  }
  await page.setViewportSize({ width: 390, height: 800 });
  await page.goto("/tax");
  await expect(page.getByRole("table", { name: /Schedule C/ })).toBeVisible();
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(
    true,
  );
  await scan(page, "worksheet at 390 px");
  // The good practice, open, passes the scan too, in both themes.
  await page.setViewportSize({ width: 1280, height: 720 });
  await page.goto("/tax");
  await page.getByRole("button", { name: "Good practice before you file" }).click();
  await expect(page.getByText("Months closed", { exact: true })).toBeVisible();
  for (const value of ["light", "dark"] as const) {
    await theme(page, value);
    await scan(page, `good practice open (${value})`);
  }
});

test("the table is on screen at once, and a book with nothing that changes the figures shows nothing orange", async ({
  page,
  request,
}) => {
  await page.setViewportSize({ width: 1440, height: 800 });
  await page.goto("/tax");
  // The tabs, the year and the choices come first, and then the table. The page's title is whatever size the
  // application's header makes it (the ux-guards spec holds the first row to the screen at 1440 by 800), so
  // this measures from the foot of the title: the table starts within about a screen of it, however tall the
  // title is, and a page that grows its introductions again fails here.
  const first = page
    .getByRole("table", { name: /Schedule C/ })
    .getByRole("row")
    .nth(1);
  await expect(first).toBeVisible();
  const title = await page.getByRole("heading", { level: 1 }).boundingBox();
  const box = await first.boundingBox();
  const below = (box?.y ?? 9999) + (box?.height ?? 0) - ((title?.y ?? 0) + (title?.height ?? 0));
  expect(below).toBeLessThanOrEqual(620);

  // Give the account its tax line back: nothing would change the figures now, so nothing is orange. The
  // service still says that the months are open and the form is a draft; those are good practice and facts.
  await api(
    request,
    "accounts.setTags",
    { accountId: "6140", effectiveOn: "2026-01-01", tags: { taxLine: "scheduleC.line22" } },
    crypto.randomUUID(),
  );
  await page.goto("/tax");
  const region = page.getByRole("region", { name: "Checks on these figures" });
  await expect(region).toBeVisible();
  await expect(region.locator('[data-severity="attention"]')).toHaveCount(0);
  await expect(region.getByRole("list", { name: "About these figures" })).toContainText(
    "IRS early-release draft",
  );
  const summary = await api(request, "taxSummary.get", {});
  expect(
    (summary.checks as { status: string }[]).filter((entry) => entry.status === "attention").length,
  ).toBeGreaterThan(0);

  // A transaction waiting for review changes the figures once it is posted, so it is orange, and its link
  // says how many it is. The count comes from the service as data, in the app's own words.
  const csv = "Date,Description,Amount\n2026-05-14,Late coffee,-4.50\n";
  const upload = await request.post("/v1/uploads", {
    headers: { "content-type": "text/csv", "x-upload-name": "late.csv" },
    data: csv,
  });
  const receipt = (await upload.json()).data as { sha256: string };
  await api(
    request,
    "import.commit",
    { sha256: receipt.sha256, ledgerAccountId: "1000" },
    crypto.randomUUID(),
  );
  await page.goto("/tax");
  const waiting = region.locator('[data-severity="attention"]');
  await expect(waiting).toHaveCount(1);
  await expect(waiting).toContainText(
    "1 transaction dated in 2026 is waiting for review, so it is not in these figures.",
  );
  await expect(waiting.getByRole("link")).toHaveText("Review 1 transaction");
  await expect(waiting.getByRole("link")).toHaveAttribute("href", "/inbox");
  // The words of the service ("lines", "the Inbox") are not on the page.
  await expect(region).not.toContainText("Inbox");
  await expect(region).not.toContainText(/\blines? dated\b/);
});
