/** What every read of the payees begins with: the book at a pinned revision, the list of payees at a
 * pinned payees revision, the text the Inbox holds for the journals of the range, and the wire shapes
 * the reads share. */
import { type BookState, hashCanonical } from "@rastrata/kernel";

import type {
  Payee as PayeeWire,
  PayeeRef,
  PayeeTally,
  PayeeTransaction,
} from "../../client-contracts.gen.ts";
import { ApplicationError } from "../../errors.ts";
import { formatMoney } from "../../money.ts";
import {
  type JournalEffect,
  type JournalText,
  PAYEE_TOTALS_VERSION,
  type PayeeRecord,
  type Tally,
  attributionHash,
} from "../../payees/totals.ts";
import { payeeText } from "../../payees/match.ts";
import { isProfitLossRole } from "../../reports/chart.ts";
import { reportContext, resolveRange } from "../../reports/columns.ts";
import type { SliceContext } from "../types.ts";
import { readTaxState } from "../tax/store.ts";
import { type Payee, type PayeeState, payeesRuntime, readPayeeState } from "./store.ts";
import { readJournalTexts } from "./sources.ts";

export interface Loaded {
  readonly state: BookState;
  readonly payeeState: PayeeState;
  readonly records: readonly PayeeRecord[];
  /** Payee id to name. */
  readonly names: ReadonlyMap<string, string>;
  /** The payees that have 1099 details. */
  readonly vendors: ReadonlySet<string>;
  readonly texts: ReadonlyMap<string, JournalText>;
  readonly textsRead: boolean;
  readonly from: string;
  readonly to: string;
  /** The income and expense accounts the read was limited to, sorted; absent for all of them. */
  readonly accountIds?: readonly string[];
  readonly only?: ReadonlySet<string>;
}

const revisionOf = (input: Record<string, unknown>): bigint | undefined =>
  typeof input.revision === "string" ? BigInt(input.revision) : undefined;

/** The list of payees as the caller asked for it (the newest, or pinned to a recorded revision). */
export function payeesOf(
  context: SliceContext,
  input: Record<string, unknown>,
): { readonly payeeState: PayeeState; readonly vendors: ReadonlySet<string> } {
  const runtime = payeesRuntime(context.service);
  const payeeState = readPayeeState(
    runtime.store,
    typeof input.payeesRevision === "string"
      ? { throughRevision: Number(input.payeesRevision) }
      : {},
  );
  const vendors = new Set(readTaxState(runtime.store).vendors.map((vendor) => vendor.id));
  return { payeeState, vendors };
}

export const recordOf = (payee: Payee): PayeeRecord => ({
  id: payee.id,
  name: payee.name,
  words: payee.words,
  retired: payee.retired,
});

/** The accounts a read was limited to: each must be an income or expense account of the chart in force on
 * the date, the only accounts a report by payee has money on. */
function onlyAccounts(
  input: Record<string, unknown>,
  accounts: ReturnType<typeof reportContext>["accounts"],
): readonly string[] | undefined {
  if (!Array.isArray(input.accountIds) || input.accountIds.length === 0) return undefined;
  const ids = [...new Set(input.accountIds as string[])].sort();
  for (const id of ids) {
    const account = accounts.find((entry) => entry.id === id);
    if (!account)
      throw new ApplicationError(
        "account_not_found",
        `No account has the id ${id}. Use accounts.list to find an account's id.`,
        404,
        [{ path: "input.accountIds", message: `No account ${id}` }],
      );
    if (!isProfitLossRole(account.role))
      throw new ApplicationError(
        "invalid_input",
        `Money by payee reads income and expense accounts: ${account.code} ${account.name} is neither.`,
        400,
        [
          {
            path: "input.accountIds",
            message: `${account.code} is not an income or expense account`,
          },
        ],
      );
  }
  return ids;
}

export async function load(input: Record<string, unknown>, context: SliceContext): Promise<Loaded> {
  const { aggregate } = await context.service.readAggregate(revisionOf(input));
  const state = aggregate.state;
  const to = String(input.asOf);
  const reports = reportContext(state, to);
  const range = resolveRange(reports, to, typeof input.from === "string" ? input.from : undefined);
  const accountIds = onlyAccounts(input, reports.accounts);
  const { payeeState, vendors } = payeesOf(context, input);
  const { texts, read } = await readJournalTexts(context, range.from, to);
  return {
    state,
    payeeState,
    records: payeeState.payees.map(recordOf),
    names: new Map(payeeState.payees.map((payee) => [payee.id, payee.name])),
    vendors,
    texts,
    textsRead: read,
    from: range.from,
    to,
    ...(accountIds ? { accountIds, only: new Set(accountIds) } : {}),
  };
}

/** The identity of a report by payee: the ledger half (the profit and loss of the same range), the
 * payees' words and the text behind each journal. */
export function populationOf(ledgerPopulationHash: string, loaded: Loaded): string {
  return hashCanonical({
    type: "PayeeTotalsPopulation",
    version: PAYEE_TOTALS_VERSION,
    ledgerPopulationHash,
    attributionHash: attributionHash(loaded.records, loaded.texts),
    from: loaded.from,
    to: loaded.to,
    accountIds: loaded.accountIds ?? null,
  }).digest;
}

export const payeeWire = (payee: Payee, vendors: ReadonlySet<string>): PayeeWire => ({
  id: payee.id,
  version: payee.version,
  name: payee.name,
  words: [...payee.words],
  defaultAccountId: payee.defaultAccountId,
  note: payee.note,
  retired: payee.retired,
  hasTaxDetails: vendors.has(payee.id),
  recordedAt: payee.recordedAt,
  principal: payee.principal,
});

export const tallyWire = (tally: Tally): PayeeTally => ({
  received: formatMoney(tally.received),
  spent: formatMoney(tally.spent),
  transactions: tally.transactions,
});

export const net = (tally: { readonly received: bigint; readonly spent: bigint }): string =>
  formatMoney(tally.received - tally.spent);

export const refOf = (names: ReadonlyMap<string, string>, id: string): PayeeRef => ({
  id,
  name: names.get(id) ?? id,
});

/** Payees as a list reads them: by name, and by id where two have the same name. */
export const refsByName = (names: ReadonlyMap<string, string>, ids: Iterable<string>): PayeeRef[] =>
  [...ids]
    .map((id) => refOf(names, id))
    .sort((a, b) => {
      const x = a.name.toLowerCase();
      const y = b.name.toLowerCase();
      return x < y ? -1 : x > y ? 1 : a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
    });

export function transactionWire(
  effect: JournalEffect,
  names: ReadonlyMap<string, string>,
): PayeeTransaction {
  const outcome = effect.outcome;
  return {
    date: effect.date,
    journalId: effect.journalId,
    narration: payeeText(effect.narration),
    text: effect.text,
    textFrom: effect.textFrom,
    received: formatMoney(effect.received),
    spent: formatMoney(effect.spent),
    accounts: effect.accounts
      .map((account) => `${account.code} ${account.name}`)
      .join("; ")
      .slice(0, 400),
    payee: outcome.kind === "payee" ? refOf(names, outcome.payeeId) : null,
    key: outcome.kind === "payee" ? outcome.key : null,
    reverses: effect.reverses,
  };
}
