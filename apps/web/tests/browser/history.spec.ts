import { expect, test } from "@playwright/test";
import { pick } from "../support/pick";
import { chooseRadio } from "../support/accounting";

/** Settings, Bring in history: a file of entries from another system is previewed, the accounts it has
 * and the book lacks are chosen or added, and the entries are imported dated as they were. */

const csv = [
  "Trans #,Type,Date,Num,Name,Memo,Account,Debit,Credit",
  "1,General Journal,01/02/2022,,,Owner puts money in,Business Checking (1234),5000.00,",
  ",,,,,,Owner Investment,,5000.00",
  "2,Invoice,02/03/2022,1001,Hill Co,Design work,Accounts Receivable (A/R),1200.00,",
  ",,,,,,Sales,,1200.00",
  "3,Expense,03/05/2022,,Vendor,Studio rent,Rent & Lease,650.00,",
  ",,,,,,Business Checking (1234),,650.00",
].join("\n");

const file = { name: "journal.csv", mimeType: "text/csv", buffer: Buffer.from(csv) };

// One book, made by the first test and used by the second.
test.describe.configure({ mode: "serial" });

test("a file of entries is previewed, its accounts are chosen, and its entries are imported", async ({
  page,
}) => {
  test.setTimeout(90_000);
  await page.clock.setFixedTime(new Date("2026-04-02T12:00:00"));
  await page.goto("/");
  await page.getByRole("textbox", { name: "Business name" }).fill("October Studio");
  await page.getByRole("button", { name: "Continue", exact: true }).click();
  await chooseRadio(page, "Other business");
  await page.getByRole("button", { name: "Continue", exact: true }).click();
  await page.getByRole("button", { name: "Continue", exact: true }).click();
  await page.getByRole("button", { name: "Create book", exact: true }).first().click();
  await expect(page.locator(".app-book-name")).toHaveText("October Studio");

  await page.goto("/settings/history");
  await expect(page.getByRole("heading", { name: "Bring in history", level: 1 })).toBeVisible();
  await page.locator('input[type="file"]').first().setInputFiles(file);
  await expect(page.getByText("3 entries, from Jan 2, 2022 to Mar 5, 2022.")).toBeVisible();

  // The dates could be read either way, so the page says how it read them and lets them be read the
  // other way; the entries move with it.
  const order = page.getByLabel("How the dates are written");
  await expect(order).toHaveAttribute("data-value", "mdy");
  await pick(page, order, { value: "dmy" });
  await expect(page.getByText("3 entries, from Feb 1, 2022 to May 3, 2022.")).toBeVisible();
  await pick(page, order, { value: "mdy" });
  await expect(page.getByText("3 entries, from Jan 2, 2022 to Mar 5, 2022.")).toBeVisible();

  // What the file's name or number says is set for them: the file's checking account is the book's own,
  // by its name; the account nothing says anything about waits for a choice, and the import waits with it.
  const posted = (label: string) => page.getByLabel(`Posted to ${label}`, { exact: true });
  await expect(posted("Owner Investment")).toHaveAttribute("data-value", "+equity");
  // "Business Checking (1234)" is a name and a code: the row says both. The book has no bank account yet
  // (a template carries none), so the file's is added as one.
  await expect(posted("1234 Business Checking")).toHaveAttribute("data-value", "+asset");
  await expect(posted("Accounts Receivable (A/R)")).toHaveAttribute("data-value", "+asset");
  await expect(posted("Sales")).toHaveAttribute("data-value", "4000");
  // "Rent & Lease" means the same as the book's own rent account, so that one is chosen, for the person to keep
  // or change; nothing waits, so the import is offered.
  await expect(posted("Rent & Lease")).toHaveAttribute("data-value", "6100");
  await expect(page.getByRole("button", { name: "Import 3 entries" })).toBeEnabled();

  await pick(page, posted("Rent & Lease"), "Add as an expense account");
  await expect(page.getByRole("button", { name: "Import 3 entries" })).toBeEnabled();
  await page.getByRole("button", { name: "Import 3 entries" }).click();
  await expect(page.getByText("3 entries are in your books")).toBeVisible();
  await expect(page.getByText("Your books begin on Jan 2, 2022.")).toBeVisible();
  await expect(page.getByRole("link", { name: "Open Reports" })).toBeVisible();
  // (Close the books is also an entry of the Settings list beside the page: this is the page's own link.)
  await expect(page.getByRole("main").getByRole("link", { name: "Close the books" })).toBeVisible();

  // The entries are in the book, dated as they were, and the accounts were added to the chart.
  await page.goto("/journal");
  await expect(page.getByText("Studio rent").first()).toBeVisible();
  await page.goto("/accounts");
  await page.getByRole("searchbox", { name: "Search accounts" }).fill("Rent & Lease");
  await expect(page.locator(".rt-chart-groups").getByText("Rent & Lease").first()).toBeVisible();

  // The same file again changes nothing: it is already in the books.
  await page.goto("/settings/history");
  await page.locator('input[type="file"]').first().setInputFiles(file);
  await expect(page.getByText("Every entry of this file is already in your books.")).toBeVisible();
  await expect(page.getByRole("button", { name: /^Import/ })).toHaveCount(0);

  // Each year is tied to the old books: their trial balance at the end of 2022 agrees with what came in.
  const trialBalance = (rent: string) => ({
    name: "trial-balance-2022.csv",
    mimeType: "text/csv",
    buffer: Buffer.from(
      [
        "Account,Debit,Credit",
        "Business Checking (1234),4350.00,",
        "Accounts Receivable (A/R),1200.00,",
        "Owner Investment,,5000.00",
        "Sales,,1200.00",
        `Rent & Lease,${rent},`,
      ].join("\n"),
    ),
  });
  // The comparison is a fold under the import: it is the check made afterwards.
  await page.getByRole("button", { name: "Compare with your old books" }).click();
  const compare = page.getByRole("button", { name: "Compare", exact: true });
  await expect(compare).toBeDisabled();
  await page.locator('input[type="file"]').last().setInputFiles(trialBalance("650.00"));
  await page.getByLabel("As at").fill("2022-12-31");
  await compare.click();
  await expect(
    page.getByText("Every account agrees with your old books as at Dec 31, 2022."),
  ).toBeVisible();
  await expect(page.getByRole("link", { name: "Close the year" })).toBeVisible();

  // A figure that is off is named, with by how much.
  await page.locator('input[type="file"]').last().setInputFiles(trialBalance("651.00"));
  await compare.click();
  await expect(page.getByText("1 account differs from your old books.")).toBeVisible();
  const differing = page
    .getByRole("region", { name: "Accounts that differ" })
    .getByRole("row", { name: /Rent & Lease/ });
  await expect(differing).toContainText("651.00");
  await expect(differing).toContainText("650.00");
  await expect(page.getByRole("link", { name: "Close the year" })).toHaveCount(0);
});

test("a file that is not a list of entries is refused before it is sent, and a bad file says what is wrong", async ({
  page,
}) => {
  await page.goto("/settings/history");
  // An old Excel workbook (.xls) cannot be read, and the page says so before anything is sent.
  await page
    .locator('input[type="file"]')
    .first()
    .setInputFiles({
      name: "ledger.xls",
      mimeType: "application/vnd.ms-excel",
      buffer: Buffer.from("not really a workbook"),
    });
  await expect(
    page.getByText("That looks like an old Excel workbook (.xls), which cannot be read."),
  ).toBeVisible();
  // A file called .xlsx that is no workbook is read as text, and the text names no entries.
  await page
    .locator('input[type="file"]')
    .first()
    .setInputFiles({
      name: "ledger.xlsx",
      mimeType: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
      buffer: Buffer.from("not really a workbook"),
    });
  await expect(page.getByText(/No row names a date, an account and amounts/)).toBeVisible();

  // An entry that does not balance is named with its row, and nothing can be imported.
  await page
    .locator('input[type="file"]')
    .first()
    .setInputFiles({
      name: "bad.csv",
      mimeType: "text/csv",
      buffer: Buffer.from(
        ["Date,Account,Debit,Credit", "2022-01-02,Sales,10.00,", "2022-01-02,Sales,,9.00"].join(
          "\n",
        ),
      ),
    });
  await expect(page.getByRole("heading", { name: "What needs fixing in the file" })).toBeVisible();
  await expect(page.getByText(/Row 2:/)).toBeVisible();
  await expect(page.getByRole("button", { name: /^Import/ })).toHaveCount(0);
});
