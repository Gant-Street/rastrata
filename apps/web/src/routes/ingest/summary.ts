import type {
  AccountList,
  BankfeedStatus,
  InboxBalanceCheck,
  InboxSource,
  InboxSummary,
  ReconcileStatus,
  StripeStatus,
} from "@rastrata/application/client-contracts";
import { negateMoney } from "@rastrata/application/money";
import type { AccountChoiceItem, BankTileData, BankTileLinks } from "@rastrata/ui/banking/types";
import { createMemo, createRoot } from "solid-js";
import { BrowserApplicationClient } from "../../application-client";
import { capabilities, has } from "../../capabilities";
import { createLoader } from "../../loader";
import { STATEMENT_BALANCE_PROVIDERS } from "../reconcile/figures";

/** What the bank tiles, the account strip and the tab row's count know about the book's banking, read
 * once and shared. Everything here is built from the operations the lanes already have
 * (`accounts.list`, `inbox.summary`, `inbox.balanceChecks`, `reconcile.status`, and the two
 * connection summaries), so no screen asks for these again: Home draws the tiles, the Banking tabs
 * draw a count, and all of them read the same answer. */

export type BankingState = "loading" | "ready" | "error";

/** The raw answers the tiles are built from. `feed` and `stripe` are `null` when that read could not
 * be made: a tile then says nothing about its connection, and never guesses. */
export interface BankingReads {
  readonly accounts: AccountList;
  readonly inbox: InboxSummary;
  /** Empty when the read failed: a tile then has no statement line, which is a smaller claim. */
  readonly checks: readonly InboxBalanceCheck[];
  readonly status: ReconcileStatus;
  readonly feed?: BankfeedStatus | null;
  readonly stripe?: StripeStatus | null;
}

export interface BankingRead {
  readonly tiles: readonly BankTileData[];
  /** Transactions waiting for a person across every source, including ones with no chart account yet. */
  readonly toReview: number;
}

export interface BankingSummary {
  /** One tile per bank, card and Stripe account, in chart order. Empty until the first read. */
  tiles(): readonly BankTileData[];
  /** `loading` until the first read finishes; `error` when the first read failed. A later read that
   * fails leaves the last answer in place and sets `stale`. */
  state(): BankingState;
  /** The last answer could not be refreshed, so what is shown may be out of date. */
  stale(): boolean;
  /** A read is under way (the last answer stays on screen while it runs). */
  refreshing(): boolean;
  /** Transactions waiting for review, or undefined until it has been read. */
  toReview(): number | undefined;
  /** Read again. A caller that only wants fresh numbers on arrival passes `maxAgeMs` so a read that
   * just finished is not repeated. */
  reload(maxAgeMs?: number): Promise<void>;
}

const sum = (values: Iterable<number>): number => {
  let total = 0;
  for (const value of values) total += value;
  return total;
};

/** A balance as a statement prints it, in the way the books carry it. A card's balance owed is
 * positive on the statement and negative in the books. */
const inBooks = (balance: string, normalSide: "debit" | "credit"): string =>
  normalSide === "credit" ? negateMoney(balance) : balance;

const RANK = { reconciliation: 3, statement: 2, feed: 1 } as const;

interface Reported {
  readonly balance: string;
  readonly asOf: string;
  readonly source: "statement" | "feed" | "reconciliation";
}

/** The newest balance an outside party has reported for one account: a statement file, the bank's
 * feed or a reconciled statement. The newest date wins; on one date the reconciled statement is the
 * one the owner confirmed, then a statement, then a feed. */
function newestReport(candidates: readonly Reported[]): Reported | undefined {
  return [...candidates].sort(
    (left, right) => right.asOf.localeCompare(left.asOf) || RANK[right.source] - RANK[left.source],
  )[0];
}

function feedConnection(
  feed: BankfeedStatus | null | undefined,
  accountId: string,
): BankTileData["connection"] | undefined {
  const linked = feed?.accounts.find((entry) => entry.link?.ledgerAccountId === accountId);
  if (!feed || !linked?.link) return undefined;
  const syncedAt = linked.link.lastOkAt ?? linked.link.lastSyncAt;
  return {
    kind: "feed",
    state: linked.link.lastError !== null || !feed.connected ? "attention" : "connected",
    ...(syncedAt ? { syncedAt } : {}),
  };
}

function accountTiles(reads: BankingReads): BankTileData[] {
  const byId = new Map(reads.accounts.accounts.map((account) => [account.id, account]));
  const tiles: BankTileData[] = [];
  for (const row of reads.status.accounts) {
    if (!row.tracked) continue;
    const sources = reads.inbox.sources.filter(
      (source) => source.ledgerAccountId === row.account.id,
    );
    const candidates: Reported[] = reads.checks
      .filter((check) => check.ledgerAccountId === row.account.id)
      .map((check) => ({
        balance: check.reported,
        asOf: check.asOf,
        source: STATEMENT_BALANCE_PROVIDERS.has(check.provider) ? "statement" : "feed",
      }));
    const last =
      row.lastReconciledDate !== null && row.lastReconciledBalance !== null
        ? {
            date: row.lastReconciledDate,
            balance: inBooks(row.lastReconciledBalance, row.account.normalSide),
          }
        : undefined;
    if (last) candidates.push({ balance: last.balance, asOf: last.date, source: "reconciliation" });
    const report = newestReport(candidates);
    const connection = feedConnection(reads.feed, row.account.id);
    tiles.push({
      accountId: row.account.id,
      code: row.account.code,
      name: row.account.name,
      kind: row.account.role === "liability" ? "card" : "bank",
      bookBalance:
        byId.get(row.account.id)?.balance ?? inBooks(row.bookBalance, row.account.normalSide),
      ...(report
        ? {
            statementBalance: report.balance,
            statementAsOf: report.asOf,
            statementSource: report.source,
          }
        : {}),
      toReview: sum(sources.map((source) => source.counts.toReview)),
      imported: sources.some((source) => source.counts.total > 0),
      ...(last ? { lastReconciled: last } : {}),
      ...(connection ? { connection } : {}),
    });
  }
  return tiles;
}

/** Stripe, as a tile: shown when the book has the Stripe accounts, a key, or anything imported from
 * Stripe, so a book with no Stripe in it is not offered one. Not connected is a state of the tile,
 * with the one way in, and never a warning. */
function stripeTile(reads: BankingReads): BankTileData | null {
  const stripe = reads.stripe ?? null;
  const sources: readonly InboxSource[] = reads.inbox.sources.filter(
    (source) => source.provider === "stripe",
  );
  const balanceRole = stripe?.roles.find((role) => role.role === "stripe.balance");
  const chart =
    (balanceRole?.accountId
      ? reads.accounts.accounts.find((account) => account.id === balanceRole.accountId)
      : undefined) ??
    reads.accounts.accounts.find((account) => account.tags?.roleKey === "stripe.balance");
  if (!(stripe?.key.present ?? false) && !chart && sources.length === 0) return null;
  const snapshot = stripe?.balance.snapshot ?? null;
  // Where the service cannot connect Stripe (no credential of its own and no Stripe app on the control
  // plane), the tile has no connection to speak of: it shows the balance and the way Stripe is booked.
  const connection: BankTileData["connection"] | undefined =
    stripe && has(capabilities(), "stripe")
      ? {
          kind: "stripe",
          // A key with a problem or a sync that failed is a fault; a key that works whose accounts are not
          // chosen yet is the next step, and the tile does not call it one.
          state: !stripe.key.present
            ? "not_connected"
            : stripe.key.problem !== null
              ? "attention"
              : !stripe.configured
                ? "setup"
                : stripe.lastSync?.disposition === "failed"
                  ? "attention"
                  : "connected",
          ...(stripe.lastSync?.finishedAt ? { syncedAt: stripe.lastSync.finishedAt } : {}),
        }
      : undefined;
  return {
    accountId: chart?.id ?? "",
    code: chart?.code ?? "",
    name: "Stripe",
    kind: "stripe",
    bookBalance: chart?.balance ?? null,
    ...(snapshot
      ? {
          statementBalance: snapshot.total,
          statementAsOf: snapshot.readAt,
          statementSource: "feed" as const,
        }
      : {}),
    toReview: sum(sources.map((source) => source.counts.toReview)),
    imported: sources.some((source) => source.counts.total > 0),
    ...(connection ? { connection } : {}),
  };
}

/** The tiles and the count, from what the operations returned. Pure: no reading, no clock. */
export function buildBanking(reads: BankingReads): BankingRead {
  const stripe = stripeTile(reads);
  return {
    tiles: [...accountTiles(reads), ...(stripe ? [stripe] : [])],
    toReview: reads.inbox.counts.toReview,
  };
}

/** Where a tile goes: a bank or card account opens its own transactions; Stripe opens Stripe's page,
 * where it is connected, set up and read. */
export const bankTileLinks: BankTileLinks = {
  open: (tile) =>
    tile.kind === "stripe"
      ? "/settings/stripe"
      : `/ledger?accountId=${encodeURIComponent(tile.accountId)}`,
  connect: () => "/settings/stripe",
};

/** Where a bank is connected: through Stripe on a hosted service with accounts, through a feed of the service's own
 * where it keeps the credential, nowhere else. */
export function connectBankPath(): string | null {
  const can = capabilities();
  return can.banks ? "/settings/banks" : can.connections ? "/settings/bankfeed" : null;
}

async function readBanking(client: BrowserApplicationClient): Promise<BankingRead> {
  /** A read the tiles can do without: it narrows what a tile says, and never what is true. */
  const optional = async <T>(read: () => Promise<T>): Promise<T | null> => {
    try {
      return await read();
    } catch {
      return null;
    }
  };
  const [accounts, inbox, status, checks, feed, stripe] = await Promise.all([
    client.read("accounts.list", {}),
    client.read("inbox.summary", {}),
    client.read("reconcile.status", {}),
    optional(() => client.read("inbox.balanceChecks", {})),
    optional(() => client.read("bankfeed.status", { books: false })),
    optional(() => client.read("stripe.status", { books: false })),
  ]);
  return buildBanking({ accounts, inbox, status, checks: checks?.checks ?? [], feed, stripe });
}

/** The banking summary for a client, held in plain signals (never a suspending resource): the last
 * answer stays on screen while the next is read, and a read that fails after one succeeded says the
 * figures may be out of date rather than replacing them with nothing. Create it inside a reactive
 * owner; `bankingSummary()` is the one the application shares. */
export function createBankingSummary(client: BrowserApplicationClient): BankingSummary {
  let finishedAt = 0;
  const reads = createLoader(async () => {
    try {
      return await readBanking(client);
    } finally {
      finishedAt = Date.now();
    }
  });
  const tiles = createMemo(() => reads.value()?.tiles ?? []);
  return {
    tiles,
    state: () =>
      reads.value() !== undefined ? "ready" : reads.error() !== undefined ? "error" : "loading",
    stale: () => reads.value() !== undefined && reads.error() !== undefined,
    refreshing: () => reads.loading(),
    toReview: () => reads.value()?.toReview,
    reload: async (maxAgeMs = 0) => {
      if (maxAgeMs > 0 && (reads.loading() || Date.now() - finishedAt < maxAgeMs)) return;
      await reads.reload();
    },
  };
}

let shared: BankingSummary | undefined;

/** The one banking summary the whole application reads: the tiles on Home, the account strip, and
 * the count on the For review tab. It is made on first use, outside any page, so it outlives each
 * page that asks for it, and it reads again when the window comes back to the front. A page that
 * changes what is waiting (an action on For review, an import) calls `reload()`. */
export function bankingSummary(): BankingSummary {
  if (shared) return shared;
  const made = createRoot(() =>
    createBankingSummary(new BrowserApplicationClient(window.localStorage)),
  );
  shared = made;
  if (typeof document !== "undefined")
    document.addEventListener("visibilitychange", () => {
      if (document.visibilityState === "visible") void made.reload(15_000);
    });
  // Every successful write of the application says so (the shell re-reads its tab counts on it); what is
  // waiting, and the balances, may have moved, so the tiles read again.
  if (typeof window !== "undefined")
    window.addEventListener("rastrata:write", () => void made.reload(1_000));
  return made;
}

/** The accounts the list of transactions for review can be narrowed to: each bank account, card and Stripe
 * that a statement or a connection has brought transactions for. An account nothing has come in for is
 * left out (there is nothing of its own to show), and the page offers the select only when more than one
 * is here. Pure: the page draws it. */
export function accountChoicesOf(tiles: readonly BankTileData[]): AccountChoiceItem[] {
  return tiles
    .filter((tile) => tile.imported || tile.toReview > 0)
    .map((tile) => ({
      key: tile.kind === "stripe" ? "provider:stripe" : tile.accountId,
      label: tile.name,
    }));
}
