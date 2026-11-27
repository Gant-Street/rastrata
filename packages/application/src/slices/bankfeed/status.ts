import { describeCredential } from "../../bankfeed/credentials.ts";
import type {
  BankfeedSettings,
  BankfeedStatus,
  BankfeedStatusInput,
} from "../../client-contracts.gen.ts";
import { ApplicationError } from "../../errors.ts";
import type { SliceContext } from "../types.ts";
import { accountViews, booksView } from "./accounts.ts";
import { bankfeedRuntime } from "./runtime.ts";
import { bankfeedStore } from "./store.ts";
import { attentionOf, problemWire, requestsWire, runWire } from "./view.ts";

/** A connected, linked feed whose last good sync is older than this is called stale. */
export const STALE_AFTER_DAYS = 3;

export const settingsWire = (settings: {
  readonly dailySync: boolean;
  readonly dailyAt: string;
}): BankfeedSettings => ({ dailySync: settings.dailySync, dailyAt: settings.dailyAt });

/** The whole state of the bank feed. It makes no request to the Bridge: everything here is what is
 * already known, and `books: false` skips reading the ledger as well, for a quick summary. */
export async function bankfeedStatus(
  context: SliceContext,
  input: BankfeedStatusInput,
): Promise<BankfeedStatus> {
  const { service } = context;
  const store = bankfeedStore(service);
  const runtime = bankfeedRuntime(service);
  const setup = service.setupState();
  if (!setup) throw new ApplicationError("book_not_configured", "Book is not configured", 409);
  const nowMs = Date.parse(runtime.now());
  const credential = describeCredential(runtime.credentials, runtime.policy);
  const connection = store.connection();
  const books = await booksView(context, setup.currency, input.books !== false);
  const accounts = accountViews(store, books);
  const held = store.held(50);
  const history = store.runs(10);
  const links = store.links();
  return {
    connected: credential.present,
    credential: { present: credential.present, host: credential.host, problem: credential.problem },
    bookCurrency: setup.currency,
    accounts,
    linked: accounts.filter((account) => account.link !== null).length,
    unlinked: accounts.filter((account) => account.state === "unlinked").length,
    attention: attentionOf({
      credential,
      connection,
      accounts,
      links,
      heldCount: held.count,
      nowMs,
      staleAfterDays: STALE_AFTER_DAYS,
    }),
    problems: connection.issues.map(problemWire).slice(0, 20),
    messages: connection.messages.slice(0, 5).map((message) => message.slice(0, 200)),
    requests: requestsWire(store, nowMs),
    settings: settingsWire(store.settings()),
    lastSync: history[0] ? runWire(history[0]) : null,
    history: history.map(runWire),
    held: held.rows.map((row) => ({
      accountId: row.accountId,
      id: row.id,
      postedOn: row.postedOn,
      reason: row.reason.slice(0, 300),
    })),
    heldCount: held.count,
    scheduler: runtime.scheduler,
  };
}
