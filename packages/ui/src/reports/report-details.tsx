import { For, Show } from "solid-js";
import { formatDateRange } from "../format";
import { Details, DetailsList } from "../kit";
import { useUi } from "../locale";

/** The proof a report carries, one click away: the book revision it was read at, the fingerprint of
 * exactly what it was built from (the population hash, which the CSV file carries too), the basis, the
 * currency and the fiscal year. The surface of a report is for reading figures; these are for the
 * person who needs to show that the same figures can be made again, so they sit at the foot, in a fold
 * that says only its name until it is opened. Inside, the fingerprint has a button that copies all of it.
 *
 * It prints as one plain line instead (the disclosure does not print), so a page torn from a binder
 * still says what it was built from. */
export function ReportDetails(props: {
  revision: string;
  populationHash: string;
  basis: "cash" | "accrual";
  currency: string;
  fiscalYear?: { readonly year: number; readonly startsOn: string; readonly endsOn: string };
  /** Each column's own fingerprint, when a report was read in several parts (by month). */
  columns?: readonly { readonly label: string; readonly hash: string }[] | undefined;
  /** Other facts the report was built from, after the revision ("Payees revision", 12). */
  extra?: readonly { readonly label: string; readonly value: string }[] | undefined;
  /** Start with the details open (stories and tests). */
  defaultOpen?: boolean | undefined;
}) {
  const ui = useUi();
  const t = () => ui.messages.reports.details;
  const items = () => [
    { label: t().revision, value: props.revision },
    ...(props.extra ?? []),
    {
      label: t().fingerprint,
      value: props.populationHash,
      mono: true,
      copy: true,
      copyLabel: t().fingerprintName,
    },
    { label: t().basis, value: props.basis === "cash" ? t().basisCash : t().basisAccrual },
    { label: t().currency, value: props.currency },
    ...(props.fiscalYear
      ? [
          {
            label: t().fiscalYear,
            value: `${props.fiscalYear.year}, ${formatDateRange(props.fiscalYear.startsOn, props.fiscalYear.endsOn)}`,
          },
        ]
      : []),
  ];
  return (
    <div class="rt-report-foot">
      <Details summary={t().summary} defaultOpen={props.defaultOpen ?? false}>
        <DetailsList items={items()} />
        <p class="rt-hint">{t().fingerprintHelp}</p>
        <Show when={props.columns && props.columns.length > 0}>
          <div class="rt-report-columns">
            <Details summary={t().columnsSummary}>
              <p class="rt-hint">{t().columnsHelp}</p>
              <section class="rt-table-scroll" tabindex={0} aria-label={t().columnsSummary}>
                <table class="rt-table">
                  <thead>
                    <tr>
                      <th scope="col">{t().columnLabel}</th>
                      <th scope="col">{t().fingerprint}</th>
                    </tr>
                  </thead>
                  <tbody>
                    <For each={props.columns}>
                      {(column) => (
                        <tr>
                          <th scope="row">{column.label}</th>
                          <td>
                            <code class="rt-hash">{column.hash}</code>
                          </td>
                        </tr>
                      )}
                    </For>
                  </tbody>
                </table>
              </section>
            </Details>
          </div>
        </Show>
      </Details>
      <p class="rt-report-proof">{t().printLine(props.revision, props.populationHash)}</p>
    </div>
  );
}
