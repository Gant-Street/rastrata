import { createMemo, For, Show, type JSX } from "solid-js";
import { isBalanceSheet, ROLE_ORDER, taxLineOptions } from "./chart-logic";
import type { ChartAccount, TaxFormChoice } from "./chart-types";
import { type ChartMessageOverrides, mergeChartMessages } from "./messages";

export interface ChartPreviewProps {
  accounts: readonly ChartAccount[];
  taxForms: readonly TaxFormChoice[];
  messages?: ChartMessageOverrides;
}

/**
 * The chart as a person reads it before their books are made: each account's code and name, in the
 * order a chart is read, and the line of the tax form an income or expense account reports on. Nothing
 * here is edited and nothing internal is shown: an account is renamed, removed or added on the Chart
 * of accounts once the books exist, where the change is dated and kept.
 */
export function ChartPreview(props: ChartPreviewProps): JSX.Element {
  const m = createMemo(() => mergeChartMessages(props.messages).editor);
  return (
    <div class="rt-chart-preview">
      <For each={ROLE_ORDER}>
        {(role) => {
          const rows = () => props.accounts.filter((account) => account.role === role);
          const options = createMemo(() => taxLineOptions(props.taxForms, role));
          const lineOf = (account: ChartAccount): string =>
            isBalanceSheet(role)
              ? ""
              : (options().find((option) => option.value === account.tags.taxLine)?.label ?? "");
          return (
            <Show when={rows().length > 0}>
              <section class="rt-chart-preview-group" aria-labelledby={`chart-preview-${role}`}>
                <h4 id={`chart-preview-${role}`} class="rt-chart-preview-heading">
                  {m().groups[role] ?? role} <span class="rt-chart-count">({rows().length})</span>
                </h4>
                <ul class="rt-chart-preview-list">
                  <For each={rows()}>
                    {(account) => (
                      <li
                        class="rt-chart-preview-row"
                        data-line={lineOf(account) === "" ? undefined : ""}
                      >
                        <span class="rt-chart-code">{account.code}</span>
                        <span class="rt-chart-preview-name">{account.name}</span>
                        <Show when={lineOf(account) !== ""}>
                          <span class="rt-chart-preview-line">{lineOf(account)}</span>
                        </Show>
                      </li>
                    )}
                  </For>
                </ul>
              </section>
            </Show>
          );
        }}
      </For>
    </div>
  );
}
