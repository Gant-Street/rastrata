import type {
  BankOfferInput,
  BankOfferResult,
  BankReceiveInput,
  BankReceiveResult,
} from "../../agent/bank-wire.ts";
import { describePrincipal, requireControlPlane } from "../../agent/principal.ts";
import { PROVIDER, accountKeyOf, normaliseTransactions } from "../../banks/normalise.ts";
import { booksFirstDay } from "../../calendar/setup.ts";
import type {
  AccountList,
  BanksStatus,
  CutoverState,
  InboxSourceChange,
  InboxSourceList,
} from "../../client-contracts.gen.ts";
import { ApplicationError } from "../../errors.ts";
import { deriveUuid } from "../../ingest/hash.ts";
import { addDays, isCalendarDate } from "../../ingest/text.ts";
import type { IngestBatch } from "../../ingest-types.ts";
import type { ApplicationService } from "../../service.ts";
import { ingestPort } from "../ingest/port.ts";
import { callOperation } from "../shadow/operations.ts";
import type { SliceContext, SliceHandlers } from "../types.ts";
import { type BankAccountRow, banksStore } from "./store.ts";
import { accountView, labelsOf } from "./view.ts";

/** Roles whose accounts are Stripe's own: a bank connection does not feed them. */
const STRIPE_ROLE_KEYS = new Set(["stripe.balance", "payouts.in-transit"]);

/** The kinds of account that are an asset of the books (money held) and the kinds that are a liability (money owed); `other` may be either. */
const ASSET_KINDS = new Set(["checking", "savings"]);
const LIABILITY_KINDS = new Set(["credit_card", "line_of_credit", "mortgage"]);

const dayOf = (instant: string): string => instant.slice(0, 10);

/** Offer: the control plane says which accounts the connection has brought and how each stands. Booking is the owner's and is never touched.
 *
 * It keeps no answer by the call's identity (`retainRequest`): a message that says how things stand now is not a request whose answer should be remembered. An account that
 * becomes inactive and then active again is told twice with the same words, and the second must change what the first left, which a remembered answer would not. Asking again
 * with the same accounts is harmless: it writes what is already written. */
function offer(service: ApplicationService, input: BankOfferInput): BankOfferResult {
  const store = banksStore(service);
  const at = service.now();
  store.transaction(() => {
    for (const account of input.accounts) store.upsert(account, at);
  });
  return {
    accounts: input.accounts.map((account) => ({
      id: account.id,
      booked: store.account(account.id)?.ledgerAccountId != null,
    })),
  };
}

/** Receive: the transactions the control plane read since the last time. Posted ones are queued in the Inbox through the same pipeline a statement file and a SimpleFIN
 * feed use (the same duplicate checks, the same cautions); nothing is posted. An account that is not booked queues nothing and says so: the sender keeps its place.
 *
 * It keeps no answer by the call's identity, as `offer` does not: the same transactions are sent again once the owner has booked the account, and the answer then is not the answer
 * to the first time. What makes asking twice harmless is the pipeline, which takes a transaction once. */
function receive(context: SliceContext, input: BankReceiveInput): BankReceiveResult {
  const { service } = context;
  const store = banksStore(service);
  const at = service.now();
  const key = accountKeyOf(input.account.id);
  if (key === null)
    throw new ApplicationError(
      "bank_account_unusable",
      "That account's identifier cannot be used as a key.",
      422,
    );
  store.upsert(input.account, at);
  const row = store.account(input.account.id);
  const normalised = normaliseTransactions(input.account, input.transactions, {
    accountKey: key,
  });
  const { counts } = normalised;
  const none: BankReceiveResult = {
    booked: false,
    received: counts.received,
    queued: 0,
    duplicates: 0,
    pending: counts.pending,
    held: counts.held,
  };
  if (
    row === null ||
    row.ledgerAccountId === null ||
    row.startOn === null ||
    row.state === "disconnected" ||
    !service.setupState()
  )
    return none;

  const { ledgerAccountId, startOn } = row;
  const bytes = new TextEncoder().encode(JSON.stringify(input));
  const port = ingestPort(service);
  return service.store.transaction(() => {
    let queued = 0;
    let duplicates = 0;
    if (normalised.lines.length > 0) {
      const raw = port.archive(
        bytes,
        "application/json",
        `bank-${input.account.id}-${input.refresh}.json`,
      );
      // The instant the batch is stamped with comes from the payload (the latest time Stripe changed any of its transactions), so that the same payload sent again is the same
      // batch and the pipeline recognises it.
      const latest = Math.max(...input.transactions.map((transaction) => transaction.updated));
      const batch: IngestBatch = {
        provider: PROVIDER,
        sourceKey: key,
        raw,
        lines: normalised.lines,
        balances: [],
        cursor: input.refresh,
        fetchedAt: new Date(latest * 1000).toISOString(),
        ledgerAccountId,
        startOn,
      };
      const report = port.submit(batch);
      queued = report.newCount;
      duplicates = report.duplicateCount + report.overlapCount;
    }
    store.hold(input.account.id, normalised.held, at);
    // A transaction that was held once and arrives readable is no longer held.
    store.releaseHeld(
      input.account.id,
      normalised.lines.map((line) => `id:${line.providerId}`),
    );
    store.recordReceived(input.account.id, { at, refreshId: input.refresh, queued });
    return {
      booked: true,
      received: counts.received,
      queued,
      duplicates: duplicates + counts.repeated,
      pending: counts.pending,
      held: counts.held,
    };
  });
}

async function status(context: SliceContext, books: boolean): Promise<BanksStatus> {
  const { service } = context;
  const store = banksStore(service);
  const chart =
    books && service.setupState()
      ? await callOperation<AccountList>(context, "accounts.list").catch(() => null)
      : null;
  const labels = labelsOf(chart);
  const held = store.held(50);
  return {
    accounts: store.accounts().map((row) => accountView(row, labels)),
    held: held.map((item) => ({
      accountId: item.accountId,
      id: item.id,
      postedOn: item.postedOn,
      reason: item.reason,
    })),
    heldCount: store.heldCount(),
  };
}

/** Book an account to a chart account, with the first day to read.
 *
 * Booking is the owner's choice and the only thing that makes an account's transactions queue: an account that appears later is listed as unbooked and nothing is queued
 * from it. The pairing is never guessed. It contacts nothing: it records the choice, and tells the Inbox where the account is booked and from which day
 * (`inbox.configureSource`), so a line before the cutover date is set aside, visibly, the same way a statement or a SimpleFIN source does it. */
async function book(
  context: SliceContext,
  input: { account: string; ledgerAccountId: string; startOn?: string },
  operationId: string,
) {
  const { service } = context;
  return service.retainAsyncRequest(operationId, "banks.book", input, async () => {
    const store = banksStore(service);
    const setup = service.setupState();
    if (!setup) throw new ApplicationError("book_not_configured", "Book is not configured", 409);
    const row = store.account(input.account);
    if (row === null)
      throw new ApplicationError(
        "bank_account_unknown",
        "That bank account has not been connected. Connect the bank first, then book one of its accounts.",
        404,
      );
    const key = accountKeyOf(row.accountId);
    if (key === null)
      throw new ApplicationError(
        "bank_account_unusable",
        "That account's identifier cannot be used as a key.",
        422,
      );
    if (row.state === "disconnected")
      throw new ApplicationError(
        "bank_account_disconnected",
        "That connection was stopped. Connect the bank again to book its accounts.",
        409,
      );

    const chart = await callOperation<AccountList>(context, "accounts.list");
    const target = chart.accounts.find((account) => account.id === input.ledgerAccountId);
    if (!target)
      throw new ApplicationError("account_not_found", "That chart account does not exist.", 404);
    if (target.role !== "asset" && target.role !== "liability")
      throw new ApplicationError(
        "account_role_invalid",
        `${target.code} ${target.name} is not a bank or card account (it is not an asset or a liability). A bank connection is booked to a bank, card or loan account.`,
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
    // A checking or savings account holds money (an asset); a card, line of credit or mortgage is owed (a liability). The other way round would book every line backwards.
    if (
      (ASSET_KINDS.has(row.kind) && target.role !== "asset") ||
      (LIABILITY_KINDS.has(row.kind) && target.role !== "liability")
    )
      throw new ApplicationError(
        "account_kind_mismatch",
        `${row.name} is ${ASSET_KINDS.has(row.kind) ? "a bank account, which is an asset" : "a card or a loan, which is a liability"} in your books, but ${target.code} ${target.name} is ${target.role === "asset" ? "an asset" : "a liability"}. Choose ${ASSET_KINDS.has(row.kind) ? "an asset" : "a liability"} account.`,
        422,
      );
    // One chart account is fed by one bank account at a time. The exception is a connection that has stopped (it needs the owner to sign in again, or was disconnected) and that
    // the new account replaces: Stripe makes a new account each time a bank is connected, so the same bank account comes back with a new identifier. It is recognised by the
    // bank, the last four digits and the kind, and the stopped one is let go.
    const taken = store.byLedger(target.id);
    let replaced: BankAccountRow | null = null;
    if (taken !== null && taken.accountId !== row.accountId) {
      const same =
        taken.state !== "active" &&
        taken.institution === row.institution &&
        taken.last4 === row.last4 &&
        taken.kind === row.kind;
      if (!same)
        throw new ApplicationError(
          "bank_ledger_account_taken",
          `${target.code} ${target.name} is already fed by another bank account. Stop that one first.`,
          409,
        );
      replaced = taken;
    }

    // An earlier connection may have fed this chart account already. The same transactions come back with new identifiers from a new connection, so reading them again would queue
    // them twice: unless the owner says otherwise, the first day is the day after the last line the earlier one brought.
    const sources = await callOperation<InboxSourceList>(context, "inbox.sources").catch(
      () => null,
    );
    const earlier = (sources?.sources ?? []).filter(
      (other) =>
        other.provider === PROVIDER &&
        other.accountKey !== key &&
        other.ledgerAccountId === target.id &&
        other.batches > 0 &&
        other.lastLineOn !== null,
    );
    const lastEarlier =
      earlier
        .map((other) => other.lastLineOn as string)
        .sort()
        .at(-1) ?? null;

    // The first day: the owner's, else the day after an earlier connection's last line, else the recorded cutover date, else the first day of the book.
    let startOn = input.startOn;
    let afterEarlier = false;
    if (startOn === undefined && lastEarlier !== null) {
      startOn = addDays(lastEarlier, 1);
      afterEarlier = true;
    }
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

    // Tell the Inbox where this account is booked and from which day. A source that already has drafts or posted entries cannot move to another chart account: the Inbox says so.
    await callOperation<InboxSourceChange>(
      context,
      "inbox.configureSource",
      { provider: PROVIDER, accountKey: key, ledgerAccountId: target.id, startOn },
      deriveUuid(["banks.book", operationId, key]),
    );
    store.transaction(() => {
      if (replaced !== null) store.unbook(replaced.accountId);
      store.book(row.accountId, {
        ledgerAccountId: target.id,
        startOn,
        at: service.now(),
        by: describePrincipal(context.access.principal),
      });
    });

    const notes: string[] = [];
    if (replaced !== null)
      notes.push(
        `This replaces the earlier connection of ${replaced.institution} ${replaced.name}${replaced.last4 ? ` ending ${replaced.last4}` : ""}, which had stopped. Its lines stay where they are.`,
      );
    if (afterEarlier && lastEarlier !== null)
      notes.push(
        `The first day is ${startOn}, the day after the last line the earlier connection brought (${lastEarlier}), so that nothing is queued twice. A transaction the bank posted late with an earlier date is not read; choose an earlier first day if you need it, and check the lines it brings against what is already there.`,
      );
    else if (earlier.length > 0 && replaced === null)
      notes.push(
        `An earlier connection fed ${target.code} ${target.name} with lines up to ${lastEarlier}. A new connection brings the same transactions with new identifiers, so the ones from your first day to then would be queued twice. Book it again with a first day of ${addDays(lastEarlier as string, 1)} to avoid that.`,
      );
    for (const other of sources?.sources ?? [])
      if (other.provider !== PROVIDER && other.ledgerAccountId === target.id && other.batches > 0)
        notes.push(
          `Another source already feeds ${target.code} ${target.name} (${other.provider}, lines from ${other.firstLineOn ?? "?"} to ${other.lastLineOn ?? "?"}). Sources are separate and Rastrata does not match one against the other, so the same transactions would be queued twice for any dates both cover.${
            other.lastLineOn
              ? ` Book it again with a first day of ${addDays(other.lastLineOn, 1)} to start after the last imported line.`
              : ""
          }`,
        );
    if (startOn > dayOf(service.now()))
      notes.push(
        `The first day, ${startOn}, has not come yet, so nothing is queued until it does.`,
      );

    const updated = store.account(row.accountId);
    if (updated === null) throw new Error("The booked account is missing from its own view");
    return { account: accountView(updated, labelsOf(chart)), notes };
  });
}

/** Stop queuing lines from an account. Lines already imported stay in the Inbox and in the books; the Inbox's own record of the account (its chart account and first day) is
 * left alone. */
async function unbook(context: SliceContext, input: { account: string }, operationId: string) {
  const { service } = context;
  return service.retainAsyncRequest(operationId, "banks.unbook", input, async () => {
    const store = banksStore(service);
    const row = store.account(input.account);
    const unbooked = row?.ledgerAccountId != null;
    if (unbooked) store.unbook(input.account);
    const chart = service.setupState()
      ? await callOperation<AccountList>(context, "accounts.list").catch(() => null)
      : null;
    const updated = store.account(input.account);
    return {
      account: updated === null ? null : accountView(updated, labelsOf(chart)),
      unbooked,
    };
  });
}

export const banksHandlers: SliceHandlers = {
  "banks.offer": (input, { service, access }) => {
    requireControlPlane(access, "banks.offer");
    return offer(service, input as unknown as BankOfferInput);
  },

  "banks.receive": (input, context) => {
    requireControlPlane(context.access, "banks.receive");
    return receive(context, input as unknown as BankReceiveInput);
  },

  "banks.status": (input, context) => status(context, input.books !== false),

  "banks.book": (input, context) =>
    book(
      context,
      input as { account: string; ledgerAccountId: string; startOn?: string },
      context.operationId,
    ),

  "banks.unbook": (input, context) =>
    unbook(context, input as { account: string }, context.operationId),
};
