import { For, Show } from "solid-js";
import { Check, TriangleAlert } from "../icons";
import { Status } from "../notice";
import type { InboxStatus } from "./types";
import { words } from "./words";
import { formatInstant, formatMoney, formatMoneyAbsolute, isNegativeMoney } from "../format";

/** "rule:42" is a rule; the built-ins and known lanes have names; anything else is shown as sent by
 * whoever registered it (it is text, never markup). */
export function proposerName(proposer: string): string {
  if (proposer === "rule" || proposer.startsWith("rule:")) return words.proposerRule;
  return words.proposer_[proposer] ?? proposer;
}

/** The first word of a proposer's id when it is a rule, so a person can open it. */
export function ruleIdOf(proposer: string): string | null {
  return proposer.startsWith("rule:") && proposer.length > 5 ? proposer.slice(5) : null;
}

/** A status in words (never colour alone); orange means a person has something to decide. */
export function StatusChip(props: { status: InboxStatus; covered?: boolean }) {
  // A line booked together with a payout has nothing for a person to decide: it is not orange.
  const waiting = () =>
    (props.status === "new" || props.status === "proposed") && props.covered !== true;
  return (
    <Status tone={waiting() ? "review" : "neutral"}>
      {props.covered && (props.status === "new" || props.status === "proposed")
        ? words.covered
        : words.statusLabel[props.status]}
    </Status>
  );
}

/** A posted line that is on a completed reconciliation says so, in a word and a check mark (never
 * colour alone); the statement it was checked against is read out for assistive technology. */
export function ReconciledMark(props: { statementDate: string }) {
  return (
    <span class="rt-inbox-reconciled">
      <Check aria-hidden="true" />
      {words.reconciled}
      <span class="rt-sr-only"> {words.reconciledTo(props.statementDate)}</span>
    </span>
  );
}

/** An amount in a Spent or Received column: the figure without its sign, because the column says which
 * way the money went. `signed` is for the one place a single column holds both (a phone's list). */
export function Absolute(props: { amount: string; signed?: boolean }) {
  return (
    <span class="rt-inbox-amount" data-out={isNegativeMoney(props.amount) ? "" : undefined}>
      {props.signed ? formatMoney(props.amount) : formatMoneyAbsolute(props.amount)}
    </span>
  );
}

/** A signed amount in tabular figures. The sign is a minus; the direction is also said in words for
 * assistive technology, so the figure alone never carries it. */
export function Amount(props: { amount: string; currency?: string; showCurrency?: boolean }) {
  return (
    <span class="rt-inbox-amount" data-out={isNegativeMoney(props.amount) ? "" : undefined}>
      <span aria-hidden="true">
        {formatMoney(props.amount)}
        <Show when={props.showCurrency && props.currency}>
          <span class="rt-inbox-currency"> {props.currency}</span>
        </Show>
      </span>
      <span class="rt-sr-only">
        {formatMoneyAbsolute(props.amount)} {props.currency ?? ""}{" "}
        {isNegativeMoney(props.amount) ? words.moneyOut : words.moneyIn}
      </span>
    </span>
  );
}

/** Cautions about a line, each with words and an icon. The explanation is one tap away in detail. */
export function FlagList(props: {
  flags: readonly string[];
  currency?: string;
  compact?: boolean;
}) {
  return (
    <Show when={props.flags.length > 0}>
      <ul class="rt-inbox-flags" aria-label="Cautions">
        <For each={props.flags}>
          {(flag) => (
            <li>
              <TriangleAlert aria-hidden="true" />
              <span>
                {flag === "foreign_currency" && props.currency
                  ? `${words.flagLabel.foreign_currency}: ${props.currency}`
                  : (words.flagLabel[flag] ?? flag)}
              </span>
              <Show when={!props.compact && words.flagExplain[flag]}>
                <span class="rt-inbox-flag-note">{words.flagExplain[flag]}</span>
              </Show>
            </li>
          )}
        </For>
      </ul>
    </Show>
  );
}

/** An ISO instant for people, on the viewer's own clock: "Oct 3, 2026, 7:02 PM". */
export const instant = formatInstant;

/** The names providers give the things a line links to, in words. A Map, because keys come from the
 * provider and must never reach an object's own properties. */
const LINK_LABELS = new Map([
  ["payout", "Payout"],
  ["members", "Transactions it books"],
  ["membersSha256", "Fingerprint of those transactions (SHA-256)"],
  ["balanceTransaction", "Balance transaction"],
  ["charge", "Charge"],
  ["paymentIntent", "Payment intent"],
  ["checkoutSession", "Checkout session"],
  ["invoice", "Invoice"],
  ["refund", "Refund"],
  ["dispute", "Dispute"],
  ["customer", "Customer"],
]);

/** A link's key in words. Unknown keys are split at capitals and shown as the text they are. */
export function linkLabel(key: string): string {
  const known = LINK_LABELS.get(key);
  if (known) return known;
  const spaced = key
    .replace(/([a-z0-9])([A-Z])/g, "$1 $2")
    .replace(/[_-]+/g, " ")
    .trim()
    .toLowerCase();
  return spaced ? `${spaced.charAt(0).toUpperCase()}${spaced.slice(1)}` : key;
}

/** A chart account's label for a leg, or the id when the account is not in the list. */
export const labelOf = (
  accounts: readonly { readonly value: string; readonly label: string }[],
  id: string,
): string => accounts.find((account) => account.value === id)?.label ?? id;
