import { createSignal, createUniqueId, For, type JSX, Show } from "solid-js";
import { formatCount, formatDateRange, formatMoney, formatFiguresInText } from "../format";
import { Details } from "../kit";
import { Money } from "../money";
import { Status } from "../notice";
import { Amount } from "../reports/amount";
import { ReportBusy } from "../reports/report-state";
import type {
  TaxLineAccountView,
  TaxNoteView,
  TaxUnmappedView,
  TaxWorksheetLineView,
  TaxWorksheetData,
} from "./types";
import { TaxWarnings } from "./warnings";
import { reasonText, words } from "./words";

/** Whether any line differs between what is booked and what goes on the form (Schedule C line 24b).
 * Only then does the table carry two columns of figures; otherwise one says it all. */
export const hasAdjustments = (worksheet: TaxWorksheetData): boolean =>
  worksheet.parts.some((part) => part.lines.some((line) => line.booked !== line.amount));

function Sources(props: {
  sources: readonly { title: string; url: string; readOn?: string | undefined }[];
}) {
  return (
    <ul class="rt-tax-sources">
      <For each={props.sources}>
        {(source) => (
          <li>
            <a href={source.url} rel="noopener noreferrer" target="_blank">
              {words.sourceRead(source.title, source.readOn)}
            </a>
          </li>
        )}
      </For>
    </ul>
  );
}

/** The notes a screen does not show: what the tool is and is not is said once, under the page's title,
 * and the longer form of it is in the files a pack carries. */
const NOT_ON_SCREEN: ReadonlySet<string> = new Set(["scope", "not_filing"]);

/** Notes the service wrote about how to read a figure, each with where the rule comes from and the day
 * it was read, and the form's own sources. Rastrata states no rule that it did not read. They are one fold
 * at the foot, closed: the figures are what the page is for, and what stands behind them is a click away. */
export function TaxNotes(props: {
  notes: readonly TaxNoteView[];
  /** Where the form's lines come from, listed after the notes. */
  sources?: readonly { title: string; url: string; readOn?: string | undefined }[] | undefined;
  /** Start open (stories and tests). */
  defaultOpen?: boolean | undefined;
}) {
  const notes = () => props.notes.filter((note) => !NOT_ON_SCREEN.has(note.key));
  const sources = () => props.sources ?? [];
  return (
    <Show when={notes().length > 0 || sources().length > 0}>
      <div class="rt-tax-notes">
        <Details
          summary={words.notesFold}
          preview={notes().length > 0 ? words.notesCount(notes().length) : undefined}
          defaultOpen={props.defaultOpen ?? false}
        >
          <Show when={notes().length > 0}>
            <ul>
              <For each={notes()}>
                {(note) => (
                  <li>
                    <p>{formatFiguresInText(note.text)}</p>
                    <Show when={note.sources && note.sources.length > 0}>
                      <Sources sources={note.sources ?? []} />
                    </Show>
                  </li>
                )}
              </For>
            </ul>
          </Show>
          <Show when={sources().length > 0}>
            <Sources sources={sources()} />
          </Show>
        </Details>
      </div>
    </Show>
  );
}

function AccountRows(props: {
  line: TaxWorksheetLineView;
  id: string;
  activityHref?: ((account: TaxLineAccountView) => string) | undefined;
}) {
  return (
    <ul class="rt-tax-accountlist" id={props.id}>
      <For each={props.line.accounts}>
        {(account) => (
          <li>
            <span class="rt-tax-accountname">
              <span class="rt-code">{account.code}</span> {account.name}
              <small>
                {formatDateRange(account.from, account.to)}, {formatCount(account.postings)}{" "}
                {account.postings === 1 ? "posting" : "postings"}
              </small>
            </span>
            <Amount
              value={account.amount}
              href={props.activityHref?.(account)}
              context={words.accountActivity(account.code, account.name)}
            />
          </li>
        )}
      </For>
    </ul>
  );
}

/** The worksheet as the form prints it: each line in order with its figure, the accounts behind a line one
 * press away, computed lines (gross profit, total expenses, net) set apart, and a line the books cannot
 * know said plainly. A line that is booked at one amount and goes on the form at another shows both. */
export function TaxWorksheetTable(props: {
  worksheet: TaxWorksheetData;
  activityHref?: ((account: TaxLineAccountView) => string) | undefined;
  busy?: boolean | undefined;
}) {
  const [open, setOpen] = createSignal<ReadonlySet<string>>(new Set());
  const toggle = (key: string) =>
    setOpen((current) => {
      const next = new Set(current);
      if (!next.delete(key)) next.add(key);
      return next;
    });
  const two = () => hasAdjustments(props.worksheet);
  const span = () => (two() ? 3 : 2);
  const caption = () =>
    `${words.worksheetTitle(props.worksheet.form.name, props.worksheet.taxYear)}: ${formatDateRange(props.worksheet.from, props.worksheet.to)}`;
  const ids = new Map<string, string>();
  const idFor = (key: string) => {
    let id = ids.get(key);
    if (!id) {
      id = createUniqueId();
      ids.set(key, id);
    }
    return id;
  };
  const detail = (line: TaxWorksheetLineView): string | undefined => {
    const parts = [
      line.formula,
      line.adjustment
        ? words.mealsTaken(line.adjustment.percent, formatMoney(line.adjustment.removed))
        : undefined,
      line.note,
    ].filter((part): part is string => !!part);
    return parts.length > 0 ? parts.join(" ") : undefined;
  };
  const figures = (line: TaxWorksheetLineView): JSX.Element => (
    <>
      <Show when={two()}>
        <td class="rt-number">
          <Money value={line.booked} />
        </td>
      </Show>
      <td class="rt-number">
        <Money value={line.amount} />
      </td>
    </>
  );
  const label = (line: TaxWorksheetLineView): JSX.Element => (
    <th scope="row">
      <span class="rt-code">{line.number}</span> {line.label}
      <Show when={line.kind === "untracked"}>
        {" "}
        <Status tone="calm">{words.notInBooks}</Status>
      </Show>
      <Show when={line.accounts.length > 0}>
        {" "}
        <button
          type="button"
          class="rt-tax-toggle"
          aria-expanded={open().has(line.key)}
          aria-controls={idFor(line.key)}
          onClick={() => toggle(line.key)}
        >
          {words.accountsCount(line.accounts.length)}
          <span class="rt-sr-only">
            {" "}
            {open().has(line.key) ? words.accountsHide(line.label) : words.accountsShow(line.label)}
          </span>
        </button>
      </Show>
      <Show when={detail(line)}>{(text) => <small>{text()}</small>}</Show>
    </th>
  );
  return (
    <ReportBusy busy={props.busy ?? false}>
      <section class="rt-table-scroll" tabindex={0} aria-label={words.tableScroll(caption())}>
        <table class="rt-table rt-statement rt-tax-worksheet" data-columns={span() - 1}>
          <caption>
            {words.worksheetTitle(props.worksheet.form.name, props.worksheet.taxYear)}:{" "}
            <span class="rt-tax-nowrap">
              {formatDateRange(props.worksheet.from, props.worksheet.to)}
            </span>
          </caption>
          <thead>
            <tr>
              <th scope="col">{words.columnLine}</th>
              <Show when={two()}>
                <th scope="col" class="rt-number">
                  {words.columnBooked}
                </th>
              </Show>
              <th scope="col" class="rt-number">
                {two() ? words.columnForm : words.columnAmount}
              </th>
            </tr>
          </thead>
          <For each={props.worksheet.parts}>
            {(part) => (
              <tbody>
                <tr class="rt-statement-heading">
                  <th scope="rowgroup" colspan={span()}>
                    {part.label}
                  </th>
                </tr>
                <For each={part.lines.filter((line) => !line.net)}>
                  {(line) => (
                    <>
                      <tr
                        class={
                          line.kind === "computed"
                            ? "rt-statement-subtotal"
                            : line.kind === "untracked"
                              ? "rt-statement-calculated"
                              : undefined
                        }
                        data-kind={line.kind}
                      >
                        {label(line)}
                        {figures(line)}
                      </tr>
                      <Show when={open().has(line.key)}>
                        <tr class="rt-tax-accountsrow">
                          <td colspan={span()}>
                            <AccountRows
                              line={line}
                              id={idFor(line.key)}
                              activityHref={props.activityHref}
                            />
                          </td>
                        </tr>
                      </Show>
                    </>
                  )}
                </For>
              </tbody>
            )}
          </For>
          <tfoot>
            <For
              each={props.worksheet.parts.flatMap((part) => part.lines.filter((line) => line.net))}
            >
              {(line) => (
                <tr data-kind="net">
                  {label(line)}
                  {figures(line)}
                </tr>
              )}
            </For>
          </tfoot>
        </table>
      </section>
    </ReportBusy>
  );
}

/** Accounts with activity and no line from this form: listed with their amounts and why, never guessed.
 * When every account has a line there is nothing to list, and the section is not on the page. */
export function TaxUnmapped(props: {
  unmapped: readonly TaxUnmappedView[];
  fixHref?: string | undefined;
  activityHref?: ((account: TaxUnmappedView) => string) | undefined;
  /** Renders a link, so the application can use its router. */
  renderLink?: ((href: string, children: JSX.Element) => JSX.Element) | undefined;
}) {
  const titleId = createUniqueId();
  const link = (href: string, children: JSX.Element) =>
    props.renderLink ? props.renderLink(href, children) : <a href={href}>{children}</a>;
  return (
    <Show when={props.unmapped.length > 0}>
      <section class="rt-tax-unmapped" aria-labelledby={titleId}>
        <h3 id={titleId}>{words.unmappedTitle}</h3>
        <section
          class="rt-table-scroll"
          tabindex={0}
          aria-label={words.tableScroll(words.unmappedTitle)}
        >
          <table class="rt-table">
            <thead>
              <tr>
                <th scope="col">{words.unmappedColumnAccount}</th>
                <th scope="col" class="rt-number">
                  {words.unmappedColumnAmount}
                </th>
                <th scope="col">{words.unmappedColumnWhy}</th>
              </tr>
            </thead>
            <tbody>
              <For each={props.unmapped}>
                {(account) => (
                  <tr>
                    <th scope="row">
                      <span class="rt-code">{account.code}</span> {account.name}
                      <small>{formatDateRange(account.from, account.to)}</small>
                    </th>
                    <td class="rt-number">
                      <Amount
                        value={account.amount}
                        href={props.activityHref?.(account)}
                        context={words.accountActivity(account.code, account.name)}
                      />
                    </td>
                    <td>{reasonText(account.reason, account.taxLine)}</td>
                  </tr>
                )}
              </For>
            </tbody>
          </table>
        </section>
        <Show when={props.fixHref}>
          <p>{link(props.fixHref as string, words.unmappedFix)}</p>
        </Show>
      </section>
    </Show>
  );
}

/** The worksheet's tie to the profit and loss of the same dates, row by row. A worksheet that did not tie
 * is never shown, so that it ties is not said. */
export function TaxReconciliation(props: { worksheet: TaxWorksheetData }) {
  const titleId = createUniqueId();
  const reconciliation = () => props.worksheet.reconciliation;
  return (
    <section class="rt-tax-reconciliation" aria-labelledby={titleId}>
      <h3 id={titleId}>{words.reconciliationTitle}</h3>
      <table class="rt-table rt-tax-tie">
        <tbody>
          <For each={reconciliation().rows}>
            {(row) => (
              <tr>
                <th scope="row">{row.label}</th>
                <td class="rt-number">
                  <Money value={row.amount} />
                </td>
              </tr>
            )}
          </For>
        </tbody>
        <tfoot>
          <tr>
            <th scope="row">{words.reconciliationNet}</th>
            <td class="rt-number">
              <Money value={reconciliation().netIncomeBooks} />
            </td>
          </tr>
        </tfoot>
      </table>
    </section>
  );
}

/** The whole worksheet view: the warnings, the table, the accounts that have no line, the tie to the
 * profit and loss and, folded at the foot, the notes and their sources. */
export function TaxWorksheetView(props: {
  worksheet: TaxWorksheetData;
  activityHref?: ((account: TaxLineAccountView) => string) | undefined;
  unmappedActivityHref?: ((account: TaxUnmappedView) => string) | undefined;
  fixHref?: string | undefined;
  renderLink?: ((href: string, children: JSX.Element) => JSX.Element) | undefined;
  busy?: boolean | undefined;
  /** Warning codes the page has already said in its checks and notes (the early release, the year not
   * over): each fact is said once. */
  omitWarnings?: readonly string[] | undefined;
  /** Start with the notes open (stories and tests). */
  notesOpen?: boolean | undefined;
  /** The downloads, above the fold of notes at the foot. */
  exportControls?: JSX.Element;
}) {
  return (
    <div class="rt-tax-worksheet-view">
      <TaxWarnings warnings={props.worksheet.warnings} omit={props.omitWarnings} />
      <TaxWorksheetTable
        worksheet={props.worksheet}
        activityHref={props.activityHref}
        busy={props.busy}
      />
      <TaxUnmapped
        unmapped={props.worksheet.unmapped}
        fixHref={props.fixHref}
        activityHref={props.unmappedActivityHref}
        renderLink={props.renderLink}
      />
      <TaxReconciliation worksheet={props.worksheet} />
      <Show when={props.exportControls}>
        <div class="rt-tax-exports">{props.exportControls}</div>
      </Show>
      <TaxNotes
        notes={props.worksheet.notes}
        sources={props.worksheet.form.sources}
        defaultOpen={props.notesOpen}
      />
    </div>
  );
}
