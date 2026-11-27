import type { ApplicationInputs } from "@rastrata/application/client-contracts";
import {
  Button,
  SAID_BY_THE_CHECKS,
  TaxWorksheetView,
  taxWords,
  type TaxFormId,
  PageSkeleton,
} from "@rastrata/ui";
import { type Accessor, createMemo, createSignal, Show } from "solid-js";
import type { BrowserApplicationClient } from "../../application-client";
import { createKeyedLoader } from "../../loader";
import { activityHref, type MealsPercent } from "./controller";
import { saveCsv } from "./download";
import { failureText, TaxFailure } from "./failure";

type WorksheetKey = ApplicationInputs["taxWorksheet.get"];

const sameKey = (left: WorksheetKey | undefined, right: WorksheetKey | undefined) =>
  JSON.stringify(left) === JSON.stringify(right);

/** The worksheet for the year: your books totalled by the tax line each account is tagged with. The form and
 * the meals percentage are chosen here and kept in the address; the figures stay where they are while they are
 * read again. Nothing on it decides what is deductible or what is owed. */
export function WorksheetTab(props: {
  client: BrowserApplicationClient;
  year: Accessor<number | undefined>;
  form: Accessor<TaxFormId | null>;
  meals: Accessor<MealsPercent>;
}) {
  const key = createMemo<WorksheetKey | undefined>(
    () => {
      const taxYear = props.year();
      if (taxYear === undefined) return undefined;
      const form = props.form();
      return {
        taxYear,
        ...(form ? { form } : {}),
        // The percentage belongs to Schedule C's line 24b; the other forms do not use it.
        ...(form === null || form === "scheduleC" ? { mealsPercent: props.meals() } : {}),
      };
    },
    undefined,
    { equals: sameKey },
  );
  const worksheet = createKeyedLoader(key, (input) => props.client.read("taxWorksheet.get", input));
  const [exporting, setExporting] = createSignal<string | null>(null);
  const [message, setMessage] = createSignal("");

  async function download(file: "worksheet" | "accounts" | "postings") {
    const input = key();
    if (!input) return;
    setExporting(file);
    setMessage("");
    try {
      const done = await props.client.read("taxWorksheet.export", { ...input, file });
      setMessage(taxWords.exported(saveCsv(done.filename, done.mediaType, done.content)));
    } catch (cause) {
      setMessage(failureText(cause, taxWords.exportFailed));
    } finally {
      setExporting(null);
    }
  }

  return (
    <section class="rt-tax-section" aria-labelledby="tax-worksheet-title">
      <h2 id="tax-worksheet-title" class="rt-sr-only">
        {taxWords.pageWorksheet}
      </h2>
      <Show
        when={worksheet.error() === undefined}
        fallback={<TaxFailure error={worksheet.error()} retry={() => void worksheet.reload()} />}
      >
        <Show
          when={worksheet.value()}
          fallback={<PageSkeleton shape="table" label={taxWords.loading} />}
        >
          {(data) => (
            <TaxWorksheetView
              worksheet={data()}
              busy={worksheet.loading()}
              omitWarnings={SAID_BY_THE_CHECKS}
              fixHref="/accounts"
              activityHref={(account) =>
                activityHref({
                  accountId: account.accountId,
                  asOf: data().to,
                  reportFrom: data().from,
                  population: data().ledgerPopulationHash,
                  from: account.from,
                  to: account.to,
                })
              }
              unmappedActivityHref={(account) =>
                activityHref({
                  accountId: account.accountId,
                  asOf: data().to,
                  reportFrom: data().from,
                  population: data().ledgerPopulationHash,
                  from: account.from,
                  to: account.to,
                })
              }
              exportControls={
                <>
                  <Button
                    variant="secondary"
                    label={taxWords.exportWorksheet}
                    pending={exporting() === "worksheet"}
                    pendingLabel={taxWords.exporting}
                    onClick={() => void download("worksheet")}
                  />
                  <Button
                    variant="secondary"
                    label={taxWords.exportAccounts}
                    pending={exporting() === "accounts"}
                    pendingLabel={taxWords.exporting}
                    onClick={() => void download("accounts")}
                  />
                  <Button
                    variant="secondary"
                    label={taxWords.exportPostings}
                    pending={exporting() === "postings"}
                    pendingLabel={taxWords.exporting}
                    onClick={() => void download("postings")}
                  />
                </>
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
