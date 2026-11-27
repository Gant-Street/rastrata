import { For, type JSX, Match, Show, Switch } from "solid-js";
import { Button, buttonAttrs } from "../button";
import { Dialog } from "../dialog";
import { formatDate, formatInstant } from "../format";
import { Details } from "../kit";
import { Notice } from "../notice";
import { Pager } from "../pager";
import { whoWrote } from "./logic";
import { Figure } from "./tables";
import type { PayeeDetailData, PayeeRefView, PayeeSubject, PayeeTransactionView } from "./types";
import { words } from "./words";

/** One transaction's text and where it came from, with its account. The text is what the bank wrote, shown
 * as the text it is. */
function What(props: { row: PayeeTransactionView; showKey: boolean }): JSX.Element {
  return (
    <>
      <span class="rt-payees-text">{props.row.text === "" ? words.noText : props.row.text}</span>
      <small>{props.row.accounts}</small>
      <Show when={props.showKey && props.row.key}>
        <small>{words.matchedWords(props.row.key ?? "")}</small>
      </Show>
      <Show when={props.row.textFrom === "connector"}>
        <small>{words.textFromConnector}</small>
      </Show>
      <Show when={props.row.textFrom === "narration"}>
        <small>{words.textFromNarration}</small>
      </Show>
      <Show when={props.row.reverses}>
        <small>{words.reversal}</small>
      </Show>
    </>
  );
}

/** What the sheet is called: a payee by its own name (the one the row gave, or the one read for it when a
 * link opened the sheet before any row did), a group of texts by what it is. */
const titleOf = (subject: PayeeSubject, detail: PayeeDetailData | undefined): string => {
  switch (subject.kind) {
    case "payee":
      return detail?.payee?.name ?? subject.label;
    case "unnamed":
      return words.sheetUnnamedTitle;
    case "ambiguous":
      return words.sheetAmbiguousTitle;
    case "no_payee":
      return subject.why === "by_hand" ? words.sheetByHandTitle : words.sheetNoBankTextTitle;
  }
};

/** What a row of the report is made of: the transactions behind it, a page at a time, each with its date,
 * what the bank wrote, the account and the money, and a way to the entry itself. For a payee it also
 * shows the words that find it and what was recorded, and leads to changing it; for a text nobody has
 * named it leads to naming a payee from it. A side sheet, so the report stays in view behind it. */
export function PayeeSheet(props: {
  subject: PayeeSubject;
  /** What was read for it; none until the first read arrives. */
  detail: PayeeDetailData | undefined;
  /** A read is under way (the first, or another page). */
  loading?: boolean | undefined;
  /** Why the last read failed, in words. */
  failure?: string | undefined;
  onRetry: () => void;
  onPage: (page: number) => void;
  /** Where an entry is. */
  entryHref: (journalId: string) => string;
  /** Change the name or words of a payee, by its id (the payee itself, or one of those that tie). */
  onChange?: ((payeeId: string) => void) | undefined;
  /** Name a payee out of this text. */
  onName?: (() => void) | undefined;
  /** Where the 1099 vendors are, for a payee that is one. */
  taxHref?: string | undefined;
  onClose: () => void;
  returnFocus?: (() => HTMLElement | null) | undefined;
}): JSX.Element {
  const title = () => titleOf(props.subject, props.detail);
  const tied = (): readonly PayeeRefView[] =>
    props.subject.kind === "ambiguous" ? props.subject.payees : [];
  const readFailure = () => (
    <Notice title={words.sheetFailed} tone="error" role="alert">
      <p>{props.failure}</p>
      <Button variant="secondary" label={words.retry} onClick={props.onRetry} />
    </Notice>
  );
  return (
    <Dialog
      open
      placement="end"
      title={<span class="rt-payees-title">{title()}</span>}
      closeLabel={words.sheetClose}
      class="rt-payees-sheet rt-payees-sheet-wide"
      onOpenChange={(open) => {
        if (!open) props.onClose();
      }}
      {...(props.returnFocus ? { finalFocusEl: props.returnFocus } : {})}
      {...(props.detail
        ? {
            description: `${words.sheetTotals(props.detail.count)}, ${words.sheetDates(props.detail.from, props.detail.to)}`,
          }
        : {})}
    >
      <div class="rt-payees-sheetbody" aria-busy={props.loading ?? false}>
        <Show when={props.subject.kind === "unnamed" || props.subject.kind === "ambiguous"}>
          <p class="rt-payees-from">
            <span class="rt-payees-from-label">{words.columnWrote}</span>
            <span class="rt-payees-text">{props.subject.label || words.noText}</span>
          </p>
        </Show>
        <Show when={props.subject.kind === "unnamed" && props.onName}>
          <p class="rt-payees-sheetactions">
            <Button variant="secondary" label={words.nameThis} onClick={() => props.onName?.()} />
            <span class="rt-hint">{words.sheetUnnamedNote}</span>
          </p>
        </Show>
        <Show when={tied().length > 0 && props.onChange}>
          <p class="rt-payees-sheetactions">
            <For each={tied()}>
              {(entry) => (
                <Button
                  variant="secondary"
                  size="sm"
                  label={words.changePayee(entry.name)}
                  onClick={() => props.onChange?.(entry.id)}
                />
              )}
            </For>
          </p>
        </Show>
        <Show when={props.detail?.payee}>
          {(record) => (
            <section class="rt-payees-record" aria-label={words.sheetWords}>
              <h3>{words.sheetWords}</h3>
              <Show
                when={record().words.length > 0}
                fallback={<p class="rt-hint">{words.sheetNoWords}</p>}
              >
                <ul class="rt-payees-words">
                  <For each={record().words}>{(entry) => <li>{entry}</li>}</For>
                </ul>
              </Show>
              <Show when={record().note}>
                <p>
                  <strong>{words.sheetNote}</strong>{" "}
                  <span class="rt-payees-text">{record().note}</span>
                </p>
              </Show>
              <Show when={record().retired}>
                <p class="rt-hint">{words.retired}</p>
              </Show>
              <Show when={record().hasTaxDetails}>
                <p class="rt-hint">{words.sheetTax}</p>
                <Show when={props.taxHref}>
                  <p>
                    <a {...buttonAttrs({ variant: "secondary", size: "sm" })} href={props.taxHref}>
                      {words.sheetTaxLink}
                    </a>
                  </p>
                </Show>
              </Show>
              <Show when={props.onChange}>
                <p class="rt-payees-sheetactions">
                  <Button
                    variant="secondary"
                    label={words.sheetChange}
                    onClick={() => props.onChange?.(record().id)}
                  />
                </p>
              </Show>
            </section>
          )}
        </Show>

        <Switch>
          <Match when={props.detail === undefined && props.failure !== undefined}>
            {readFailure()}
          </Match>
          <Match when={props.detail === undefined}>
            <p class="rt-hint" role="status">
              {words.sheetLoading}
            </p>
          </Match>
          <Match when={props.detail}>
            {(detail) => (
              <>
                <Show when={props.failure !== undefined}>{readFailure()}</Show>
                <Show
                  when={detail().transactions.length > 0}
                  fallback={<p class="rt-hint">{words.sheetNone}</p>}
                >
                  <section
                    class="rt-table-scroll"
                    tabindex={0}
                    aria-label={words.tableScroll(title())}
                  >
                    <table class="rt-table rt-payees-table rt-payees-transactions">
                      <caption class="rt-sr-only">{title()}</caption>
                      <thead>
                        <tr>
                          <th scope="col">{words.columnDate}</th>
                          <th scope="col">{words.columnWrote}</th>
                          <th scope="col" class="rt-number">
                            {words.columnReceived}
                          </th>
                          <th scope="col" class="rt-number">
                            {words.columnSpent}
                          </th>
                        </tr>
                      </thead>
                      <tbody>
                        <For each={detail().transactions}>
                          {(row) => (
                            <tr>
                              <th scope="row" class="rt-payees-date">
                                <a
                                  href={props.entryHref(row.journalId)}
                                  aria-label={words.openEntryFor(
                                    row.date,
                                    row.text || words.noText,
                                  )}
                                >
                                  {formatDate(row.date)}
                                </a>
                              </th>
                              <td>
                                <What row={row} showKey={props.subject.kind === "payee"} />
                              </td>
                              <td class="rt-number">
                                <Figure value={row.received} />
                              </td>
                              <td class="rt-number">
                                <Figure value={row.spent} />
                              </td>
                            </tr>
                          )}
                        </For>
                      </tbody>
                    </table>
                  </section>
                </Show>
                <Show when={detail().count > detail().pageSize}>
                  <div class="rt-payees-pager">
                    <Pager
                      count={detail().count}
                      page={detail().page}
                      pageSize={detail().pageSize}
                      onPageChange={props.onPage}
                    />
                    <span class="rt-hint">
                      {words.transactionsShown(detail().transactions.length, detail().count)}
                    </span>
                  </div>
                </Show>
                <Show when={detail().history.length > 1}>
                  <Details summary={words.sheetHistory}>
                    <ol class="rt-payees-history">
                      <For each={[...detail().history.slice(0, -1)].reverse()}>
                        {(version) => (
                          <li>
                            {words.sheetHistoryRow(
                              version.version,
                              formatInstant(version.recordedAt),
                              whoWrote(version.principal),
                              version.name,
                            )}
                          </li>
                        )}
                      </For>
                    </ol>
                  </Details>
                </Show>
              </>
            )}
          </Match>
        </Switch>
      </div>
    </Dialog>
  );
}
