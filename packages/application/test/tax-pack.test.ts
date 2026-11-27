import { describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import type { AccountTagMap } from "../src/account-tags.ts";
import { buildTagMap, type TagRecord } from "../src/chart/tags.ts";
import { compileReports } from "../src/reports.ts";
import { yearClose } from "../src/tax/close.ts";
import { buildPack, PACK_FORMAT } from "../src/tax/pack.ts";
import { analyzeWorksheet, type WorksheetRequest } from "../src/tax/worksheet.ts";
import { KernelBook, type AccountSpec } from "./support/kernel-book.ts";

// ---------------------------------------------------------------------------------------------
// The scenario: a plain list of entries. Every expected figure below is summed from this list with
// ordinary loops; nothing is read back from the compiler under test.
// ---------------------------------------------------------------------------------------------
const C = (dollars: number, cents = 0) => BigInt(dollars) * 100n + BigInt(cents);
const money = (cents: bigint) => {
  const negative = cents < 0n;
  const absolute = negative ? -cents : cents;
  return `${negative ? "-" : ""}${absolute / 100n}.${(absolute % 100n).toString().padStart(2, "0")}`;
};

const ACCOUNTS: readonly (AccountSpec & {
  tax?: string;
  flow?: string;
})[] = [
  { code: "1000", role: "asset", name: "Checking", flow: "cash" },
  { code: "1500", role: "asset", name: "Equipment", flow: "investing" },
  { code: "2000", role: "liability", name: "Card", flow: "operating" },
  { code: "2500", role: "liability", name: "Loan", flow: "financing" },
  { code: "3000", role: "equity", name: "Owner investment", flow: "financing" },
  { code: "3100", role: "equity", name: "Owner draw", flow: "financing" },
  { code: "4000", role: "income", name: "Sales", tax: "scheduleC.line1" },
  { code: "4100", role: "income", name: "Returns", tax: "scheduleC.line2" },
  { code: "6000", role: "expense", name: "Advertising", tax: "scheduleC.line8" },
  { code: "6100", role: "expense", name: "Meals", tax: "scheduleC.line24b" },
  { code: "6200", role: "expense", name: "Software", tax: "scheduleC.line27b" },
  { code: "6300", role: "expense", name: "Interest", tax: "scheduleC.line16b" },
  { code: "6900", role: "expense", name: '=HYPERLINK("http://evil.example","x")' },
];

type Entry = { date: string; lines: readonly (readonly [string, bigint])[]; memo: string };
const ENTRIES: readonly Entry[] = [
  {
    date: "2025-01-02",
    lines: [
      ["1000", C(20000)],
      ["3000", -C(20000)],
    ],
    memo: "Owner investment",
  },
  {
    date: "2025-01-15",
    lines: [
      ["1500", C(3000)],
      ["1000", -C(3000)],
    ],
    memo: "Laptop",
  },
  {
    date: "2025-02-01",
    lines: [
      ["1000", C(10000)],
      ["2500", -C(10000)],
    ],
    memo: "Loan proceeds",
  },
  {
    date: "2025-02-10",
    lines: [
      ["1000", C(6000)],
      ["4000", -C(6000)],
    ],
    memo: "Design work",
  },
  {
    date: "2025-03-10",
    lines: [
      ["4100", C(200)],
      ["1000", -C(200)],
    ],
    memo: "Refund",
  },
  {
    date: "2025-04-10",
    lines: [
      ["6000", C(450, 50)],
      ["2000", -C(450, 50)],
    ],
    memo: "Ads on the card",
  },
  {
    date: "2025-05-10",
    lines: [
      ["6100", C(85, 25)],
      ["1000", -C(85, 25)],
    ],
    memo: "Client lunch",
  },
  {
    date: "2025-06-10",
    lines: [
      ["6200", C(99, 99)],
      ["2000", -C(99, 99)],
    ],
    memo: "Software",
  },
  {
    date: "2025-07-10",
    lines: [
      ["6300", C(55)],
      ["1000", -C(55)],
    ],
    memo: "Loan interest",
  },
  {
    date: "2025-08-10",
    lines: [
      ["2000", C(300)],
      ["1000", -C(300)],
    ],
    memo: "Card payment",
  },
  {
    date: "2025-09-01",
    lines: [
      ["3100", C(1000)],
      ["1000", -C(1000)],
    ],
    memo: "Owner draw",
  },
  {
    date: "2025-10-10",
    lines: [
      ["6900", C(77, 77)],
      ["1000", -C(77, 77)],
    ],
    memo: "@SUM(1+1) memo",
  },
  {
    date: "2025-11-30",
    lines: [
      ["2500", C(2000)],
      ["1000", -C(2000)],
    ],
    memo: "Loan principal",
  },
  {
    date: "2026-01-05",
    lines: [
      ["1000", C(500)],
      ["4000", -C(500)],
    ],
    memo: "Next year's sale",
  },
];

const inYear = (entry: Entry) => entry.date >= "2025-01-01" && entry.date <= "2025-12-31";
const sumRange = (code: string, upTo = "2025-12-31", from = "0000-01-01") =>
  ENTRIES.filter((entry) => entry.date >= from && entry.date <= upTo).reduce(
    (total, entry) =>
      total +
      entry.lines
        .filter(([account]) => account === code)
        .reduce((sum, [, cents]) => sum + cents, 0n),
    0n,
  );

function tagMap(withTaxLines = true): AccountTagMap {
  const records: TagRecord[] = [];
  for (const account of ACCOUNTS) {
    if (withTaxLines && account.tax)
      records.push({
        seq: records.length + 1,
        accountId: account.code,
        tag: "taxLine",
        effectiveOn: "0001-01-01",
        value: account.tax,
      });
    if (account.flow)
      records.push({
        seq: records.length + 1,
        accountId: account.code,
        tag: "cashFlowClass",
        effectiveOn: "0001-01-01",
        value: account.flow,
      });
  }
  return buildTagMap(records, records.length);
}

const book = new KernelBook({
  basis: "cash",
  firstYear: 2025,
  years: 2,
  accounts: ACCOUNTS.map(({ code, role, name }) => ({ code, role, name: name ?? code })),
});
for (const entry of ENTRIES) book.post(entry.date, entry.lines, entry.memo);

const request = (tags = tagMap()): WorksheetRequest => ({
  taxYear: 2025,
  form: "scheduleC",
  from: "2025-01-01",
  to: "2025-12-31",
  mealsPercent: 50,
  tags,
  today: "2026-03-01",
});

function pack(tags = tagMap(), extra: Parameters<typeof buildPack>[0]["extra"] = []) {
  const worksheetRequest = request(tags);
  const analysis = analyzeWorksheet(book.state, worksheetRequest);
  return buildPack({
    state: book.state,
    request: worksheetRequest,
    bookName: "Acme Studio",
    analysis,
    extra,
    close: yearClose(
      book.state,
      worksheetRequest.from,
      worksheetRequest.to,
      worksheetRequest.today,
    ),
    checks: [
      { key: "inbox", status: "ok", title: "Inbox lines", detail: "No line is waiting." },
      {
        key: "reconcile",
        status: "attention",
        title: "Accounts reconciled",
        detail: "Checking was last reconciled to 2025-11-30.",
        href: "/reconcile",
      },
    ],
  });
}

// ---------------------------------------------------------------------------------------------
// A small, separate CSV reader, so the files are read back by something that is not the code that
// wrote them.
// ---------------------------------------------------------------------------------------------
function parseCsv(text: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let cell = "";
  let quoted = false;
  for (let index = 0; index < text.length; index++) {
    const char = text[index] as string;
    if (quoted) {
      if (char === '"' && text[index + 1] === '"') {
        cell += '"';
        index++;
      } else if (char === '"') quoted = false;
      else cell += char;
    } else if (char === '"') quoted = true;
    else if (char === ",") {
      row.push(cell);
      cell = "";
    } else if (char === "\r" && text[index + 1] === "\n") {
      row.push(cell);
      rows.push(row);
      row = [];
      cell = "";
      index++;
    } else cell += char;
  }
  if (cell !== "" || row.length > 0) {
    row.push(cell);
    rows.push(row);
  }
  return rows;
}

/** The rows of the table whose header row starts with `first`, up to the next blank row. */
function table(csv: string, first: string): Record<string, string>[] {
  const rows = parseCsv(csv);
  const start = rows.findIndex((row) => row[0] === first);
  if (start < 0) throw new Error(`No table starting with ${first}`);
  const header = rows[start] as string[];
  const body: Record<string, string>[] = [];
  for (const row of rows.slice(start + 1)) {
    if (row.length === 0 || row.every((cell) => cell === "")) break;
    body.push(Object.fromEntries(header.map((name, index) => [name, row[index] ?? ""])));
  }
  return body;
}

const file = (built: ReturnType<typeof pack>, path: string) => {
  const found = built.files.find((item) => item.path === path);
  if (!found) throw new Error(`No file ${path}`);
  return found;
};
const header = (csv: string, key: string): string =>
  parseCsv(csv).find((row) => row[0] === key)?.[1] ?? "";

describe("the year-end pack, rebuilt independently", () => {
  const built = pack();
  const revenue =
    sumRange("4000", "2025-12-31", "2025-01-01") + sumRange("4100", "2025-12-31", "2025-01-01");
  const expenseCodes = ["6000", "6100", "6200", "6300", "6900"];
  const expenses = expenseCodes.reduce(
    (total, code) => total + sumRange(code, "2025-12-31", "2025-01-01"),
    0n,
  );
  const netIncome = -revenue - expenses; // credits are negative in the ledger: income is -sum

  test("the profit and loss file has every account's amount and the net income", () => {
    const rows = table(file(built, "statements/profit-and-loss.csv").content, "Account ID");
    const amount = (code: string) => rows.find((row) => row.Code === code)?.Amount;
    expect(amount("4000")).toBe(money(-sumRange("4000", "2025-12-31", "2025-01-01")));
    expect(amount("4100")).toBe(money(-sumRange("4100", "2025-12-31", "2025-01-01")));
    for (const code of expenseCodes)
      expect(amount(code)).toBe(money(sumRange(code, "2025-12-31", "2025-01-01")));
    const all = parseCsv(file(built, "statements/profit-and-loss.csv").content);
    const net = all.find((row) => row[2] === "Net income");
    expect(net?.[4]).toBe(money(netIncome));
    // 6000.00 - 200.00 - (450.50 + 85.25 + 99.99 + 55.00 + 77.77) = 5031.49
    expect(money(netIncome)).toBe("5031.49");
  });

  test("the trial balance balances and each balance is the sum of the entries", () => {
    const rows = table(file(built, "statements/trial-balance.csv").content, "Account ID");
    for (const row of rows) {
      if (!row.Code) continue;
      const role = ACCOUNTS.find((account) => account.code === row.Code)?.role;
      const expected =
        role === "income" || role === "expense"
          ? sumRange(row.Code as string, "2025-12-31", "2025-01-01")
          : sumRange(row.Code as string, "2025-12-31");
      expect(row.Balance, `account ${row.Code}`).toBe(money(expected));
    }
    const all = parseCsv(file(built, "statements/trial-balance.csv").content);
    const total = all.find((row) => row[2] === "Total");
    expect(total?.[5]).toBe(total?.[6]);
  });

  test("the balance sheet balances: assets, liabilities, equity and this year's earnings", () => {
    const content = file(built, "statements/balance-sheet.csv").content;
    const rows = parseCsv(content);
    const totals = new Map(
      rows
        .filter((row) => row[0] === "" && row[2])
        .map((row) => [row[2] as string, row[4] as string]),
    );
    const assets = sumRange("1000") + sumRange("1500");
    const liabilities = -(sumRange("2000") + sumRange("2500"));
    const contributed = -(sumRange("3000") + sumRange("3100"));
    expect(totals.get("Total assets")).toBe(money(assets));
    expect(totals.get("Total liabilities")).toBe(money(liabilities));
    expect(totals.get("Contributed equity")).toBe(money(contributed));
    expect(totals.get("Earnings this fiscal year to date (calculated)")).toBe(money(netIncome));
    expect(totals.get("Total liabilities and equity")).toBe(
      money(liabilities + contributed + netIncome),
    );
    expect(assets).toBe(liabilities + contributed + netIncome);
    expect(totals.get("Difference (assets less liabilities and equity)")).toBe("0.00");
  });

  test("the general ledger has every posting of the year and nothing else", () => {
    const rows = table(file(built, "statements/general-ledger.csv").content, "Row");
    const lines = rows.filter((row) => row.Row === "line");
    const expectedPostings = ENTRIES.filter(inYear).reduce(
      (count, entry) => count + entry.lines.length,
      0,
    );
    expect(lines.length).toBe(expectedPostings);
    for (const account of ACCOUNTS) {
      const mine = lines.filter((row) => row.Code === account.code);
      const debit = mine.reduce(
        (sum, row) => sum + BigInt((row.Debit ?? "0.00").replace(".", "")),
        0n,
      );
      const credit = mine.reduce(
        (sum, row) => sum + BigInt((row.Credit ?? "0.00").replace(".", "")),
        0n,
      );
      expect(debit - credit, `account ${account.code}`).toBe(
        sumRange(account.code, "2025-12-31", "2025-01-01"),
      );
    }
    expect(
      lines.every((row) => (row.Date ?? "") >= "2025-01-01" && (row.Date ?? "") <= "2025-12-31"),
    ).toBe(true);
  });

  test("the cash flow is tied to the cash account", () => {
    const content = file(built, "statements/cash-flow.csv").content;
    const rows = parseCsv(content);
    const total = (label: string) =>
      rows.find((row) => row[0] === "Total" && row[3] === label)?.[4];
    const opening = sumRange("1000", "2024-12-31");
    const closing = sumRange("1000", "2025-12-31");
    expect(total("Cash at the start of the period")).toBe(money(opening));
    expect(total("Cash at the end of the period")).toBe(money(closing));
    expect(total("Net change in cash")).toBe(money(closing - opening));
  });

  test("the worksheet lines are the sums by tax line, and the net reconciles to the profit and loss", () => {
    const rows = parseCsv(file(built, "tax/schedule-c-worksheet.csv").content);
    const line = (number: string) =>
      rows.find((row) => row[1] === number && row[3] !== "reconciliation")?.slice(4, 6);
    expect(line("1")).toEqual([
      money(-sumRange("4000", "2025-12-31", "2025-01-01")),
      money(-sumRange("4000", "2025-12-31", "2025-01-01")),
    ]);
    expect(line("2")?.[1]).toBe(money(sumRange("4100", "2025-12-31", "2025-01-01")));
    expect(line("8")?.[1]).toBe(money(sumRange("6000", "2025-12-31", "2025-01-01")));
    // 50% of 85.25 is 42.625, rounded half away from zero to 42.63.
    expect(line("24b")).toEqual(["85.25", "42.63"]);
    const reconciliation = rows.filter((row) => row[0] === "Reconciliation to the profit and loss");
    const last = reconciliation.at(-1);
    expect(last?.[5]).toBe(money(netIncome));
    const parts = reconciliation
      .slice(0, -1)
      .reduce((sum, row) => sum + BigInt((row[5] ?? "0.00").replace(".", "")), 0n);
    expect(money(parts)).toBe(money(netIncome));
    // The account named like a formula has no tax line, so it is listed as not mapped.
    const accounts = file(built, "tax/schedule-c-accounts.csv").content;
    expect(accounts).toContain("not mapped: no_tax_line");
    const postings = parseCsv(file(built, "tax/schedule-c-postings.csv").content);
    const mapped = postings.filter((row) => row[1] === "mapped").length;
    expect(mapped).toBeGreaterThan(0);
  });

  test("the manifest ties every file to its hash, size and population", () => {
    const manifest = JSON.parse(file(built, "manifest.json").content);
    expect(manifest.format).toBe(PACK_FORMAT);
    expect(manifest.taxYear).toBe(2025);
    expect(manifest.range).toEqual({ from: "2025-01-01", to: "2025-12-31" });
    const listed = manifest.files.map((entry: { path: string }) => entry.path);
    // Every file but the manifest itself, each once.
    expect([...listed].sort()).toEqual(
      built.files
        .filter((item) => item.path !== "manifest.json")
        .map((item) => item.path)
        .sort(),
    );
    for (const entry of manifest.files as { path: string; bytes: number; sha256: string }[]) {
      const content = file(built, entry.path).content;
      expect(entry.sha256, entry.path).toBe(createHash("sha256").update(content).digest("hex"));
      expect(entry.bytes, entry.path).toBe(Buffer.byteLength(content));
    }
    expect(built.manifestSha256).toBe(
      createHash("sha256").update(file(built, "manifest.json").content).digest("hex"),
    );
    // The populations are the ones the reports compile, and the figure files say so in their headers.
    const reports = compileReports(book.state, "2025-12-31", { from: "2025-01-01" });
    expect(manifest.populations.ledger).toBe(reports.populationHash);
    for (const path of [
      "statements/profit-and-loss.csv",
      "statements/balance-sheet.csv",
      "statements/trial-balance.csv",
      "statements/general-ledger.csv",
    ]) {
      expect(header(file(built, path).content, "Population hash"), path).toBe(
        reports.populationHash,
      );
      expect(file(built, path).population).toBe(reports.populationHash);
    }
    expect(header(file(built, "tax/schedule-c-worksheet.csv").content, "Population hash")).toBe(
      manifest.populations.worksheet,
    );
    expect(manifest.populations.tagMap).toBe(tagMap().hash);
    expect(manifest.bookRevision).toBe(String(book.state.bookRevision));
  });

  test("the README says what is and is not in the pack and names every file", () => {
    const readme = file(built, "README.md").content;
    for (const item of built.files)
      if (item.path !== "README.md") expect(readme, item.path).toContain(item.path);
    expect(readme).toContain("What is not in it");
    expect(readme).toContain("Rastrata files nothing");
    expect(readme).toContain("does not give tax advice");
    expect(readme).toContain("Accounts reconciled");
    expect(readme).toContain("needs a look");
    expect(readme).toContain("https://www.irs.gov/instructions/i1040sc");
    expect(readme).toContain(`Built from book revision ${book.state.bookRevision}`);
  });

  test("the same book gives the same bytes, and a changed tag changes the tax files and not the statements", () => {
    const again = pack();
    expect(again.files.map((item) => item.sha256)).toEqual(built.files.map((item) => item.sha256));
    expect(again.manifestSha256).toBe(built.manifestSha256);
    const retagged = pack(tagMap(false));
    const same = (path: string) => file(retagged, path).sha256 === file(built, path).sha256;
    expect(same("statements/profit-and-loss.csv")).toBe(true);
    expect(same("statements/balance-sheet.csv")).toBe(true);
    expect(same("statements/trial-balance.csv")).toBe(true);
    expect(same("statements/general-ledger.csv")).toBe(true);
    expect(same("tax/schedule-c-worksheet.csv")).toBe(false);
    expect(retagged.manifestSha256).not.toBe(built.manifestSha256);
  });

  test("a spreadsheet cannot run any text in any file as a formula", () => {
    let cells = 0;
    for (const item of built.files) {
      if (!item.path.endsWith(".csv")) continue;
      for (const row of parseCsv(item.content))
        for (const cell of row) {
          cells++;
          if (/^[=+\-@\t\r]/.test(cell))
            expect(cell, `${item.path}: ${cell}`).toMatch(/^-?\d+\.\d{2}$/);
        }
    }
    expect(cells).toBeGreaterThan(500);
    // The hostile account name and narration are there, made text.
    const all = built.files
      .filter((item) => item.path.endsWith(".csv"))
      .map((item) => item.content)
      .join("\n");
    expect(all).toContain(`'=HYPERLINK(`);
    expect(all).toContain("'@SUM(1+1) memo");
  });

  test("extra files from the other parts of the lane are listed, hashed and described in the README", () => {
    const withExtra = pack(tagMap(), [
      {
        path: "tax/1099-vendors.csv",
        mediaType: "text/csv; charset=utf-8",
        description: "1099 vendor totals.",
        content: "Vendor,Total\r\n",
        population: null,
      },
    ]);
    expect(file(withExtra, "tax/1099-vendors.csv").sha256).toBe(
      createHash("sha256").update("Vendor,Total\r\n").digest("hex"),
    );
    expect(file(withExtra, "README.md").content).toContain("tax/1099-vendors.csv");
    const manifest = JSON.parse(file(withExtra, "manifest.json").content);
    expect(manifest.files.map((entry: { path: string }) => entry.path)).toContain(
      "tax/1099-vendors.csv",
    );
  });

  test("a folder name is built from fixed words", () => {
    expect(built.folder).toBe("rastrata-year-end-2025");
    expect(
      built.files.every(
        (item) =>
          !item.path.includes("..") && !item.path.startsWith("/") && !item.path.includes("\\"),
      ),
    ).toBe(true);
  });
});
