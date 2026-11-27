// biome-ignore-all lint/a11y/noRedundantRoles: on a narrow screen each row is laid out as a grid, and a table whose elements are not laid out as a table stops being read as one in Safari and older Chromium; the roles are said outright to keep it one
import { For, Show, type JSX } from "solid-js";
import { DateValue } from "../date-value";
import { isZeroMoney } from "../format";
import { Money } from "../money";
import { Pager } from "../pager";
import { chartWords } from "./chart-words";

export interface AccountRegisterRow {
  readonly journalId: string;
  readonly postingId: string;
  readonly date: string;
  readonly narration: string;
  /** The entry's number in the book ("No. 23" is "23"), when the service says it. */
  readonly postingSequence?: string | undefined;
  readonly debit: string;
  readonly credit: string;
  readonly runningBalance: string;
}

export interface AccountRegisterData {
  readonly account: { readonly name: string };
  readonly currency: string;
  readonly from: string;
  readonly to: string;
  readonly balanceKind: "cumulative" | "fiscalYearToDate";
  readonly openingBalance: string;
  readonly closingBalance: string;
  readonly totalDebit: string;
  readonly totalCredit: string;
  readonly count: number;
  readonly page: number;
  readonly pageSize: number;
  readonly rows: readonly AccountRegisterRow[];
}

export interface AccountRegisterProps {
  data: AccountRegisterData;
  /** Where an entry's page is. */
  entryHref: (journalId: string) => string;
  onPage: (page: number) => void;
  /** How the two amounts are named. A bank or card account says what was spent and what was received
   * (money out of the account is a credit to it, money in a debit); every other account says Debit and
   * Credit, the words of its kind. */
  columns?: "money" | "ledger" | undefined;
}

/** A reversal's narration names the entry it reverses by the identifier the ledger gave it (a long id, or
 * "source-" and a fingerprint for an imported line). An identifier says nothing to a reader, and the list
 * has no column of entry numbers to point at, so the register says "Reversal: Entered twice": the entry's
 * own page names the entry it reverses, with a link. */
const REVERSAL = /^Reversal of ([^\s:]+):/;
const readable = (narration: string): string => narration.replace(REVERSAL, "Reversal:");

/** An account's transactions in a range, with the balance before it, a running balance after each and the
 * balance at the end: Date, Description, the two amounts (Spent and Received for a bank or card account,
 * Debit and Credit for any other) and Balance. An amount that is nothing on a line is left blank. Each
 * description leads to its entry, where its number is. The balance of an asset, liability or equity
 * account carries on from the start of the books; an income or expense account starts each fiscal year
 * from zero, which the first row (the balance before the period) shows. */
export function AccountRegister(props: AccountRegisterProps): JSX.Element {
  const w = chartWords.register;
  const name = () => props.data.account.name;
  const blank = (amount: string, nothing: boolean) =>
    nothing && isZeroMoney(amount) ? null : <Money value={amount} />;
  const money = () => props.columns === "money";
  // Spent is the credit and Received the debit: the amounts keep their order, and the columns swap.
  const first = (line: { debit: string; credit: string }) => (money() ? line.credit : line.debit);
  const second = (line: { debit: string; credit: string }) => (money() ? line.debit : line.credit);
  const firstName = () => (money() ? w.columnSpent : w.columnDebit);
  const secondName = () => (money() ? w.columnReceived : w.columnCredit);
  return (
    <div class="rt-account-register">
      <section class="rt-table-scroll" tabindex="0" aria-label={w.scroll(name())}>
        <table class="rt-table rt-account-register-table" role="table">
          <caption class="rt-sr-only">{w.caption(name())}</caption>
          <thead role="rowgroup">
            <tr role="row">
              <th scope="col" role="columnheader">
                {w.columnDate}
              </th>
              <th scope="col" role="columnheader">
                {w.columnDescription}
              </th>
              <th scope="col" role="columnheader" class="rt-number">
                {firstName()}
              </th>
              <th scope="col" role="columnheader" class="rt-number">
                {secondName()}
              </th>
              <th scope="col" role="columnheader" class="rt-number">
                {w.columnBalance}
              </th>
            </tr>
          </thead>
          <tbody role="rowgroup">
            <Show when={props.data.page === 1}>
              <tr role="row" class="rt-account-register-opening">
                <td role="cell" data-cell="date">
                  <DateValue value={props.data.from} />
                </td>
                <th scope="row" role="rowheader" data-cell="description">
                  {w.opening}
                </th>
                <td role="cell" class="rt-number" data-cell="first" />
                <td role="cell" class="rt-number" data-cell="second" />
                <td role="cell" class="rt-number" data-cell="balance" data-label={w.columnBalance}>
                  <Money value={props.data.openingBalance} />
                </td>
              </tr>
            </Show>
            <For each={props.data.rows}>
              {(line) => (
                <tr role="row">
                  <td role="cell" data-cell="date">
                    <DateValue value={line.date} />
                  </td>
                  <th
                    scope="row"
                    role="rowheader"
                    class="rt-account-register-description"
                    data-cell="description"
                  >
                    <a href={props.entryHref(line.journalId)}>
                      <bdi>{readable(line.narration)}</bdi>
                    </a>
                  </th>
                  <td role="cell" class="rt-number" data-cell="first" data-label={firstName()}>
                    {blank(first(line), true)}
                  </td>
                  <td role="cell" class="rt-number" data-cell="second" data-label={secondName()}>
                    {blank(second(line), true)}
                  </td>
                  <td
                    role="cell"
                    class="rt-number"
                    data-cell="balance"
                    data-label={w.columnBalance}
                  >
                    <Money value={line.runningBalance} />
                  </td>
                </tr>
              )}
            </For>
            <Show when={props.data.rows.length === 0 && props.data.page === 1}>
              <tr role="row">
                <td role="cell" colspan={5} class="rt-account-register-none">
                  {w.empty}
                </td>
              </tr>
            </Show>
          </tbody>
          <tfoot role="rowgroup">
            <tr role="row">
              <th scope="row" role="rowheader" colspan={2} data-cell="description">
                {w.totals}
              </th>
              <td role="cell" class="rt-number" data-cell="first" data-label={firstName()}>
                <Money value={money() ? props.data.totalCredit : props.data.totalDebit} />
              </td>
              <td role="cell" class="rt-number" data-cell="second" data-label={secondName()}>
                <Money value={money() ? props.data.totalDebit : props.data.totalCredit} />
              </td>
              <td role="cell" class="rt-number" data-cell="balance" data-label={w.columnBalance}>
                <Money value={props.data.closingBalance} />
              </td>
            </tr>
          </tfoot>
        </table>
      </section>
      <Show when={props.data.count > props.data.pageSize}>
        <p class="rt-hint">
          {w.showing(
            (props.data.page - 1) * props.data.pageSize + 1,
            Math.min(props.data.count, props.data.page * props.data.pageSize),
            props.data.count,
          )}
        </p>
        <Pager
          count={props.data.count}
          pageSize={props.data.pageSize}
          page={props.data.page}
          onPageChange={props.onPage}
        />
      </Show>
    </div>
  );
}
