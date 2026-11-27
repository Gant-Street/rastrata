import type { IngestItem, Proposal, ProposalContext, Proposer } from "../../ingest-types.ts";
import { formatMoney, parseMoney } from "../../money.ts";
import type { Direction } from "../classifier.ts";
import { accountFor, KINDS, type StarterAccount, type StarterKind } from "./accounts.ts";
import { findMerchant, type MerchantEntry } from "./match.ts";

/** Starter suggestions: what a book is offered before it has learned anything. A new business
 * imports its first statement with no rules and no history, so nothing would be suggested and the
 * first thing asked of a person would be a page of blank decisions. For the lines whose merchant is
 * a common one, this proposes the category that merchant usually is, in this book's own chart.
 *
 * It is the weakest source and it knows it:
 *
 * - It only suggests. Like every proposer it returns a proposal; accepting, drafting and posting are
 *   the Inbox's, with every safeguard they have.
 * - It is asked only for a line nothing else has a suggestion for (the registry runs it as a
 *   fallback: after rules, the classifier, the transfer and entry matchers and Stripe have spoken).
 * - It says nothing for a line a rule decides, even a rule whose account has since closed: a rule is
 *   the owner's word, and the list does not speak over it.
 * - It says nothing where the book's own history disagrees: if lines of this merchant were ever
 *   booked to another account than the one it would suggest, the book knows better, and the
 *   classifier will say so once it has seen enough. Where history agrees, or has none, it suggests.
 * - Money in is never an expense: a refund from a merchant gets nothing.
 *
 * The reason is one plain sentence ("USPS is usually postage."), with no figure in it: the list has
 * no record behind it to count. Its confidence is a fixed 50, below anything a rule, the classifier
 * or a matcher gives, so "best suggestions first" puts these last and `--min-confidence` leaves them
 * out. Its name in the data is `starter`, which is how an agent tells one from a learned suggestion. */

export const STARTER_PROPOSER = "starter";

/** The version of the list and of the way it is read. It is part of the proposer's revision, so a
 * change here makes the Inbox suggest again for the lines still open. */
export const STARTER_LOGIC = 1;

export const STARTER_CONFIDENCE = 0.5;

/** The tags the chart records on an account on a date. */
export interface StarterTags {
  readonly taxLine?: string | undefined;
  readonly roleKey?: string | undefined;
}

export interface StarterOptions {
  /** True when a rule decides the line, whether or not the rule can be applied. */
  readonly decidedByRule?: (item: IngestItem) => boolean;
  /** The accounts lines of this merchant were booked to before, on this side of the account. */
  readonly bookedTo?: (merchantId: string, direction: Direction) => ReadonlySet<string> | undefined;
  readonly tagsOf?: (accountId: string, asOf: string) => StarterTags;
  /** For a kind found by role key: the account the lane that owns the key books it to on a date. A
   * string is that account, null is "none, say nothing", undefined leaves it to the chart's tags. */
  readonly roleAccount?: (
    roleKey: string,
    asOf: string,
    accounts: ProposalContext["accounts"],
  ) => string | null | undefined;
}

/** The one sentence that says why. */
export function starterReason(entry: MerchantEntry, kind: StarterKind): string {
  return entry.why ?? `${entry.name} is usually ${KINDS[kind].noun}.`;
}

/** How a book has booked the merchants the list knows: for each, the accounts its lines went to. Built
 * from the same examples the classifier learns from (posted entries and the Inbox's decisions). */
export function merchantHistory(
  examples: Iterable<HistoryExample>,
): (merchantId: string, direction: Direction) => ReadonlySet<string> | undefined {
  const history = new MerchantHistory();
  for (const example of examples) history.add(example);
  return (merchantId, direction) => history.bookedTo(merchantId, direction);
}

export interface HistoryExample {
  readonly text: string;
  readonly accountId: string;
  readonly direction: Direction;
}

/** The same history, kept as examples come and go instead of made again from all of them: each account a
 * merchant's lines went to, with how many lines went there, so that forgetting one line does not forget
 * the account while another line went there too. */
export class MerchantHistory {
  readonly #lines = new Map<string, Map<string, number>>();
  readonly #accounts = new Map<string, Set<string>>();

  /** Learn an example. The key of the merchant and side it is about when this changed which accounts
   * the merchant's lines went to (the only thing the proposer reads), else null. */
  add(example: HistoryExample): string | null {
    const finding = findMerchant([example.text]);
    if (finding.outcome !== "found") return null;
    const key = `${finding.entry.id}|${example.direction}`;
    let lines = this.#lines.get(key);
    if (!lines) {
      lines = new Map();
      this.#lines.set(key, lines);
      this.#accounts.set(key, new Set());
    }
    const had = lines.get(example.accountId) ?? 0;
    lines.set(example.accountId, had + 1);
    if (had > 0) return null;
    (this.#accounts.get(key) as Set<string>).add(example.accountId);
    return key;
  }

  /** Forget an example learned with `add`; the key as `add` gives it. */
  remove(example: HistoryExample): string | null {
    const finding = findMerchant([example.text]);
    if (finding.outcome !== "found") return null;
    const key = `${finding.entry.id}|${example.direction}`;
    const lines = this.#lines.get(key);
    const had = lines?.get(example.accountId) ?? 0;
    if (!lines || had === 0) return null;
    if (had > 1) {
      lines.set(example.accountId, had - 1);
      return null;
    }
    lines.delete(example.accountId);
    (this.#accounts.get(key) as Set<string>).delete(example.accountId);
    if (lines.size === 0) {
      this.#lines.delete(key);
      this.#accounts.delete(key);
    }
    return key;
  }

  /** The accounts lines of this merchant were booked to before, on this side of the account. */
  bookedTo(merchantId: string, direction: Direction): ReadonlySet<string> | undefined {
    return this.#accounts.get(`${merchantId}|${direction}`);
  }

  /** What the history holds, as plain data in a fixed order, so that a test can compare two. */
  snapshot(): [string, string[]][] {
    return [...this.#accounts]
      .map(([key, accounts]) => [key, [...accounts].sort()] as [string, string[]])
      .sort(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0));
  }
}

export function createStarterProposer(options: StarterOptions = {}): Proposer {
  // The chart as the mapping reads it, once per run and date: tags are in force from a date.
  const charts = new WeakMap<ProposalContext, Map<string, StarterAccount[]>>();
  const chartOn = (context: ProposalContext, date: string): StarterAccount[] => {
    let dates = charts.get(context);
    if (!dates) {
      dates = new Map();
      charts.set(context, dates);
    }
    let chart = dates.get(date);
    if (!chart) {
      // An account that cannot take a posting on the date is left out, as if it were not there.
      chart = context.accounts
        .filter(
          (account) =>
            account.closedOn === null &&
            account.postingAllowed !== false &&
            (account.openedOn === undefined || account.openedOn <= date),
        )
        .map((account) => {
          const tags = options.tagsOf?.(account.id, date) ?? {};
          return {
            id: account.id,
            name: account.name,
            role: account.role,
            taxLine: tags.taxLine,
            roleKey: tags.roleKey,
          };
        });
      dates.set(date, chart);
    }
    return chart;
  };

  return {
    name: STARTER_PROPOSER,
    propose(item: IngestItem, context: ProposalContext): readonly Proposal[] {
      const line = item.line;
      if (line.kind !== "bankLine") return [];
      if (item.status !== "new" && item.status !== "proposed") return [];
      const bankId = item.ledgerAccountId;
      if (bankId === null) return [];
      let cents: bigint;
      try {
        cents = parseMoney(line.amount);
      } catch {
        return [];
      }
      if (cents === 0n) return [];
      const finding = findMerchant([line.counterparty, line.description]);
      if (finding.outcome !== "found") return [];
      const spec = KINDS[finding.kind];
      const direction: Direction = cents > 0n ? "in" : "out";
      if (spec.direction !== direction) return [];
      if (options.decidedByRule?.(item)) return [];

      const chart = chartOn(context, line.postedOn).filter((account) => account.id !== bankId);
      let accountId: string | null = null;
      const chosen =
        spec.roleKey === undefined
          ? undefined
          : options.roleAccount?.(spec.roleKey, line.postedOn, context.accounts);
      if (chosen === null) return [];
      if (chosen !== undefined) {
        // Another lane named the account; it must still be one that can take this line.
        accountId = chart.some((account) => account.id === chosen) ? chosen : null;
      } else accountId = accountFor(finding.kind, chart)?.accountId ?? null;
      if (accountId === null) return [];

      const before = options.bookedTo?.(finding.entry.id, direction);
      if (before) for (const earlier of before) if (earlier !== accountId) return [];

      const size = cents < 0n ? -cents : cents;
      return [
        {
          proposer: STARTER_PROPOSER,
          kind: "categorize",
          confidence: STARTER_CONFIDENCE,
          reasons: [starterReason(finding.entry, finding.kind)],
          legs: [
            { accountId: bankId, amount: formatMoney(cents) },
            { accountId, amount: formatMoney(cents > 0n ? -size : size) },
          ],
        },
      ];
    },
  };
}
