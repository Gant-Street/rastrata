import { expect, test } from "bun:test";
import {
  type AccountInput,
  type Line,
  type PeriodInput,
  matchLines,
  tieOut,
} from "../src/shadow/xero/tie-out.ts";

const line = (id: string, date: string, net: bigint, description = id): Line => ({
  id,
  date,
  description,
  reference: "",
  source: "",
  net,
});

const BANK: AccountInput = {
  accountId: "a1000",
  code: "1000",
  name: "Business checking",
  role: "asset",
  xero: [{ code: "090", name: "Business Bank Account", bank: true }],
};
const SALES: AccountInput = {
  accountId: "a4000",
  code: "4000",
  name: "Sales",
  role: "income",
  xero: [{ code: "200", name: "Sales", bank: false }],
};
const CARD: AccountInput = {
  accountId: "a2000",
  code: "2000",
  name: "Business credit card",
  role: "liability",
  xero: [{ code: "092", name: "Business Card", bank: true }],
};

/** July 2026 in both books: a client pays 1,200.00 into the bank. */
function july(overrides: Partial<PeriodInput> = {}): PeriodInput {
  return {
    from: "2026-07-01",
    to: "2026-07-31",
    rastrataClosing: new Map([
      ["a1000", 1_320_000n],
      ["a4000", -120_000n],
    ]),
    rastrataMovement: new Map([
      ["a1000", 120_000n],
      ["a4000", -120_000n],
    ]),
    rastrataLines: new Map([
      ["a1000", [line("r1", "2026-07-03", 120_000n, "Client payment")]],
      ["a4000", [line("r2", "2026-07-03", -120_000n, "Client payment")]],
    ]),
    xeroClosing: new Map([
      ["090", 1_320_000n],
      ["200", -120_000n],
    ]),
    xeroOpening: new Map([
      ["090", 1_200_000n],
      ["200", 0n],
    ]),
    sameFiscalYear: true,
    xeroLines: new Map([
      ["090", [line("x1", "2026-07-03", 120_000n, "Receive Money")]],
      ["200", [line("x2", "2026-07-02", -120_000n, "Invoice")]],
    ]),
    ...overrides,
  };
}

const run = (period: PeriodInput, extra: Partial<Parameters<typeof tieOut>[0]> = {}) =>
  tieOut({
    cutoverDate: "2026-07-01",
    accounts: [BANK, SALES, CARD],
    xeroUnmapped: new Map(),
    reconciledThrough: new Map([["090", "2026-07-31"]]),
    periods: [period],
    ...extra,
  })[0];

test("two books that agree match, to the cent, and the lines pair off within a few days", () => {
  const result = run(july());
  expect(result?.xeroReconciled).toBe(true);
  expect(result?.accounts.map((item) => [item.code, item.status, item.basis])).toEqual([
    ["1000", "matches", "closing"],
    ["4000", "matches", "movement"],
  ]);
  const bank = result?.accounts[0];
  expect(bank).toMatchObject({
    xero: 1_320_000n,
    rastrata: 1_320_000n,
    difference: 0n,
    carried: 0n,
    matched: 1,
  });
  expect(bank?.unmatched).toEqual([]);
  expect(bank?.residual).toBe(0n);
  // The credit card has nothing in either book: not in the report.
  expect(result?.accounts.find((item) => item.code === "2000")).toBeUndefined();
});

test("a line in one book only is the whole of the difference, and the difference is explained exactly", () => {
  const result = run(
    july({
      xeroLines: new Map([
        [
          "090",
          [line("x1", "2026-07-03", 120_000n), line("x9", "2026-07-20", -4_599n, "Software")],
        ],
        ["200", [line("x2", "2026-07-03", -120_000n)]],
      ]),
      xeroClosing: new Map([
        ["090", 1_315_401n],
        ["200", -120_000n],
      ]),
    }),
  );
  const bank = result?.accounts[0];
  expect(bank).toMatchObject({
    status: "differs",
    xero: 1_315_401n,
    rastrata: 1_320_000n,
    difference: 4_599n,
  });
  expect(bank?.unmatched).toHaveLength(1);
  expect(bank?.unmatched?.[0]).toMatchObject({ side: "xero", line: { id: "x9", net: -4_599n } });
  expect(bank?.residual).toBe(0n);
  expect(bank?.carried).toBe(0n);
});

test("what the books already disagreed about when the period began is carried, not blamed on a line", () => {
  // The bank started 126.80 apart (the opening balance came from the statement, Xero's book was behind).
  const result = run(
    july({
      xeroClosing: new Map([
        ["090", 1_307_320n],
        ["200", -120_000n],
      ]),
    }),
  );
  const bank = result?.accounts[0];
  expect(bank).toMatchObject({
    status: "differs",
    difference: 12_680n,
    carried: 12_680n,
    residual: 0n,
  });
  expect(bank?.unmatched).toEqual([]);
});

test("dates may be a few days apart and amounts must be exact; the nearest pairs first", () => {
  const xero = [
    line("x1", "2026-07-10", 500n),
    line("x2", "2026-07-12", 500n),
    line("x3", "2026-07-01", 777n),
  ];
  const rastrata = [
    line("r1", "2026-07-11", 500n),
    line("r2", "2026-07-30", 500n),
    line("r3", "2026-07-02", 776n),
  ];
  const { unmatched, matched } = matchLines(xero, rastrata, 4);
  expect(matched).toBe(1);
  expect(unmatched.map((item) => `${item.side}:${item.line.id}`).sort()).toEqual([
    "rastrata:r2",
    "rastrata:r3",
    "xero:x2",
    "xero:x3",
  ]);
  // Two equal amounts the same day on each side pair off one for one.
  const twins = matchLines(
    [line("a", "2026-07-01", 5n), line("b", "2026-07-01", 5n)],
    [line("c", "2026-07-01", 5n)],
    0,
  );
  expect(twins.matched).toBe(1);
  expect(twins.unmatched).toHaveLength(1);
});

test("Xero is only a yardstick where it was reconciled: through the end of the period, for the account and for the rest", () => {
  const behind = run(july(), { reconciledThrough: new Map([["090", "2026-07-15"]]) });
  expect(behind?.xeroReconciled).toBe(false);
  expect(behind?.xeroNotReconciled).toEqual([
    { code: "090", name: "Business Bank Account", through: "2026-07-15" },
  ]);
  for (const account of behind?.accounts ?? []) {
    expect(account.status).toBe("not_comparable");
    expect(account.reason?.code).toBe("xero_not_reconciled");
  }
  expect(behind?.accounts[0]?.reason?.message).toContain("through 2026-07-15");
  // Never given a date: it says so.
  const none = run(july(), { reconciledThrough: new Map() });
  expect(none?.accounts[0]?.reason?.message).toContain("no date that was given");
  // A bank account with no activity in the period does not hold the others back.
  const quiet = run(
    july({ xeroLines: new Map(), xeroClosing: new Map(), xeroOpening: new Map() }),
    {
      reconciledThrough: new Map(),
    },
  );
  expect(quiet?.xeroReconciled).toBe(true);
});

test("a period that starts before the cutover, an account nothing maps, and a period with no Xero data are not comparable, with the reason", () => {
  const early = run(july({ from: "2026-06-01" }), { cutoverDate: "2026-07-01" });
  expect(early?.accounts.every((item) => item.reason?.code === "before_cutover")).toBe(true);
  const stranger: AccountInput = {
    accountId: "a6000",
    code: "6000",
    name: "Software",
    role: "expense",
    xero: [],
  };
  const result = run(
    july({
      rastrataClosing: new Map([
        ["a6000", 4_599n],
        ["a1000", 1_320_000n],
      ]),
      rastrataMovement: new Map([
        ["a6000", 4_599n],
        ["a1000", 120_000n],
      ]),
      rastrataLines: new Map([
        ["a6000", [line("r9", "2026-07-09", 4_599n)]],
        ["a1000", [line("r1", "2026-07-03", 120_000n)]],
      ]),
      xeroClosing: null,
      xeroOpening: null,
      xeroLines: null,
    }),
    { accounts: [stranger, BANK, SALES] },
  );
  expect(result?.accounts.find((item) => item.code === "6000")?.reason?.code).toBe(
    "no_xero_counterpart",
  );
  expect(result?.accounts.find((item) => item.code === "1000")?.reason?.code).toBe("no_xero_data");
});

test("income compares movement from two trial balances when no transactions were imported, unless a year end is between them", () => {
  const twoTrialBalances = july({
    xeroLines: null,
    xeroOpening: new Map([
      ["090", 1_200_000n],
      ["200", -50_000n],
    ]),
    xeroClosing: new Map([
      ["090", 1_320_000n],
      ["200", -170_000n],
    ]),
  });
  const result = run(twoTrialBalances);
  expect(result?.accounts.find((item) => item.code === "4000")).toMatchObject({
    status: "matches",
    xero: -120_000n,
    unmatched: null,
    residual: null,
  });
  const crossing = run({ ...twoTrialBalances, sameFiscalYear: false });
  expect(crossing?.accounts.find((item) => item.code === "4000")?.reason?.code).toBe(
    "fiscal_year_boundary",
  );
  // A balance sheet account is compared by its balance whatever the year end.
  expect(crossing?.accounts.find((item) => item.code === "1000")?.status).toBe("matches");
});

test("several Xero accounts mapped to one account are summed, and an unmapped Xero account with a balance is listed", () => {
  const merged: AccountInput = {
    ...SALES,
    xero: [
      { code: "200", name: "Sales", bank: false },
      { code: "201", name: "Sales (services)", bank: false },
    ],
  };
  const result = run(
    july({
      // Rastrata has the sales as two lines, as Xero has them in two accounts.
      rastrataLines: new Map([
        ["a1000", [line("r1", "2026-07-03", 120_000n)]],
        ["a4000", [line("r2", "2026-07-03", -70_000n), line("r3", "2026-07-03", -50_000n)]],
      ]),
      xeroClosing: new Map([
        ["090", 1_320_000n],
        ["200", -70_000n],
        ["201", -50_000n],
        ["777", 12_300n],
      ]),
      xeroLines: new Map([
        ["090", [line("x1", "2026-07-03", 120_000n)]],
        ["200", [line("x2", "2026-07-03", -70_000n)]],
        ["201", [line("x3", "2026-07-03", -50_000n)]],
      ]),
    }),
    {
      accounts: [BANK, merged],
      xeroUnmapped: new Map([["777", { name: "Mystery", bank: false }]]),
    },
  );
  expect(result?.accounts.find((item) => item.code === "4000")).toMatchObject({
    status: "matches",
    xero: -120_000n,
    matched: 2,
  });
  expect(result?.unmapped).toEqual([{ code: "777", name: "Mystery", net: 12_300n }]);
});

test("a book that has a line the lines do not account for is residual, never silently absorbed", () => {
  // Rastrata's movement says 1,200.00 but only 1,000.00 of lines were given: 200.00 is unexplained.
  const result = run(
    july({
      rastrataLines: new Map([
        ["a1000", [line("r1", "2026-07-03", 100_000n)]],
        ["a4000", [line("r2", "2026-07-03", -120_000n)]],
      ]),
      xeroLines: new Map([
        ["090", [line("x1", "2026-07-03", 100_000n)]],
        ["200", [line("x2", "2026-07-03", -120_000n)]],
      ]),
      xeroClosing: new Map([
        ["090", 1_300_000n],
        ["200", -120_000n],
      ]),
    }),
  );
  const bank = result?.accounts[0];
  expect(bank?.difference).toBe(20_000n);
  expect(bank?.unmatched).toEqual([]);
  expect(bank?.residual).toBe(20_000n);
});
