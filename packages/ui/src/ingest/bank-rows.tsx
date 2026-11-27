import { For, type JSX, Show } from "solid-js";
import { Button, buttonAttrs } from "../button";
import { formatCount, formatDate } from "../format";
import { Money } from "../money";
import { Notice } from "../notice";
import { PageSkeleton } from "../skeleton";
import type { BankTileData, BankTileLinks } from "./bank-tile-types";
import { tileWords as words } from "./tile-words";

export interface BankRowsProps {
  tiles: readonly BankTileData[];
  /** The rows are being read, were read, or could not be. Never shows a figure it has not read. */
  state?: "ready" | "loading" | "error";
  links: BankTileLinks;
  /** Start reconciling an account: the one thing to do on a bank or card account's row. */
  onReconcile: (tile: BankTileData) => void;
  onRetry?: () => void;
  /** The last read failed after an earlier one worked: the figures stay, and say they may be old. */
  stale?: boolean;
  /** The accessible name of the list. */
  label?: string;
}

/** The id of a row's Reconcile button, so a host can return focus to it when its form closes. */
export const bankReconcileId = (accountId: string): string => `rt-bank-reconcile-${accountId}`;

/** The bank, card and Stripe accounts as rows of the Accounts page: the account's name (the link to it),
 * what the bank says and how many transactions wait, the balance in the books, and the one thing to do
 * (Reconcile; for Stripe that is not connected or not set up yet, the way in). An account with nothing
 * to reconcile yet has no button. Every state of the read is said in words; with no account there is
 * no list (the page that holds it leaves it out). */
export function BankRows(props: BankRowsProps): JSX.Element {
  const state = () => props.state ?? "ready";
  return (
    <section
      class="rt-bank-rows"
      aria-label={props.label ?? words.sectionLabel}
      aria-busy={state() === "loading" ? true : undefined}
    >
      <Show
        when={state() === "ready"}
        fallback={
          <Show
            when={state() === "error"}
            fallback={<PageSkeleton shape="table" label={words.loading} />}
          >
            <Notice title={words.failedTitle} tone="error" role="alert">
              <p>{words.failedBody}</p>
              <Show when={props.onRetry}>
                <Button
                  variant="secondary"
                  size="sm"
                  label={words.retry}
                  onClick={() => props.onRetry?.()}
                />
              </Show>
            </Notice>
          </Show>
        }
      >
        <ul class="rt-bank-row-list">
          <For each={props.tiles}>
            {(tile) => <BankRow tile={tile} links={props.links} onReconcile={props.onReconcile} />}
          </For>
        </ul>
        <Show when={props.stale}>
          <p class="rt-bank-tiles-stale" role="status">
            {words.stale}
            <Show when={props.onRetry}>
              {" "}
              <button type="button" class="rt-bank-tiles-retry" onClick={() => props.onRetry?.()}>
                {words.retry}
              </button>
            </Show>
          </p>
        </Show>
      </Show>
    </section>
  );
}

function BankRow(props: {
  tile: BankTileData;
  links: BankTileLinks;
  onReconcile: (tile: BankTileData) => void;
}): JSX.Element {
  const tile = () => props.tile;
  const stripe = () => tile().kind === "stripe";
  const idle = () => tile().connection?.state === "not_connected";
  const setup = () => tile().connection?.state === "setup";
  const problem = () => tile().connection?.state === "attention";
  /** What the bank (or Stripe) last said, when it is not what the books hold. */
  const reported = () => {
    const said = tile().statementBalance;
    return said !== undefined && said !== tile().bookBalance ? said : undefined;
  };
  /** There is something to reconcile once a posting has reached the account or it has been reconciled
   * before. Until then the Reconcile form would only say that nothing has reached the account yet. */
  const reconcilable = () =>
    !stripe() &&
    (tile().lastReconciled !== undefined ||
      (tile().bookBalance !== null && tile().bookBalance !== "0.00"));
  return (
    <li class="rt-bank-row" data-kind={tile().kind} data-idle={idle() ? "" : undefined}>
      <span class="rt-bank-row-name">
        <Show when={!idle() && !setup()} fallback={<bdi>{tile().name}</bdi>}>
          <a href={props.links.open(tile())}>
            <bdi>{tile().name}</bdi>
          </a>
        </Show>
      </span>
      <span class="rt-bank-row-line" data-problem={problem() ? "" : undefined}>
        <Show when={idle()}>{words.notConnected}</Show>
        <Show when={problem()}>{words.connectionAttention}</Show>
        <Show when={!idle() && !problem()}>
          <Show when={reported()}>
            {(said) => (
              <span class="rt-bank-row-said">
                {stripe() ? words.stripeSays : words.bankSays} <Money value={said()} />
                <Show when={tile().statementAsOf}>
                  {(when) => (
                    <>
                      {" "}
                      {words.asOf} {formatDate(when())}
                    </>
                  )}
                </Show>
              </span>
            )}
          </Show>
          <Show when={reported() !== undefined && tile().toReview > 0}>
            <span aria-hidden="true"> · </span>
            <span class="rt-sr-only">, </span>
          </Show>
          <Show when={tile().toReview > 0}>
            <span class="rt-bank-row-waiting">{words.toReview(formatCount(tile().toReview))}</span>
          </Show>
        </Show>
      </span>
      <span class="rt-bank-row-balance">
        <Show when={!idle() && tile().bookBalance !== null}>
          <Money value={tile().bookBalance as string} />
        </Show>
      </span>
      <span class="rt-bank-row-action">
        <Show when={reconcilable()}>
          <button
            {...buttonAttrs({ variant: "secondary", size: "sm" })}
            type="button"
            id={bankReconcileId(tile().accountId)}
            aria-label={words.reconcileLabel(tile().name)}
            onClick={() => props.onReconcile(tile())}
          >
            {words.reconcile}
          </button>
        </Show>
        <Show when={idle() || setup()}>
          <a
            {...buttonAttrs({ variant: "secondary", size: "sm" })}
            href={props.links.connect(tile())}
          >
            {idle() ? words.connectStripe : words.finishStripeSetup}
          </a>
        </Show>
      </span>
    </li>
  );
}
