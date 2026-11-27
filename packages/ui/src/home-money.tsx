import { createMemo, createSignal, createUniqueId, For, type JSX, Show } from "solid-js";
import { PageSkeleton } from "./skeleton";
import { Button } from "./button";
import { EmptyState } from "./kit/empty-state";
import { formatCount } from "./format";
import { barHeight, niceTop, tallest } from "./home-scale";
import type { MoneyMonthView } from "./home-types";
import { homeWords } from "./home-words";
import { Money } from "./money";
import { Notice } from "./notice";

const words = homeWords.money;

/** "Money in and out": the last six months as two thin bars a month, solid for what came in and hatched
 * for what went out (so no meaning rests on colour). Under it is one line: the profit of the year so
 * far, or the figures of the month a person points at or taps. The same figures are a table for a
 * screen reader, which is the text alternative for the drawing. For an accrual book it says income and
 * expenses, because those are not money. Nothing is drawn for a month the books had not begun, or one
 * that could not be read, and a drawing of nothing is replaced by one sentence. */
export function MoneyInOut(props: {
  months: readonly MoneyMonthView[];
  /** Profit so far this fiscal year, or null when it could not be read. */
  profit: string | null;
  /** A cash book: the figures are money in and out. Otherwise they are income and expenses. */
  cash: boolean;
  currency: string;
  state: "loading" | "ready" | "error";
  /** Something is recorded in these months. */
  any: boolean;
  onRetry?: () => void;
  headingLevel?: 2 | 3;
}): JSX.Element {
  const headingId = createUniqueId();
  const [seen, setSeen] = createSignal<string | null>(null);
  const top = createMemo(() => niceTop(tallest(props.months)));
  // The line under the chart is the year's profit; while a month's bars are pointed at (or after they
  // are tapped) it is that month's figures instead, in the same place, so nothing on the page moves.
  const focus = createMemo(() => {
    const month = props.months.find((item) => item.month === seen());
    return month && month.income !== null && month.expenses !== null
      ? { label: month.name, income: month.income, expenses: month.expenses }
      : null;
  });
  return (
    <section class="rt-inout" aria-labelledby={headingId} aria-busy={props.state === "loading"}>
      <div class="rt-inout-head">
        <Show
          when={props.headingLevel === 3}
          fallback={
            <h2 id={headingId} class="rt-home-heading">
              {words.heading(props.cash)}
            </h2>
          }
        >
          <h3 id={headingId} class="rt-home-heading">
            {words.heading(props.cash)}
          </h3>
        </Show>
      </div>

      <Show when={props.state === "loading"}>
        <PageSkeleton shape="chart" label={words.loading} />
      </Show>

      <Show when={props.state === "error"}>
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

      <Show when={props.state === "ready"}>
        <Show when={props.any} fallback={<EmptyState live>{words.nothing}</EmptyState>}>
          <ul class="rt-inout-legend" aria-hidden="true">
            <li>
              <span class="rt-inout-swatch" data-series="in" />
              {words.in(props.cash)}
            </li>
            <li>
              <span class="rt-inout-swatch" data-series="out" />
              {words.out(props.cash)}
            </li>
          </ul>

          <figure
            class="rt-inout-chart"
            role="img"
            aria-label={words.chartLabel(props.cash, props.months.length)}
            // A mouse that leaves the drawing leaves the month; a finger that lifts has not looked away.
            onPointerLeave={(event) => {
              if (event.pointerType === "mouse") setSeen(null);
            }}
          >
            <div class="rt-inout-plot">
              <div class="rt-inout-grid">
                <div class="rt-inout-line" style={{ bottom: "100%" }}>
                  <span class="rt-inout-tick">{formatCount(Number(top() / 100n))}</span>
                </div>
                <div class="rt-inout-line" style={{ bottom: "50%" }}>
                  <span class="rt-inout-tick">
                    {top() % 200n === 0n ? formatCount(Number(top() / 200n)) : ""}
                  </span>
                </div>
                <div class="rt-inout-line" data-axis="" style={{ bottom: "0%" }}>
                  <span class="rt-inout-tick">0</span>
                </div>
              </div>
              <div class="rt-inout-cols">
                <For each={props.months}>
                  {(month) => (
                    <div
                      class="rt-inout-col"
                      data-seen={seen() === month.month ? "" : undefined}
                      onPointerEnter={(event) => {
                        if (event.pointerType === "mouse") setSeen(month.month);
                      }}
                      // A tap shows the month, and a second tap on it puts the year back. (A finger that scrolls
                      // the page ends in a cancel, not here.)
                      onPointerUp={(event) => {
                        if (event.pointerType !== "mouse")
                          setSeen(seen() === month.month ? null : month.month);
                      }}
                    >
                      <div class="rt-inout-bars">
                        <span
                          class="rt-inout-bar"
                          data-series="in"
                          style={{ height: `${barHeight(month.income, top())}%` }}
                        />
                        <span
                          class="rt-inout-bar"
                          data-series="out"
                          style={{ height: `${barHeight(month.expenses, top())}%` }}
                        />
                      </div>
                      <span class="rt-inout-month">{month.short}</span>
                    </div>
                  )}
                </For>
              </div>
            </div>
          </figure>

          <table class="rt-sr-only">
            <caption class="rt-sr-only">
              {words.tableCaption(props.cash)} ({props.currency})
            </caption>
            <thead>
              <tr>
                <th scope="col">{words.month}</th>
                <th scope="col" class="rt-number">
                  {words.in(props.cash)}
                </th>
                <th scope="col" class="rt-number">
                  {words.out(props.cash)}
                </th>
              </tr>
            </thead>
            <tbody>
              <For each={props.months}>
                {(month) => (
                  <tr>
                    <th scope="row">{month.name}</th>
                    <Show
                      when={month.income !== null && month.expenses !== null}
                      fallback={
                        <td colSpan={2} class="rt-inout-note">
                          {month.note}
                        </td>
                      }
                    >
                      <td class="rt-number">
                        <Money value={month.income as string} />
                      </td>
                      <td class="rt-number">
                        <Money value={month.expenses as string} />
                      </td>
                    </Show>
                  </tr>
                )}
              </For>
            </tbody>
          </table>

          <Show when={focus() !== null || props.profit !== null}>
            <dl class="rt-inout-facts">
              <Show
                when={focus()}
                fallback={
                  <div>
                    <dt>{words.yearSoFar}</dt>
                    <dd>
                      <span>
                        {words.profit} <Money value={props.profit as string} />
                      </span>
                    </dd>
                  </div>
                }
              >
                {(month) => (
                  <div>
                    <dt>{month().label}</dt>
                    <dd>
                      <span>
                        {words.inShort(props.cash)} <Money value={month().income} />
                      </span>
                      <span>
                        {words.outShort(props.cash)} <Money value={month().expenses} />
                      </span>
                    </dd>
                  </div>
                )}
              </Show>
            </dl>
          </Show>
        </Show>
      </Show>
    </section>
  );
}
