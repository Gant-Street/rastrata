import { describe, expect, test } from "bun:test";
import type { CashFlow } from "../src/client-contracts.gen.ts";
import { formatMoney, parseMoney } from "../src/money.ts";
import { compileReports } from "../src/reports.ts";
import { compileCashFlow } from "../src/reports/cash-flow.ts";
import { PROFIT_LOSS_ROLES } from "../src/reports/chart.ts";
import { addDays } from "../src/reports/dates.ts";
import { BEGINNING, failure, monthEnds, row } from "./support/helpers.ts";
import { KernelBook } from "./support/kernel-book.ts";
import { CHART, Scenario, generate } from "./support/scenario.ts";
import { FULL_TAGS, tagMap } from "./support/tags.ts";

const m = formatMoney;

let cached: Scenario | undefined;
const threeYears = (): Scenario => {
  cached ??= generate(7, { firstYear: 2024, years: 3 });
  return cached;
};

const section = (statement: CashFlow, key: string) => {
  const found = statement.sections.find((item) => item.key === key);
  if (!found) throw new Error(`No ${key} section`);
  return found;
};
const line = (statement: CashFlow, key: string, code: string) => {
  const found = section(statement, key).lines.find((item) => item.code === code);
  if (!found) throw new Error(`No ${code} line in ${key}`);
  return found;
};
const netIncomeLine = (statement: CashFlow) => {
  const found = section(statement, "operating").lines.find((item) => item.group === "netIncome");
  if (!found) throw new Error("No net income line");
  return found;
};
const total = (statement: CashFlow, key: string) => {
  const found = statement.totals.find((item) => item.key === key);
  if (!found) throw new Error(`No ${key} total`);
  return found;
};

/** What the statement should say, summed from the entries by plain loops, never from the compiler's
 * own structures: net income, and the cash effect (the negative ledger change) of each tagged class. */
function oracle(
  scenario: Scenario,
  from: string,
  to: string,
  tags: Readonly<Record<string, string>> = FULL_TAGS,
) {
  const netIncome = -scenario.sumRoles(PROFIT_LOSS_ROLES, from, to);
  const effect = (classes: string[]) =>
    Object.entries(tags)
      .filter(([, tag]) => classes.includes(tag))
      .reduce((sum, [code]) => sum - scenario.sum(code, from, to), 0n);
  return {
    netIncome,
    operating: netIncome + effect(["operating", "noncash"]),
    investing: effect(["investing"]),
    financing: effect(["financing"]),
    opening: scenario.sum("1000", BEGINNING, addDays(from, -1)),
    closing: scenario.sum("1000", BEGINNING, to),
  };
}

describe("the cash-flow statement ties to the cash accounts", () => {
  test("every section and the net change match an independent summation at every month end", () => {
    const scenario = threeYears();
    const state = scenario.book.state;
    const tags = tagMap(FULL_TAGS);
    for (const asOf of monthEnds(2024, 36)) {
      const statement = compileCashFlow(state, asOf, { tags });
      const from = `${asOf.slice(0, 4)}-01-01`;
      const expected = oracle(scenario, from, asOf);
      expect(statement.available).toBe(true);
      expect(statement.periodStart).toBe(from);
      expect(section(statement, "operating").total, `${asOf} operating`).toBe(
        m(expected.operating),
      );
      expect(section(statement, "investing").total, `${asOf} investing`).toBe(
        m(expected.investing),
      );
      expect(section(statement, "financing").total, `${asOf} financing`).toBe(
        m(expected.financing),
      );
      expect(statement.sections.some((item) => item.key === "unclassified")).toBe(false);
      expect(netIncomeLine(statement).amount).toBe(m(expected.netIncome));
      expect(statement.openingCash).toBe(m(expected.opening));
      expect(statement.closingCash).toBe(m(expected.closing));
      expect(statement.netChange).toBe(m(expected.closing - expected.opening));
      expect(statement.ties).toBe(true);
      // The sections add up to the net change, with no residual and no tolerance.
      const sum = statement.sections.reduce((all, item) => all + parseMoney(item.total), 0n);
      expect(m(sum), asOf).toBe(statement.netChange ?? "");
      // And each section is the sum of its own lines.
      for (const item of statement.sections)
        expect(m(item.lines.reduce((all, entry) => all + parseMoney(entry.amount), 0n))).toBe(
          item.total,
        );
    }
  });

  test("closing cash is the balance sheet's cash, and net income is the profit and loss's, for any range", () => {
    const state = threeYears().book.state;
    const tags = tagMap(FULL_TAGS);
    for (const [from, to] of [
      ["2024-01-01", "2024-12-31"],
      ["2025-03-15", "2026-02-10"],
      ["2024-06-01", "2026-12-31"],
      ["2026-05-05", "2026-05-05"],
    ] as const) {
      const statement = compileCashFlow(state, to, { tags, from });
      const sheet = compileReports(state, to, { from });
      expect(statement.closingCash, `${from}..${to}`).toBe(
        row(sheet.balanceSheet.rows, "1000").amount,
      );
      expect(statement.ledgerPopulationHash).toBe(sheet.populationHash);
      expect(netIncomeLine(statement).amount).toBe(sheet.profitAndLoss.netIncome);
      const expected = oracle(threeYears(), from, to);
      expect(statement.netChange).toBe(m(expected.closing - expected.opening));
    }
  });

  test("an account's line is the opposite of its ledger change, in the section its tag names", () => {
    const scenario = threeYears();
    const statement = compileCashFlow(scenario.book.state, "2025-12-31", {
      tags: tagMap(FULL_TAGS),
      from: "2025-01-01",
    });
    const change = (code: string) => scenario.sum(code, "2025-01-01", "2025-12-31");
    for (const [code, sectionKey, group] of [
      ["1100", "operating", "workingCapital"],
      ["2000", "operating", "workingCapital"],
      ["1600", "operating", "nonCash"],
      ["2500", "financing", "account"],
      ["3000", "financing", "account"],
      ["3100", "financing", "account"],
    ] as const) {
      if (change(code) === 0n) continue;
      const entry = line(statement, sectionKey, code);
      expect(entry.group, code).toBe(group);
      expect(entry.amount, code).toBe(m(-change(code)));
    }
    // A receivable that grew used cash; a payable that grew provided it.
    expect(parseMoney(line(statement, "operating", "1100").amount)).toBe(-change("1100"));
    expect(line(statement, "operating", "1600").amount).toBe(m(-change("1600")));
    expect(parseMoney(line(statement, "operating", "1600").amount)).toBeGreaterThan(0n);
    // The cash account itself is the thing tied to, never a line.
    expect(
      statement.sections.flatMap((item) => item.lines).some((entry) => entry.code === "1000"),
    ).toBe(false);
    expect(statement.cashAccounts).toEqual([
      {
        accountId: "1000",
        code: "1000",
        name: "Operating cash",
        opening: statement.openingCash ?? "",
        closing: statement.closingCash ?? "",
        change: statement.netChange ?? "",
      },
    ]);
  });

  test("a sale of equipment at a gain keeps the gain in net income and the asset change in investing, and ties", () => {
    const book = new KernelBook({ firstYear: 2025, years: 1, accounts: CHART });
    const scenario = new Scenario(book);
    scenario.post("2025-01-05", [
      ["1000", 10_000_00n],
      ["3000", -10_000_00n],
    ]);
    scenario.post("2025-02-01", [
      ["1500", 2_000_00n],
      ["1000", -2_000_00n],
    ]);
    // Sold for 1,000 against a book value of 800: a gain of 200.
    scenario.post("2025-06-10", [
      ["1000", 1_000_00n],
      ["1500", -800_00n],
      ["4900", -200_00n],
    ]);
    const statement = compileCashFlow(book.state, "2025-06-30", { tags: tagMap(FULL_TAGS) });
    expect(netIncomeLine(statement).amount).toBe("200.00");
    expect(line(statement, "investing", "1500").amount).toBe("-1200.00");
    expect(section(statement, "investing").total).toBe("-1200.00");
    expect(section(statement, "financing").total).toBe("10000.00");
    expect(statement.netChange).toBe("9000.00");
    expect(statement.closingCash).toBe("9000.00");
  });

  test("a reversal nets to nothing in the statement", () => {
    const book = new KernelBook({ firstYear: 2025, years: 1, accounts: CHART });
    const scenario = new Scenario(book);
    scenario.post("2025-01-05", [
      ["1000", 500_00n],
      ["3000", -500_00n],
    ]);
    const sale = scenario.post("2025-02-01", [
      ["1100", 300_00n],
      ["4000", -300_00n],
    ]);
    const before = compileCashFlow(book.state, "2025-02-28", { tags: tagMap(FULL_TAGS) });
    expect(netIncomeLine(before).amount).toBe("300.00");
    expect(line(before, "operating", "1100").amount).toBe("-300.00");
    scenario.reverse(sale, "2025-02-20");
    const after = compileCashFlow(book.state, "2025-02-28", { tags: tagMap(FULL_TAGS) });
    expect(netIncomeLine(after).amount).toBe("0.00");
    // The receivable moved up and back down, so it has no line at all.
    expect(section(after, "operating").lines.some((entry) => entry.code === "1100")).toBe(false);
    expect(after.netChange).toBe("500.00");
  });

  test("several cash accounts are summed and each is listed", () => {
    const book = new KernelBook({
      firstYear: 2025,
      years: 1,
      accounts: [
        ...CHART,
        { code: "1010", role: "asset", name: "Savings" },
        { code: "1020", role: "asset", name: "Payment processor balance" },
      ],
    });
    const scenario = new Scenario(book);
    scenario.post("2025-01-05", [
      ["1000", 700_00n],
      ["1010", 200_00n],
      ["3000", -900_00n],
    ]);
    scenario.post("2025-03-05", [
      ["1020", 55_00n],
      ["4000", -55_00n],
    ]);
    scenario.post("2025-04-05", [
      ["1010", 40_00n],
      ["1000", -40_00n],
    ]);
    const tags = tagMap({ ...FULL_TAGS, "1010": "cash", "1020": "cash" });
    const statement = compileCashFlow(book.state, "2025-06-30", { tags });
    expect(
      statement.cashAccounts.map((entry) => [entry.code, entry.opening, entry.closing]),
    ).toEqual([
      ["1000", "0.00", "660.00"],
      ["1010", "0.00", "240.00"],
      ["1020", "0.00", "55.00"],
    ]);
    expect(statement.openingCash).toBe("0.00");
    expect(statement.closingCash).toBe("955.00");
    // A transfer between two cash accounts is not a cash flow, so it appears nowhere.
    expect(section(statement, "operating").total).toBe("55.00");
    expect(section(statement, "financing").total).toBe("900.00");
  });
});

describe("what the statement will not guess", () => {
  const state = () => threeYears().book.state;

  test("an untagged account with activity is shown as Not classified, with a visible warning", () => {
    const tags = tagMap({ ...FULL_TAGS, "1100": undefined });
    const statement = compileCashFlow(state(), "2025-12-31", { tags, from: "2025-01-01" });
    const scenario = threeYears();
    const change = scenario.sum("1100", "2025-01-01", "2025-12-31");
    expect(change).not.toBe(0n);
    expect(section(statement, "unclassified").label).toBe("Not classified");
    expect(line(statement, "unclassified", "1100").amount).toBe(m(-change));
    expect(section(statement, "operating").lines.some((entry) => entry.code === "1100")).toBe(
      false,
    );
    const warning = statement.warnings.find((item) => item.code === "unclassified_accounts");
    expect(warning?.message).toContain("1100 Accounts receivable");
    expect(warning?.message).toMatch(/not in operating, investing or financing/);
    // It still has to be somewhere for the statement to tie, and it does.
    expect(statement.ties).toBe(true);
    expect(statement.netChange).toBe(
      m(
        scenario.sum("1000", BEGINNING, "2025-12-31") -
          scenario.sum("1000", BEGINNING, "2024-12-31"),
      ),
    );
    // Tagging it moves it out and removes the warning.
    const tagged = compileCashFlow(state(), "2025-12-31", {
      tags: tagMap(FULL_TAGS),
      from: "2025-01-01",
    });
    expect(tagged.warnings).toEqual([]);
    expect(tagged.sections.some((item) => item.key === "unclassified")).toBe(false);
    expect(
      parseMoney(section(tagged, "operating").total) -
        parseMoney(section(statement, "operating").total),
    ).toBe(-change);
  });

  test("an untagged account that did not move is not a problem", () => {
    const book = new KernelBook({ firstYear: 2025, years: 1, accounts: CHART });
    const scenario = new Scenario(book);
    scenario.post("2025-01-05", [
      ["1000", 100_00n],
      ["3000", -100_00n],
    ]);
    const tags = tagMap({ "1000": "cash", "3000": "financing" });
    const statement = compileCashFlow(book.state, "2025-03-31", { tags });
    expect(statement.warnings).toEqual([]);
    expect(statement.sections.map((item) => item.key)).toEqual([
      "operating",
      "investing",
      "financing",
    ]);
    expect(statement.closingCash).toBe("100.00");
  });

  test("with no account tagged cash the statement is unavailable and says why", () => {
    const none = compileCashFlow(state(), "2025-12-31", { tags: tagMap({}) });
    expect(none.available).toBe(false);
    expect(none.reason).toMatch(/No account is tagged as cash/);
    expect(none.reason).toMatch(/in your chart of accounts/);
    expect(none.sections).toEqual([]);
    expect(none.cashAccounts).toEqual([]);
    expect([none.openingCash, none.netChange, none.closingCash, none.ties]).toEqual([
      null,
      null,
      null,
      null,
    ]);
    expect(none.totals).toEqual([]);
    // Tags on everything else do not make up for it.
    const noCash = compileCashFlow(state(), "2025-12-31", {
      tags: tagMap({ ...FULL_TAGS, "1000": "operating" }),
    });
    expect(noCash.available).toBe(false);
    expect(noCash.populationHash).toMatch(/^[0-9a-f]{64}$/);
  });

  test("a cash tag on a liability, and a tag on an income account, are named and set aside", () => {
    const tags = tagMap({ ...FULL_TAGS, "2500": "cash", "4000": "operating" });
    const statement = compileCashFlow(state(), "2026-12-31", { tags, from: "2026-01-01" });
    const codes = statement.warnings.map((item) => item.code);
    expect(codes).toContain("cash_tag_not_an_asset");
    expect(codes).toContain("tag_ignored");
    expect(statement.warnings.find((item) => item.code === "tag_ignored")?.message).toContain(
      "4000 Sales",
    );
    // The liability is treated as not classified rather than as cash, so cash is still account 1000 only.
    expect(statement.cashAccounts.map((entry) => entry.code)).toEqual(["1000"]);
    expect(statement.ties).toBe(true);
    const sales = threeYears().sum("4000", "2026-01-01", "2026-12-31");
    expect(netIncomeLine(statement).amount).toBe(
      m(-threeYears().sumRoles(PROFIT_LOSS_ROLES, "2026-01-01", "2026-12-31")),
    );
    expect(sales).not.toBe(0n);
  });
});

describe("cash-flow populations", () => {
  const state = () => threeYears().book.state;

  test("the population covers the ledger population and the tags, and nothing else changes it", () => {
    const base = compileCashFlow(state(), "2025-06-30", { tags: tagMap(FULL_TAGS) });
    const again = compileCashFlow(state(), "2025-06-30", { tags: tagMap(FULL_TAGS) });
    expect(again).toEqual(base);
    const retagged = compileCashFlow(state(), "2025-06-30", {
      tags: tagMap({ ...FULL_TAGS, "1500": "operating" }, 3),
    });
    // Same ledger, same range: the ledger population is unchanged and the cash-flow population is not.
    expect(retagged.ledgerPopulationHash).toBe(base.ledgerPopulationHash);
    expect(retagged.tagMapHash).not.toBe(base.tagMapHash);
    expect(retagged.populationHash).not.toBe(base.populationHash);
    expect(retagged.tagsRevision).toBe("3");
    expect(base.tagsRevision).toBe("0");
    // A different range or date changes both.
    const other = compileCashFlow(state(), "2025-06-30", {
      tags: tagMap(FULL_TAGS),
      from: "2025-02-01",
    });
    expect(other.ledgerPopulationHash).not.toBe(base.ledgerPopulationHash);
    expect(other.populationHash).not.toBe(base.populationHash);
    expect(base.compilerVersion).toBe("rastrata-cash-flow-v2");
    // Retagging moves money between sections but cannot move the cash it ties to.
    expect(retagged.closingCash).toBe(base.closingCash);
    expect(retagged.netChange).toBe(base.netChange);
    expect(section(retagged, "operating").total).not.toBe(section(base, "operating").total);
  });

  test("a basis the book does not keep is refused here too, and dates outside the calendar", () => {
    const tags = tagMap(FULL_TAGS);
    expect(
      failure(() => compileCashFlow(state(), "2025-06-30", { tags, basis: "cash" })).code,
    ).toBe("basis_unavailable");
    expect(failure(() => compileCashFlow(state(), "2027-06-30", { tags })).code).toBe(
      "calendar_not_configured",
    );
    expect(
      failure(() => compileCashFlow(state(), "2025-06-30", { tags, from: "2025-07-01" })).code,
    ).toBe("invalid_input");
  });
});

describe("cash-flow comparison columns", () => {
  const state = () => threeYears().book.state;
  const tags = () => tagMap(FULL_TAGS);

  for (const kind of ["previousPeriod", "previousYear"] as const) {
    test(`${kind}: each comparison is the statement that range has on its own`, () => {
      const withComparison = compileCashFlow(state(), "2025-09-30", {
        tags: tags(),
        from: "2025-07-01",
        compare: kind,
      });
      const comparison = withComparison.comparison;
      if (!comparison) throw new Error("Expected a comparison");
      const alone = compileCashFlow(state(), comparison.asOf, {
        tags: tags(),
        from: comparison.periodStart,
      });
      expect(withComparison.warnings).toEqual([]);
      // The current column is unchanged by asking for a comparison.
      const current = compileCashFlow(state(), "2025-09-30", { tags: tags(), from: "2025-07-01" });
      expect(withComparison.populationHash).toBe(current.populationHash);
      expect(withComparison.closingCash).toBe(current.closingCash);
      expect(comparison.populationHash).toBe(
        compileReports(state(), comparison.asOf, { from: comparison.periodStart }).populationHash,
      );
      for (const item of withComparison.sections) {
        expect(item.comparative, item.key).toBe(section(alone, item.key).total);
        expect(item.change, item.key).toBe(
          m(parseMoney(item.total) - parseMoney(section(alone, item.key).total)),
        );
      }
      expect(netIncomeLine(withComparison).comparative).toBe(netIncomeLine(alone).amount);
      for (const key of ["netChange", "openingCash", "closingCash"]) {
        const entry = total(withComparison, key);
        const earlier = total(alone, key);
        expect(entry.comparative, key).toBe(earlier.amount);
        expect(entry.change, key).toBe(m(parseMoney(entry.amount) - parseMoney(earlier.amount)));
      }
      // A line that moved in only one of the two columns still shows both figures.
      for (const item of withComparison.sections.flatMap((entry) => entry.lines)) {
        expect(item.comparative).toBeDefined();
        expect(item.change).toBe(
          m(parseMoney(item.amount) - parseMoney(item.comparative ?? "0.00")),
        );
      }
    });
  }

  test("a comparison from before the book began is reported as unavailable", () => {
    const statement = compileCashFlow(state(), "2024-06-30", {
      tags: tags(),
      from: "2024-04-01",
      compare: "previousYear",
    });
    expect(statement.comparison).toBeNull();
    expect(statement.warnings.map((item) => item.code)).toEqual(["comparison_unavailable"]);
    expect(statement.totals.every((entry) => entry.comparative === undefined)).toBe(true);
  });
});

describe("property: every generated book ties, on either basis and any fiscal year", () => {
  const cases = [
    { seed: 31, firstYear: 2025, years: 2, startMonth: 1, basis: "accrual" as const },
    { seed: 32, firstYear: 2025, years: 2, startMonth: 7, basis: "cash" as const },
    { seed: 33, firstYear: 2024, years: 2, startMonth: 10, basis: "accrual" as const },
    { seed: 34, firstYear: 2026, years: 1, startMonth: 4, basis: "cash" as const },
    { seed: 35, firstYear: 2023, years: 2, startMonth: 2, basis: "accrual" as const },
  ];
  for (const options of cases) {
    test(`seed ${options.seed}: ${options.years} fiscal year(s) from month ${options.startMonth}, ${options.basis} basis`, () => {
      const scenario = generate(options.seed, options);
      const state = scenario.book.state;
      const tags = tagMap(FULL_TAGS);
      const ends = monthEnds(options.firstYear, options.years * 12, options.startMonth);
      for (const asOf of ends) {
        const statement = compileCashFlow(state, asOf, { tags, basis: options.basis });
        const sheet = compileReports(state, asOf, { basis: options.basis });
        expect(statement.basis).toBe(options.basis);
        expect(statement.ties, asOf).toBe(true);
        // Closing cash equals the balance sheet's cash.
        expect(statement.closingCash, asOf).toBe(row(sheet.balanceSheet.rows, "1000").amount);
        // Net income agrees with the profit and loss; sections add up to the change in cash.
        expect(netIncomeLine(statement).amount).toBe(sheet.profitAndLoss.netIncome);
        const sum = statement.sections.reduce((all, item) => all + parseMoney(item.total), 0n);
        expect(m(sum)).toBe(statement.netChange ?? "");
        expect(
          parseMoney(statement.closingCash ?? "0.00") - parseMoney(statement.openingCash ?? "0.00"),
        ).toBe(sum);
        // And an independent summation agrees.
        const expected = oracle(scenario, statement.periodStart, asOf);
        expect(statement.netChange).toBe(m(expected.closing - expected.opening));
        expect(section(statement, "operating").total).toBe(m(expected.operating));
      }
    });
  }
});
