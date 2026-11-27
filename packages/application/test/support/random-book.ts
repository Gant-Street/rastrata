/** Random books for differential tests: a kernel book that is posted to, backdated into, reversed,
 * corrected by supersession, closed, reopened and reconfigured at random, from a seed, so a failing
 * book can be replayed. Every command is offered to the kernel and may be refused (a posting into a
 * closed month, a reopen with nothing to reopen); the state after a refusal is visited too, because a
 * replay passes it along. */
import type { BookState } from "@rastrata/kernel";
import { KernelBook, sequence } from "./kernel-book.ts";
import { CHART } from "./scenario.ts";

export interface Visit {
  /** The state after this step. */
  readonly state: BookState;
  /** What was tried: post, opening, reverse, supersede, close, reopen, account, extend. */
  readonly operation: string;
  /** Whether the kernel committed it (a refused command leaves the history as it was). */
  readonly committed: boolean;
  /** 1 for the first command. */
  readonly step: number;
}

export interface RandomBookOptions {
  readonly seed: number;
  /** How many commands to try. */
  readonly steps: number;
  readonly firstYear?: number;
  readonly years?: number;
  /** Make the book with the state commitment the application's books have (the default, because a
   * command then costs the same at any size); false makes the older kind, whose state hash re-encodes
   * every journal on every command. */
  readonly chainHead?: boolean;
  /** Post a good share of the entries from sources of every kind the screens tell apart (an opening entry,
   * a Stripe payout, a bank line, an import), not only the opening tools'. Off by default, which keeps a
   * seed's book what it was. */
  readonly sources?: boolean;
  /** Reverse the entries the book would supersede, so that no journal is taken out of the reports by a correction
   * (what every book the application makes is like, and what the reports' quick paths are made for). Off by default,
   * which keeps a seed's book what it was. */
  readonly noSupersession?: boolean;
  /** Called after every command with the book, so a test can read the state as a replay would. */
  readonly onState?: (visit: Visit, book: KernelBook) => void;
}

const pad = (value: number) => String(value).padStart(2, "0");
const SOURCES = ["opening-", "stripe-", "ingest-stripe-", "ingest-", "ingest-bank-", "import-"];
const ROLES = ["asset", "liability", "equity", "income", "expense"] as const;

export function playRandomBook(options: RandomBookOptions): KernelBook {
  const firstYear = options.firstYear ?? 2025;
  let years = options.years ?? 2;
  const book = new KernelBook({
    firstYear,
    years,
    accounts: CHART,
    chainHead: options.chainHead ?? true,
  });
  const random = sequence(options.seed);
  const below = (count: number) => Math.floor(random() * count);
  const between = (low: number, high: number) => low + below(high - low + 1);
  const pick = <T>(list: readonly T[]): T => list[below(list.length)] as T;
  const posted: string[] = [];
  const corrected = new Set<string>();
  /** The accounts and the first date each can be posted to. */
  const accounts: { code: string; from: string }[] = CHART.map(({ code }) => ({
    code,
    from: "0000-01-01",
  }));
  let closed = 0;
  let extra = 0;
  let latest = `${firstYear}-01-15`;

  const anyDate = () => `${firstYear + below(years)}-${pad(between(1, 12))}-${pad(between(1, 28))}`;
  /** Half the time near the newest date so far, so postings also arrive in order. */
  const someDate = () => {
    if (random() < 0.5) return anyDate();
    const next = new Date(Date.parse(`${latest}T00:00:00Z`) + between(0, 9) * 86_400_000);
    const date = next.toISOString().slice(0, 10);
    return date > `${firstYear + years - 1}-12-28` ? anyDate() : date;
  };
  /** A balanced journal of two to four lines on accounts that are open on `date`. */
  const lines = (date: string): (readonly [string, bigint])[] => {
    const open = accounts.filter((account) => account.from <= date);
    const count = between(2, 4);
    const result: [string, bigint][] = [];
    let sum = 0n;
    for (let index = 0; index < count - 1; index += 1) {
      const cents = BigInt(between(1, 250_000)) * (random() < 0.5 ? 1n : -1n);
      result.push([pick(open).code, cents]);
      sum += cents;
    }
    result.push([pick(open).code, sum === 0n ? 1n : -sum]);
    if (sum === 0n) result.push([pick(open).code, -1n]);
    return result;
  };
  const posting = (step: number): [string, boolean] => {
    const date = someDate();
    const id = book.tryPost(date, lines(date), `entry ${step}`);
    if (id) {
      posted.push(id);
      if (date > latest) latest = date;
    }
    return ["post", id !== null];
  };

  for (let step = 1; step <= options.steps; step += 1) {
    const roll = random();
    let operation = "post";
    let committed = false;
    if (roll < 0.62 || (roll < 0.76 && posted.length === 0)) {
      [operation, committed] = posting(step);
    } else if (roll < 0.7) {
      operation = "reverse";
      const target = pick(posted.filter((id) => !corrected.has(id)));
      if (target) {
        const date = someDate();
        const id = book.tryReverse(target, date);
        committed = id !== null;
        if (id) {
          corrected.add(target);
          if (date > latest) latest = date;
        }
      }
    } else if (roll < 0.76) {
      operation = options.noSupersession === true ? "reverse" : "supersede";
      const target = pick(posted.filter((id) => !corrected.has(id)));
      if (target) {
        const date = someDate();
        const id =
          options.noSupersession === true
            ? book.tryReverse(target, date)
            : book.supersede(target, date, lines(date));
        committed = id !== null;
        if (id) {
          corrected.add(target);
          if (options.noSupersession !== true) posted.push(id);
          if (date > latest) latest = date;
        }
      }
    } else if (roll < 0.79) {
      operation = "close";
      committed = book.close(`period-${String(closed + 1).padStart(3, "0")}`);
      if (committed) closed += 1;
    } else if (roll < 0.83) {
      operation = "reopen";
      if (closed > 0) {
        committed = book.reopen(`period-${String(closed).padStart(3, "0")}`);
        if (committed) closed -= 1;
      }
    } else if (roll < 0.87) {
      operation = "account";
      const code = `7${String(extra + 100)}`;
      const after = new Date(Date.parse(`${latest}T00:00:00Z`) + 86_400_000)
        .toISOString()
        .slice(0, 10);
      try {
        book.addAccount({ code, role: pick(ROLES), name: `Added ${extra}` }, after);
        accounts.push({ code, from: after });
        extra += 1;
        committed = true;
      } catch {
        // The kernel refused: the account is not added and the book is as it was.
      }
    } else if (roll < 0.88 && years < 4) {
      operation = "extend";
      try {
        book.extendYears(1);
        years += 1;
        committed = true;
      } catch {
        // Refused (a configuration change must fall after every journal); try again another time.
      }
    } else if (roll < 0.9 || (options.sources === true && roll < 0.96)) {
      // An entry from the opening tools: the cash flow reads it, and any correction of it, as the
      // position the books start from. With `sources`, entries from the other sources too.
      operation = "opening";
      const date = someDate();
      const kind = options.sources === true ? pick(SOURCES) : "opening-";
      const id = book.postFromSource(date, lines(date), `${kind}${date}-${step}`);
      committed = id !== null;
      if (id) {
        posted.push(id);
        if (date > latest) latest = date;
      }
    } else {
      [operation, committed] = posting(step);
    }
    options.onState?.({ state: book.state, operation, committed, step }, book);
  }
  return book;
}
