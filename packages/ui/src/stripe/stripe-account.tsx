import { For, type JSX, Show } from "solid-js";
import { RowMenu } from "../accounting/row-menu";
import type { RowAction } from "../accounting-types";
import { Button } from "../button";
import { DateValue } from "../date-value";
import { formatFiguresInText, formatMoney } from "../format";
import { Money } from "../money";
import { Pager } from "../pager";
import { PageSkeleton } from "../skeleton";
import type { StripeListState, StripePayoutView } from "./types";
import { words } from "./words";

/** One thing the block says needs the person, with the one thing to do about it. */
export interface StripeAttention {
  readonly text: string;
  readonly action?:
    | { readonly label: string; readonly onSelect: () => void; readonly pending?: boolean }
    | undefined;
}

/** The Stripe account and its payouts, in the ledger language (docs/reference/design-language.md), as a bank is on
 * Bank accounts: one rule over the block, a mark, what it is, when it was last read, and a row for each payout with
 * its date, where it stands and its amount. Nothing is marked on a payout that is in the books and matched to its
 * deposit; a payout that needs the person has an orange cell and says why, and a block that needs the person turns
 * its rule orange and says what, with the button. What Rastrata read and when, how it counted it, and a balance that
 * agrees are not said: they are the normal state. */
export function StripeAccount(props: {
  /** The Stripe account's identifier, or null before the first reading has learned it. */
  accountId: string | null;
  /** A plain fact that is not the usual one: "Practice data", "Disconnected". */
  note?: string | undefined;
  /** When it was last read, in words ("Updated today 6:27 PM"), or that it is being read now. */
  dateline?: string | null | undefined;
  /** What needs the person, most pressing first. */
  attention?: readonly StripeAttention[] | undefined;
  /** What is going on while a reading runs here, for a screen reader and the eye: "6 payouts booked so far…". */
  progress?: string | null | undefined;
  /** What can be done to the account: read it now, disconnect it. */
  actions?: readonly RowAction[] | undefined;
  rows: readonly StripePayoutView[];
  count: number;
  page: number;
  pageSize: number;
  state?: StripeListState | undefined;
  /** The books' currency, for the heading of the amount column. */
  currency: string;
  inboxHref: string;
  onPageChange: (page: number) => void;
  onRetry?: (() => void) | undefined;
  busy?: boolean | undefined;
  /** How a link is drawn (the application's router). */
  renderLink?: ((href: string, children: JSX.Element) => JSX.Element) | undefined;
}): JSX.Element {
  const link = (href: string, children: JSX.Element) =>
    props.renderLink ? props.renderLink(href, children) : <a href={href}>{children}</a>;
  const attention = () => props.attention ?? [];
  return (
    <section
      class="rt-stripeacct"
      aria-labelledby="rt-stripeacct-title"
      data-attention={attention().length > 0 ? "" : undefined}
    >
      <header class="rt-stripeacct-head">
        <span class="rt-stripeacct-mark" aria-hidden="true">
          S
        </span>
        <div class="rt-stripeacct-name">
          <h2 id="rt-stripeacct-title">{words.payoutsTitle}</h2>
          <Show when={props.accountId}>
            <bdi class="rt-stripeacct-id">{props.accountId}</bdi>
          </Show>
          <Show when={props.note}>
            <span class="rt-stripeacct-note">{props.note}</span>
          </Show>
        </div>
        <Show when={props.dateline}>
          <span class="rt-stripeacct-dateline">{props.dateline}</span>
        </Show>
        <Show when={(props.actions?.length ?? 0) > 0}>
          <RowMenu
            id="rt-stripeacct-actions"
            label={words.actionsLabel}
            actions={[...(props.actions ?? [])]}
          />
        </Show>
      </header>
      <For each={attention()}>
        {(item) => (
          <div class="rt-stripeacct-attention" role="status">
            <span class="rt-cell" data-tone="attention" aria-hidden="true" />
            <p>
              <bdi>{formatFiguresInText(item.text)}</bdi>
            </p>
            <Show when={item.action}>
              {(action) => (
                <Button
                  size="sm"
                  label={action().label}
                  pending={action().pending ?? false}
                  disabled={(props.busy ?? false) && !action().pending}
                  onClick={() => action().onSelect()}
                />
              )}
            </Show>
          </div>
        )}
      </For>
      <Show when={props.progress}>
        <p class="rt-stripeacct-progress" role="status">
          {props.progress}
        </p>
      </Show>
      <Show
        when={props.state !== "loading" && props.state !== "error"}
        fallback={
          props.state === "error" ? (
            <div class="rt-stripeacct-attention" role="alert">
              <span class="rt-cell" data-tone="problem" aria-hidden="true" />
              <p>{words.payoutsFailed}</p>
              <Show when={props.onRetry}>
                <Button
                  size="sm"
                  variant="secondary"
                  label={words.tryAgain}
                  onClick={() => props.onRetry?.()}
                />
              </Show>
            </div>
          ) : (
            <PageSkeleton shape="table" label={words.payoutsLoading} />
          )
        }
      >
        <Show
          when={props.rows.length > 0}
          fallback={<p class="rt-stripeacct-empty">{words.payoutsEmpty}</p>}
        >
          <div class="rt-stripeacct-labels" aria-hidden="true">
            <span>{words.payoutColumns.arrives}</span>
            <span>{words.payoutColumns.status}</span>
            <span>{words.payoutColumns.amount(props.currency)}</span>
          </div>
          <ul class="rt-stripeacct-rows" aria-label={words.payoutCaption}>
            <For each={props.rows}>
              {(row) => (
                <li data-booking={row.booking} data-deposit={row.deposit}>
                  <div class="rt-stripeacct-date">
                    <DateValue value={row.arrivalOn} />
                  </div>
                  <div class="rt-stripeacct-status">
                    <PayoutStatus row={row} inboxHref={props.inboxHref} link={link} />
                  </div>
                  <div class="rt-stripeacct-amount">
                    <Money value={row.amount} />
                    <Show when={row.currency.toUpperCase() !== props.currency.toUpperCase()}>
                      <span class="rt-stripeacct-currency">{row.currency.toUpperCase()}</span>
                    </Show>
                  </div>
                </li>
              )}
            </For>
          </ul>
          <Show when={props.count > props.pageSize}>
            <Pager
              count={props.count}
              page={props.page}
              pageSize={props.pageSize}
              onPageChange={props.onPageChange}
            />
          </Show>
        </Show>
      </Show>
    </section>
  );
}

/** Where a payout stands, in the fewest words: nothing marks one that is in the books; the way to match its bank
 * deposit is the cell itself; one that needs the person has the orange cell and says why. */
function PayoutStatus(props: {
  row: StripePayoutView;
  inboxHref: string;
  link: (href: string, children: JSX.Element) => JSX.Element;
}): JSX.Element {
  const row = () => props.row;
  const needs = (text: string, href?: string) => (
    <span class="rt-stripeacct-needs">
      <span class="rt-cell" data-tone="attention" aria-hidden="true" />
      {href ? props.link(href, text) : text}
    </span>
  );
  return (
    <Show
      when={row().booking === "booked"}
      fallback={
        <Show
          when={row().booking === "waiting"}
          fallback={
            <>
              {row().booking === "held"
                ? needs(words.payoutHeld, props.inboxHref)
                : row().booking === "mismatch"
                  ? needs(words.payoutOff(formatMoney(row().difference ?? "0.00")))
                  : needs(words.payoutNotBooked)}
              <Show when={row().booking !== "held" && row().reason}>
                <span class="rt-stripeacct-reason">
                  <bdi>{formatFiguresInText(row().reason ?? "")}</bdi>
                </span>
              </Show>
            </>
          }
        >
          <span class="rt-stripeacct-quiet">{words.payoutWaiting}</span>
        </Show>
      }
    >
      <Show
        when={row().deposit === "unmatched"}
        fallback={
          <span class="rt-stripeacct-quiet">
            {row().deposit === "reversed" ? words.depositReversed : words.depositMatched}
          </span>
        }
      >
        {props.link(props.inboxHref, words.depositInbox)}
      </Show>
    </Show>
  );
}
