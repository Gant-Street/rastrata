import { sha256Hex } from "../ingest/hash.ts";
import type { Connector, IngestBatch } from "../ingest-types.ts";
import { BridgeClient, BridgeError, type ClientOptions, type FetchFn } from "./client.ts";
import { amountToMoney } from "./amount.ts";
import { OVERLAP_DAYS, PROVIDER, WINDOW_DAYS } from "./constants.ts";
import type { AccessUrl } from "./credentials.ts";
import { type BridgeConnection, decodeAccountSet } from "./decode.ts";
import { type Counts, type HeldTransaction, currencyOf, normaliseAccount } from "./normalise.ts";
import { type BridgeProblem, concerns } from "./problems.ts";
import {
  SECONDS_PER_DAY,
  type Window,
  cutWindows,
  epochOfDate,
  isPlausibleEpoch,
  utcDate,
} from "./time.ts";

/** The SimpleFIN connector for one linked account: it reads the account's posted transactions from
 * the Bridge window by window and hands each window to the pipeline as one batch with its exact
 * bytes. It is the contract's `Connector`, with each batch carrying the facts the runner records.
 *
 * Properties the tests hold it to:
 *  - **Only a linked account is asked for** (`account=<id>`); the connector is made for one link and
 *    cannot name another. Listing accounts is a separate, cheaper request (`balances-only=1`).
 *  - **The cursor moves only when a window was read completely.** `batch.cursor` is set only then,
 *    and the connector stops after a window it could not trust: an error the Bridge names for this
 *    account or its bank, an account that is not in the answer, an answer with no transaction list,
 *    or an account that now belongs to another bank connection. The next run reads that period again;
 *    the pipeline refuses what it already has, so nothing is lost and nothing is imported twice.
 *  - **The cursor means "everything before this instant has been read and applied".** A run starts
 *    five days before it (the Bridge's own advice) so a transaction the bank posted late is still
 *    found, and never before the account's first day.
 *  - **Windows tile the period** in pieces of at most 45 days, oldest first, each starting exactly
 *    where the one before ended.
 *  - Fetching goes through the injected `fetch`; the credential is held by the client and appears in
 *    no batch, cursor, name, message or record. */

export interface LinkedAccount {
  /** The Bridge's id for the account. */
  readonly accountId: string;
  /** The provider account key (`simplefin:<id>`), the identity of every line. */
  readonly accountKey: string;
  /** The chart account the account is booked to. */
  readonly ledgerAccountId: string;
  /** The first day that belongs in the book for this account, `YYYY-MM-DD`. */
  readonly startOn: string;
  /** The bank connection the account belonged to when it was linked, or null when unknown. */
  readonly connId: string | null;
}

export interface ConnectorSettings {
  readonly bookCurrency: string;
  readonly windowDays?: number;
  readonly overlapDays?: number;
}

export interface ConnectorDeps {
  readonly access: AccessUrl;
  readonly guard?: ClientOptions["guard"];
  readonly onRequest?: ClientOptions["onRequest"];
  readonly sleep?: ClientOptions["sleep"];
  readonly timeoutMs?: number;
}

export interface SimpleFinCursor {
  readonly v: 1;
  /** Everything before this instant (epoch seconds) has been read and applied. */
  readonly through: number;
}

export const encodeCursor = (cursor: SimpleFinCursor): string => JSON.stringify(cursor);

/** A cursor this connector wrote, or null. An unreadable cursor is treated as none: the run starts
 * over from the account's first day, which is safe because everything already read is known. */
export function decodeCursor(text: string | null | undefined): SimpleFinCursor | null {
  if (!text) return null;
  try {
    const value = JSON.parse(text) as Record<string, unknown>;
    return value.v === 1 && typeof value.through === "number" && Number.isSafeInteger(value.through)
      ? { v: 1, through: value.through }
      : null;
  } catch {
    return null;
  }
}

/** What a window reports beside its batch, for the runner to record. */
export interface WindowFacts {
  readonly window: Window;
  /** The last window of this run. */
  readonly final: boolean;
  /** True when the window was read completely and the cursor may move to its end. */
  readonly advance: boolean;
  /** Everything the Bridge said is wrong, as sent (`errlist` and `errors`). */
  readonly problems: readonly BridgeProblem[];
  readonly connections: readonly BridgeConnection[];
  /** Notes from the Bridge that are not errors. */
  readonly messages: readonly string[];
  readonly counts: Counts;
  readonly held: readonly HeldTransaction[];
  /** The account as the Bridge describes it now, or null when the answer did not list it. */
  readonly account: {
    readonly name: string;
    readonly currency: string;
    readonly balance: string | null;
    readonly balanceOn: string | null;
    readonly connId: string | null;
    readonly orgId: string | null;
    readonly orgName: string | null;
  } | null;
  /** The account is not in the answer. */
  readonly missing: boolean;
  /** The account now belongs to another bank connection than the one it was linked under. */
  readonly moved: boolean;
}

export interface PulledWindow {
  readonly batch: Omit<IngestBatch, "raw">;
  readonly raw: {
    readonly bytes: Uint8Array;
    readonly mediaType: string;
    readonly name?: string;
  };
  readonly facts: WindowFacts;
}

export interface SimpleFinConnector {
  readonly provider: typeof PROVIDER;
  pull(
    cursor: string | null,
    options: { readonly fetch: FetchFn; readonly now: () => string },
  ): AsyncIterable<PulledWindow>;
}

/** Compile-time proof that the connector satisfies the ingestion contract. */
export const asConnector = (connector: SimpleFinConnector): Connector => connector;

/** Where a run of this account starts: the first day, or five days before the cursor, whichever is
 * later; and where it ends: now. */
export function runWindow(
  link: Pick<LinkedAccount, "startOn">,
  cursor: SimpleFinCursor | null,
  nowSeconds: number,
  overlapDays = OVERLAP_DAYS,
): Window | null {
  const first = epochOfDate(link.startOn);
  const from = cursor ? Math.max(first, cursor.through - overlapDays * SECONDS_PER_DAY) : first;
  return from < nowSeconds ? { from, to: nowSeconds } : null;
}

export function createSimpleFinConnector(
  link: LinkedAccount,
  settings: ConnectorSettings,
  deps: ConnectorDeps,
): SimpleFinConnector {
  return {
    provider: PROVIDER,
    async *pull(cursorText, { fetch, now }) {
      const clock = (): number => Date.parse(now());
      const client = new BridgeClient(deps.access, {
        fetch,
        now: clock,
        ...(deps.guard ? { guard: deps.guard } : {}),
        ...(deps.onRequest ? { onRequest: deps.onRequest } : {}),
        ...(deps.sleep ? { sleep: deps.sleep } : {}),
        ...(deps.timeoutMs ? { timeoutMs: deps.timeoutMs } : {}),
      });
      const period = runWindow(
        link,
        decodeCursor(cursorText),
        Math.floor(clock() / 1000),
        settings.overlapDays ?? OVERLAP_DAYS,
      );
      if (period === null) return;
      const windows = cutWindows(period.from, period.to, settings.windowDays ?? WINDOW_DAYS);
      const accountHash = sha256Hex(link.accountId).slice(0, 8);

      for (const [index, window] of windows.entries()) {
        const final = index === windows.length - 1;
        const fetched = await client.accounts({
          account: link.accountId,
          startDate: window.from,
          endDate: window.to,
        });
        const decoded = decodeAccountSet(fetched.json, deps.access.secrets);
        if (!decoded.ok) throw new BridgeError("bankfeed_bad_response", decoded.problem, false);
        const set = decoded.value;
        const found = set.accounts.filter((account) => account.id === link.accountId);
        // Two accounts with the same id cannot be told apart: treated as not listed.
        const account = found.length === 1 ? found[0] : undefined;
        const connId = account?.connId ?? link.connId;
        const relevant = set.problems.filter((problem) =>
          concerns(problem, { id: link.accountId, connId }),
        );
        const moved =
          account !== undefined &&
          link.connId !== null &&
          account.connId !== null &&
          account.connId !== link.connId;
        const normalised =
          account === undefined || moved
            ? null
            : normaliseAccount(account, {
                accountKey: link.accountKey,
                bookCurrency: settings.bookCurrency,
                window,
                attachBalance: final && relevant.length === 0,
              });
        const advance = normalised?.listed === true && relevant.length === 0 && !moved;
        const raw = {
          bytes: fetched.bytes,
          mediaType: "application/json",
          name: `simplefin-${accountHash}-${utcDate(window.from)}-${utcDate(window.to)}.json`,
        };
        yield {
          batch: {
            provider: PROVIDER,
            sourceKey: link.accountKey,
            lines: normalised?.lines ?? [],
            balances: normalised?.balance ? [normalised.balance] : [],
            ...(advance ? { cursor: encodeCursor({ v: 1, through: window.to }) } : {}),
            fetchedAt: now(),
            ledgerAccountId: link.ledgerAccountId,
          },
          raw,
          facts: {
            window,
            final,
            advance,
            problems: set.problems,
            connections: set.connections,
            messages: set.messages,
            counts: normalised?.counts ?? {
              received: 0,
              imported: 0,
              pending: 0,
              afterWindow: 0,
              repeated: 0,
              held: 0,
            },
            held: normalised?.held ?? [],
            account: account
              ? {
                  name: account.name,
                  currency: currencyOf(account.currency) ?? account.currency,
                  balance: amountToMoney(account.balance),
                  balanceOn: isPlausibleEpoch(account.balanceDate)
                    ? utcDate(account.balanceDate)
                    : null,
                  connId: account.connId,
                  orgId: account.orgId,
                  orgName: account.orgName,
                }
              : null,
            missing: account === undefined,
            moved,
          },
        };
        // A window that could not be trusted ends the run: the next one starts from the same cursor.
        if (!advance) return;
      }
    },
  };
}
