import { expect, test, type APIRequestContext, type Page } from "./support/playwright";
import { WRITE_OPERATIONS } from "@rastrata/application/client-contracts";
import axe from "axe-core";

/** Parsed JSON, typed the way `Response.json()` types it, so tests can read fields freely. */
type Json = Awaited<ReturnType<Response["json"]>>;

declare global {
  interface Window {
    axe: typeof axe;
  }
}

/** Import a statement against the real local API, on a book that has no bank or card account yet: the
 * account comes from what the person brings. The picker offers "New account…", the drawer opens on a bank
 * account with the name that was typed, and the account it makes is the one the statement goes into. The
 * tests share the book and run one after another. */
test.describe.configure({ mode: "serial" });

const version = "rastrata-application-v1";
const writes: ReadonlySet<string> = new Set(WRITE_OPERATIONS);
const BOOK_OPERATION = "7b8c9d0e-1f2a-4b3c-8d4e-5f6a7b8c9d0e";
const setup = {
  name: "Bright Bakes",
  currency: "USD",
  fiscalYear: 2026,
  periodModel: "monthly",
  basis: "cash",
  accounts: [
    // An asset the book needs, but not a bank account: the statement has nowhere to go yet.
    { code: "1500", name: "Equipment", role: "asset", tags: { cashFlowClass: "investing" } },
    { code: "3000", name: "Owner's investment", role: "equity" },
    { code: "4000", name: "Sales", role: "income" },
    { code: "6210", name: "Bank and card fees", role: "expense" },
  ],
};

async function api(
  request: APIRequestContext,
  name: string,
  input: unknown = {},
  operationId?: string,
): Promise<Json> {
  const identity = operationId ?? (writes.has(name) ? crypto.randomUUID() : undefined);
  const response = await request.post(`/v1/${name}`, {
    data: { version, bookId: "local-book", input, ...(identity ? { operationId: identity } : {}) },
  });
  const body = await response.json();
  expect(body.ok, `${name}: ${JSON.stringify(body.error)}`).toBe(true);
  return body.data;
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

const picker = (page: Page) => page.getByRole("combobox", { name: "Account" });

test("a first import on a book with no bank account makes the account from the picker, and imports into it", async ({
  page,
  request,
}) => {
  const errors: string[] = [];
  page.on("pageerror", (error) => errors.push(error.message));
  await api(request, "book.setup", setup, BOOK_OPERATION);

  await page.goto("/import");
  await expect(page.getByRole("heading", { level: 1, name: "Import a statement" })).toBeVisible();
  // No account yet is not a dead end: the picker is there, and says that the first import makes the account.
  await expect(page.getByText(/Your first import makes the account/)).toBeVisible();
  await expect(page.getByText("Chart of accounts")).toHaveCount(0);
  await scan(page, "import, no account yet");

  // "New account…" is the only entry: the name typed is the account's, and it is a bank account from the start.
  await picker(page).focus();
  await picker(page).fill("Chase checking");
  await picker(page).press("ArrowDown");
  await picker(page).press("Enter");
  const drawer = page.getByRole("dialog", { name: "New account" });
  await expect(drawer).toBeVisible();
  await expect(drawer.getByRole("textbox", { name: "Name" })).toHaveValue("Chase checking");
  await expect(drawer.getByLabel("Type")).toHaveAttribute("data-value", "bank");
  await expect(drawer.getByRole("textbox", { name: "Code" })).toHaveValue("1000");
  await drawer.getByRole("button", { name: "Add account" }).click();
  await expect(drawer).toHaveCount(0);

  // The account is in the books, a bank account by its tag, and it is the one chosen for the statement.
  await expect(picker(page)).toHaveValue("Chase checking");
  const chart = await api(request, "accounts.list");
  const made = chart.accounts.find((account: Json) => account.code === "1000");
  expect(made).toMatchObject({ name: "Chase checking", role: "asset" });
  expect(made.tags).toMatchObject({ cashFlowClass: "cash", kind: "bank" });

  // The statement goes into it.
  await page.locator('input[type="file"]').setInputFiles({
    name: "Chase1234_Activity.csv",
    mimeType: "text/csv",
    buffer: Buffer.from(
      [
        "Details,Posting Date,Description,Amount,Type,Balance,Check or Slip #",
        "DEBIT,03/20/2026,MONTHLY SERVICE FEE,-15.00,FEE,985.00,",
        "CREDIT,03/18/2026,STRIPE TRANSFER ST-X1,318.40,ACH_CREDIT,1000.00,",
      ].join("\n"),
    ),
  });
  await page.getByRole("button", { name: /^Import 2 transactions/ }).click();
  await expect(page.getByText(/2 transactions? (are|is) (in|waiting)/)).toBeVisible();
  const summary = await api(request, "inbox.summary");
  expect(summary.counts.total).toBe(2);
  expect(summary.sources[0]?.ledgerAccountId).toBe(made.id);
  expect(errors).toEqual([]);
});
