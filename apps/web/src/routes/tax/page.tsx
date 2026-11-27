import {
  PageHeader,
  TaxChecks,
  TaxYearBar,
  taxWords,
  type TaxFormId,
  type TaxSalesPeriodKind,
} from "@rastrata/ui";
import { createEffect, createMemo, createSignal, Show } from "solid-js";
import { BrowserApplicationClient } from "../../application-client";
import { createKeyedLoader } from "../../loader";
import { AccountantTab } from "./accountant-tab";
import {
  defaultTaxState,
  type MealsPercent,
  parseTaxState,
  serializeTaxState,
  type TaxScreenState,
  type TaxTab,
} from "./controller";
import { describeFailure, TaxFailure } from "./failure";
import { TaxFormChoices } from "./form-choices";
import { PackTab } from "./pack-tab";
import { SalesTab } from "./sales-tab";
import { VendorsTab } from "./vendors-tab";
import { WorksheetTab } from "./worksheet-tab";
import { keepChoices, TAX_CHOICES } from "../reports/last-choices";

/** Each tool is a page of its own, opened from the list of reports and named as the list names it. */
const PAGE_TITLE: Record<TaxTab, string> = {
  worksheet: taxWords.pageWorksheet,
  pack: taxWords.pagePack,
  vendors: taxWords.pageVendors,
  sales: taxWords.pageSales,
  accountant: taxWords.pageAccountant,
};

/** The Tax screen: the year, what to look at first, and the tools for getting the books ready for a return:
 * the worksheet, the year-end pack, the 1099 vendor list, the sales tax summary and the accountant's pack.
 * Rastrata books and reports. It gives no tax advice and files nothing; each tool says what it is in one
 * sentence, and the how-tos (Help) hold the rest. Everything is read with plain signals, so a read never takes the page or the focus away; the year, the tab
 * and the options live in the address. */
export function TaxPage() {
  const client = new BrowserApplicationClient(window.localStorage);
  const [state, setState] = createSignal<TaxScreenState>(
    typeof window === "undefined" ? defaultTaxState() : parseTaxState(window.location.search),
  );
  const update = (patch: Partial<TaxScreenState>) =>
    setState((current) => ({ ...current, ...patch }));

  // The address follows the screen, so a reload, a link and the back button agree with it.
  createEffect(() => {
    const query = serializeTaxState(state());
    // The year and the form are carried to the next tax tool opened from the list of reports.
    keepChoices(TAX_CHOICES, query, ["tab"]);
    const next = `${window.location.pathname}${query ? `?${query}` : ""}`;
    if (next !== `${window.location.pathname}${window.location.search}`)
      window.history.replaceState(window.history.state, "", next);
  });

  // The first read: the years that were verified, the year to show (the service chooses when the address
  // names none) and what to look at first.
  const summary = createKeyedLoader(
    createMemo(() => ({ year: state().year }), undefined, {
      equals: (left, right) => left.year === right.year,
    }),
    (input) => client.read("taxSummary.get", input.year === null ? {} : { taxYear: input.year }),
  );
  // The year the tools read: the one chosen, else the one the service chose.
  const year = () => state().year ?? summary.value()?.taxYear;
  const years = () => summary.value()?.years ?? [];
  const revision = () => summary.value()?.bookRevision;
  // A tab that saves something that changes the checks asks for them again.
  const readChecksAgain = () => void summary.reload();
  // A year the book's calendar does not cover is a state of the books, said plainly. It is not shown as a
  // failed read of the last year: the last year's checks and tabs are not left on screen under it.
  const uncovered = () =>
    summary.error() !== undefined && describeFailure(summary.error()).state === "calendar";
  const chooseAgain = () => update({ year: null });

  // Only the tab on screen has content, so the others are neither read nor laid out.
  // A memo: the tool is drawn again only when it is another tool, never when the year or a choice changes.
  const tool = createMemo(() => state().tab);
  const tabContent = (value: TaxTab) =>
    value === "worksheet" ? (
      <WorksheetTab
        client={client}
        year={year}
        form={() => state().form}
        meals={() => state().meals}
      />
    ) : value === "pack" ? (
      <PackTab
        client={client}
        year={year}
        form={() => state().form}
        meals={() => state().meals}
        bookRevision={revision}
      />
    ) : value === "vendors" ? (
      <VendorsTab client={client} year={year} onChanged={readChecksAgain} />
    ) : value === "sales" ? (
      <SalesTab
        client={client}
        year={year}
        period={() => state().period}
        onPeriod={(period: TaxSalesPeriodKind) => update({ period })}
      />
    ) : (
      <AccountantTab client={client} year={year} bookRevision={revision} />
    );

  return (
    <section class="app-tax" aria-labelledby="tax-title">
      <PageHeader
        titleId="tax-title"
        title={PAGE_TITLE[state().tab]}
        description={taxWords.describe[state().tab]}
      />
      <Show
        when={summary.value()}
        fallback={
          <Show
            when={summary.error() !== undefined}
            fallback={
              <p class="rt-hint" role="status">
                {taxWords.loading}
              </p>
            }
          >
            <TaxFailure
              error={summary.error()}
              retry={() => void summary.reload()}
              onChooseYear={state().year !== null ? chooseAgain : undefined}
            />
          </Show>
        }
      >
        {(loaded) => (
          <div class="rt-tax-tabs rt-tax-page">
            <TaxYearBar
              years={years()}
              year={year() ?? loaded().taxYear}
              disabled={summary.loading()}
              onYear={(next) => update({ year: next })}
            >
              {/* The worksheet and the pack are built from the same two choices. */}
              <Show when={!uncovered() && (state().tab === "worksheet" || state().tab === "pack")}>
                <TaxFormChoices
                  form={() => state().form}
                  defaultForm={() => loaded().form.id}
                  meals={() => state().meals}
                  onForm={(form: TaxFormId) => update({ form })}
                  onMeals={(meals: MealsPercent) => update({ meals })}
                />
              </Show>
            </TaxYearBar>
            <Show when={!uncovered()}>
              <TaxChecks
                checks={loaded().checks}
                // The form's draft status is said where the form is chosen: the worksheet and the pack.
                omitNotes={
                  state().tab === "worksheet" || state().tab === "pack" ? undefined : ["draft"]
                }
                year={year() ?? loaded().taxYear}
                state={
                  summary.error() !== undefined ? "error" : summary.loading() ? "loading" : "ready"
                }
                onRetry={() => void summary.reload()}
              />
            </Show>
            <div class="rt-tax-panel">
              <Show
                when={!uncovered()}
                fallback={<TaxFailure error={summary.error()} onChooseYear={chooseAgain} />}
              >
                {tabContent(tool())}
              </Show>
            </div>
          </div>
        )}
      </Show>
    </section>
  );
}
