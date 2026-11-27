import { afterEach, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ApplicationHttp } from "../src/http.ts";
import { LocalBookService } from "../src/local.ts";
import {
  APPLICATION_API_VERSION,
  BUSINESS_PERMISSIONS,
  type BusinessPermission,
} from "../src/schema.ts";

/** The ranking read through the API: the largest entries of a range, by what they spent or took in. */

const cleanup: (() => void)[] = [];
afterEach(() => {
  for (const work of cleanup.splice(0)) work();
});

const setup = {
  name: "Willow Lane Studio",
  currency: "USD",
  fiscalYear: 2026,
  fiscalYearStartMonth: 1,
  basis: "cash",
  periodModel: "monthly",
  accounts: [
    { code: "1000", name: "Operating cash", role: "asset", tags: { cashFlowClass: "cash" } },
    { code: "2000", name: "Card balance", role: "liability", tags: { cashFlowClass: "operating" } },
    { code: "3000", name: "Owner capital", role: "equity", tags: { cashFlowClass: "financing" } },
    { code: "4000", name: "Sales", role: "income" },
    { code: "5000", name: "Supplies", role: "expense" },
    { code: "5100", name: "Rent", role: "expense" },
    { code: "5200", name: "Contract labor", role: "expense" },
    { code: "5300", name: "Meals", role: "expense" },
  ],
};

type Line = readonly [account: string, debit: string, credit: string];

async function fixture() {
  const directory = mkdtempSync(join(tmpdir(), "rastrata-reports-largest-"));
  const service = await LocalBookService.open(join(directory, "book.sqlite"));
  cleanup.push(() => {
    service.close();
    rmSync(directory, { recursive: true, force: true });
  });
  const call = async (
    name: string,
    input: unknown = {},
    operationId?: string,
    permissions: readonly BusinessPermission[] = BUSINESS_PERMISSIONS,
  ) => {
    const http = new ApplicationHttp(service, { bookId: service.bookId, permissions });
    const response = await http.fetch(
      new Request(`http://127.0.0.1:4010/v1/${name}`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          version: APPLICATION_API_VERSION,
          bookId: "local-book",
          input,
          ...(operationId ? { operationId } : {}),
        }),
      }),
    );
    return { status: response.status, text: await response.text() };
  };
  const json = async (...args: Parameters<typeof call>) => {
    const reply = await call(...args);
    return { status: reply.status, body: JSON.parse(reply.text), text: reply.text };
  };
  /** Post one entry and return its journal id (a draft posts as the journal named for the draft). */
  const post = async (date: string, lines: readonly Line[], narration: string) => {
    const draft = await json(
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
    expect(draft.status, draft.text).toBe(200);
    const planId = crypto.randomUUID();
    const prepared = await json(
      "journal.prepare",
      { draftId: draft.body.data.id, expectedVersion: draft.body.data.version },
      planId,
    );
    const committed = await json("operations.commit", {
      planId,
      planHash: prepared.body.data.planHash,
    });
    expect(committed.body.data.disposition, committed.text).toBe("committed");
    return draft.body.data.id as string;
  };
  const reverse = async (journalId: string, accountingDate: string) => {
    const planId = crypto.randomUUID();
    const prepared = await json(
      "journal.prepareReverse",
      { journalId, accountingDate, reason: "Entered by mistake" },
      planId,
    );
    expect(prepared.status, prepared.text).toBe(200);
    const committed = await json("operations.commit", {
      planId,
      planHash: prepared.body.data.planHash,
    });
    expect(committed.body.data.disposition, committed.text).toBe("committed");
  };
  const largest = async (input: Record<string, unknown>) => {
    const reply = await json("reports.largest", input);
    expect(reply.status, reply.text).toBe(200);
    return reply.body.data;
  };
  expect((await json("book.setup", setup, crypto.randomUUID())).body.ok).toBe(true);
  return { call, json, post, reverse, largest };
}

/** March 2026: the rent, a check for contract labor, a purchase split over two accounts, a refund, a payment of the card, an entry
 * made twice and reversed, a second check of the same amount, and the month's sales. February and April each have an expense of their
 * own, to show what the range leaves out. */
async function march() {
  const f = await fixture();
  const ids = {
    capital: await f.post(
      "2026-03-01",
      [
        ["1000", "10000.00", ""],
        ["3000", "", "10000.00"],
      ],
      "Owner contribution",
    ),
    rent: await f.post(
      "2026-03-02",
      [
        ["5100", "750.00", ""],
        ["1000", "", "750.00"],
      ],
      "March rent",
    ),
    check: await f.post(
      "2026-03-05",
      [
        ["5200", "600.00", ""],
        ["1000", "", "600.00"],
      ],
      "Check 1041",
    ),
    supplies: await f.post(
      "2026-03-09",
      [
        ["5000", "80.00", ""],
        ["2000", "", "80.00"],
      ],
      "Office supplies on the card",
    ),
    cardPayment: await f.post(
      "2026-03-12",
      [
        ["2000", "1200.00", ""],
        ["1000", "", "1200.00"],
      ],
      "Card payment",
    ),
    split: await f.post(
      "2026-03-15",
      [
        ["5000", "300.00", ""],
        ["5300", "250.00", ""],
        ["1000", "", "550.00"],
      ],
      "Client dinner and supplies",
    ),
    refund: await f.post(
      "2026-03-20",
      [
        ["1000", "40.00", ""],
        ["5000", "", "40.00"],
      ],
      "Supplies returned",
    ),
    sales: await f.post(
      "2026-03-22",
      [
        ["1000", "3000.00", ""],
        ["4000", "", "3000.00"],
      ],
      "March sales",
    ),
    twice: await f.post(
      "2026-03-25",
      [
        ["5100", "900.00", ""],
        ["1000", "", "900.00"],
      ],
      "Rent paid twice",
    ),
    secondCheck: await f.post(
      "2026-03-28",
      [
        ["5200", "600.00", ""],
        ["1000", "", "600.00"],
      ],
      "Check 1048",
    ),
    february: await f.post(
      "2026-02-10",
      [
        ["5200", "2000.00", ""],
        ["1000", "", "2000.00"],
      ],
      "February labor",
    ),
    april: await f.post(
      "2026-04-02",
      [
        ["5100", "5000.00", ""],
        ["1000", "", "5000.00"],
      ],
      "April deposit on a new lease",
    ),
  };
  await f.reverse(ids.twice, "2026-03-26");
  return { ...f, ids };
}

test("the largest expense of a month is the biggest entry, not a transfer, a refund or an entry made twice and reversed", async () => {
  const f = await march();
  const ranking = await f.largest({ asOf: "2026-03-31", from: "2026-03-01" });
  expect(ranking.kind).toBe("expense");
  expect(ranking.periodStart).toBe("2026-03-01");
  expect(ranking.asOf).toBe("2026-03-31");
  expect(ranking.currency).toBe("USD");
  // The rent, the two checks, the split purchase and the office supplies: the card payment is a transfer, the refund is not an
  // expense, and the rent that was paid twice was reversed, with its reversal.
  expect(ranking.count).toBe(5);
  expect(
    ranking.rows.map(
      (row: { rank: number; narration: string; amount: string }) =>
        `${row.rank} ${row.amount} ${row.narration}`,
    ),
  ).toEqual([
    "1 750.00 March rent",
    "2 600.00 Check 1041",
    "3 600.00 Check 1048",
    "4 550.00 Client dinner and supplies",
    "5 80.00 Office supplies on the card",
  ]);
  const [rent] = ranking.rows;
  expect(rent).toMatchObject({
    journalId: f.ids.rent,
    date: "2026-03-02",
    accountId: expect.any(String),
    code: "5100",
    name: "Rent",
    accounts: 1,
  });
  expect(rent.postingSequence).toMatch(/^[1-9][0-9]*$/);
});

test("an entry split over accounts is one expense of the whole amount, named for the account that holds most of it", async () => {
  const f = await march();
  const ranking = await f.largest({ asOf: "2026-03-31", from: "2026-03-01" });
  const split = ranking.rows.find((row: { journalId: string }) => row.journalId === f.ids.split);
  expect(split).toMatchObject({
    amount: "550.00",
    code: "5000",
    name: "Supplies",
    accounts: 2,
  });
});

test("equal amounts go to the earlier entry, so the same book always gives the same order", async () => {
  const f = await march();
  const ranking = await f.largest({ asOf: "2026-03-31", from: "2026-03-01", limit: 3 });
  expect(ranking.rows.map((row: { journalId: string }) => row.journalId)).toEqual([
    f.ids.rent,
    f.ids.check,
    f.ids.secondCheck,
  ]);
  // The limit cuts the list and says how many were ranked in all.
  expect(ranking.limit).toBe(3);
  expect(ranking.rows).toHaveLength(3);
  expect(ranking.count).toBe(5);
  expect(await f.largest({ asOf: "2026-03-31", from: "2026-03-01", limit: 3 })).toEqual(ranking);
});

test("income is ranked by what was taken in, and a transfer or an owner's contribution is not income", async () => {
  const f = await march();
  const sales = await f.largest({ asOf: "2026-03-31", from: "2026-03-01", kind: "income" });
  expect(sales.kind).toBe("income");
  expect(sales.count).toBe(1);
  expect(sales.rows).toHaveLength(1);
  expect(sales.rows[0]).toMatchObject({
    rank: 1,
    journalId: f.ids.sales,
    amount: "3000.00",
    code: "4000",
    name: "Sales",
  });
});

test("the range is the dates asked for, and from defaults to the start of the fiscal year", async () => {
  const f = await march();
  // Through April, the lease deposit is the largest; the range up to March does not see it.
  const april = await f.largest({ asOf: "2026-04-30", from: "2026-03-01", limit: 1 });
  expect(april.rows[0]).toMatchObject({ journalId: f.ids.april, amount: "5000.00" });
  expect(april.count).toBe(6);
  const february = await f.largest({ asOf: "2026-02-28" });
  expect(february.periodStart).toBe("2026-01-01");
  expect(february.rows.map((row: { journalId: string }) => row.journalId)).toEqual([
    f.ids.february,
  ]);
  // With no from, March's ranking includes February's 2,000.00 labor, the year being the range.
  const year = await f.largest({ asOf: "2026-03-31", limit: 1 });
  expect(year.rows[0]).toMatchObject({ journalId: f.ids.february, amount: "2000.00" });
  expect(year.count).toBe(6);
  // A range with nothing in it is an empty list, not an error.
  const empty = await f.largest({ asOf: "2026-01-31" });
  expect(empty).toMatchObject({ count: 0, rows: [] });
});

test("an entry reversed after the as-of date still counts as of that date, and stops counting once the reversal is in force", async () => {
  const f = await fixture();
  const lease = await f.post(
    "2026-03-10",
    [
      ["5100", "1000.00", ""],
      ["1000", "", "1000.00"],
    ],
    "Deposit",
  );
  await f.post(
    "2026-03-11",
    [
      ["5000", "70.00", ""],
      ["1000", "", "70.00"],
    ],
    "Supplies",
  );
  await f.reverse(lease, "2026-04-05");
  const march = await f.largest({ asOf: "2026-03-31", from: "2026-03-01" });
  expect(march.rows.map((row: { amount: string }) => row.amount)).toEqual(["1000.00", "70.00"]);
  const april = await f.largest({ asOf: "2026-04-30", from: "2026-03-01" });
  expect(april.rows.map((row: { amount: string }) => row.amount)).toEqual(["70.00"]);
  expect(april.count).toBe(1);
});

test("a pinned revision ranks the book as it was", async () => {
  const f = await march();
  const before = await f.largest({ asOf: "2026-03-31", from: "2026-03-01" });
  await f.post(
    "2026-03-30",
    [
      ["5100", "9000.00", ""],
      ["1000", "", "9000.00"],
    ],
    "Annual insurance",
  );
  const now = await f.largest({ asOf: "2026-03-31", from: "2026-03-01", limit: 1 });
  expect(now.rows[0]).toMatchObject({ amount: "9000.00" });
  const then = await f.largest({
    asOf: "2026-03-31",
    from: "2026-03-01",
    revision: before.bookRevision,
  });
  expect(then.rows).toEqual(before.rows);
  expect(then.count).toBe(before.count);
});

test("it is a read: a person who may only read can ask it, and asking changes nothing", async () => {
  const f = await march();
  const asked = await f.json(
    "reports.largest",
    { asOf: "2026-03-31", from: "2026-03-01" },
    undefined,
    ["read"],
  );
  expect(asked.status, asked.text).toBe(200);
  expect(asked.body.data.rows[0].amount).toBe("750.00");
  const again = await f.json("reports.largest", { asOf: "2026-03-31", from: "2026-03-01" });
  expect(again.body.data.bookRevision).toBe(asked.body.data.bookRevision);
});

test("what cannot be ranked is refused with the reason", async () => {
  const f = await march();
  for (const [input, path] of [
    [{ asOf: "2026-03-31", limit: 0 }, "limit"],
    [{ asOf: "2026-03-31", limit: 51 }, "limit"],
    [{ asOf: "2026-03-31", limit: 2.5 }, "limit"],
    [{ asOf: "2026-03-31", kind: "asset" }, "kind"],
    [{ kind: "expense" }, "asOf"],
    [{ asOf: "2026-02-30" }, "asOf"],
  ] as const) {
    const reply = await f.json("reports.largest", input);
    expect(reply.status, JSON.stringify(input)).toBe(400);
    expect(reply.body.error.code, JSON.stringify(input)).toBe("invalid_input");
    expect(JSON.stringify(reply.body.error.details), JSON.stringify(input)).toContain(path);
  }
  // A start after the end is refused like any report's.
  const backwards = await f.json("reports.largest", { asOf: "2026-03-01", from: "2026-03-31" });
  expect(backwards.status).toBe(400);
  // A date outside the book's calendar is the calendar's refusal.
  const outside = await f.json("reports.largest", { asOf: "2031-03-31", from: "2031-03-01" });
  expect(outside.body.ok).toBe(false);
  expect(outside.body.error.code).toBe("calendar_not_configured");
});
