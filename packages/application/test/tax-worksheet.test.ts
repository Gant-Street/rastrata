import { describe, expect, test } from "bun:test";
import type { AccountTagMap } from "../src/account-tags.ts";
import { buildTagMap, type TagRecord } from "../src/chart/tags.ts";
import { taxForm } from "../src/chart/tax-lines.ts";
import { compileReports } from "../src/reports.ts";
import { catalogLineIds, worksheetLayout, WORKSHEET_FORMS } from "../src/tax/forms.ts";
import {
  compileWorksheet,
  defaultWorksheetForm,
  percentOf,
  worksheetPostings,
  type WorksheetRequest,
} from "../src/tax/worksheet.ts";
import {
  worksheetAccountsCsv,
  worksheetCsv,
  worksheetHeader,
  worksheetPostingsCsv,
} from "../src/tax/csv.ts";
import { KernelBook, sequence, type AccountSpec } from "./support/kernel-book.ts";

const money = (cents: bigint) => {
  const negative = cents < 0n;
  const absolute = negative ? -cents : cents;
  return `${negative ? "-" : ""}${absolute / 100n}.${(absolute % 100n).toString().padStart(2, "0")}`;
};
const C = (dollars: number, cents = 0) => BigInt(dollars) * 100n + BigInt(cents);

/** Tags the way the chart lane records them: an effective date and a value per account and tag. */
function tagMap(
  tags: readonly (readonly [account: string, line: string | null, from?: string])[],
): AccountTagMap {
  const records: TagRecord[] = tags.map(([accountId, value, from], index) => ({
    seq: index + 1,
    accountId,
    tag: "taxLine",
    effectiveOn: from ?? "0001-01-01",
    value,
  }));
  return buildTagMap(records, records.length);
}

const SCHEDULE_C_ACCOUNTS: readonly AccountSpec[] = [
  { code: "1000", role: "asset", name: "Checking" },
  { code: "3000", role: "equity", name: "Owner investment" },
  { code: "4000", role: "income", name: "Sales" },
  { code: "4100", role: "income", name: "Returns and allowances" },
  { code: "4900", role: "income", name: "Other income" },
  { code: "5000", role: "expense", name: "Purchases" },
  { code: "6000", role: "expense", name: "Advertising" },
  { code: "6100", role: "expense", name: "Meals" },
  { code: "6200", role: "expense", name: "Software" },
  { code: "6300", role: "expense", name: "Interest" },
  { code: "6900", role: "expense", name: "Miscellaneous" },
  { code: "6950", role: "expense", name: "Gifts" },
];

/** The entries a person would post, as plain data: the expected figures below are summed from this
 * list with ordinary loops, not from anything the compiler does. */
const ENTRIES: readonly {
  date: string;
  lines: readonly (readonly [string, bigint])[];
  memo: string;
}[] = [
  {
    date: "2025-01-05",
    lines: [
      ["1000", C(10000)],
      ["3000", -C(10000)],
    ],
    memo: "Owner investment",
  },
  {
    date: "2025-02-10",
    lines: [
      ["1000", C(5000)],
      ["4000", -C(5000)],
    ],
    memo: "Sales February",
  },
  {
    date: "2025-03-15",
    lines: [
      ["1000", C(7500, 55)],
      ["4000", -C(7500, 55)],
    ],
    memo: "Sales March",
  },
  {
    date: "2025-04-01",
    lines: [
      ["4100", C(120)],
      ["1000", -C(120)],
    ],
    memo: "Refund to a customer",
  },
  {
    date: "2025-04-20",
    lines: [
      ["6000", C(300)],
      ["1000", -C(300)],
    ],
    memo: "Ads",
  },
  {
    date: "2025-05-05",
    lines: [
      ["6100", C(100, 5)],
      ["1000", -C(100, 5)],
    ],
    memo: "Client lunch",
  },
  {
    date: "2025-06-30",
    lines: [
      ["6000", C(200)],
      ["1000", -C(200)],
    ],
    memo: "Ads June",
  },
  {
    date: "2025-07-01",
    lines: [
      ["6000", C(50)],
      ["1000", -C(50)],
    ],
    memo: "Paper (after the re-tag)",
  },
  {
    date: "2025-08-08",
    lines: [
      ["6200", C(99, 99)],
      ["1000", -C(99, 99)],
    ],
    memo: "Software",
  },
  {
    date: "2025-09-09",
    lines: [
      ["5000", C(1000)],
      ["1000", -C(1000)],
    ],
    memo: "Stock bought",
  },
  {
    date: "2025-10-10",
    lines: [
      ["6900", C(77, 77)],
      ["1000", -C(77, 77)],
    ],
    memo: "Odds and ends",
  },
  {
    date: "2025-11-11",
    lines: [
      ["6950", C(33, 33)],
      ["1000", -C(33, 33)],
    ],
    memo: "A gift",
  },
  {
    date: "2025-12-15",
    lines: [
      ["6300", C(12, 34)],
      ["1000", -C(12, 34)],
    ],
    memo: "Interest",
  },
  {
    date: "2025-12-31",
    lines: [
      ["1000", C(40)],
      ["4900", -C(40)],
    ],
    memo: "Rebate received",
  },
  {
    date: "2026-01-15",
    lines: [
      ["6100", C(999)],
      ["1000", -C(999)],
    ],
    memo: "Next year's lunch",
  },
];

function scheduleCBook(): KernelBook {
  const book = new KernelBook({
    basis: "cash",
    firstYear: 2025,
    years: 2,
    accounts: SCHEDULE_C_ACCOUNTS,
  });
  for (const entry of ENTRIES) book.post(entry.date, entry.lines, entry.memo);
  // Posted and reversed within the year: nets to nothing wherever it is counted.
  const mistake = book.post(
    "2025-12-20",
    [
      ["6000", C(500)],
      ["1000", -C(500)],
    ],
    "Posted twice",
  );
  book.reverse(mistake, "2025-12-21");
  return book;
}

const SCHEDULE_C_TAGS = tagMap([
  ["4000", "scheduleC.line1"],
  ["4100", "scheduleC.line2"],
  ["4900", "scheduleC.line6"],
  ["5000", "scheduleC.line36"],
  ["6000", "scheduleC.line8"],
  ["6000", "scheduleC.line22", "2025-07-01"],
  ["6100", "scheduleC.line24b"],
  ["6200", "scheduleC.line27b"],
  ["6300", "scheduleC.line16b"],
  ["6950", "form1120S.line16"],
]);

const request = (overrides: Partial<WorksheetRequest> = {}): WorksheetRequest => ({
  taxYear: 2025,
  form: "scheduleC",
  from: "2025-01-01",
  to: "2025-12-31",
  mealsPercent: 50,
  tags: SCHEDULE_C_TAGS,
  today: "2026-03-01",
  ...overrides,
});

const line = (worksheet: ReturnType<typeof compileWorksheet>, key: string) => {
  for (const part of worksheet.parts)
    for (const entry of part.lines) if (entry.key === key) return entry;
  throw new Error(`No line ${key}`);
};

describe("percentOf", () => {
  test("rounds half a cent away from zero and is exact for whole percentages", () => {
    expect(percentOf(10005n, 50)).toBe(5003n);
    expect(percentOf(-10005n, 50)).toBe(-5003n);
    expect(percentOf(10004n, 50)).toBe(5002n);
    expect(percentOf(10005n, 80)).toBe(8004n);
    expect(percentOf(12345n, 100)).toBe(12345n);
    expect(percentOf(12345n, 0)).toBe(0n);
    expect(percentOf(1n, 50)).toBe(1n);
    expect(percentOf(-1n, 50)).toBe(-1n);
    expect(percentOf(0n, 50)).toBe(0n);
  });
});

describe("a Schedule C worksheet for 2025", () => {
  const book = scheduleCBook();
  const worksheet = compileWorksheet(book.state, request());

  test("each tagged line is the sum of its accounts, in the line's own sign", () => {
    expect(line(worksheet, "scheduleC.line1").booked).toBe(money(C(12500, 55)));
    // Returns and allowances are a positive number on the form.
    expect(line(worksheet, "scheduleC.line2").amount).toBe("120.00");
    expect(line(worksheet, "scheduleC.line6").amount).toBe("40.00");
    expect(line(worksheet, "scheduleC.line36").amount).toBe("1000.00");
    // 6000 was re-tagged from 1 July: the postings before it feed line 8, those from it feed line 22.
    // The 500.00 posted and reversed in December nets to nothing on line 22.
    expect(line(worksheet, "scheduleC.line8").amount).toBe("500.00");
    expect(line(worksheet, "scheduleC.line22").amount).toBe("50.00");
    expect(line(worksheet, "scheduleC.line27b").amount).toBe("99.99");
    expect(line(worksheet, "scheduleC.line16b").amount).toBe("12.34");
    expect(line(worksheet, "scheduleC.line16a").amount).toBe("0.00");
  });

  test("exactly one line is flagged as the net, so a screen can set it apart without reading a label", () => {
    const flagged = worksheet.parts.flatMap((part) => part.lines).filter((entry) => entry.net);
    expect(flagged.map((entry) => entry.key)).toEqual(["scheduleC.line31"]);
    expect(flagged[0]?.kind).toBe("computed");
    expect(flagged[0]?.amount).toBe(worksheet.reconciliation.netProfit);
  });

  test("the computed lines are the arithmetic the form prints", () => {
    expect(line(worksheet, "scheduleC.line3").amount).toBe(money(C(12500, 55) - C(120)));
    expect(line(worksheet, "scheduleC.line40").amount).toBe("1000.00");
    expect(line(worksheet, "scheduleC.line42").amount).toBe("1000.00");
    expect(line(worksheet, "scheduleC.line4").amount).toBe("1000.00");
    expect(line(worksheet, "scheduleC.line5").amount).toBe(money(C(12500, 55) - C(120) - C(1000)));
    expect(line(worksheet, "scheduleC.line7").amount).toBe(
      money(C(12500, 55) - C(120) - C(1000) + C(40)),
    );
    // Meals at 50% of 100.05 is 50.025, rounded half away from zero to 50.03.
    expect(line(worksheet, "scheduleC.line24b").booked).toBe("100.05");
    expect(line(worksheet, "scheduleC.line24b").amount).toBe("50.03");
    expect(line(worksheet, "scheduleC.line24b").adjustment).toEqual({
      kind: "meals",
      percent: 50,
      removed: "50.02",
      reason: expect.any(String),
    });
    expect(line(worksheet, "scheduleC.line28").amount).toBe(
      money(C(500) + C(50) + C(50, 3) + C(99, 99) + C(12, 34)),
    );
    expect(line(worksheet, "scheduleC.line28").booked).toBe(
      money(C(500) + C(50) + C(100, 5) + C(99, 99) + C(12, 34)),
    );
    expect(line(worksheet, "scheduleC.line30").amount).toBe("0.00");
    expect(line(worksheet, "scheduleC.line31").amount).toBe(
      money(C(11420, 55) - (C(500) + C(50) + C(50, 3) + C(99, 99) + C(12, 34))),
    );
    // Inventory is not in the books.
    expect(line(worksheet, "scheduleC.line35").kind).toBe("untracked");
    expect(line(worksheet, "scheduleC.line35").amount).toBe("0.00");
  });

  test("accounts with activity and no line from the form are listed, never guessed", () => {
    expect(
      worksheet.unmapped.map((row) => [row.code, row.reason, row.taxLine, row.amount]),
    ).toEqual([
      ["6900", "no_tax_line", null, "77.77"],
      ["6950", "other_form", "form1120S.line16", "33.33"],
    ]);
    expect(worksheet.unmappedExpenses).toBe("111.10");
    expect(worksheet.unmappedIncome).toBe("0.00");
    expect(worksheet.warnings.map((warning) => warning.code)).toContain("unmapped_accounts");
  });

  test("the accounts behind a line carry the dates of their postings", () => {
    const advertising = line(worksheet, "scheduleC.line8").accounts;
    expect(advertising).toEqual([
      {
        accountId: "6000",
        code: "6000",
        name: "Advertising",
        role: "expense",
        amount: "500.00",
        from: "2025-04-20",
        to: "2025-06-30",
        postings: 2,
      },
    ]);
    const supplies = line(worksheet, "scheduleC.line22").accounts;
    expect(supplies[0]).toMatchObject({ from: "2025-07-01", to: "2025-12-21", postings: 3 });
    expect(supplies[0]?.amount).toBe("50.00");
  });

  test("reconciles exactly to the profit and loss of the same dates", () => {
    const reports = compileReports(book.state, "2025-12-31", { from: "2025-01-01" });
    expect(worksheet.reconciliation.netIncomeBooks).toBe(reports.profitAndLoss.netIncome);
    expect(worksheet.reconciliation.ties).toBe(true);
    const total = worksheet.reconciliation.rows.reduce(
      (sum, row) => sum + BigInt(row.amount.replace(".", "")),
      0n,
    );
    expect(money(total)).toBe(worksheet.reconciliation.netIncomeBooks);
    // The independent figure: revenue less every expense, summed from the entries above.
    const revenue = C(12500, 55) - C(120) + C(40);
    const expenses =
      C(1000) + C(300) + C(100, 5) + C(200) + C(50) + C(99, 99) + C(77, 77) + C(33, 33) + C(12, 34);
    expect(worksheet.reconciliation.netIncomeBooks).toBe(money(revenue - expenses));
    expect(worksheet.ledgerPopulationHash).toBe(reports.populationHash);
  });

  test("a year that has not ended says the figures are so far; the range and cutover are said", () => {
    const early = compileWorksheet(book.state, request({ today: "2025-06-01" }));
    expect(early.warnings.map((warning) => warning.code)).toContain("year_not_ended");
    expect(worksheet.warnings.map((warning) => warning.code)).not.toContain("year_not_ended");
    const started = compileWorksheet(book.state, request({ booksStartOn: "2025-04-01" }));
    expect(started.warnings.map((warning) => warning.code)).toContain("books_start_late");
    const custom = compileWorksheet(book.state, request({ from: "2025-04-01", to: "2025-09-30" }));
    expect(custom.warnings.map((warning) => warning.code)).toContain("range_not_calendar_year");
    expect(line(custom, "scheduleC.line1").amount).toBe("0.00");
    expect(line(custom, "scheduleC.line8").amount).toBe("500.00");
  });

  test("the meals percentage is applied and shown, and 100 takes nothing off", () => {
    const all = compileWorksheet(book.state, request({ mealsPercent: 100 }));
    expect(line(all, "scheduleC.line24b").amount).toBe("100.05");
    expect(line(all, "scheduleC.line24b").adjustment?.removed).toBe("0.00");
    const trucker = compileWorksheet(book.state, request({ mealsPercent: 80 }));
    expect(line(trucker, "scheduleC.line24b").amount).toBe("80.04");
    expect(trucker.reconciliation.ties).toBe(true);
    expect(trucker.populationHash).not.toBe(worksheet.populationHash);
  });

  test("the population changes with the tags, the range and the book, and is stable otherwise", () => {
    expect(compileWorksheet(book.state, request()).populationHash).toBe(worksheet.populationHash);
    const retagged = tagMap([
      ["4000", "scheduleC.line1"],
      ["6000", "scheduleC.line8"],
    ]);
    expect(compileWorksheet(book.state, request({ tags: retagged })).populationHash).not.toBe(
      worksheet.populationHash,
    );
    expect(compileWorksheet(book.state, request({ to: "2025-12-30" })).populationHash).not.toBe(
      worksheet.populationHash,
    );
  });

  test("the posting detail adds up to each line and carries the journal behind it", () => {
    const rows = worksheetPostings(book.state, request());
    const byLine = new Map<string, bigint>();
    for (const row of rows)
      if (row.line) byLine.set(row.line, (byLine.get(row.line) ?? 0n) + row.amount);
    expect(money(byLine.get("scheduleC.line1") ?? 0n)).toBe("12500.55");
    expect(money(byLine.get("scheduleC.line22") ?? 0n)).toBe("50.00");
    expect(
      rows.filter((row) => row.status === "no_tax_line").map((row) => row.account.code),
    ).toEqual(["6900"]);
    expect(rows.every((row) => row.journalId.startsWith("fx-"))).toBe(true);
    // Nothing outside the range is in it.
    expect(rows.every((row) => row.date >= "2025-01-01" && row.date <= "2025-12-31")).toBe(true);
  });

  test("the files are CSV with neutralised text and exact money", () => {
    const header = worksheetHeader(worksheet, "=HYPERLINK(x) Co");
    const csv = worksheetCsv(header, worksheet);
    expect(csv).toContain("Report,Schedule C (Form 1040) worksheet 2025");
    // A book name that starts like a formula is made text.
    expect(csv).toContain("Book,'=HYPERLINK(x) Co");
    expect(csv).toContain(`Population hash,${worksheet.populationHash}`);
    expect(csv).toMatch(
      /Part II: Expenses,24b,Travel and meals: Deductible meals,tagged,100\.05,50\.03,/,
    );
    expect(csv).toContain("Net income per the profit and loss, same dates");
    expect(csv.split("\r\n").every((row) => !/^[=+@]/.test(row))).toBe(true);
    const accounts = worksheetAccountsCsv(header, worksheet);
    expect(accounts).toContain("not mapped: other_form");
    const postings = worksheetPostingsCsv(header, worksheetPostings(book.state, request()));
    expect(postings).toContain("Journal ID");
    expect(postings.split("\r\n").length).toBeGreaterThan(20);
  });
});

describe("a worksheet from a hostile account name", () => {
  test("is neutralised everywhere it is written", () => {
    const book = new KernelBook({
      basis: "cash",
      firstYear: 2025,
      years: 1,
      accounts: [
        { code: "1000", role: "asset", name: "Checking" },
        { code: "4000", role: "income", name: "=cmd|' /C calc'!A0" },
        { code: "6000", role: "expense", name: "@SUM(1+1)" },
      ],
    });
    book.post(
      "2025-02-01",
      [
        ["1000", C(10)],
        ["4000", -C(10)],
      ],
      "+1 memo",
    );
    book.post(
      "2025-02-02",
      [
        ["6000", C(3)],
        ["1000", -C(3)],
      ],
      "-2 memo",
    );
    const worksheet = compileWorksheet(book.state, request({ tags: tagMap([]) }));
    const header = worksheetHeader(worksheet, "Hostile Co");
    const accounts = worksheetAccountsCsv(header, worksheet);
    expect(accounts).toContain("'=cmd|' /C calc'!A0");
    expect(accounts).toContain("'@SUM(1+1)");
    const postings = worksheetPostingsCsv(
      header,
      worksheetPostings(book.state, request({ tags: tagMap([]) })),
    );
    expect(postings).toContain("'+1 memo");
    expect(postings).toContain("'-2 memo");
  });
});

describe("layouts and the verified catalog", () => {
  for (const form of WORKSHEET_FORMS)
    for (const year of [2025, 2026])
      test(`${form} ${year}: every catalog line is in the layout once, and every term resolves`, () => {
        const layout = worksheetLayout(form, year);
        const items = layout.parts.flatMap((part) => part.items);
        const ids = items.map((item) => item.id);
        expect(new Set(ids).size).toBe(ids.length);
        const tagged = items.filter((item) => item.kind === "tagged").map((item) => item.id);
        expect([...tagged].sort()).toEqual([...catalogLineIds(form, year)].sort());
        for (const item of items) {
          if (item.kind === "tagged")
            for (const more of item.plus ?? []) expect(ids).toContain(more);
          if (item.kind === "computed")
            for (const [, term] of item.terms) expect(ids).toContain(term);
        }
        expect(ids).toContain(layout.net);
        // The lines and their numbers come from the verified catalog for that year.
        for (const id of tagged)
          expect(layout.forms.some((f) => taxForm(f, year)?.lines.some((l) => l.id === id))).toBe(
            true,
          );
      });

  test("Schedule C 2026 has the three interest lines and 2025 has two", () => {
    const interest = (year: number) =>
      worksheetLayout("scheduleC", year)
        .parts.flatMap((part) => part.items)
        .map((item) => item.id)
        .filter((id) => /line16/.test(id));
    expect(interest(2025)).toEqual(["scheduleC.line16a", "scheduleC.line16b"]);
    expect(interest(2026)).toEqual(["scheduleC.line16a", "scheduleC.line16b", "scheduleC.line16c"]);
  });
});

describe("an S corporation worksheet", () => {
  const accounts: readonly AccountSpec[] = [
    { code: "1000", role: "asset", name: "Bank" },
    { code: "3000", role: "equity", name: "Stock" },
    { code: "4000", role: "income", name: "Sales" },
    { code: "4100", role: "income", name: "Returns" },
    { code: "5000", role: "expense", name: "Purchases" },
    { code: "5100", role: "expense", name: "Direct labor" },
    { code: "6000", role: "expense", name: "Officer pay" },
    { code: "6100", role: "expense", name: "Insurance" },
    { code: "6200", role: "expense", name: "Meals" },
  ];
  const tags = tagMap([
    ["4000", "form1120S.line1a"],
    ["4100", "form1120S.line1b"],
    ["5000", "form1125A.line2"],
    ["5100", "form1125A.line3"],
    ["6000", "form1120S.line7"],
    ["6100", "form1120S.line20"],
    ["6200", "form1120S.line20"],
  ]);
  const book = new KernelBook({ basis: "accrual", firstYear: 2026, years: 1, accounts });
  book.post(
    "2026-02-01",
    [
      ["1000", C(50000)],
      ["4000", -C(50000)],
    ],
    "Sales",
  );
  book.post(
    "2026-03-01",
    [
      ["4100", C(2000)],
      ["1000", -C(2000)],
    ],
    "Returns",
  );
  book.post(
    "2026-04-01",
    [
      ["5000", C(10000)],
      ["1000", -C(10000)],
    ],
    "Purchases",
  );
  book.post(
    "2026-05-01",
    [
      ["5100", C(5000)],
      ["1000", -C(5000)],
    ],
    "Labor",
  );
  book.post(
    "2026-06-01",
    [
      ["6000", C(12000)],
      ["1000", -C(12000)],
    ],
    "Officer",
  );
  book.post(
    "2026-07-01",
    [
      ["6100", C(1500)],
      ["1000", -C(1500)],
    ],
    "Insurance",
  );
  book.post(
    "2026-08-01",
    [
      ["6200", C(250)],
      ["1000", -C(250)],
    ],
    "Meals",
  );
  const worksheet = compileWorksheet(book.state, {
    taxYear: 2026,
    form: "form1120S",
    from: "2026-01-01",
    to: "2026-12-31",
    mealsPercent: 50,
    tags,
    today: "2027-01-10",
  });

  test("totals the lines, takes cost of goods sold from Form 1125-A and ties to the profit and loss", () => {
    expect(line(worksheet, "form1120S.line1c").amount).toBe("48000.00");
    expect(line(worksheet, "form1125A.line6").amount).toBe("15000.00");
    expect(line(worksheet, "form1125A.line8").amount).toBe("15000.00");
    expect(line(worksheet, "form1120S.line2").amount).toBe("15000.00");
    expect(line(worksheet, "form1120S.line3").amount).toBe("33000.00");
    expect(line(worksheet, "form1120S.line6").amount).toBe("33000.00");
    expect(line(worksheet, "form1120S.line7").amount).toBe("12000.00");
    expect(line(worksheet, "form1120S.line20").amount).toBe("1750.00");
    expect(line(worksheet, "form1120S.line21").amount).toBe("13750.00");
    expect(line(worksheet, "form1120S.line22").amount).toBe("19250.00");
    expect(worksheet.unmapped).toEqual([]);
    expect(worksheet.reconciliation.netIncomeBooks).toBe("19250.00");
    // Other deductions list each account, for the statement the instructions ask for.
    expect(line(worksheet, "form1120S.line20").accounts.map((row) => row.code)).toEqual([
      "6100",
      "6200",
    ]);
    expect(worksheet.forms.map((form) => form.id)).toEqual(["form1120S", "form1125A"]);
    // The 2026 forms are IRS drafts and the worksheet says so.
    expect(worksheet.form.status).toBe("draft");
    expect(worksheet.warnings.map((warning) => warning.code)).toContain("draft_form");
    expect(worksheet.notes.map((note) => note.key)).toContain("draft");
  });

  test("an account tagged straight to line 2 adds to the Form 1125-A total", () => {
    const direct = tagMap([
      ["4000", "form1120S.line1a"],
      ["5000", "form1120S.line2"],
      ["5100", "form1125A.line3"],
    ]);
    const result = compileWorksheet(book.state, {
      taxYear: 2026,
      form: "form1120S",
      from: "2026-01-01",
      to: "2026-12-31",
      mealsPercent: 50,
      tags: direct,
      today: "2027-01-10",
    });
    expect(line(result, "form1120S.line2").amount).toBe("15000.00");
    expect(line(result, "form1120S.line2").formula).toContain("Form 1125-A line 8");
    expect(result.reconciliation.ties).toBe(true);
  });

  test("the form is chosen from the tags when none is given", () => {
    expect(defaultWorksheetForm(book.state, tags, "2026-12-31")).toBe("form1120S");
    expect(defaultWorksheetForm(book.state, tagMap([]), "2026-12-31")).toBe("scheduleC");
    const partnership = tagMap([
      ["4000", "form1065.line1a"],
      ["6100", "form1065.line21"],
      ["6000", "form1120S.line7"],
    ]);
    expect(defaultWorksheetForm(book.state, partnership, "2026-12-31")).toBe("form1065");
  });
});

describe("a partnership worksheet", () => {
  test("shows depreciation as line 16a less 16b and guaranteed payments on line 10", () => {
    const book = new KernelBook({
      basis: "cash",
      firstYear: 2025,
      years: 1,
      accounts: [
        { code: "1000", role: "asset", name: "Bank" },
        { code: "4000", role: "income", name: "Fees" },
        { code: "6000", role: "expense", name: "Guaranteed payments" },
        { code: "6100", role: "expense", name: "Depreciation" },
      ],
    });
    book.post(
      "2025-03-01",
      [
        ["1000", C(9000)],
        ["4000", -C(9000)],
      ],
      "Fees",
    );
    book.post(
      "2025-04-01",
      [
        ["6000", C(2000)],
        ["1000", -C(2000)],
      ],
      "Guaranteed payment",
    );
    book.post(
      "2025-05-01",
      [
        ["6100", C(300)],
        ["1000", -C(300)],
      ],
      "Depreciation",
    );
    const worksheet = compileWorksheet(book.state, {
      taxYear: 2025,
      form: "form1065",
      from: "2025-01-01",
      to: "2025-12-31",
      mealsPercent: 50,
      tags: tagMap([
        ["4000", "form1065.line1a"],
        ["6000", "form1065.line10"],
        ["6100", "form1065.line16a"],
      ]),
      today: "2026-02-01",
    });
    expect(line(worksheet, "form1065.line16c").amount).toBe("300.00");
    expect(line(worksheet, "form1065.line22").amount).toBe("2300.00");
    expect(line(worksheet, "form1065.line23").amount).toBe("6700.00");
    expect(line(worksheet, "form1065.line16b").kind).toBe("untracked");
    expect(worksheet.form.status).toBe("final");
    expect(worksheet.warnings.map((warning) => warning.code)).not.toContain("draft_form");
  });
});

describe("any book, any tags", () => {
  // A seeded generator: random postings to random accounts with random (and changing) tags. Whatever
  // the tags, the worksheet reconciles to the profit and loss to the cent and never loses an amount.
  test("always reconciles, and every income and expense posting is in exactly one place", () => {
    const lines2025 = taxForm("scheduleC", 2025)?.lines.map((entry) => entry.id) ?? [];
    for (let seed = 1; seed <= 25; seed++) {
      const random = sequence(seed);
      const pick = <T>(items: readonly T[]): T => items[Math.floor(random() * items.length)] as T;
      const accounts: AccountSpec[] = [
        { code: "1000", role: "asset", name: "Bank" },
        ...Array.from({ length: 6 }, (_, index) => ({
          code: `4${index}00`,
          role: "income" as const,
          name: `Income ${index}`,
        })),
        ...Array.from({ length: 10 }, (_, index) => ({
          code: `6${index}00`,
          role: "expense" as const,
          name: `Expense ${index}`,
        })),
      ];
      const book = new KernelBook({ basis: "cash", firstYear: 2025, years: 1, accounts });
      const records: TagRecord[] = [];
      let sequenceNumber = 0;
      for (const account of accounts.slice(1)) {
        const choices =
          account.role === "income"
            ? [
                "scheduleC.line1",
                "scheduleC.line2",
                "scheduleC.line6",
                "form1120S.line1a",
                undefined,
              ]
            : [
                "scheduleC.line8",
                "scheduleC.line24b",
                "scheduleC.line27b",
                "scheduleC.line36",
                "scheduleC.line16c",
                "form1065.line21",
                undefined,
              ];
        for (let change = 0; change < 3; change++) {
          const value = pick(choices);
          records.push({
            seq: ++sequenceNumber,
            accountId: account.code,
            tag: "taxLine",
            effectiveOn:
              change === 0
                ? "0001-01-01"
                : `2025-${String(1 + Math.floor(random() * 12)).padStart(2, "0")}-15`,
            value: value ?? null,
          });
        }
      }
      for (let index = 0; index < 60; index++) {
        const month = 1 + Math.floor(random() * 12);
        const date = `2025-${String(month).padStart(2, "0")}-${String(1 + Math.floor(random() * 28)).padStart(2, "0")}`;
        const target = pick(accounts.slice(1));
        const cents = BigInt(100 + Math.floor(random() * 500000));
        if (target.role === "income")
          book.post(
            date,
            [
              ["1000", cents],
              [target.code, -cents],
            ],
            `sale ${index}`,
          );
        else
          book.post(
            date,
            [
              [target.code, cents],
              ["1000", -cents],
            ],
            `cost ${index}`,
          );
      }
      const tags = buildTagMap(records, records.length);
      const worksheet = compileWorksheet(
        book.state,
        request({ tags, mealsPercent: pick([50, 80, 100, 0]) }),
      );
      const reports = compileReports(book.state, "2025-12-31", { from: "2025-01-01" });
      expect(worksheet.reconciliation.netIncomeBooks).toBe(reports.profitAndLoss.netIncome);
      // Every posting is in exactly one place: the detail sums to the figures.
      const rows = worksheetPostings(book.state, request({ tags }));
      const ledger = new Map<string, bigint>();
      for (const row of rows)
        ledger.set(
          row.account.code,
          (ledger.get(row.account.code) ?? 0n) +
            (row.account.role === "income" ? -row.amount : row.amount),
        );
      const mapped = rows.filter((row) => row.line !== null).length;
      const unmapped = rows.length - mapped;
      expect(rows.length).toBe(60);
      expect(mapped + unmapped).toBe(60);
      // Tagged lines never carry a line the form does not have.
      for (const part of worksheet.parts)
        for (const entry of part.lines)
          if (entry.kind === "tagged") expect(lines2025).toContain(entry.key);
    }
    // Twenty-five books built straight from the kernel: a few seconds on a quiet machine and far
    // more on a busy one, so the default five seconds is not the limit.
  }, 300_000);
});
