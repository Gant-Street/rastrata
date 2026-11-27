import { describePrincipal } from "../../agent/principal.ts";
import { accountKeyOf } from "../../bankfeed/normalise.ts";
import { booksFirstDay } from "../../calendar/setup.ts";
import type {
  AccountList,
  BankfeedLinkInput,
  BankfeedLinkResult,
  BankfeedUnlinkInput,
  BankfeedUnlinkResult,
  CutoverState,
  InboxSourceChange,
  InboxSourceList,
} from "../../client-contracts.gen.ts";
import { ApplicationError } from "../../errors.ts";
import { deriveUuid } from "../../ingest/hash.ts";
import { addDays, isCalendarDate } from "../../ingest/text.ts";
import { callOperation } from "../shadow/operations.ts";
import type { SliceContext } from "../types.ts";
import { accountViews, booksView } from "./accounts.ts";
import { bankfeedRuntime } from "./runtime.ts";
import { bankfeedStore } from "./store.ts";

/** Roles whose accounts are Stripe's own: a bank feed does not feed them. */
const STRIPE_ROLE_KEYS = new Set(["stripe.balance", "payouts.in-transit"]);

const WHY: Readonly<Record<string, string>> = {
  custom_currency:
    "This account is in a custom currency (a URL, not a national currency), which Rastrata cannot book.",
  bad_id: "This account's id from the Bridge cannot be used as a key, so it cannot be linked.",
  ambiguous:
    "Another account in the Bridge's list has the same id, so Rastrata cannot ask for this one on its own and will not link it.",
};

/** Link a Bridge account to a chart account, with the first day to read.
 *
 * Linking is the owner's choice and the only thing that makes an account fetched: an account that
 * appears later is listed as unlinked and nothing is asked for it. The pairing is never guessed.
 * It contacts nothing: it records the choice, and tells the Inbox where the account is booked and from
 * which day (`inbox.configureSource`), so a line before the cutover date is set aside, visibly, the same
 * way a statement or Stripe source does it. */
export async function linkAccount(
  context: SliceContext,
  input: BankfeedLinkInput,
  operationId: string,
): Promise<BankfeedLinkResult> {
  const { service } = context;
  return service.retainAsyncRequest(operationId, "bankfeed.link", input, async () => {
    const store = bankfeedStore(service);
    const setup = service.setupState();
    if (!setup) throw new ApplicationError("book_not_configured", "Book is not configured", 409);
    const row = store.account(input.accountId);
    if (row === null || !row.listed)
      throw new ApplicationError(
        "bankfeed_account_unknown",
        "The Bridge has not listed that account. Ask the Bridge for its accounts first, then link one of them.",
        404,
      );
    if (row.support !== "ok")
      throw new ApplicationError(
        "bankfeed_account_unsupported",
        WHY[row.support] ?? "This account cannot be linked.",
        422,
      );
    const key = accountKeyOf(row.accountId);
    if (key === null)
      throw new ApplicationError("bankfeed_account_unsupported", WHY.bad_id as string, 422);

    const chart = await callOperation<AccountList>(context, "accounts.list");
    const target = chart.accounts.find((account) => account.id === input.ledgerAccountId);
    if (!target)
      throw new ApplicationError("account_not_found", "That chart account does not exist.", 404);
    if (target.role !== "asset" && target.role !== "liability")
      throw new ApplicationError(
        "account_role_invalid",
        `${target.code} ${target.name} is not a bank or card account (it is not an asset or a liability). A bank feed is booked to a bank, card or loan account.`,
        422,
      );
    if (target.closedOn !== null)
      throw new ApplicationError(
        "account_closed",
        `${target.code} ${target.name} is closed, so nothing can be booked to it.`,
        422,
      );
    if (STRIPE_ROLE_KEYS.has(target.tags?.roleKey ?? ""))
      throw new ApplicationError(
        "account_is_stripe",
        `${target.code} ${target.name} is one of the Stripe accounts, which are fed from Stripe and never from a bank.`,
        422,
      );
    const taken = store.linkByLedger(target.id);
    if (taken !== null && taken.accountId !== row.accountId)
      throw new ApplicationError(
        "bankfeed_ledger_account_taken",
        `${target.code} ${target.name} is already fed by another Bridge account. Unlink that one first.`,
        409,
      );

    // The first day: the owner's, else the recorded cutover date, else the first day of the book.
    let startOn = input.startOn;
    if (startOn === undefined) {
      const cutover = await callOperation<CutoverState>(context, "cutover.get", {}).catch(
        () => null,
      );
      startOn = cutover?.cutover?.cutoverDate ?? booksFirstDay(setup);
    }
    if (!isCalendarDate(startOn))
      throw new ApplicationError(
        "invalid_date",
        "The first day is not a real date, YYYY-MM-DD.",
        400,
        [{ path: "input.startOn", message: "Use a real date, YYYY-MM-DD" }],
      );

    // Tell the Inbox where this account is booked and from which day. A source that already has
    // drafts or posted entries cannot move to another chart account: the Inbox says so.
    await callOperation<InboxSourceChange>(
      context,
      "inbox.configureSource",
      { provider: "simplefin", accountKey: key, ledgerAccountId: target.id, startOn },
      deriveUuid(["bankfeed.link", operationId, key]),
    );
    const previous = store.link(row.accountId);
    store.saveLink({
      accountId: row.accountId,
      ledgerAccountId: target.id,
      startOn,
      connId: row.connId,
      linkedAt: previous?.linkedAt ?? bankfeedRuntime(service).now(),
      linkedBy: previous?.linkedBy ?? describePrincipal(context.access.principal),
    });

    const notes: string[] = [];
    if (row.isoCurrency !== null && row.isoCurrency !== setup.currency)
      notes.push(
        `This account is in ${row.isoCurrency} and the book is in ${setup.currency}. Rastrata does not convert currencies: its lines arrive in ${row.isoCurrency}, are held for review in the Inbox, and cannot be proposed or posted without you. No balance check is made for it.`,
      );
    const sources = await callOperation<InboxSourceList>(context, "inbox.sources").catch(
      () => null,
    );
    for (const other of sources?.sources ?? [])
      if (
        other.provider !== "simplefin" &&
        other.ledgerAccountId === target.id &&
        other.batches > 0
      )
        notes.push(
          `Statement files already feed ${target.code} ${target.name} (${other.provider}, lines from ${other.firstLineOn ?? "?"} to ${other.lastLineOn ?? "?"}). Statement files and the bank feed are separate sources and Rastrata does not match one against the other, so the same transactions would be queued twice for any dates both cover.${
            other.lastLineOn
              ? ` Link again with a first day of ${addDays(other.lastLineOn, 1)} to start after the last imported line.`
              : ""
          }`,
        );
    if (startOn > new Date(bankfeedRuntime(service).now()).toISOString().slice(0, 10))
      notes.push(`The first day, ${startOn}, has not come yet, so nothing is read until it does.`);

    const books = await booksView(context, setup.currency, true);
    const account = accountViews(store, books).find((item) => item.id === row.accountId);
    if (!account) throw new Error("The linked account is missing from its own view");
    return { account, notes };
  });
}

/** Stop reading an account. Lines already imported stay in the Inbox and in the books; the Inbox's
 * own record of the account (its chart account and first day) is left alone. */
export async function unlinkAccount(
  context: SliceContext,
  input: BankfeedUnlinkInput,
  operationId: string,
): Promise<BankfeedUnlinkResult> {
  const { service } = context;
  return service.retainAsyncRequest(operationId, "bankfeed.unlink", input, async () => {
    const store = bankfeedStore(service);
    const setup = service.setupState();
    if (!setup) throw new ApplicationError("book_not_configured", "Book is not configured", 409);
    const link = store.link(input.accountId);
    const unlinked = link !== null;
    if (link !== null) store.deleteLink(input.accountId);
    const books = await booksView(context, setup.currency, false);
    const account = accountViews(store, books).find((item) => item.id === input.accountId) ?? null;
    return { account, unlinked };
  });
}
