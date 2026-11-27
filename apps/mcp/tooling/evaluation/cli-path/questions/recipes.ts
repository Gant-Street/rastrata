/** What the scripted right agent does for each question the product can answer today: the real
 * `rastrata` commands, and the answer read out of what they return. This is how a question earns the
 * class `now`: there is a recipe here that gets the oracle's answer from the service, and a test runs
 * every recipe against a seeded book.
 *
 * The rule the recipes keep is the runbook's: a figure the service reports is read and used as it
 * stands, and the only arithmetic is exact cents on a pair of figures the service returned (a
 * difference, a sign). They never add up a list of lines (that is a payee report's work: those
 * questions are `after:payees`) and never round (a percentage is the profit and loss's own: it comes from
 * `reports profit-loss --share income`). A recipe that needed either would be a sign the question belongs
 * to a lane.
 *
 * A recipe never reads the oracle. */
import { cents, dec } from "@rastrata/application/testing/evaluation-fixtures";
import type { Cli } from "../drivers/cli.ts";
import type { Json } from "../owner.ts";
import type { Question } from "./types.ts";

/** The books as the agent reads them: each call is a real command, and a failure is an error with
 * what the command said. */
export class Books {
  constructor(readonly cli: Cli) {}

  /** `rastrata ARGS`: the `data` of a reply that succeeded. */
  async read(args: readonly string[]): Promise<Json> {
    const reply = await this.cli.rastrata(args);
    if (!reply.ok)
      throw new Error(
        `rastrata ${args.join(" ")} failed: ${String(reply.json?.error?.message ?? reply.stderr.trim()).slice(0, 200)}`,
      );
    return reply.json.data;
  }

  /** `rastrata call OPERATION --input -`: the `data` of a reply that succeeded. */
  async call(operation: string, input: Record<string, unknown> = {}): Promise<Json> {
    const reply = await this.cli.call(operation, input);
    if (!reply.ok)
      throw new Error(
        `rastrata call ${operation} failed: ${String(reply.json?.error?.message ?? reply.stderr.trim()).slice(0, 200)}`,
      );
    return reply.json.data;
  }

  profitLoss(from: string, to: string, share?: "income"): Promise<Json> {
    return this.read([
      "reports",
      "profit-loss",
      "--from",
      from,
      "--as-of",
      to,
      ...(share ? ["--share", share] : []),
    ]);
  }
  balanceSheet(asOf: string): Promise<Json> {
    return this.read(["reports", "balance-sheet", "--as-of", asOf]);
  }
  async account(code: string): Promise<Json> {
    const found = ((await this.read(["accounts", "list"])).accounts as Json[]).find(
      (account) => account.code === code,
    );
    if (!found) throw new Error(`The book has no account ${code}`);
    return found;
  }
}

const MARCH = { from: "2026-03-01", to: "2026-03-31" } as const;

const totalLine = (report: Json, key: string): Json => {
  const found = (report.statement.totals as Json[]).find((total) => total.key === key);
  if (!found) throw new Error(`The report has no ${key} total`);
  return found;
};

const totalOf = (report: Json, key: string): string => totalLine(report, key).amount;

const rowOf = (report: Json, code: string): Json => {
  const found = (report.statement.rows as Json[]).find((row) => row.code === code);
  if (!found) throw new Error(`The report has no row for ${code}`);
  return found;
};

/** The share of income the report worked out for a row or a total, as it wrote it ("30.2", "-29.4"). It is
 * read and used as it stands: the division and the rounding are the service's. */
const shareOf = (line: Json, what: string): string => {
  if (typeof line.share !== "string") throw new Error(`The report gives no share for ${what}`);
  return line.share;
};

/** The same amount with the opposite sign, in exact cents. */
const negate = (amount: string): string => dec(-cents(amount));

const first = <T>(list: readonly T[], what: string): T => {
  const found = list[0];
  if (found === undefined) throw new Error(`There is no ${what}`);
  return found;
};

/** The largest of some amounts and what it belongs to; the first of equals. */
function biggest<T>(items: readonly T[], amount: (item: T) => string, what: string): T {
  let best: T | undefined;
  for (const item of items)
    if (best === undefined || cents(amount(item)) > cents(amount(best))) best = item;
  if (best === undefined) throw new Error(`There is no ${what}`);
  return best;
}

type Recipe = (books: Books, question: Question) => Promise<string>;

const paidPayouts = async (books: Books): Promise<Json[]> =>
  ((await books.read(["stripe", "payouts"])).payouts as Json[]).filter(
    (payout) => payout.status === "paid",
  );

/** What a payee called by these words would have received and spent in March, whether or not any payee
 * is named (the payees lane's `payees.test`: the matches are whole words, in order). */
const payeeTest = async (books: Books, word: string): Promise<Json> =>
  (await books.call("payees.test", { words: [word], from: MARCH.from, asOf: MARCH.to })).matches;

const capitalised = (text: string): string =>
  text
    .split(/\s+/)
    .filter(Boolean)
    .map((word) => `${word.slice(0, 1).toUpperCase()}${word.slice(1).toLowerCase()}`)
    .join(" ");

/** The statement balance the question itself tells the agent ("ends at 11,125.71"). */
const statedBalance = (question: Question): string => {
  const found = /ends at ([\d,]+\.\d{2})/.exec(question.text);
  if (!found?.[1]) throw new Error("The question does not give a statement balance");
  return found[1].replaceAll(",", "");
};

export const RECIPES: Readonly<Record<string, Recipe>> = {
  A1: async (books) => totalOf(await books.profitLoss(MARCH.from, MARCH.to), "netIncome"),
  A2: async (books) => totalOf(await books.profitLoss(MARCH.from, MARCH.to), "income"),
  A3: async (books) => totalOf(await books.profitLoss(MARCH.from, MARCH.to), "expense"),
  A4: async (books) => rowOf(await books.profitLoss(MARCH.from, MARCH.to), "6000").amount,
  A5: async (books) => rowOf(await books.profitLoss(MARCH.from, MARCH.to), "6200").amount,
  A6: async (books) => {
    const report = await books.profitLoss(MARCH.from, MARCH.to);
    const expenses = (report.statement.rows as Json[]).filter((row) => row.role === "expense");
    return biggest(expenses, (row) => row.amount, "expense").name;
  },
  A7: async (books) => (await books.account("1000")).balance,
  A8: async (books) => negate((await books.account("2000")).balance),
  A9: async (books) => totalOf(await books.balanceSheet(MARCH.to), "asset"),

  A11: async (books) => (await books.account("1010")).balance,
  A12: async (books) =>
    (
      await books.call("activity.get", {
        accountId: "1000",
        asOf: "2026-03-15",
        from: MARCH.from,
        to: "2026-03-15",
      })
    ).closingBalance,
  A13: async (books) => totalOf(await books.balanceSheet(MARCH.to), "totalEquity"),
  A14: async (books) => {
    const statement = await books.read([
      "reports",
      "cash-flow",
      "--from",
      MARCH.from,
      "--as-of",
      MARCH.to,
    ]);
    const found = (statement.totals as Json[]).find((total) => total.key === "netChange");
    if (!found) throw new Error("The cash flow statement has no net change");
    return found.amount;
  },
  A15: async (books) => (await books.account("1110")).balance,
  A17: async (books) => rowOf(await books.profitLoss(MARCH.from, MARCH.to), "6025").amount,
  A18: async (books) => String((await paidPayouts(books)).length),
  A19: async (books) =>
    biggest(await paidPayouts(books), (payout) => payout.amount, "Stripe payout").amount,

  A21: async (books) => negate(rowOf(await books.profitLoss(MARCH.from, MARCH.to), "4100").amount),
  // Money by payee, from the payees lane. `payees.test` totals the words the agent chooses, whether or not
  // any payee is named, and `payees.totals` ranks the bank's texts (digits made one) largest first.
  // (Asked before that lane landed, A25, A26, A33 and A34 were `after:payees`: the closest read gave the
  // entries to add up by hand.)
  A25: async (books) => (await payeeTest(books, "NORTHWIND")).received,
  A26: async (books) => {
    const report = await books.call("payees.totals", {
      from: MARCH.from,
      asOf: MARCH.to,
      direction: "received",
    });
    const customers = [
      ...(report.rows as Json[]).map((row) => ({ name: String(row.name), received: row.received })),
      ...(report.unnamed as Json[]).map((row) => ({
        name: capitalised(String(row.suggestedWords || row.text)),
        received: row.received,
      })),
    ];
    return biggest(customers, (customer) => customer.received, "customer").name;
  },
  A33: async (books) => (await payeeTest(books, "ADOBE")).spent,
  A34: async (books) => (await payeeTest(books, "UBER")).spent,
  // (A22 has no recipe on purpose. `tax vendors` answers 0 here, which is right, but it says in the same
  // reply that no account is marked and so nothing is counted: the same 0 would come back for a book
  // with a contractor paid $5,000 and no mark. Reading that 0 as the answer would be a coincidence.)
  A24: async (books) =>
    biggest(await paidPayouts(books), (payout) => payout.amount, "Stripe payout").arrivalOn,
  A29: async (books) => rowOf(await books.profitLoss(MARCH.from, MARCH.to), "4900").amount,
  // A share of income, from the profit and loss itself (the percent lane). Asked before that lane landed,
  // A27 and A28 were `after:percent`: the report had amounts only, and a share needs a division and a
  // rounding that the runbook tells an agent never to do itself.
  A27: async (books) =>
    shareOf(rowOf(await books.profitLoss(MARCH.from, MARCH.to, "income"), "6000"), "advertising"),
  A28: async (books) =>
    shareOf(
      totalLine(await books.profitLoss(MARCH.from, MARCH.to, "income"), "netIncome"),
      "net income",
    ),

  A31: async (books) => rowOf(await books.profitLoss(MARCH.from, MARCH.to), "6120").amount,
  A32: async (books) => String((await books.call("journal.list", { text: "ADOBE" })).count),
  A35: async (books) => {
    const found = await books.call("journal.list", { text: "ATX ACCOUNTING" });
    if (found.count !== 1) throw new Error(`${found.count} entries match ATX ACCOUNTING, not one`);
    return first(found.entries as Json[], "entry").amount;
  },
  // The largest single expense, from the ranking read (`reports largest`). Asked before it existed, A36 was `after:none`:
  // no read ranked entries, and the agent paged the ledger and compared for itself.
  A36: async (books) =>
    first(
      (
        await books.read([
          "reports",
          "largest",
          "--from",
          MARCH.from,
          "--as-of",
          MARCH.to,
          "--limit",
          "1",
        ])
      ).rows as Json[],
      "expense",
    ).amount,
  A37: async (books) =>
    String(
      (
        await books.call("activity.get", {
          accountId: "6290",
          asOf: MARCH.to,
          from: MARCH.from,
          to: MARCH.to,
        })
      ).count,
    ),
  A38: async (books) => {
    const report = await books.profitLoss(MARCH.from, MARCH.to);
    return (report.statement.rows as Json[])
      .filter((row) => row.role === "expense" && cents(row.amount) > 80_000n)
      .map((row) => row.name)
      .join("; ");
  },

  A41: async (books, question) =>
    dec(cents((await books.account("1000")).balance) - cents(statedBalance(question))),
  A42: async (books) => {
    const excluded = (await books.read(["inbox", "list", "--status=excluded"])).items as Json[];
    const lines = excluded.filter(
      (item) => item.ledgerAccountId === "1000" && item.exclusion?.code !== "before_cutover",
    );
    if (lines.length !== 1) throw new Error(`${lines.length} Chase lines are set aside, not one`);
    return (lines[0] as Json).line.description;
  },
  A43: async (books) => String((await books.read(["inbox", "summary"])).counts.excluded),
  A44: async (books) => String((await books.read(["inbox", "summary"])).counts.toReview),
  A45: async (books) =>
    String(
      ((await books.read(["reconcile", "status"])).accounts as Json[]).filter(
        (entry) => entry.lastReconciledDate !== null,
      ).length,
    ),
  A46: async (books) =>
    String(((await books.read(["cutover", "checklist"])).verdict.blocking as Json[]).length),
  A47: async (books) => {
    const march = ((await books.read(["periods", "list"])).periods as Json[]).find(
      (period) => period.startsOn === "2026-03-01",
    );
    if (!march) throw new Error("The calendar has no March");
    return march.status;
  },
  A48: async (books) => (await books.read(["cutover", "show"])).cutover.cutoverDate,
  A49: async (books) => (await books.read(["reports", "calendar"])).basis,

  A51: async (books) => {
    const summary = await books.read(["tax", "sales", "--year", "2026"]);
    const march = (summary.periods as Json[]).find((period) => period.key === "2026-03");
    if (!march) throw new Error("The sales tax summary has no March");
    return march.collected;
  },
  A52: async (books) => worksheetLine(books, "Net profit or (loss)"),
  A53: async (books) => worksheetLine(books, "Travel and meals: Deductible meals"),
  A54: async (books) => {
    const rules = (await books.read(["rules", "list"])).rules as Json[];
    const made = rules.filter((rule) => rule.createdBy?.kind === "agent");
    if (made.length !== 1)
      throw new Error(`${made.length} rules were written by an agent, not one`);
    return (made[0] as Json).name;
  },
  // The changes lane's list: who made each change. (Asked before it landed, these two were
  // `after:changes`: the closest read said when an entry was posted and never by whom.)
  A55: async (books) =>
    String(
      (await books.call("changes.list", { kinds: ["entry.posted"], by: { kind: "agent" } })).count,
    ),
  A56: async (books) => {
    const found = await books.call("changes.list", { kinds: ["entry.posted"], text: "rent" });
    const rent = (found.changes as Json[]).filter((change) =>
      String(change.summary).includes("March rent, entered by hand"),
    );
    if (rent.length !== 1)
      throw new Error(`${rent.length} changes are the rent entered by hand, not one`);
    return (rent[0] as Json).by.kind;
  },
  // The catch-all lane's role key: the chart says which account is the catch-all for expenses, and an
  // agent reads it instead of guessing that Other expenses is meant.
  A57: async (books) => {
    const accounts = (await books.read(["accounts", "list"])).accounts as Json[];
    const marked = accounts.filter((account) => account.tags?.roleKey === "catchall.expense");
    if (marked.length !== 1)
      throw new Error(
        `${marked.length} accounts are marked as the catch-all for expenses, not one`,
      );
    return (marked[0] as Json).name;
  },
  A58: async (books) => {
    const accounts = (await books.read(["accounts", "list"])).accounts as Json[];
    const added = accounts.filter((account) => account.openedOn > "2026-01-01");
    if (added.length !== 1) throw new Error(`${added.length} accounts were added, not one`);
    return (added[0] as Json).name;
  },
};

async function worksheetLine(books: Books, label: string): Promise<string> {
  const worksheet = await books.read(["tax", "worksheet", "--year", "2026"]);
  for (const part of worksheet.parts as Json[])
    for (const line of part.lines as Json[]) if (line.label === label) return line.amount;
  throw new Error(`The worksheet has no line "${label}"`);
}
