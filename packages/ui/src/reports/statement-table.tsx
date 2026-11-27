import { For, type JSX, Show } from "solid-js";
import { EmptyState } from "../kit";
import { useUi } from "../locale";
import { Status } from "../notice";
import { Amount } from "./amount";
import { Share } from "./share";

/** One amount in a row, with where it links to: the account activity behind it. */
export interface Figure {
  /** Always a wire amount ("-12.34"). */
  readonly value: string;
  readonly href?: string | undefined;
  /** What the link says about where it goes, read aloud after the figure. */
  readonly context?: string | undefined;
  /** What the value is: an amount (the default), or a share of income, which is written as a percentage
   * and, when empty, as a dash that says it has none. */
  readonly kind?: "money" | "share" | undefined;
}

/** One row of a statement. A heading opens a group and a subheading names a part of it; an account
 * row is a figure from one account and may link to the activity behind it; a calculated row is a
 * figure the book computes rather than holds (retained earnings carried forward); a subtotal closes
 * a group; a total is the figure the statement exists to state, set under the double rule. */
export interface StatementLine {
  readonly key: string;
  readonly kind: "heading" | "subheading" | "account" | "calculated" | "subtotal" | "total";
  readonly label: string;
  /** The account's code, set small before its name. */
  readonly code?: string | undefined;
  /** One figure per column, in column order; a missing one is an empty cell. A heading has none. */
  readonly figures?: readonly (Figure | undefined)[] | undefined;
  /** A short explanation under the label. */
  readonly note?: string | undefined;
  /** Marks a row that needs a person (an account without a tag), in words, not color alone. */
  readonly flag?: string | undefined;
}

/** A financial statement as a table: account names down the side, amounts right-aligned in tabular
 * figures, groups with their own headings, and the total under a double rule. It scrolls inside its
 * own region on a narrow screen and never carries a figure it was not given. */
export function StatementTable(props: {
  /** The statement and its period, shown above the table. */
  caption: string;
  lines: readonly StatementLine[];
  /** The heading of each figure column, after the account column. */
  columns: readonly string[];
  /** More for a screen reader after a column's heading, where the heading alone is not enough: a share
   * column says which period it is the share for. One entry per column, or none. */
  columnHints?: readonly (string | undefined)[] | undefined;
  /** The heading of the account column. */
  accountHeading?: string | undefined;
  /** The caption names the table for assistive technology; hide it when the page already says it. */
  captionHidden?: boolean | undefined;
  /** Many columns of figures (a column for each month): the account names stay in view while the
   * figures scroll sideways, and the columns are set closer together. */
  wide?: boolean | undefined;
  /** Shown instead of the table when there are no lines. */
  empty?: JSX.Element;
}) {
  const ui = useUi();
  const t = () => ui.messages.reports.table;
  const span = () => props.columns.length + 1;
  /** Lines grouped under their heading; the totals are the footer. */
  const groups = () => {
    const result: { heading?: StatementLine; lines: StatementLine[] }[] = [];
    for (const line of props.lines) {
      if (line.kind === "total") continue;
      if (line.kind === "heading") result.push({ heading: line, lines: [] });
      else {
        let current = result.at(-1);
        if (!current) {
          current = { lines: [] };
          result.push(current);
        }
        current.lines.push(line);
      }
    }
    return result;
  };
  const totals = () => props.lines.filter((line) => line.kind === "total");
  const cells = (line: StatementLine) => (
    <For each={props.columns}>
      {(_, index) => (
        <td class="rt-number">
          <Show when={line.figures?.[index()]}>
            {(figure) => (
              <Show
                when={figure().kind === "share"}
                fallback={
                  <Amount
                    value={figure().value}
                    href={figure().href}
                    {...(figure().context !== undefined
                      ? { context: figure().context as string }
                      : {})}
                  />
                }
              >
                <Share value={figure().value} />
              </Show>
            )}
          </Show>
        </td>
      )}
    </For>
  );
  const label = (line: StatementLine) => (
    <th scope="row">
      <Show when={line.code}>
        <span class="rt-code">{line.code}</span>{" "}
      </Show>
      {line.label}
      <Show when={line.flag}>
        {" "}
        <Status tone="attention">{line.flag}</Status>
      </Show>
      <Show when={line.note}>
        <small>{line.note}</small>
      </Show>
    </th>
  );
  return (
    <Show
      when={props.lines.length > 0}
      fallback={props.empty ?? <EmptyState>{t().nothing}</EmptyState>}
    >
      <section class="rt-table-scroll" tabindex={0} aria-label={t().scroll(props.caption)}>
        <table
          class="rt-table rt-statement"
          data-columns={props.columns.length}
          data-wide={props.wide ? "" : undefined}
          style={props.wide ? { "--rt-columns": String(props.columns.length) } : undefined}
        >
          <caption data-hidden={props.captionHidden ? "" : undefined}>{props.caption}</caption>
          <thead>
            <tr>
              <th scope="col">{props.accountHeading ?? t().account}</th>
              <For each={props.columns}>
                {(heading, index) => (
                  <th scope="col" class="rt-number">
                    {heading}
                    <Show when={props.columnHints?.[index()]}>
                      {(hint) => <span class="rt-sr-only">, {hint()}</span>}
                    </Show>
                  </th>
                )}
              </For>
            </tr>
          </thead>
          <For each={groups()}>
            {(group) => (
              <tbody>
                <Show when={group.heading}>
                  {(heading) => (
                    <tr class="rt-statement-heading">
                      <th scope="rowgroup" colspan={span()}>
                        {heading().label}
                      </th>
                    </tr>
                  )}
                </Show>
                <For each={group.lines}>
                  {(line) => (
                    <Show
                      when={line.kind !== "subheading"}
                      fallback={
                        <tr class="rt-statement-subheading">
                          <th scope="row" colspan={span()}>
                            {line.label}
                          </th>
                        </tr>
                      }
                    >
                      <tr class={`rt-statement-${line.kind}`}>
                        {label(line)}
                        {cells(line)}
                      </tr>
                    </Show>
                  )}
                </For>
              </tbody>
            )}
          </For>
          <Show when={totals().length > 0}>
            <tfoot>
              <For each={totals()}>
                {(line) => (
                  <tr>
                    {label(line)}
                    {cells(line)}
                  </tr>
                )}
              </For>
            </tfoot>
          </Show>
        </table>
      </section>
    </Show>
  );
}
