import type { CoreReports, JournalEntry } from "@rastrata/application/client-contracts";

export interface FixtureEvent {
  readonly sourceId: string;
  readonly date: string;
  readonly debit: string;
  readonly credit: string;
  readonly amount: string;
  readonly reverses?: string;
}

export const CAPITAL: FixtureEvent = {
  sourceId: "CAPITAL-001",
  date: "2026-01-10",
  debit: "1000",
  credit: "3000",
  amount: "1000.00",
};
export const SERVICE: FixtureEvent = {
  sourceId: "SERVICE-001",
  date: "2026-01-10",
  debit: "1000",
  credit: "4000",
  amount: "200.00",
};
export const SUPPLIES: FixtureEvent = {
  sourceId: "SUPPLIES-001",
  date: "2026-01-10",
  debit: "5000",
  credit: "1000",
  amount: "50.00",
};
export const REFUND: FixtureEvent = {
  ...SUPPLIES,
  date: "2026-01-11",
  debit: "1000",
  credit: "5000",
  reverses: "SUPPLIES-001",
};

export function cents(value: string): bigint {
  if (!/^-?\d+\.\d{2}$/.test(value)) throw new Error(`Not exact USD money: ${value}`);
  return BigInt(value.replace(".", ""));
}

export function money(value: bigint): string {
  const magnitude = value < 0n ? -value : value;
  return `${value < 0n ? "-" : ""}${magnitude / 100n}.${String(magnitude % 100n).padStart(2, "0")}`;
}

/** Independent fixture arithmetic: no report compiler, kernel, or service math. */
export function expectedFigures(events: readonly FixtureEvent[]) {
  const balances: Record<string, bigint> = { "1000": 0n, "3000": 0n, "4000": 0n, "5000": 0n };
  for (const event of events) {
    balances[event.debit] = (balances[event.debit] ?? 0n) + cents(event.amount);
    balances[event.credit] = (balances[event.credit] ?? 0n) - cents(event.amount);
  }
  const values = Object.values(balances);
  return {
    balances: Object.fromEntries(
      Object.entries(balances).map(([code, value]) => [code, money(value)]),
    ),
    assets: money(balances["1000"] ?? 0n),
    equity: money(-(balances["3000"] ?? 0n) - (balances["4000"] ?? 0n) - (balances["5000"] ?? 0n)),
    revenue: money(-(balances["4000"] ?? 0n)),
    expenses: money(balances["5000"] ?? 0n),
    netIncome: money(-(balances["4000"] ?? 0n) - (balances["5000"] ?? 0n)),
    debit: money(values.reduce((total, value) => total + (value > 0n ? value : 0n), 0n)),
    credit: money(values.reduce((total, value) => total - (value < 0n ? value : 0n), 0n)),
  };
}

export function financialProblems(
  events: readonly FixtureEvent[],
  reports: CoreReports | null,
  journals: readonly JournalEntry[],
): string[] {
  const problems: string[] = [];
  if (!reports) return ["Expected a configured book and January report"];
  const expected = expectedFigures(events);
  const actual = {
    assets: reports.balanceSheet.assets,
    equity: reports.balanceSheet.equity,
    revenue: reports.profitAndLoss.revenue,
    expenses: reports.profitAndLoss.expenses,
    netIncome: reports.profitAndLoss.netIncome,
    debit: reports.trialBalance.debit,
    credit: reports.trialBalance.credit,
  };
  for (const [key, value] of Object.entries(actual)) {
    if (value !== expected[key as keyof typeof actual])
      problems.push(`${key}: expected ${expected[key as keyof typeof actual]}, received ${value}`);
  }
  if (!reports.trialBalance.balanced || !reports.balanceSheet.balanced)
    problems.push("Reports are not balanced");
  if (reports.currency !== "USD" || reports.basis !== "accrual" || reports.asOf !== "2026-01-31")
    problems.push("Wrong report scope");
  if (
    reports.balanceSheet.liabilities !== "0.00" ||
    reports.balanceSheet.currentEarnings !== expected.netIncome
  )
    problems.push("Unexpected liabilities or current earnings");
  const rows = Object.fromEntries(
    reports.trialBalance.rows.map((row) => [row.code, row.signedBalance]),
  );
  for (const [code, value] of Object.entries(expected.balances)) {
    if ((rows[code] ?? "0.00") !== value)
      problems.push(`Account ${code}: expected ${value}, received ${rows[code]}`);
  }
  if (reports.trialBalance.rows.some((row) => !(row.code in expected.balances)))
    problems.push("Unexpected account in trial balance");
  if (journals.length !== events.length || reports.postingSequence !== String(events.length))
    problems.push(`Expected exactly ${events.length} posted journals`);
  const remaining = [...journals];
  for (const event of events) {
    const index = remaining.findIndex(
      (journal) =>
        journal.source?.id === event.sourceId &&
        (journal.correction?.correctionJournalId === journal.id) === Boolean(event.reverses),
    );
    const journal = index < 0 ? undefined : remaining.splice(index, 1)[0];
    if (!journal) {
      problems.push(`Missing ${event.reverses ? "reversal of " : ""}${event.sourceId}`);
      continue;
    }
    const lines = journal.lines
      .map((line) => `${line.accountId}:${line.debit}:${line.credit}`)
      .sort();
    const intended = [
      `${event.debit}:${event.amount}:0.00`,
      `${event.credit}:0.00:${event.amount}`,
    ].sort();
    if (journal.date !== event.date || JSON.stringify(lines) !== JSON.stringify(intended))
      problems.push(`Wrong posting facts for ${event.sourceId}`);
    if (event.reverses) {
      const original = journals.find(
        (item) => item.source?.id === event.reverses && item.source?.originalJournalId === item.id,
      );
      if (!original || journal.correction?.originalJournalId !== original.id)
        problems.push("Reversal lost its original journal link");
    }
  }
  if (remaining.length) problems.push("Unexpected economic effects, even if net balances agree");
  return problems;
}
