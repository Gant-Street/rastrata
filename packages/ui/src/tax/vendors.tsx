import { createUniqueId, For, type JSX, Show } from "solid-js";
import { CheckField } from "../accounting-controls";
import { Button } from "../button";
import { formatCount, formatDate, formatDateRange, formatMoney } from "../format";
import { Details, EmptyState } from "../kit";
import { Money } from "../money";
import { Notice, Status } from "../notice";
import { ReportBusy } from "../reports/report-state";
import { SAID_BY_THE_CHECKS, TaxWarnings } from "./warnings";
import { TaxNotes } from "./worksheet";
import type {
  TaxPayeeRowView,
  TaxVendorAttention,
  TaxVendorReporting,
  TaxVendorRowView,
  TaxVendorsData,
  TaxVendorW9,
} from "./types";
import { words } from "./words";

const REPORTING_WORD: Record<TaxVendorReporting, string> = {
  yes: words.reportingYes,
  no: words.reportingNo,
  undecided: words.reportingUndecided,
};
const W9_WORD: Record<TaxVendorW9, string> = {
  not_requested: words.w9NotRequested,
  requested: words.w9Requested,
  received: words.w9Received,
};
const ATTENTION_WORD: Record<TaxVendorAttention, string> = {
  undecided: words.attentionUndecided,
  w9_missing: words.attentionW9,
  method_unconfirmed: words.attentionMethod,
};

/** The reporting threshold for the year. The service says it; the numbers are the IRS's, read from its own
 * pages on the day shown. The figure is on the page; its exceptions and where it was read are one fold
 * under it, closed. */
function Threshold(props: { data: TaxVendorsData }) {
  const titleId = createUniqueId();
  return (
    <section class="rt-tax-threshold" aria-labelledby={titleId}>
      <h3 id={titleId}>{words.thresholdLabel(props.data.threshold.taxYear)}</h3>
      <p class="rt-tax-threshold-amount">
        <Money value={props.data.threshold.amount} />
      </p>
      <Details summary={words.thresholdSources}>
        <Show when={props.data.threshold.note}>
          <p class="rt-hint">{props.data.threshold.note}</p>
        </Show>
        <ul class="rt-tax-sources">
          <For each={props.data.threshold.sources}>
            {(source) => (
              <li>
                <a href={source.url} rel="noopener noreferrer" target="_blank">
                  {words.sourceRead(source.title, source.readOn)}
                </a>
              </li>
            )}
          </For>
        </ul>
      </Details>
    </section>
  );
}

/** The accounts a person marks as holding payments that may need a 1099. Only marked accounts are counted. */
function ReportableAccounts(props: {
  data: TaxVendorsData;
  pendingId?: string | null | undefined;
  error?: string | undefined;
  onMark: (accountId: string, marked: boolean) => void;
}) {
  const titleId = createUniqueId();
  return (
    <section class="rt-tax-accounts" aria-labelledby={titleId}>
      <h3 id={titleId}>{words.accountsTitle}</h3>
      <Show when={props.error}>
        <Notice title={props.error ?? ""} tone="error" role="alert" />
      </Show>
      <Show
        when={props.data.accounts.length > 0}
        fallback={<EmptyState>{words.accountsNone}</EmptyState>}
      >
        <ul class="rt-tax-accountchoices">
          <For each={props.data.accounts}>
            {(account) => (
              <li>
                <CheckField
                  label={account.name}
                  checked={account.marked}
                  disabled={props.pendingId === account.accountId}
                  onChange={(marked) => props.onMark(account.accountId, marked)}
                />
                <span class="rt-tax-accountcode">{account.code}</span>
                <Show when={account.suggested && !account.marked}>
                  <Status>{words.accountSuggested}</Status>
                </Show>
              </li>
            )}
          </For>
        </ul>
      </Show>
    </section>
  );
}

function VendorRow(props: {
  row: TaxVendorRowView;
  onEdit: (vendorId: string) => void;
  payeeHref?: ((vendorId: string) => string) | undefined;
}) {
  const vendor = () => props.row.vendor;
  return (
    <tr data-attention={props.row.attention.length > 0 ? "" : undefined}>
      <th scope="row">
        <button
          type="button"
          class="rt-tax-linkbutton"
          onClick={() => props.onEdit(vendor().id)}
          aria-label={words.vendorEdit(vendor().name)}
        >
          {vendor().name}
        </button>
        <small>
          {vendor().payeeKeys.join("; ")}
          <Show when={props.row.meetsThreshold}> · {words.atOrOver}</Show>
        </small>
        <Show when={props.payeeHref}>
          {(href) => (
            <small>
              <a href={href()(vendor().id)} aria-label={words.vendorPayeeLinkFor(vendor().name)}>
                {words.vendorPayeeLink}
              </a>
            </small>
          )}
        </Show>
      </th>
      <td>{REPORTING_WORD[vendor().reporting]}</td>
      <td>
        {W9_WORD[vendor().w9]}
        <Show when={vendor().w9On}>{(date) => <small>{formatDate(date())}</small>}</Show>
      </td>
      <td class="rt-number">
        <Money value={props.row.counted} />
      </td>
      <td class="rt-number">
        <Money value={props.row.card} />
      </td>
      <td class="rt-number">
        <Money value={props.row.other} />
      </td>
      <td>
        <Show when={props.row.attention.length > 0} fallback={<span class="rt-hint">—</span>}>
          <ul class="rt-tax-attention">
            <For each={props.row.attention}>
              {(code) => (
                <li>
                  <Status tone="review">{ATTENTION_WORD[code]}</Status>
                </li>
              )}
            </For>
          </ul>
        </Show>
      </td>
    </tr>
  );
}

function PayeeRow(props: { row: TaxPayeeRowView; onMake: (payee: string) => void }) {
  return (
    <tr>
      <th scope="row">
        <span class="rt-tax-payee">{props.row.payee}</span>
        <Show when={props.row.ambiguous}>
          <small>{words.payeeAmbiguous}</small>
        </Show>
      </th>
      <td class="rt-number">{formatCount(props.row.payments)}</td>
      <td>{formatDateRange(props.row.firstOn, props.row.lastOn)}</td>
      <td class="rt-number">
        <Money value={props.row.counted} />
      </td>
      <td class="rt-number">
        <Money value={props.row.card} />
      </td>
      <td class="rt-number">
        <Money value={props.row.other} />
      </td>
      <td>
        <Button
          variant="quiet"
          size="sm"
          label={words.vendorAdd}
          aria-label={words.payeeMakeVendor(props.row.payee)}
          onClick={() => props.onMake(props.row.payee)}
        />
      </td>
    </tr>
  );
}

/** The 1099 vendor list for a year: the threshold, the accounts that are counted, each vendor with what it
 * was paid (what counts, what the processor reports, what the rules leave out), what each needs, and the
 * payees that are not vendors yet. A list, not a form: nothing is filed and no taxpayer identification
 * number is ever asked for. The payees and the totals are on the page when there is something in them. */
export function TaxVendorsView(props: {
  data: TaxVendorsData;
  busy?: boolean | undefined;
  pendingAccountId?: string | null | undefined;
  accountsError?: string | undefined;
  onMarkAccount: (accountId: string, marked: boolean) => void;
  onAddVendor: () => void;
  onEditVendor: (vendorId: string) => void;
  onMakeVendor: (payee: string) => void;
  /** Where a vendor is in Money by payee, for the link under its name. A vendor is a payee with the same id. */
  payeeHref?: ((vendorId: string) => string) | undefined;
  exportControls?: JSX.Element;
  /** Start with the notes open (stories and tests). */
  notesOpen?: boolean | undefined;
}) {
  const vendorsId = createUniqueId();
  const payeesId = createUniqueId();
  const counting = () => props.data.accounts.some((account) => account.marked);
  return (
    <ReportBusy busy={props.busy ?? false}>
      <div class="rt-tax-vendors">
        <TaxWarnings warnings={props.data.warnings} omit={SAID_BY_THE_CHECKS} />
        <Threshold data={props.data} />
        <ReportableAccounts
          data={props.data}
          pendingId={props.pendingAccountId}
          error={props.accountsError}
          onMark={props.onMarkAccount}
        />

        <section class="rt-tax-vendorlist" aria-labelledby={vendorsId}>
          <div class="rt-tax-sectionhead">
            <h3 id={vendorsId}>{words.vendorsList}</h3>
            <Button
              variant="secondary"
              size="sm"
              label={words.vendorAdd}
              onClick={props.onAddVendor}
            />
          </div>
          <Show
            when={props.data.vendors.length > 0}
            fallback={<EmptyState>{words.vendorsNone}</EmptyState>}
          >
            <section
              class="rt-table-scroll"
              tabindex={0}
              aria-label={words.tableScroll(words.vendorsList)}
            >
              <table class="rt-table rt-tax-vendortable">
                <thead>
                  <tr>
                    <th scope="col">{words.vendorColumn}</th>
                    <th scope="col">{words.vendorReporting}</th>
                    <th scope="col">{words.vendorW9}</th>
                    <th scope="col" class="rt-number">
                      {words.vendorCounted}
                    </th>
                    <th scope="col" class="rt-number">
                      {words.vendorCard}
                    </th>
                    <th scope="col" class="rt-number">
                      {words.vendorOther}
                    </th>
                    <th scope="col">{words.vendorAttention}</th>
                  </tr>
                </thead>
                <tbody>
                  <For each={props.data.vendors}>
                    {(row) => (
                      <VendorRow
                        row={row}
                        onEdit={props.onEditVendor}
                        payeeHref={props.payeeHref}
                      />
                    )}
                  </For>
                </tbody>
              </table>
            </section>
          </Show>
        </section>

        <Show when={props.data.payees.length > 0}>
          <section class="rt-tax-payees" aria-labelledby={payeesId}>
            <h3 id={payeesId}>{words.payeesTitle}</h3>
            <section
              class="rt-table-scroll"
              tabindex={0}
              aria-label={words.tableScroll(words.payeesTitle)}
            >
              <table class="rt-table rt-tax-payeetable">
                <thead>
                  <tr>
                    <th scope="col">{words.payeeColumn}</th>
                    <th scope="col" class="rt-number">
                      {words.payeePayments}
                    </th>
                    <th scope="col">{words.payeeDates}</th>
                    <th scope="col" class="rt-number">
                      {words.vendorCounted}
                    </th>
                    <th scope="col" class="rt-number">
                      {words.vendorCard}
                    </th>
                    <th scope="col" class="rt-number">
                      {words.vendorOther}
                    </th>
                    <th scope="col">
                      <span class="rt-sr-only">{words.vendorAdd}</span>
                    </th>
                  </tr>
                </thead>
                <tbody>
                  <For each={props.data.payees}>
                    {(row) => <PayeeRow row={row} onMake={props.onMakeVendor} />}
                  </For>
                </tbody>
              </table>
            </section>
          </section>
        </Show>

        <Show when={counting()}>
          <p class="rt-tax-totals" data-facts="">
            {words.totalsLine(
              formatMoney(props.data.totals.counted),
              formatMoney(props.data.totals.card),
              formatMoney(props.data.totals.other),
            )}
          </p>
        </Show>
        <div class="rt-tax-exports">{props.exportControls}</div>
        {/* The threshold note is said with the threshold, above, with its sources. */}
        <TaxNotes
          notes={props.data.notes.filter((note) => note.key !== "threshold")}
          defaultOpen={props.notesOpen}
        />
      </div>
    </ReportBusy>
  );
}
