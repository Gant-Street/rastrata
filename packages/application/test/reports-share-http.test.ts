import { afterEach, describe, expect, test } from "bun:test";
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

/** The share of income through the API: the request field, the reply, the file, and what is refused. */

const cleanup: (() => void)[] = [];
afterEach(() => {
  for (const work of cleanup.splice(0)) work();
});

const setup = {
  name: "October Cash Co",
  currency: "USD",
  fiscalYear: 2025,
  fiscalYearStartMonth: 10,
  basis: "cash",
  periodModel: "monthly",
  accounts: [
    { code: "1000", name: "Operating cash", role: "asset", tags: { cashFlowClass: "cash" } },
    { code: "2000", name: "Card balance", role: "liability", tags: { cashFlowClass: "operating" } },
    { code: "3000", name: "Owner capital", role: "equity", tags: { cashFlowClass: "financing" } },
    { code: "4000", name: "Sales", role: "income" },
    { code: "5000", name: "Supplies", role: "expense" },
  ],
};

async function fixture() {
  const directory = mkdtempSync(join(tmpdir(), "rastrata-reports-share-"));
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
  const post = async (
    date: string,
    lines: readonly (readonly [string, string, string])[],
    narration: string,
  ) => {
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
  };
  return { call, json, post };
}

/** Income 2,100.00 over the year (1,200.00 in November, 900.00 in March) and supplies 380.00 (300.00 in
 * December, 80.00 in February). */
async function seeded() {
  const f = await fixture();
  expect((await f.json("book.setup", setup, crypto.randomUUID())).body.ok).toBe(true);
  for (const [date, lines, narration] of [
    [
      "2025-10-05",
      [
        ["1000", "5000.00", ""],
        ["3000", "", "5000.00"],
      ],
      "Owner contribution",
    ],
    [
      "2025-11-10",
      [
        ["1000", "1200.00", ""],
        ["4000", "", "1200.00"],
      ],
      "November sales",
    ],
    [
      "2025-12-12",
      [
        ["5000", "300.00", ""],
        ["1000", "", "300.00"],
      ],
      "December supplies",
    ],
    [
      "2026-02-14",
      [
        ["5000", "80.00", ""],
        ["2000", "", "80.00"],
      ],
      "Supplies on the card",
    ],
    [
      "2026-03-03",
      [
        ["1000", "900.00", ""],
        ["4000", "", "900.00"],
      ],
      "March sales",
    ],
  ] as const)
    await f.post(date, lines, narration);
  return f;
}

/** A line of a statement as the API sends it: whatever fields it has, and the code or key that names it. */
type Line = Record<string, unknown>;
const byCode = (rows: Line[], code: string): Line | undefined =>
  rows.find((row) => row.code === code);
const totalOf = (totals: Line[], key: string): Line | undefined =>
  totals.find((total) => total.key === key);

describe("reports.get with share set to income, through the API", () => {
  test("every line and total carries its share of the year's income, the amounts as they were", async () => {
    const f = await seeded();
    const asked = (await f.json("reports.get", { asOf: "2026-03-31", share: "income" })).body.data;
    // Income 1,200 + 900 = 2,100.00. Supplies 300 + 80 = 380.00: 380 / 2,100 = 0.180952 -> 18.1.
    // Net income 2,100 - 380 = 1,720.00: 1,720 / 2,100 = 0.819047 -> 81.9.
    expect(asked.profitAndLoss.rows.map((row: Line) => row.code)).toEqual(["4000", "5000"]);
    expect(byCode(asked.profitAndLoss.rows, "4000")).toMatchObject({
      amount: "2100.00",
      share: "100.0",
    });
    expect(byCode(asked.profitAndLoss.rows, "5000")).toMatchObject({
      amount: "380.00",
      share: "18.1",
    });
    expect(totalOf(asked.profitAndLoss.totals, "income")).toMatchObject({ share: "100.0" });
    expect(totalOf(asked.profitAndLoss.totals, "expense")).toMatchObject({
      amount: "380.00",
      share: "18.1",
    });
    expect(totalOf(asked.profitAndLoss.totals, "revenue")).toMatchObject({ share: "100.0" });
    expect(totalOf(asked.profitAndLoss.totals, "netIncome")).toMatchObject({
      amount: "1720.00",
      share: "81.9",
    });
    expect(asked.warnings).toEqual([]);
    // The reply is the plain reply with shares added: its population, revision and statements are the same.
    const plain = (await f.json("reports.get", { asOf: "2026-03-31" })).body.data;
    expect(asked.populationHash).toBe(plain.populationHash);
    expect(asked.bookRevision).toBe(plain.bookRevision);
    expect(JSON.stringify(asked.balanceSheet)).toBe(JSON.stringify(plain.balanceSheet));
    expect(JSON.stringify(asked.trialBalance)).toBe(JSON.stringify(plain.trialBalance));
    expect(asked.profitAndLoss.netIncome).toBe(plain.profitAndLoss.netIncome);
  });

  test("a reply that does not ask for a share is byte for byte the same with share none", async () => {
    const f = await seeded();
    for (const extra of [{}, { from: "2026-01-01", compare: "previousPeriod" }]) {
      const plain = await f.call("reports.get", { asOf: "2026-03-31", ...extra });
      const none = await f.call("reports.get", { asOf: "2026-03-31", ...extra, share: "none" });
      expect(none.status).toBe(200);
      expect(none.text).toBe(plain.text);
      expect(plain.text).not.toContain("hare");
    }
  });

  test("the comparison is divided by its own period's income", async () => {
    const f = await seeded();
    // January to March 2026: income 900.00, supplies 80.00 (8.888 -> 8.9), net income 820.00 (91.1).
    // October to December 2025: income 1,200.00, supplies 300.00 (25.0), net income 900.00 (75.0).
    const quarter = (
      await f.json("reports.get", {
        asOf: "2026-03-31",
        from: "2026-01-01",
        compare: "previousPeriod",
        share: "income",
      })
    ).body.data;
    expect(byCode(quarter.profitAndLoss.rows, "5000")).toMatchObject({
      amount: "80.00",
      share: "8.9",
      comparative: "300.00",
      comparativeShare: "25.0",
      change: "-220.00",
    });
    expect(totalOf(quarter.profitAndLoss.totals, "netIncome")).toMatchObject({
      amount: "820.00",
      share: "91.1",
      comparative: "900.00",
      comparativeShare: "75.0",
    });
  });

  test("a period with no income says so and shows no share", async () => {
    const f = await seeded();
    // February 2026 has the 80.00 of supplies on the card and no income at all: nothing to divide by.
    const february = (
      await f.json("reports.get", { asOf: "2026-02-28", from: "2026-02-01", share: "income" })
    ).body.data;
    expect(byCode(february.profitAndLoss.rows, "5000")).toStrictEqual({
      accountId: expect.any(String),
      code: "5000",
      name: "Supplies",
      role: "expense",
      amount: "80.00",
    });
    expect(february.warnings).toHaveLength(1);
    expect(february.warnings[0].code).toBe("share_unavailable");
    expect(february.warnings[0].message).toMatch(/no income/);
  });

  test("what is not a share choice is refused, and only the profit and loss takes one", async () => {
    const f = await seeded();
    const wrong = await f.json("reports.get", { asOf: "2026-03-31", share: "revenue" });
    expect(wrong.status).toBe(400);
    expect(wrong.body.error.code).toBe("invalid_input");
    // The other statements' operations do not take the field at all.
    for (const name of ["reports.cashFlow", "reports.generalLedger"]) {
      const refused = await f.json(name, { asOf: "2026-03-31", share: "income" });
      expect(refused.status, name).toBe(400);
      expect(refused.body.error.code, name).toBe("invalid_input");
    }
  });

  test("reading needs no more than the permission to read", async () => {
    const f = await seeded();
    const reply = await f.json("reports.get", { asOf: "2026-03-31", share: "income" }, undefined, [
      "read",
    ]);
    expect(reply.status).toBe(200);
    expect(byCode(reply.body.data.profitAndLoss.rows, "5000")?.share).toBe("18.1");
  });
});

describe("reports.export with share set to income, through the API", () => {
  test("the profit and loss file has the share columns, and the file is the reply's figures", async () => {
    const f = await seeded();
    const file = (
      await f.json("reports.export", {
        statement: "profit-loss",
        asOf: "2026-03-31",
        share: "income",
      })
    ).body.data;
    expect(file.filename).toBe("profit-loss-2025-10-01-to-2026-03-31.csv");
    const lines = file.content.split("\r\n");
    const head = lines.findIndex((line: string) => line.startsWith("Account ID,"));
    expect(lines[head]).toBe("Account ID,Code,Account,Type,Amount,% of income");
    expect(lines[head + 1]).toBe("4000,4000,Sales,income,2100.00,100.0");
    expect(lines[head + 2]).toBe("5000,5000,Supplies,expense,380.00,18.1");
    expect(lines).toContain(",,Net income,,1720.00,81.9");
    // The population and revision are the report's: a share changes neither.
    const report = (await f.json("reports.get", { asOf: "2026-03-31" })).body.data;
    expect(file.populationHash).toBe(report.populationHash);
    expect(file.bookRevision).toBe(report.bookRevision);
  });

  test("a file not asked for a share is what it always was", async () => {
    const f = await seeded();
    const plain = await f.call("reports.export", { statement: "profit-loss", asOf: "2026-03-31" });
    const none = await f.call("reports.export", {
      statement: "profit-loss",
      asOf: "2026-03-31",
      share: "none",
    });
    expect(none.text).toBe(plain.text);
    expect(plain.text).not.toContain("% of income");
  });

  test("a statement with no income to take a share of refuses the request", async () => {
    const f = await seeded();
    for (const statement of ["trial-balance", "balance-sheet", "cash-flow", "general-ledger"]) {
      const refused = await f.json("reports.export", {
        statement,
        asOf: "2026-03-31",
        share: "income",
      });
      expect(refused.status, statement).toBe(400);
      expect(refused.body.error.code, statement).toBe("invalid_input");
      expect(refused.body.error.message).toMatch(/profit and loss/);
    }
  });
});
