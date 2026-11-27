import { For, Show } from "solid-js";
import { Check, TriangleAlert } from "../icons";
import { formatMoney } from "../format";
import { accountLabel, sideAmount } from "./labels";
import type { EntryView } from "./types";
import { words } from "./words";

/** The entry the balances make, line by line, as the ledger will see it: each account as a debit or
 * a credit, the calculated offset marked as such, and the totals under a double rule. It is the
 * thing the person is asked to approve, so it is the largest thing in its section. Everything is
 * an exact string the service (or the application's own exact arithmetic) produced. */
export function EntryReview(props: { entry: EntryView }) {
  return (
    <section class="rt-shadow-entry" aria-label={words.entryCaption(props.entry.date)}>
      <Show
        when={props.entry.lines.length > 0}
        fallback={<p class="rt-hint">{words.entryEmpty}</p>}
      >
        <section
          class="rt-table-scroll"
          tabindex="0"
          aria-label={words.entryCaption(props.entry.date)}
        >
          <table class="rt-table">
            <caption>{words.entryCaption(props.entry.date)}</caption>
            <thead>
              <tr>
                <th scope="col">{words.account}</th>
                <th scope="col" class="amount">
                  {words.debit}
                </th>
                <th scope="col" class="amount">
                  {words.credit}
                </th>
              </tr>
            </thead>
            <tbody>
              <For each={props.entry.lines}>
                {(line) => (
                  <tr data-offset={line.offset ? "" : undefined}>
                    <th scope="row">
                      <bdi>{accountLabel(line)}</bdi>
                      <Show when={line.offset}>
                        <small>{words.offsetLine}</small>
                      </Show>
                    </th>
                    <td class="amount">{sideAmount(line.debit)}</td>
                    <td class="amount">{sideAmount(line.credit)}</td>
                  </tr>
                )}
              </For>
            </tbody>
            <tfoot>
              <tr>
                <th scope="row">{words.total}</th>
                <td class="amount">{formatMoney(props.entry.debit)}</td>
                <td class="amount">{formatMoney(props.entry.credit)}</td>
              </tr>
            </tfoot>
          </table>
        </section>
        <p class="rt-shadow-balanced">
          <Show
            when={props.entry.balanced}
            fallback={
              <>
                <TriangleAlert aria-hidden="true" /> {words.entryUnbalanced}
              </>
            }
          >
            <Check aria-hidden="true" /> {words.entryBalanced}
          </Show>
        </p>
      </Show>
    </section>
  );
}
