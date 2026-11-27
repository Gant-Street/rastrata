import { For, type JSX, Show } from "solid-js";
import { PageSkeleton } from "../skeleton";
import { Dynamic } from "solid-js/web";
import { Button, buttonAttrs } from "../button";
import { formatCount } from "../format";
import { Money } from "../money";
import { Notice } from "../notice";
import type { BankTileData, BankTileLinks } from "./bank-tile-types";
import { tileWords as words } from "./tile-words";

export type { BankTileData, BankTileLinks };

export interface BankTileBandProps {
  tiles: readonly BankTileData[];
  /** The band is being read, was read, or could not be. Never shows a figure it has not read. */
  state?: "ready" | "loading" | "error";
  links: BankTileLinks;
  onRetry?: () => void;
  /** The last read failed after an earlier one worked: the figures stay, and say they may be old. */
  stale?: boolean;
  /** The level of each account's name, under the page's own headings. */
  headingLevel?: 2 | 3 | 4;
  /** The accessible name of the band. */
  label?: string;
}

/** The band of bank, card and Stripe accounts: one cell for each, divided by rules (a band, not boxes).
 * A cell is the account's name, its balance in the books and one line: what the bank says when that
 * differs, and how many transactions wait. The cell is the link to the account and carries no button;
 * what to do about an account is said once, in "Needs you". Every state of the read is said in words;
 * a band with no account in it draws nothing (the page that holds it leaves it out). */
export function BankTileBand(props: BankTileBandProps): JSX.Element {
  const state = () => props.state ?? "ready";
  return (
    <section
      class="rt-bank-tiles"
      aria-label={props.label ?? words.sectionLabel}
      aria-busy={state() === "loading" ? true : undefined}
    >
      <Show
        when={state() === "ready"}
        fallback={
          <Show
            when={state() === "error"}
            fallback={<PageSkeleton shape="tiles" label={words.loading} />}
          >
            <div class="rt-bank-tiles-state">
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
            </div>
          </Show>
        }
      >
        <ul
          class="rt-bank-tile-list"
          style={{
            "--rt-bank-wide": Math.min(4, props.tiles.length),
            "--rt-bank-mid": Math.min(2, props.tiles.length),
          }}
        >
          <For each={props.tiles}>
            {(tile) => (
              <li class="rt-bank-tile-item">
                <BankTile tile={tile} links={props.links} level={props.headingLevel ?? 3} />
              </li>
            )}
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

function BankTile(props: {
  tile: BankTileData;
  links: BankTileLinks;
  level: 2 | 3 | 4;
}): JSX.Element {
  const tile = () => props.tile;
  /** Stripe, with nothing connected yet: the tile says so and its one link is the way in. */
  const idle = () => tile().connection?.state === "not_connected";
  /** Stripe has a working key and its accounts are not chosen yet: the next step, and the tile's link. */
  const setup = () => tile().connection?.state === "setup";
  const problem = () => tile().connection?.state === "attention";
  /** What the bank (or Stripe) last said, when it is not what the books hold. The same figure twice
   * would say nothing. */
  const reported = () => {
    const said = tile().statementBalance;
    return said !== undefined && said !== tile().bookBalance ? said : undefined;
  };
  return (
    <article
      class="rt-bank-tile"
      data-kind={tile().kind}
      data-attention={tile().toReview > 0 || problem() ? "" : undefined}
      data-idle={idle() ? "" : undefined}
    >
      <Dynamic component={`h${props.level}`} class="rt-bank-tile-name">
        <Show when={!idle() && !setup()} fallback={<bdi>{tile().name}</bdi>}>
          <a class="rt-bank-tile-open" href={props.links.open(tile())}>
            <bdi>{tile().name}</bdi>
          </a>
        </Show>
      </Dynamic>

      <Show
        when={!idle()}
        fallback={
          <p class="rt-bank-tile-balance" data-quiet="">
            {words.notConnected}
          </p>
        }
      >
        <Show when={tile().bookBalance !== null}>
          <p class="rt-bank-tile-balance">
            <Money value={tile().bookBalance as string} />
          </p>
        </Show>
      </Show>

      <Show when={idle() || setup()}>
        <p class="rt-bank-tile-line">
          <a
            {...buttonAttrs({ variant: "secondary", size: "sm" })}
            href={props.links.connect(tile())}
          >
            {idle() ? words.connectStripe : words.finishStripeSetup}
          </a>
        </p>
      </Show>
      <Show when={problem()}>
        <p class="rt-bank-tile-line" data-problem="">
          {words.connectionAttention}
        </p>
      </Show>
      <Show when={!idle() && !setup() && (reported() !== undefined || tile().toReview > 0)}>
        <p class="rt-bank-tile-line">
          <Show when={reported()}>
            {(said) => (
              <span class="rt-bank-tile-said">
                {tile().kind === "stripe" ? words.stripeSays : words.bankSays}{" "}
                <Money value={said()} />
              </span>
            )}
          </Show>
          <Show when={reported() !== undefined && tile().toReview > 0}>
            <span aria-hidden="true"> · </span>
            <span class="rt-sr-only">, </span>
          </Show>
          <Show when={tile().toReview > 0}>
            <span class="rt-bank-tile-waiting">{words.toReview(formatCount(tile().toReview))}</span>
          </Show>
        </p>
      </Show>
    </article>
  );
}
