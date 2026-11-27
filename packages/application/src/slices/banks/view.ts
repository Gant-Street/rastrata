import type { AccountList } from "../../client-contracts.gen.ts";
import type { BankAccountRow } from "./store.ts";

/** How the book shows a bank connection's account: what the connection is, where it is booked, and what (if anything) the owner has to do about it, in a sentence. */

export interface BankAccountView {
  readonly id: string;
  readonly institution: string;
  readonly name: string;
  readonly last4: string | null;
  readonly kind: BankAccountRow["kind"];
  readonly state: BankAccountRow["state"];
  readonly attention: string | null;
  readonly booking: {
    readonly ledgerAccountId: string;
    readonly ledgerAccount: string | null;
    readonly startOn: string;
    readonly bookedAt: string;
  } | null;
  readonly lastReceivedAt: string | null;
  readonly queuedLines: number;
}

/** What the owner is asked to do about an account, or null when nothing needs a person. */
export function attentionOf(row: BankAccountRow): string | null {
  if (row.state === "inactive")
    return "The bank no longer lets Rastrata read this account. Sign in to the bank again to keep receiving its transactions.";
  if (row.state === "disconnected")
    return "This connection was stopped, so no new transactions arrive. Connect the bank again to receive them.";
  if (row.ledgerAccountId === null)
    return "Choose which account in your books these transactions belong to. Nothing is read into your books until you do.";
  return null;
}

/** The chart's account labels by identifier ("1000 Business Checking"), for the accounts that are booked. */
export function labelsOf(chart: AccountList | null): ReadonlyMap<string, string> {
  return new Map((chart?.accounts ?? []).map((a) => [a.id, `${a.code} ${a.name}`]));
}

export function accountView(
  row: BankAccountRow,
  labels: ReadonlyMap<string, string>,
): BankAccountView {
  return {
    id: row.accountId,
    institution: row.institution,
    name: row.name,
    last4: row.last4,
    kind: row.kind,
    state: row.state,
    attention: attentionOf(row),
    booking:
      row.ledgerAccountId !== null && row.startOn !== null && row.bookedAt !== null
        ? {
            ledgerAccountId: row.ledgerAccountId,
            ledgerAccount: labels.get(row.ledgerAccountId) ?? null,
            startOn: row.startOn,
            bookedAt: row.bookedAt,
          }
        : null,
    lastReceivedAt: row.lastReceivedAt,
    queuedLines: row.queuedLines,
  };
}
