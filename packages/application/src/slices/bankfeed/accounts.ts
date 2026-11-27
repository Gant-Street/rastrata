import { BridgeBudgetSpent, BridgeClient, BridgeError } from "../../bankfeed/client.ts";
import { QUOTA_WINDOW_MS } from "../../bankfeed/constants.ts";
import type { AccessUrl } from "../../bankfeed/credentials.ts";
import { listAccounts } from "../../bankfeed/listing.ts";
import { accountKeyOf } from "../../bankfeed/normalise.ts";
import type { ProblemView } from "../../bankfeed/problems.ts";
import { scrub } from "../../bankfeed/redact.ts";
import type {
  AccountList,
  BankfeedAccount,
  BankfeedFeedBalance,
  InboxBalanceCheckList,
  InboxSourceList,
} from "../../client-contracts.gen.ts";
import { ApplicationError } from "../../errors.ts";
import { callOperation } from "../shadow/operations.ts";
import type { SliceContext } from "../types.ts";
import { budgetGuard, recorder } from "./budget.ts";
import { bankfeedRuntime } from "./runtime.ts";
import type { BankfeedStore } from "./store.ts";
import { describeAll, namesFrom, pipeline } from "./sync.ts";
import { type BooksView, accountWire, note } from "./view.ts";

/** Asking the Bridge which accounts it lists, and showing the answer next to the book. */

/** A budget or an error from the Bridge as the error an operation reports. The message is scrubbed of
 * the credential whatever it says. */
export function asApplicationError(error: unknown, access: AccessUrl | null): ApplicationError {
  const clean = (text: string): string => scrub(text, access?.secrets ?? []);
  if (error instanceof BridgeBudgetSpent) {
    const when =
      error.until === null ? "" : ` It can ask again after ${new Date(error.until).toISOString()}.`;
    return new ApplicationError(
      error.reason === "rate_limited" ? "bankfeed_rate_limited" : "bankfeed_budget_spent",
      error.reason === "rate_limited"
        ? `The Bridge asked Rastrata to slow down, so no request is made for now.${when}`
        : `Rastrata has used its share of the Bridge's requests for the day (the Bridge expects about 24 a day and Rastrata stops at 20).${when}`,
      429,
      [],
      true,
    );
  }
  if (error instanceof BridgeError)
    return new ApplicationError(
      error.code,
      clean(error.message),
      error.code === "bankfeed_rate_limited"
        ? 429
        : error.code === "bankfeed_unavailable"
          ? 502
          : 424,
      [],
      error.retryable,
    );
  throw error;
}

/** One request: list the accounts (balances only), keep the answer's bytes and refresh what is known
 * about the accounts. The connection's problems and notes are replaced by what this answer said. */
export async function refreshListing(
  context: SliceContext,
  store: BankfeedStore,
  access: AccessUrl,
): Promise<{ readonly problems: ProblemView[]; readonly messages: string[] }> {
  const { service } = context;
  const runtime = bankfeedRuntime(service);
  const clock = (): number => Date.parse(runtime.now());
  const client = new BridgeClient(access, {
    fetch: runtime.fetch,
    now: clock,
    guard: budgetGuard(store, clock, null),
    onRequest: recorder(store),
    ...(runtime.sleep ? { sleep: runtime.sleep } : {}),
    ...(runtime.timeoutMs ? { timeoutMs: runtime.timeoutMs } : {}),
  });
  let listing: Awaited<ReturnType<typeof listAccounts>>;
  try {
    listing = await listAccounts(client, access.secrets);
  } catch (error) {
    const failure = asApplicationError(error, access);
    if (failure.code === "bankfeed_rate_limited" && error instanceof BridgeError)
      store.setPausedUntil(new Date(error.until ?? clock() + QUOTA_WINDOW_MS).toISOString());
    if (failure.code === "bankfeed_access_denied" || failure.code === "bankfeed_payment_required")
      store.setAttention(
        failure.code === "bankfeed_access_denied" ? "access_denied" : "payment_required",
        failure.message,
        runtime.now(),
      );
    throw failure;
  }
  const at = runtime.now();
  try {
    pipeline(service).archive(listing.bytes, "application/json", "simplefin-accounts.json");
  } catch {
    // The Inbox may not be available in this build; the answer is still used.
  }
  store.replaceAccounts(listing.accounts, at);
  const problems = describeAll(listing.set.problems, namesFrom(store));
  const messages = listing.set.messages.map((message) => note(message));
  store.saveListing(problems, messages, at);
  // The Bridge answered: whatever it had refused or asked before is over.
  if (store.connection().attentionCode !== null) store.setAttention(null, null, null);
  return { problems, messages };
}

/** Everything a view of the accounts reads from the rest of the book. A quick view (`books: false`)
 * reads none of it and shows nothing that needs the ledger. */
export async function booksView(
  context: SliceContext,
  bookCurrency: string,
  books: boolean,
): Promise<BooksView> {
  const keyOf = (accountId: string): string => accountKeyOf(accountId) ?? `simplefin:${accountId}`;
  if (!books)
    return {
      bookCurrency,
      chartLabel: () => null,
      sourceStartOn: () => null,
      feedBalance: () => null,
      accountKey: keyOf,
    };
  const [chart, sources, checks] = await Promise.all([
    callOperation<AccountList>(context, "accounts.list").catch(() => null),
    callOperation<InboxSourceList>(context, "inbox.sources").catch(() => null),
    callOperation<InboxBalanceCheckList>(context, "inbox.balanceChecks", {
      provider: "simplefin",
    }).catch(() => null),
  ]);
  const labels = new Map((chart?.accounts ?? []).map((a) => [a.id, `${a.code} ${a.name}`]));
  const starts = new Map(
    (sources?.sources ?? [])
      .filter((source) => source.provider === "simplefin")
      .map((source) => [source.accountKey, source.startOn]),
  );
  const balances = new Map<string, BankfeedFeedBalance>(
    (checks?.checks ?? []).flatMap((check) =>
      check.provider === "simplefin"
        ? [
            [
              check.accountKey,
              {
                asOf: check.asOf,
                reported: check.reported,
                ledger: check.ledger,
                waiting: check.waiting,
                excluded: check.excluded,
                difference: check.difference,
              },
            ] as const,
          ]
        : [],
    ),
  );
  return {
    bookCurrency,
    chartLabel: (id) => labels.get(id) ?? null,
    sourceStartOn: (key) => starts.get(key) ?? null,
    feedBalance: (key) => balances.get(key) ?? null,
    accountKey: keyOf,
  };
}

/** Every account the Bridge has listed, with whether it is linked. */
export function accountViews(store: BankfeedStore, books: BooksView): BankfeedAccount[] {
  const links = new Map(store.links().map((link) => [link.accountId, link]));
  return store.accounts().map((row) => accountWire(row, links.get(row.accountId), books));
}
