import { KernelBook, sequence, type AccountSpec, type Role } from "./kernel-book.ts";

/** A small chart that exercises every statement: cash, working capital, a fixed asset with a contra
 * account, a loan, owner equity and draws, income, a gain, cost of sales, rent and depreciation. */
export const CHART: readonly AccountSpec[] = [
  { code: "1000", role: "asset", name: "Operating cash" },
  { code: "1100", role: "asset", name: "Accounts receivable" },
  { code: "1500", role: "asset", name: "Equipment" },
  { code: "1600", role: "asset", name: "Accumulated depreciation" },
  { code: "2000", role: "liability", name: "Accounts payable" },
  { code: "2500", role: "liability", name: "Bank loan" },
  { code: "3000", role: "equity", name: "Owner capital" },
  { code: "3100", role: "equity", name: "Owner draws" },
  { code: "4000", role: "income", name: "Sales" },
  { code: "4900", role: "gain", name: "Gain on sale" },
  { code: "5000", role: "expense", name: "Cost of goods sold" },
  { code: "6000", role: "expense", name: "Rent" },
  { code: "6100", role: "expense", name: "Depreciation" },
];

export const ROLE_OF: Readonly<Record<string, Role>> = Object.fromEntries(
  CHART.map((account) => [account.code, account.role]),
);

export interface Entry {
  readonly date: string;
  readonly code: string;
  readonly cents: bigint;
}

/** A kernel book together with every posted line, kept as plain data. Expected figures in a test are
 * summed from `entries` with ordinary loops, independently of how the compiler is structured. */
export class Scenario {
  readonly entries: Entry[] = [];
  constructor(readonly book: KernelBook) {}

  post(date: string, lines: readonly (readonly [string, bigint])[], narration = "entry"): string {
    const id = this.book.post(date, lines, narration);
    for (const [code, cents] of lines) this.entries.push({ date, code, cents });
    return id;
  }

  reverse(journalId: string, date: string): string {
    const original = this.book.state.journals.find((item) => item.journal.id === journalId);
    if (!original) throw new Error("No such journal");
    const id = this.book.reverse(journalId, date);
    for (const posting of original.journal.postings)
      this.entries.push({
        date,
        code: posting.accountId.toUpperCase(),
        cents: -posting.bookValue.amount.coefficient,
      });
    return id;
  }

  /** Sum of the ledger-signed postings of one account dated in [from, to]. */
  sum(code: string, from: string, to: string): bigint {
    let total = 0n;
    for (const entry of this.entries)
      if (entry.code === code && entry.date >= from && entry.date <= to) total += entry.cents;
    return total;
  }

  /** Sum over every account of the roles given, dated in [from, to]. */
  sumRoles(roles: readonly Role[], from: string, to: string): bigint {
    let total = 0n;
    for (const entry of this.entries) {
      const role = ROLE_OF[entry.code];
      if (role && roles.includes(role) && entry.date >= from && entry.date <= to)
        total += entry.cents;
    }
    return total;
  }
}

const pad = (value: number) => String(value).padStart(2, "0");

export interface GenerateOptions {
  readonly firstYear: number;
  readonly years: number;
  readonly startMonth?: number;
  readonly basis?: "accrual" | "cash";
  readonly extend?: boolean;
}

/** Months of the book, as [year, month] pairs, from the first fiscal year's start. */
export function months(options: GenerateOptions): [number, number][] {
  const result: [number, number][] = [];
  const start = options.startMonth ?? 1;
  for (let index = 0; index < options.years * 12; index++) {
    const absolute = start - 1 + index;
    result.push([options.firstYear + Math.floor(absolute / 12), (absolute % 12) + 1]);
  }
  return result;
}

/** A deterministic multi-year book: an owner contribution on the first day, then every month some
 * sales (cash or on account), receipts from customers, rent, supplier bills and payments, and now
 * and then a loan, an equipment purchase, depreciation, an owner draw, a gain and a reversal. */
export function generate(seed: number, options: GenerateOptions): Scenario {
  const book = new KernelBook({
    ...(options.basis ? { basis: options.basis } : {}),
    firstYear: options.firstYear,
    years: options.years,
    ...(options.startMonth ? { startMonth: options.startMonth } : {}),
    accounts: CHART,
  });
  const scenario = new Scenario(book);
  const random = sequence(seed);
  const between = (low: number, high: number) => low + Math.floor(random() * (high - low + 1));
  const cents = (low: number, high: number) =>
    BigInt(between(low * 100, high * 100) + between(0, 99));
  const all = months(options);
  const first = all[0];
  if (!first) throw new Error("A scenario needs at least one month");
  scenario.post(
    `${first[0]}-${pad(first[1])}-02`,
    [
      ["1000", 40_000_00n],
      ["3000", -40_000_00n],
    ],
    "Owner contribution",
  );
  const posted: string[] = [];
  for (const [year, month] of all) {
    const day = () => pad(between(3, 27));
    const date = () => `${year}-${pad(month)}-${day()}`;
    const sale = cents(200, 4000);
    const onAccount = random() < 0.5;
    posted.push(
      scenario.post(date(), [
        [onAccount ? "1100" : "1000", sale],
        ["4000", -sale],
      ]),
    );
    if (onAccount) {
      const receipt = cents(100, 2000);
      scenario.post(date(), [
        ["1000", receipt],
        ["1100", -receipt],
      ]);
    }
    const rent = cents(300, 900);
    posted.push(
      scenario.post(date(), [
        ["6000", rent],
        ["1000", -rent],
      ]),
    );
    const bill = cents(50, 800);
    scenario.post(date(), [
      ["5000", bill],
      ["2000", -bill],
    ]);
    if (random() < 0.7) {
      const payment = cents(20, 700);
      scenario.post(date(), [
        ["2000", payment],
        ["1000", -payment],
      ]);
    }
    if (random() < 0.15) {
      const loan = cents(1000, 5000);
      scenario.post(date(), [
        ["1000", loan],
        ["2500", -loan],
      ]);
    }
    if (random() < 0.1) {
      const equipment = cents(500, 3000);
      scenario.post(date(), [
        ["1500", equipment],
        ["1000", -equipment],
      ]);
    }
    if (month % 3 === 0) {
      const depreciation = cents(30, 150);
      scenario.post(date(), [
        ["6100", depreciation],
        ["1600", -depreciation],
      ]);
    }
    if (random() < 0.12) {
      const draw = cents(100, 900);
      scenario.post(date(), [
        ["3100", draw],
        ["1000", -draw],
      ]);
    }
    if (random() < 0.08) {
      const gain = cents(10, 300);
      scenario.post(date(), [
        ["1000", gain],
        ["4900", -gain],
      ]);
    }
    if (random() < 0.1 && posted.length > 0) {
      // A journal is reversed at most once, so take it off the list when it is.
      const [target] = posted.splice(between(0, posted.length - 1), 1);
      if (target) scenario.reverse(target, `${year}-${pad(month)}-28`);
    }
  }
  return scenario;
}
