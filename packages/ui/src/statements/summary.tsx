import { For, Show } from "solid-js";
import type { BalanceCheck, Counts, Totals } from "./types";
import { words } from "./words";
import { formatMoney, isNegativeMoney } from "../format";
import { formatDateRange } from "../format";

const Amount = (props: { value: string }) => (
  <span class="rt-imp-amount" data-negative={isNegativeMoney(props.value) ? "" : undefined}>
    {formatMoney(props.value)}
  </span>
);

/** What the file holds, as a list of facts under Details: the page's one sentence already says how many
 * transactions are new. The figures are plain text in a description list so a screen reader reads each
 * label with its value. */
export function ImportSummary(props: {
  counts: Counts;
  totals: Totals;
  range: { from: string | null; to: string | null };
}) {
  const already = () => props.counts.duplicate + props.counts.overlap;
  return (
    <section class="rt-imp-summary" aria-label={words.linesInFile(props.counts.lines)}>
      <h3>{words.totals}</h3>
      <dl class="rt-imp-facts">
        <div>
          <dt>{words.newLines}</dt>
          <dd>{props.counts.new}</dd>
        </div>
        <div>
          <dt>{words.alreadyImported}</dt>
          <dd>{already()}</dd>
        </div>
        <Show when={props.counts.excluded > 0}>
          <div>
            <dt>{words.keptOut}</dt>
            <dd>{props.counts.excluded}</dd>
          </div>
        </Show>
        <Show when={props.counts.skipped > 0}>
          <div>
            <dt>{words.rowsLeftOut}</dt>
            <dd>{props.counts.skipped}</dd>
          </div>
        </Show>
        <div>
          <dt>{words.moneyIn}</dt>
          <dd>
            <Amount value={props.totals.moneyIn} />
            <small>{words.inCount(props.totals.inCount)}</small>
          </dd>
        </div>
        <div>
          <dt>{words.moneyOut}</dt>
          <dd>
            <Amount value={props.totals.moneyOut} />
            <small>{words.inCount(props.totals.outCount)}</small>
          </dd>
        </div>
        <div>
          <dt>{words.net}</dt>
          <dd>
            <Amount value={props.totals.net} />
          </dd>
        </div>
        <Show when={props.range.from}>
          <div>
            <dt>{words.dateRange}</dt>
            <dd>
              {formatDateRange(props.range.from ?? "", props.range.to ?? props.range.from ?? "")}
            </dd>
          </div>
        </Show>
      </dl>
    </section>
  );
}

/** The statement's own balance set against the books, with the difference shown and never fixed. */
export function ImportBalanceCheck(props: {
  checks: readonly BalanceCheck[];
  /** True for a credit card account, where a negative balance means money is owed. */
  card?: boolean | undefined;
}) {
  return (
    <section class="rt-imp-balance" aria-labelledby="rt-imp-balance-title">
      <h3 id="rt-imp-balance-title">{words.balanceTitle}</h3>
      <Show when={props.checks.length > 0} fallback={<p class="rt-hint">{words.balanceNone}</p>}>
        <For each={props.checks}>
          {(check) => (
            <>
              <dl class="rt-imp-facts">
                <div>
                  <dt>{words.balanceReported(check.asOf)}</dt>
                  <dd>
                    <Amount value={check.reported} />
                  </dd>
                </div>
                <Show
                  when={check.ledger !== null}
                  fallback={
                    <div>
                      <dt>{words.balanceBooks}</dt>
                      <dd>{words.balanceUnmapped}</dd>
                    </div>
                  }
                >
                  <div>
                    <dt>{words.balanceBooks}</dt>
                    <dd>
                      <Amount value={check.ledger as string} />
                    </dd>
                  </div>
                  <div>
                    <dt>{words.balanceWaiting}</dt>
                    <dd>
                      <Amount value={check.waiting ?? "0.00"} />
                    </dd>
                  </div>
                  <Show when={check.excluded !== null && check.excluded !== "0.00"}>
                    <div>
                      <dt>{words.balanceKept}</dt>
                      <dd>
                        <Amount value={check.excluded as string} />
                      </dd>
                    </div>
                  </Show>
                  <div
                    class="rt-imp-difference"
                    data-zero={check.difference === "0.00" ? "" : undefined}
                  >
                    <dt>{words.balanceDifference}</dt>
                    <dd>
                      <Amount value={check.difference ?? "0.00"} />
                    </dd>
                  </div>
                </Show>
              </dl>
              <Show when={check.difference !== null && check.difference !== "0.00"}>
                <p class="rt-hint">{words.balanceDiffers}</p>
              </Show>
            </>
          )}
        </For>
        <Show when={props.card}>
          <p class="rt-hint">{words.balanceCard}</p>
        </Show>
      </Show>
    </section>
  );
}
