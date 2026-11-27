import { createUniqueId, For, type JSX, Show } from "solid-js";
import { formatDate, formatDateRange, formatMonth, moneyDifference } from "../format";
import { Money } from "../money";
import { Notice, Status } from "../notice";
import { ReportBusy } from "../reports/report-state";
import { SelectField } from "../select-field";
import { salesPeriodLabel } from "./logic";
import type { TaxSalesData, TaxSalesPeriodKind } from "./types";
import { SAID_BY_THE_CHECKS, TaxWarnings } from "./warnings";
import { words } from "./words";

const PERIOD_ITEMS = [
  { value: "month", label: words.periodMonth },
  { value: "quarter", label: words.periodQuarter },
  { value: "year", label: words.periodYear },
] as const;

/** The sales tax account's year: what the books recorded as collected and as paid or returned, period by
 * period, with the balance, beside what Stripe reported on the payouts booked in the same period. It
 * never says what is owed. What Rastrata does not know (rates, which sales are taxable, where to file,
 * when a return is due) and how the figures are read are in the files it downloads and in Help. */
export function TaxSalesView(props: {
  data: TaxSalesData;
  period: TaxSalesPeriodKind;
  busy?: boolean | undefined;
  onPeriod: (period: TaxSalesPeriodKind) => void;
  /** A link to the account's activity for a period's dates. */
  activityHref?: ((accountId: string, from: string, to: string) => string) | undefined;
  accountsHref?: string | undefined;
  renderLink?: ((href: string, children: JSX.Element) => JSX.Element) | undefined;
  exportControls?: JSX.Element;
}) {
  const titleId = createUniqueId();
  const link = (href: string, children: JSX.Element) =>
    props.renderLink ? props.renderLink(href, children) : <a href={href}>{children}</a>;
  const first = () => props.data.accounts[0];
  const showStripe = () => props.data.stripe.read && props.data.stripe.payouts > 0;
  return (
    <ReportBusy busy={props.busy ?? false}>
      <div class="rt-tax-sales">
        <TaxWarnings warnings={props.data.warnings} omit={SAID_BY_THE_CHECKS} />
        <Show
          when={props.data.accounts.length > 0}
          fallback={
            <section class="rt-tax-noaccount" aria-labelledby={titleId}>
              <h3 id={titleId}>{words.salesNoAccountTitle}</h3>
              <p>{words.salesNoAccount}</p>
              <Show when={props.accountsHref}>
                <p>{link(props.accountsHref as string, words.unmappedFix)}</p>
              </Show>
              <Show when={props.data.candidates.length > 0}>
                <h4>{words.salesCandidates}</h4>
                <ul class="rt-tax-candidates">
                  <For each={props.data.candidates}>
                    {(candidate) => (
                      <li>
                        <span class="rt-code">{candidate.code}</span> {candidate.name}
                        <Show when={candidate.suggested}>
                          {" "}
                          <Status>{words.salesCandidateSuggested}</Status>
                        </Show>
                      </li>
                    )}
                  </For>
                </ul>
              </Show>
            </section>
          }
        >
          <div class="rt-tax-salescontrols">
            <SelectField
              label={words.salesPeriodLabel}
              items={PERIOD_ITEMS}
              value={props.period}
              onChange={(value) => props.onPeriod(value as TaxSalesPeriodKind)}
            />
            <p class="rt-hint" data-facts="">
              {words.salesAccounts}:{" "}
              <For each={props.data.accounts}>
                {(account, index) => (
                  <>
                    <Show when={index() > 0}>, </Show>
                    <span class="rt-code">{account.code}</span> {account.name}
                  </>
                )}
              </For>
            </p>
          </div>
          <section
            class="rt-table-scroll"
            tabindex={0}
            aria-label={words.tableScroll(words.salesTitle)}
          >
            <table class="rt-table rt-statement rt-tax-salestable">
              <caption class="rt-sr-only">
                {words.salesTitle}: {formatDateRange(props.data.from, props.data.to)}
              </caption>
              <thead>
                <tr>
                  <th scope="col">{words.salesColumnPeriod}</th>
                  <th scope="col" class="rt-number">
                    {words.salesColumnOpening}
                  </th>
                  <th scope="col" class="rt-number">
                    {words.salesColumnCollected}
                  </th>
                  <th scope="col" class="rt-number">
                    {words.salesColumnRemitted}
                  </th>
                  <th scope="col" class="rt-number">
                    {words.salesColumnClosing}
                  </th>
                  <Show when={showStripe()}>
                    <th scope="col" class="rt-number">
                      {words.salesColumnStripeBooked}
                    </th>
                    <th scope="col" class="rt-number">
                      {words.salesColumnStripeReported}
                    </th>
                    <th scope="col" class="rt-number">
                      {words.salesColumnDifference}
                    </th>
                  </Show>
                </tr>
              </thead>
              <tbody>
                <For each={props.data.periods}>
                  {(period) => (
                    <tr data-differs={period.stripeDifference !== "0.00" ? "" : undefined}>
                      <th scope="row">
                        <Show
                          when={props.activityHref && first()}
                          fallback={salesPeriodLabel(period, formatMonth, formatDate)}
                        >
                          <a
                            href={props.activityHref?.(
                              first()?.accountId ?? "",
                              period.from,
                              period.to,
                            )}
                          >
                            {salesPeriodLabel(period, formatMonth, formatDate)}
                            <span class="rt-sr-only">
                              , {words.salesActivity(first()?.code ?? "", first()?.name ?? "")}
                            </span>
                          </a>
                        </Show>
                        <small>{formatDateRange(period.from, period.to)}</small>
                      </th>
                      <td class="rt-number">
                        <Money value={period.opening} />
                      </td>
                      <td class="rt-number">
                        <Money value={period.collected} />
                      </td>
                      <td class="rt-number">
                        <Money value={period.remitted} />
                      </td>
                      <td class="rt-number">
                        <Money value={period.closing} />
                      </td>
                      <Show when={showStripe()}>
                        <td class="rt-number">
                          <Money value={period.stripeBooked} />
                        </td>
                        <td class="rt-number">
                          <Money value={period.stripeReported} />
                        </td>
                        <td class="rt-number">
                          <Money value={period.stripeDifference} />
                        </td>
                      </Show>
                    </tr>
                  )}
                </For>
              </tbody>
              <tfoot>
                <tr>
                  <th scope="row">{words.salesTotalRow}</th>
                  <td class="rt-number">
                    <Money value={props.data.opening} />
                  </td>
                  <td class="rt-number">
                    <Money value={props.data.collected} />
                  </td>
                  <td class="rt-number">
                    <Money value={props.data.remitted} />
                  </td>
                  <td class="rt-number">
                    <Money value={props.data.closing} />
                  </td>
                  <Show when={showStripe()}>
                    <td class="rt-number">
                      <Money value={props.data.stripe.booked} />
                    </td>
                    <td class="rt-number">
                      <Money value={props.data.stripe.reported} />
                    </td>
                    <td class="rt-number">
                      <Money
                        value={differenceOf(props.data.stripe.booked, props.data.stripe.reported)}
                      />
                    </td>
                  </Show>
                </tr>
              </tfoot>
            </table>
          </section>
          <Show when={props.data.stripe.read && props.data.stripe.payouts > 0}>
            <p class="rt-hint" data-facts="">
              {words.salesStripeSummary(props.data.stripe.payouts)}
            </p>
          </Show>
          <Show when={!props.data.stripe.read}>
            <Notice title={words.salesStripeNotRead} tone="review" role="status" />
          </Show>
          <Show when={(props.data.stripe.taxNotReported ?? 0) > 0}>
            <p class="rt-hint" data-facts="">
              {words.salesStripeTaxNotReported(props.data.stripe.taxNotReported ?? 0)}
            </p>
          </Show>
        </Show>
        <div class="rt-tax-exports">{props.exportControls}</div>
      </div>
    </ReportBusy>
  );
}

const differenceOf = (left: string, right: string): string => moneyDifference(left, [right]);
