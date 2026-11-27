import type {
  BankfeedAccountsResult,
  BankfeedConnectInput,
  BankfeedLinkInput,
  BankfeedSettingsInput,
  BankfeedStatusInput,
  BankfeedSyncInput,
  BankfeedSyncResult,
  BankfeedUnlinkInput,
} from "../../client-contracts.gen.ts";
import { ApplicationError } from "../../errors.ts";
import type { SliceHandler, SliceHandlers } from "../types.ts";
import { accountViews, asApplicationError, booksView, refreshListing } from "./accounts.ts";
import { connectBankfeed, disconnectBankfeed } from "./connect.ts";
import { linkAccount, unlinkAccount } from "./link.ts";
import { bankfeedRuntime } from "./runtime.ts";
import { minutesOf } from "./schedule.ts";
import { bankfeedStore } from "./store.ts";
import { bankfeedStatus, settingsWire } from "./status.ts";
import { runBankfeedSync, readAccess } from "./sync.ts";
import { problemWire, requestsWire, runWire } from "./view.ts";

/** Handlers for the bankfeed operations. Inputs are validated, permission checked and the book is
 * configured by the time they run. None of them returns, logs or echoes the setup token or the access
 * URL. */

const connect: SliceHandler = (input, context) =>
  connectBankfeed(context, input as unknown as BankfeedConnectInput, context.operationId);

const disconnect: SliceHandler = (_input, context) =>
  disconnectBankfeed(context, context.operationId);

const link: SliceHandler = (input, context) =>
  linkAccount(context, input as unknown as BankfeedLinkInput, context.operationId);

const unlink: SliceHandler = (input, context) =>
  unlinkAccount(context, input as unknown as BankfeedUnlinkInput, context.operationId);

const status: SliceHandler = (input, context) =>
  bankfeedStatus(context, input as unknown as BankfeedStatusInput);

/** Ask the Bridge for its accounts: one request, spent from the same budget as a sync. Retained under
 * the operation's identity, so a retry after a lost reply is the first answer and costs nothing. */
const accounts: SliceHandler = (_input, context) =>
  context.service.retainAsyncRequest(
    context.operationId,
    "bankfeed.accounts",
    {},
    async (): Promise<BankfeedAccountsResult> => {
      const { service } = context;
      const setup = service.setupState();
      if (!setup) throw new ApplicationError("book_not_configured", "Book is not configured", 409);
      const store = bankfeedStore(service);
      const access = readAccess(service);
      let refreshed: Awaited<ReturnType<typeof refreshListing>>;
      try {
        refreshed = await refreshListing(context, store, access);
      } catch (error) {
        throw error instanceof ApplicationError ? error : asApplicationError(error, access);
      }
      const books = await booksView(context, setup.currency, true);
      return {
        accounts: accountViews(store, books),
        problems: refreshed.problems.map(problemWire).slice(0, 20),
        messages: refreshed.messages.slice(0, 5),
        requests: requestsWire(store, Date.parse(bankfeedRuntime(service).now())),
      };
    },
  );

const sync: SliceHandler = (input, context) =>
  context.service.retainAsyncRequest(
    context.operationId,
    "bankfeed.sync",
    input,
    async (): Promise<BankfeedSyncResult> => {
      const request = input as unknown as BankfeedSyncInput;
      const outcome = await runBankfeedSync(
        context,
        {
          ...(request.budgetSeconds === undefined ? {} : { budgetSeconds: request.budgetSeconds }),
          ...(request.accountId === undefined ? {} : { accountId: request.accountId }),
        },
        context.operationId,
      );
      return {
        run: runWire(outcome.run),
        more: outcome.more,
        paused: outcome.paused,
        accounts: outcome.accounts.map((account) => ({ ...account })),
        problems: outcome.problems.map(problemWire).slice(0, 20),
      };
    },
  );

/** The daily sync's switch and time. Off until the owner turns it on. */
const settings: SliceHandler = (input, context) =>
  context.service.retainAsyncRequest(context.operationId, "bankfeed.settings", input, async () => {
    const request = input as unknown as BankfeedSettingsInput;
    const store = bankfeedStore(context.service);
    const current = store.settings();
    if (request.dailyAt !== undefined && minutesOf(request.dailyAt) === null)
      throw new ApplicationError(
        "invalid_input",
        "The daily sync time is a local time written HH:MM (24 hours), for example 06:17.",
        400,
        [{ path: "input.dailyAt", message: "Use HH:MM, 00:00 to 23:59" }],
      );
    const next = {
      dailySync: request.dailySync ?? current.dailySync,
      dailyAt: request.dailyAt ?? current.dailyAt,
    };
    store.saveSettings(next, bankfeedRuntime(context.service).now());
    return settingsWire(next);
  });

export const bankfeedHandlers: SliceHandlers = {
  "bankfeed.connect": connect,
  "bankfeed.accounts": accounts,
  "bankfeed.link": link,
  "bankfeed.unlink": unlink,
  "bankfeed.sync": sync,
  "bankfeed.status": status,
  "bankfeed.settings": settings,
  "bankfeed.disconnect": disconnect,
};
