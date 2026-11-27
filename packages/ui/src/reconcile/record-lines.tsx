import { createUniqueId, For, Show } from "solid-js";
import type { ReconcileLine } from "./types";
import { words } from "./words";
import { formatMoney, formatMoneyAbsolute } from "../format";
import { DateValue } from "../date-value";

/** The lines of a completed or voided reconciliation: the same two columns, read-only. Nothing
 * here can be ticked; the record is frozen. */
export function ReconcileRecordLines(props: {
  title: string;
  noun: string;
  lines: readonly ReconcileLine[];
  /** The exact total of these lines, supplied by the parent. */
  total: string;
}) {
  const headingId = `${createUniqueId()}-heading`;
  return (
    <section class="rt-recon-column" aria-labelledby={headingId}>
      <header class="rt-recon-column-head">
        <h2 id={headingId}>{props.title}</h2>
        <span class="rt-recon-column-count">
          {words.recordCount(props.lines.length)}
          <Show when={props.lines.length > 0}>
            {" · "}
            <span class="rt-recon-amount">{formatMoney(props.total)}</span>
          </Show>
        </span>
      </header>
      <Show
        when={props.lines.length > 0}
        fallback={<p class="rt-recon-state">{words.recordNone(props.noun)}</p>}
      >
        <div class="rt-table-scroll rt-recon-scroll">
          <table class="rt-table rt-recon-table">
            <caption class="rt-sr-only">
              {words.tableCaption(props.title, props.lines.length)}
            </caption>
            <thead>
              <tr>
                <th scope="col">{words.date}</th>
                <th scope="col">{words.description}</th>
                <th scope="col" class="amount">
                  {words.amount}
                </th>
              </tr>
            </thead>
            <tbody>
              <For each={props.lines}>
                {(line) => (
                  <tr>
                    <td class="rt-recon-date">
                      <DateValue value={line.date} />
                    </td>
                    <td class="rt-recon-description">
                      <bdi>{line.description}</bdi>
                      <Show when={line.href}>
                        {(href) => (
                          <a class="rt-recon-entry-link" href={href()}>
                            {words.viewEntry}
                            <span class="rt-sr-only"> {line.description}</span>
                          </a>
                        )}
                      </Show>
                    </td>
                    <td class="amount rt-recon-amount">{formatMoneyAbsolute(line.amount)}</td>
                  </tr>
                )}
              </For>
            </tbody>
          </table>
        </div>
      </Show>
    </section>
  );
}
