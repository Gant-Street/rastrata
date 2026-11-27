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

/** Home against the real local API: one book, taken from nothing to everything done through the
 * operations a person's screens use, and Home read after each change. What the page says needs a person
 * (its first row is the next step) must follow the book and nothing else. The tests share the book and
 * run one after another. */
test.describe.configure({ mode: "serial" });

const version = "rastrata-application-v1";
const writes: ReadonlySet<string> = new Set(WRITE_OPERATIONS);
const book = {
  name: "Harbor Light Design",
  currency: "USD",
  fiscalYear: 2026,
  periodModel: "monthly",
  basis: "cash",
  accounts: [
    {
      code: "1000",
      name: "Business checking",
      role: "asset",
      tags: { cashFlowClass: "cash" },
    },
    {
      code: "2000",
      name: "Business card",
      role: "liability",
      tags: { cashFlowClass: "operating" },
    },
    {
      code: "3900",
      name: "Opening balance equity",
      role: "equity",
      tags: { cashFlowClass: "financing" },
    },
    { code: "4000", name: "Sales", role: "income" },
    { code: "6200", name: "Software", role: "expense" },
  ],
};
const mapping = {
  delimiter: ",",
  headerRow: 1,
  date: { header: "Date" },
  dateOrder: "ymd",
  amount: { kind: "signed", amount: { header: "Amount" } },
  description: [{ header: "Description" }],
  reference: { header: "Reference" },
};

async function api(
  request: APIRequestContext,
  name: string,
  input: unknown = {},
  operationId?: string,
): Promise<Json> {
  // A write carries an identity of its own, so a retry would do its work once; a read carries none.
  const identity = operationId ?? (writes.has(name) ? crypto.randomUUID() : undefined);
  const response = await request.post(`/v1/${name}`, {
    data: { version, bookId: "local-book", input, ...(identity ? { operationId: identity } : {}) },
  });
  const body = await response.json();
  expect(body.ok, `${name}: ${JSON.stringify(body.error)}`).toBe(true);
  return body.data;
}

/** A long operation (a backup, its check) asked again under one identity until it is done. */
async function job(request: APIRequestContext, name: string, input: unknown = {}): Promise<Json> {
  const operationId = crypto.randomUUID();
  for (let attempt = 0; attempt < 600; attempt++) {
    const data = await api(request, name, input, operationId);
    if (data.state !== "running") return data;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error(`${name} did not finish`);
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

/** Home has read everything it asks about: a row that is not there is not there for good. */
const read = (page: Page) => expect(page.locator(".rt-today")).toHaveAttribute("data-read", "");
const need = (page: Page, id: string) => page.locator(`[data-need="${id}"]`);
const start = (page: Page) => page.locator(".rt-start");
const tile = (page: Page, name: string) =>
  page.locator(".rt-bank-tile").filter({ has: page.getByRole("heading", { name }) });

async function open(page: Page) {
  await page.goto("/");
  await expect(page.getByRole("heading", { level: 1, name: "Today" })).toBeVisible();
  await read(page);
}

test("a new book shows one thing to do: add the bank, with a statement file as the other way in", async ({
  page,
  request,
}) => {
  await api(request, "book.setup", book, crypto.randomUUID());
  await open(page);
  await expect(start(page).getByRole("heading", { name: "Add your bank to start" })).toBeVisible();
  await expect(start(page)).toContainText("Its transactions come in for you to review.");
  // One main button on the page, and the second way to do the same thing as a second button beside it.
  const connect = start(page).getByRole("link", { name: "Connect a bank", exact: true });
  await expect(connect).toHaveAttribute("href", "/settings/bankfeed");
  await expect(connect).toHaveAttribute("data-variant", "primary");
  await expect(
    page.locator('#main a[data-variant="primary"], #main button[data-variant="primary"]'),
  ).toHaveCount(1);
  await expect(
    start(page).getByRole("link", { name: "Import a statement", exact: true }),
  ).toHaveAttribute("href", "/import");
  // Two rows, each the link itself and each saying who it is for: no sentence carries a link.
  await expect(start(page).locator('[data-line="mover"]')).toContainText(
    "Moving from another system",
  );
  await expect(start(page).locator(".rt-start-lines li > a")).toHaveCount(2);
  await expect(
    start(page).getByRole("link", { name: "Bring in your books", exact: true }),
  ).toHaveAttribute("href", "/settings/bring-in");
  await expect(start(page).locator('[data-line="agent"]')).toContainText(
    "For the agent you already use",
  );
  await expect(
    start(page).getByRole("link", { name: "Connect an agent", exact: true }),
  ).toHaveAttribute("href", "/settings/agent");
  // Nothing else: no list of steps, no empty section, no warning, nothing about the book itself.
  await expect(page.locator(".rt-today h2")).toHaveCount(1);
  await expect(page.getByText("Finish setting up")).toHaveCount(0);
  // The chart has a bank account with nothing in it: it has nothing to show yet either.
  await expect(page.locator(".rt-needs, .rt-inout, .rt-tiles")).toHaveCount(0);
  // The header carries the business; the page says nothing about the book it is not asked to act on.
  await expect(page.locator(".app-book-name")).toHaveText("Harbor Light Design");
  await expect(page.getByText(/Cash basis|Fiscal year/)).toHaveCount(0);
  await scan(page, "the start of a new book");
});

test("posting the opening balances gives the book a history, so Home starts to ask", async ({
  page,
  request,
}) => {
  await api(request, "cutover.set", { cutoverDate: "2026-01-01" }, crypto.randomUUID());
  const balances = [{ accountId: "1000", balance: "5000.00" }];
  const planned = await api(request, "opening.plan", { cutoverDate: "2026-01-01", balances });
  expect(planned.plan.valid).toBe(true);
  await api(
    request,
    "operations.commit",
    { planId: planned.plan.planId, planHash: planned.plan.planHash },
    crypto.randomUUID(),
  );
  await open(page);
  // The book is no longer new: the start gives way to the book's own page.
  await expect(start(page)).toHaveCount(0);
  await expect(page.getByText("Finish setting up")).toHaveCount(0);
  // Nothing has been backed up, and Home says so once.
  await expect(need(page, "backup")).toContainText("Your books have never been backed up.");
  await expect(need(page, "backup").getByRole("link", { name: /^Back up now/ })).toHaveAttribute(
    "href",
    "/settings/backups",
  );
  // The account is on the page, from the banking summary: its name is the link to it, and it has no button.
  await expect(page.getByRole("heading", { name: "Accounts", exact: true })).toBeVisible();
  await expect(tile(page, "Business checking")).toContainText("5,000.00");
  await expect(
    tile(page, "Business checking").getByRole("link", { name: "Business checking" }),
  ).toHaveAttribute("href", "/ledger?accountId=1000");
  await expect(page.locator(".rt-bank-tiles").getByRole("button")).toHaveCount(0);
  // Nothing is recorded in the last six months, so there is no chart, and no sentence saying there is none.
  await expect(page.getByRole("heading", { name: "Money in and out" })).toHaveCount(0);
  await scan(page, "Home with the opening balances in");
});

test("importing a statement puts the transactions to review first in Needs you, with the page's one main button", async ({
  page,
  request,
}) => {
  const csv = [
    "Date,Description,Amount,Reference",
    '2026-03-04,"NORTHWIND INVOICE 2231",1200.00,',
    '2026-03-09,"GITHUB TEAM PLAN",-19.00,',
    '2026-03-12,"MONTHLY SOFTWARE",-42.50,',
  ].join("\n");
  const upload = await request.post("/v1/uploads", {
    headers: { "content-type": "text/csv", "x-upload-name": "statement-1000.csv" },
    data: csv,
  });
  const receipt = (await upload.json()).data as { sha256: string };
  await api(
    request,
    "import.commit",
    { sha256: receipt.sha256, ledgerAccountId: "1000", mapping, startOn: "2026-01-01" },
    crypto.randomUUID(),
  );
  await open(page);
  await expect(need(page, "review")).toContainText("3 transactions to review.");
  // Reviewing is the next step: the first row, and its verb is the button. The rows after it are links.
  await expect(page.locator(".rt-need").first()).toHaveAttribute("data-need", "review");
  const review = need(page, "review").getByRole("link", { name: "Review", exact: true });
  await expect(review).toHaveAttribute("href", "/inbox");
  await expect(review).toHaveAttribute("data-variant", "primary");
  await expect(page.locator('.rt-needs a[data-variant="primary"]')).toHaveCount(1);
  // The account's line counts the same three, in words; what to do about them is said once, above.
  await expect(tile(page, "Business checking")).toContainText("3 to review");
  await expect(page.locator(".rt-bank-tiles").getByRole("link", { name: /Review/ })).toHaveCount(0);
  await scan(page, "Home with a statement waiting");
});

test("deciding every transaction takes the review row away, and the account is ready to reconcile", async ({
  page,
  request,
}) => {
  const items = (await api(request, "inbox.list", { filter: { status: ["new", "proposed"] } }))
    .items as { id: string; line: { amount: string } }[];
  expect(items).toHaveLength(3);
  const money = items.filter((item) => Number(item.line.amount) > 0).map((item) => item.id);
  const costs = items.filter((item) => Number(item.line.amount) < 0).map((item) => item.id);
  await api(
    request,
    "inbox.categorize",
    { itemIds: money, accountId: "4000" },
    crypto.randomUUID(),
  );
  await api(
    request,
    "inbox.categorize",
    { itemIds: costs, accountId: "6200" },
    crypto.randomUUID(),
  );
  // Decided but not posted is not reviewed: the transactions are ready to post.
  await open(page);
  await expect(need(page, "review")).toContainText("3 transactions are ready to post.");
  await expect(need(page, "review").getByRole("link", { name: "Post", exact: true })).toBeVisible();
  // January holds the opening balances, has ended, and none of what waits is dated in it: its account can
  // be checked against the statement, after the transactions that wait.
  await expect(page.locator(".rt-need").first()).toHaveAttribute("data-need", "review");
  await expect(need(page, "reconcile")).toBeVisible();
  await api(request, "inbox.post", { filter: { status: ["drafted"] } });
  await open(page);
  await expect(need(page, "review")).toHaveCount(0);
  await expect(page.locator(".rt-need").first()).toHaveAttribute("data-need", "reconcile");
  await expect(need(page, "reconcile")).toContainText(
    "Business checking is ready to check against its January statement.",
  );
  await expect(
    need(page, "reconcile").getByRole("link", { name: "Reconcile", exact: true }),
  ).toHaveAttribute("href", "/reconcile?account=1000");
  await scan(page, "Home with an account to reconcile");
});

test("a reconciled account takes its row away", async ({ page, request }) => {
  let draft = await api(request, "reconcile.start", {
    accountId: "1000",
    statementDate: "2026-03-31",
    statementBalance: "0.00",
  });
  draft = await api(request, "reconcile.setCleared", {
    id: draft.id,
    expectedVersion: draft.version,
    reset: "all",
  });
  draft = await api(request, "reconcile.setStatement", {
    id: draft.id,
    expectedVersion: draft.version,
    statementDate: "2026-03-31",
    statementBalance: draft.clearedBalance,
  });
  await api(request, "reconcile.complete", { id: draft.id, expectedVersion: draft.version });
  await open(page);
  await expect(need(page, "reconcile")).toHaveCount(0);
  // The month still waits for a backup, and the backup's own row says so: the month is not named for it.
  await expect(need(page, "backup")).toBeVisible();
  await expect(need(page, "close")).toHaveCount(0);
});

test("with a verified backup the month is named, because it can be closed", async ({
  page,
  request,
}) => {
  const made = await job(request, "backup.create");
  expect(made.state).toBe("done");
  await open(page);
  // A backup that has not been checked is not a verified one, and Home says so.
  await expect(need(page, "backup")).toContainText("No backup of your books has been checked yet.");
  const verified = await job(request, "backup.verify", { backupId: made.backup.id });
  expect(verified.verification?.passed).toBe(true);
  await open(page);
  await expect(need(page, "backup")).toHaveCount(0);
  await expect(need(page, "close")).toContainText("January 2026 is ready to close.");
  await expect(
    need(page, "close").getByRole("link", { name: "Close January 2026", exact: true }),
  ).toHaveAttribute("href", "/periods");
  await scan(page, "Home with a month to close");
});

test("Home is what needs you, then the accounts; six months of money are drawn once one of them holds something", async ({
  page,
  request,
}) => {
  // Where they sit, at a desktop's width and a phone's, is the browser's to measure (tests/browser/ux-guards.spec.ts).
  const headings = async () =>
    (await page.locator(".rt-today h2").allTextContents()).map((text) =>
      text.replace(/,.*$/, "").trim(),
    );
  // Everything in this book is dated early in the year: nothing in the last six months, so no chart and
  // no sentence saying there is none.
  await open(page);
  expect(await headings()).toEqual(["Needs you", "Accounts"]);
  // A sale today is in the chart's months.
  const today = new Date().toISOString().slice(0, 10);
  const draft = await api(
    request,
    "drafts.create",
    {
      data: {
        date: today,
        reference: "A sale",
        narration: "A sale",
        lines: [
          { accountId: "1000", debit: "250.00", credit: "0.00" },
          { accountId: "4000", debit: "0.00", credit: "250.00" },
        ],
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
  await open(page);
  await expect(page.getByRole("heading", { name: "Money in and out" })).toBeVisible();
  expect(await headings()).toEqual(["Needs you", "Money in and out", "Accounts"]);
});
