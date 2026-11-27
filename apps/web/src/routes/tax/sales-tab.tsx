import type { ApplicationInputs } from "@rastrata/application/client-contracts";
import { Button, TaxSalesView, taxWords, type TaxSalesPeriodKind } from "@rastrata/ui";
import { type Accessor, createMemo, createSignal, Show } from "solid-js";
import type { BrowserApplicationClient } from "../../application-client";
import { createKeyedLoader } from "../../loader";
import { activityHref } from "./controller";
import { saveCsv } from "./download";
import { failureText, TaxFailure } from "./failure";

type SalesKey = ApplicationInputs["taxSales.get"];

/** The sales tax account: what your books recorded as collected and as paid or returned, by month, quarter
 * or the whole range, beside what Stripe reported on the payouts booked in the same period. Rastrata does not
 * know your rates or filing dates and says so; it never says what is owed. */
export function SalesTab(props: {
  client: BrowserApplicationClient;
  year: Accessor<number | undefined>;
  period: Accessor<TaxSalesPeriodKind>;
  onPeriod: (period: TaxSalesPeriodKind) => void;
}) {
  const key = createMemo<SalesKey | undefined>(
    () => {
      const taxYear = props.year();
      return taxYear === undefined ? undefined : { taxYear, period: props.period() };
    },
    undefined,
    { equals: (left, right) => JSON.stringify(left) === JSON.stringify(right) },
  );
  const sales = createKeyedLoader(key, (input) => props.client.read("taxSales.get", input));
  const [exporting, setExporting] = createSignal<string | null>(null);
  const [message, setMessage] = createSignal("");

  async function download(file: "summary" | "postings") {
    const input = key();
    if (!input) return;
    setExporting(file);
    setMessage("");
    try {
      const done = await props.client.read("taxSales.export", { ...input, file });
      setMessage(taxWords.exported(saveCsv(done.filename, done.mediaType, done.content)));
    } catch (cause) {
      setMessage(failureText(cause, taxWords.exportFailed));
    } finally {
      setExporting(null);
    }
  }

  return (
    <section class="rt-tax-section" aria-labelledby="tax-sales-title">
      <h2 id="tax-sales-title" class="rt-sr-only">
        {taxWords.salesTitle}
      </h2>
      <Show
        when={sales.error() === undefined}
        fallback={<TaxFailure error={sales.error()} retry={() => void sales.reload()} />}
      >
        <Show
          when={sales.value()}
          fallback={
            <p class="rt-hint" role="status">
              {taxWords.loading}
            </p>
          }
        >
          {(data) => (
            <TaxSalesView
              data={data()}
              period={props.period()}
              busy={sales.loading()}
              onPeriod={props.onPeriod}
              accountsHref="/accounts"
              activityHref={(accountId, from, to) =>
                activityHref({
                  accountId,
                  asOf: data().to,
                  reportFrom: data().from,
                  population: data().ledgerPopulationHash,
                  from,
                  to,
                })
              }
              exportControls={
                <Show when={data().accounts.length > 0}>
                  <Button
                    variant="secondary"
                    label={taxWords.exportSales}
                    pending={exporting() === "summary"}
                    pendingLabel={taxWords.exporting}
                    onClick={() => void download("summary")}
                  />
                  <Button
                    variant="secondary"
                    label={taxWords.exportSalesPostings}
                    pending={exporting() === "postings"}
                    pendingLabel={taxWords.exporting}
                    onClick={() => void download("postings")}
                  />
                </Show>
              }
            />
          )}
        </Show>
      </Show>
      <p class="rt-hint" role="status" aria-live="polite">
        {message()}
      </p>
    </section>
  );
}
