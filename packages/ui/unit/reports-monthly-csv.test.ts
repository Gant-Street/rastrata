import { describe, expect, test } from "bun:test";
import { amountCents } from "../src/reports/format";
import { monthlyCsv } from "../src/reports/monthly-csv";
import { accounts, hostileNames, monthlyReports } from "../stories/reports/fixtures";

/** A CSV file read back by a reader written from RFC 4180's description, so the file is checked by
 * something that is not the code that wrote it. Cells are returned as the spreadsheet would show them
 * before it decides whether one is a formula. */
function parse(content: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let cell = "";
  let quoted = false;
  for (let index = 0; index < content.length; index++) {
    const char = content.charAt(index);
    if (quoted) {
      if (char === '"' && content.charAt(index + 1) === '"') {
        cell += '"';
        index += 1;
      } else if (char === '"') quoted = false;
      else cell += char;
    } else if (char === '"') quoted = true;
    else if (char === ",") {
      row.push(cell);
      cell = "";
    } else if (char === "\r" && content.charAt(index + 1) === "\n") {
      row.push(cell);
      rows.push(row);
      row = [];
      cell = "";
      index += 1;
    } else cell += char;
  }
  expect(quoted, "a quote that never closes").toBe(false);
  expect(cell, "the file ends with a line break").toBe("");
  expect(row).toEqual([]);
  return rows;
}

const cellValue = (rows: string[][], label: string, column = 1): string | undefined =>
  rows.find((row) => row[0] === label)?.[column];

describe("the by-month CSV of a profit and loss", () => {
  const reports = monthlyReports();
  const file = monthlyCsv({ statement: "profit-loss", bookName: "Harbor Studio", reports });
  const rows = parse(file.content);

  test("it says what it is, and what it was read from", () => {
    expect(file.filename).toBe("profit-loss-by-month-2025-10-01-to-2026-03-31.csv");
    expect(file.mediaType).toBe("text/csv; charset=utf-8");
    expect(cellValue(rows, "Report")).toBe("Profit and loss by month");
    expect(cellValue(rows, "Book")).toBe("Harbor Studio");
    expect(cellValue(rows, "Currency")).toBe("USD");
    expect(cellValue(rows, "Basis")).toBe("cash");
    expect(cellValue(rows, "Period start")).toBe("2025-10-01");
    expect(cellValue(rows, "Period end")).toBe("2026-03-31");
    expect(cellValue(rows, "Book revision")).toBe("42");
    expect(cellValue(rows, "Population hash")).toBe(reports.total.populationHash);
  });

  test("each column's dates and fingerprint are in the file, and the total's", () => {
    const start = rows.findIndex((row) => row[0] === "Column");
    expect(rows[start]).toEqual(["Column", "From", "To", "Population hash"]);
    const columns = rows.slice(start + 1, start + 8);
    expect(columns.map((row) => row[0])).toEqual([
      "2025-10",
      "2025-11",
      "2025-12",
      "2026-01",
      "2026-02",
      "2026-03",
      "Total",
    ]);
    expect(columns[0]).toEqual([
      "2025-10",
      "2025-10-01",
      "2025-10-31",
      reports.months[0]?.data.populationHash ?? "",
    ]);
    expect(columns[6]).toEqual(["Total", "2025-10-01", "2026-03-31", reports.total.populationHash]);
  });

  test("the table has a column for each month and the total, and every row is as wide as its heading", () => {
    const heading = rows.findIndex((row) => row[0] === "Account ID");
    expect(rows[heading]).toEqual([
      "Account ID",
      "Code",
      "Account",
      "Type",
      "2025-10",
      "2025-11",
      "2025-12",
      "2026-01",
      "2026-02",
      "2026-03",
      "Total",
    ]);
    const body = rows.slice(heading + 1).filter((row) => row.length > 1);
    expect(body.length).toBeGreaterThan(5);
    for (const row of body) expect(row, row.join("|")).toHaveLength(11);
  });

  test("every account is in the file, including one with no activity, and its months add up to its total", () => {
    const heading = rows.findIndex((row) => row[0] === "Account ID");
    const profitLoss = rows
      .slice(heading + 1)
      .filter((row) => ["income", "gain", "expense"].includes(row[3] ?? ""));
    expect(profitLoss.map((row) => row[1])).toEqual(
      accounts
        .filter((account) => ["income", "gain", "expense"].includes(account.role))
        .map((account) => account.code)
        .sort((left, right) => {
          const order = (code: string) =>
            ["income", "gain", "expense"].indexOf(
              accounts.find((account) => account.code === code)?.role ?? "",
            );
          return order(left) - order(right);
        }),
    );
    expect(profitLoss.some((row) => row[1] === "6900")).toBe(true);
    for (const row of profitLoss) {
      const months = row.slice(4, 10).reduce((all, value) => all + amountCents(value), 0n);
      expect(months, row[2]).toBe(amountCents(row[10] ?? "0.00"));
    }
  });

  test("the totals are the service's own, under its own labels", () => {
    const net = rows.find((row) => row[2] === "Net income");
    expect(net?.slice(4)).toEqual([
      ...reports.months.map(
        (column) =>
          column.data.profitAndLoss.totals.find((total) => total.key === "netIncome")?.amount ?? "",
      ),
      "13039.60",
    ]);
    expect(rows.some((row) => row[2] === "Total income")).toBe(true);
    expect(rows.some((row) => row[2] === "Total expenses")).toBe(true);
  });

  test("money cells are plain decimals a spreadsheet reads as numbers, negative ones included", () => {
    const withLoss = monthlyReports({
      accounts: accounts.map((account) =>
        account.id === "5000" ? { ...account, now: -account.now } : account,
      ),
    });
    const text = monthlyCsv({ statement: "profit-loss", bookName: "B", reports: withLoss }).content;
    const negative = parse(text).find((row) => row[1] === "5000");
    expect(negative?.slice(4).every((cell) => /^-?\d+\.\d{2}$/.test(cell))).toBe(true);
    expect(negative?.slice(4).some((cell) => cell.startsWith("-"))).toBe(true);
    // None of them was given a leading quote: they are numbers, not text.
    expect(negative?.slice(4).some((cell) => cell.startsWith("'"))).toBe(false);
  });
});

describe("the by-month CSV of a balance sheet", () => {
  const reports = monthlyReports();
  const file = monthlyCsv({ statement: "balance-sheet", bookName: "Harbor Studio", reports });
  const rows = parse(file.content);

  test("a column for the end of each month, and no total", () => {
    expect(file.filename).toBe("balance-sheet-by-month-2025-10-01-to-2026-03-31.csv");
    expect(cellValue(rows, "Report")).toBe("Balance sheet by month");
    const heading = rows.find((row) => row[0] === "Account ID");
    expect(heading?.slice(4)).toEqual([
      "2025-10",
      "2025-11",
      "2025-12",
      "2026-01",
      "2026-02",
      "2026-03",
    ]);
    expect(rows.some((row) => row[0] === "Total")).toBe(false);
  });

  test("assets, liabilities and equity come in that order, and every column balances", () => {
    const heading = rows.findIndex((row) => row[0] === "Account ID");
    const body = rows.slice(heading + 1).filter((row) => row[3] !== undefined && row[3] !== "");
    const roles = body.map((row) => row[3]);
    expect(roles.indexOf("asset")).toBeLessThan(roles.indexOf("liability"));
    expect(roles.lastIndexOf("liability")).toBeLessThan(roles.indexOf("equity"));
    const assets = rows.find((row) => row[2] === "Total assets");
    const both = rows.find((row) => row[2] === "Total liabilities and equity");
    expect(both?.slice(4)).toEqual(assets?.slice(4));
  });
});

describe("the by-month CSV is safe to open in a spreadsheet", () => {
  test("an account name that a spreadsheet would run as a formula is text", () => {
    const names = [
      '=HYPERLINK("https://evil.example","Click")',
      "+1 (555) 010-0199",
      "-2+3+cmd|' /C calc'!A0",
      "@SUM(1+1)",
      "\tTabbed",
      "\rReturned",
    ];
    const hostile = names.map((name, index) => ({
      ...hostileNames[0],
      id: `9${index}`,
      code: `9${index}00`,
      name,
      role: "expense" as const,
      now: 100n,
      earlier: 0n,
    }));
    const reports = monthlyReports({ accounts: [...accounts, ...hostile] });
    const text = monthlyCsv({
      statement: "profit-loss",
      bookName: "=cmd|' /C calc'!A0",
      reports,
    }).content;
    const rows = parse(text);
    // The book's name is text too.
    expect(cellValue(rows, "Book")).toBe("'=cmd|' /C calc'!A0");
    for (const [index, name] of names.entries()) {
      const row = rows.find((candidate) => candidate[1] === `9${index}00`);
      expect(row?.[2], name).toBe(`'${name}`);
    }
    // No cell of the file begins with a character a spreadsheet would run, apart from the money.
    for (const row of rows)
      for (const cell of row)
        if (!/^-?\d+\.\d{2}$/.test(cell)) expect(cell, cell).not.toMatch(/^[=+\-@\t\r]/);
  });

  test("a name with a comma, a quote or a line break is quoted, and reads back as it was", () => {
    const awkward = {
      id: "7100",
      code: "7100",
      name: 'Smith, "Brothers"\nand Sons',
      role: "expense" as const,
      now: 1000n,
      earlier: 0n,
    };
    const reports = monthlyReports({ accounts: [...accounts, awkward] });
    const text = monthlyCsv({ statement: "profit-loss", bookName: "B", reports }).content;
    expect(text).toContain('"Smith, ""Brothers""\nand Sons"');
    expect(parse(text).find((row) => row[1] === "7100")?.[2]).toBe('Smith, "Brothers"\nand Sons');
  });

  test("a figure that is not money is refused, not written", () => {
    const reports = monthlyReports();
    const broken = {
      ...reports,
      months: reports.months.map((column, index) =>
        index === 0
          ? {
              ...column,
              data: {
                ...column.data,
                profitAndLoss: {
                  ...column.data.profitAndLoss,
                  rows: column.data.profitAndLoss.rows.map((row, at) =>
                    at === 0 ? { ...row, amount: "=1+1" } : row,
                  ),
                },
              },
            }
          : column,
      ),
    };
    expect(() => monthlyCsv({ statement: "profit-loss", bookName: "B", reports: broken })).toThrow(
      /money cell/,
    );
  });
});
