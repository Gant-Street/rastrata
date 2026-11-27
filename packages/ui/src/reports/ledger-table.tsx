import { For, Show } from "solid-js";
import { EmptyState } from "../kit";
import { useUi } from "../locale";
import { Amount } from "./amount";
import { DateValue } from "../date-value";

/** One account of the general ledger: its balance before the range, what moved, and its balance after. */
export interface LedgerAccountRow {
  readonly key: string;
  readonly code: string;
  readonly name: string;
  readonly opening: string;
  readonly debit: string;
  readonly credit: string;
  readonly closing: string;
  readonly lines: number;
  /** The activity behind this account in the range. */
  readonly href?: string | undefined;
  /** How the balance is carried: from the start of the book, or from zero each fiscal year. */
  readonly balanceKind: "cumulative" | "fiscalYearToDate";
}

/** The accounts of a general ledger as a table: opening, debits, credits and closing. */
export function LedgerAccounts(props: {
  caption: string;
  accounts: readonly LedgerAccountRow[];
  currency: string;
  /** The caption names the table for assistive technology; hide it when a heading above says it. */
  captionHidden?: boolean | undefined;
}) {
  const ui = useUi();
  const t = () => ui.messages.reports.ledger;
  return (
    <Show when={props.accounts.length > 0} fallback={<EmptyState>{t().none}</EmptyState>}>
      <section
        class="rt-table-scroll"
        tabindex={0}
        aria-label={ui.messages.reports.table.scroll(props.caption)}
      >
        <table class="rt-table rt-ledger">
          <caption data-hidden={props.captionHidden ? "" : undefined}>{props.caption}</caption>
          <thead>
            <tr>
              <th scope="col">{t().code}</th>
              <th scope="col" class="rt-number">
                {t().opening}
              </th>
              <th scope="col" class="rt-number">
                {t().debit}
              </th>
              <th scope="col" class="rt-number">
                {t().credit}
              </th>
              <th scope="col" class="rt-number">
                {t().closing}
              </th>
            </tr>
          </thead>
          <tbody>
            <For each={props.accounts}>
              {(account) => (
                <tr>
                  <th scope="row">
                    <span class="rt-code">{account.code}</span> {account.name}
                    <small>
                      {t().postings(account.lines)}
                      {account.balanceKind === "fiscalYearToDate"
                        ? ` · ${t().fiscalYearToDate}`
                        : ""}
                    </small>
                  </th>
                  <td class="rt-number">
                    <Amount value={account.opening} />
                  </td>
                  <td class="rt-number">
                    <Amount value={account.debit} />
                  </td>
                  <td class="rt-number">
                    <Amount value={account.credit} />
                  </td>
                  <td class="rt-number">
                    <Amount
                      value={account.closing}
                      href={account.href}
                      context={ui.messages.reports.table.drill(`${account.code} ${account.name}`)}
                    />
                  </td>
                </tr>
              )}
            </For>
          </tbody>
        </table>
      </section>
    </Show>
  );
}

/** One posting of the general ledger. */
export interface LedgerLineRow {
  readonly key: string;
  /** Lines of one account are grouped under its heading; this is that heading. */
  readonly accountKey: string;
  readonly account: string;
  readonly date: string;
  /** The entry's number in the book, said "No. 23". Its identifier is not for the surface. */
  readonly sequence?: string | undefined;
  readonly entryHref?: string | undefined;
  readonly description: string;
  readonly debit: string;
  readonly credit: string;
  readonly balance: string;
}

/** A page of postings, grouped under their account, each with its running balance. */
export function LedgerLines(props: {
  caption: string;
  lines: readonly LedgerLineRow[];
  captionHidden?: boolean | undefined;
}) {
  const ui = useUi();
  const t = () => ui.messages.reports.ledger;
  const groups = () => {
    const result: { key: string; account: string; lines: LedgerLineRow[] }[] = [];
    for (const line of props.lines) {
      const last = result.at(-1);
      if (last && last.key === line.accountKey) last.lines.push(line);
      else result.push({ key: line.accountKey, account: line.account, lines: [line] });
    }
    return result;
  };
  return (
    <Show when={props.lines.length > 0} fallback={<EmptyState>{t().none}</EmptyState>}>
      <section
        class="rt-table-scroll"
        tabindex={0}
        aria-label={ui.messages.reports.table.scroll(props.caption)}
      >
        <table class="rt-table rt-ledger rt-ledger-lines">
          <caption data-hidden={props.captionHidden ? "" : undefined}>{props.caption}</caption>
          <thead>
            <tr>
              <th scope="col">{t().date}</th>
              <th scope="col">{t().description}</th>
              <th scope="col" class="rt-number">
                {t().debit}
              </th>
              <th scope="col" class="rt-number">
                {t().credit}
              </th>
              <th scope="col" class="rt-number">
                {t().balance}
              </th>
            </tr>
          </thead>
          <For each={groups()}>
            {(group) => (
              <tbody>
                <tr class="rt-statement-heading">
                  <th scope="rowgroup" colspan={5}>
                    {group.account}
                  </th>
                </tr>
                <For each={group.lines}>
                  {(line) => (
                    <tr>
                      <td>
                        <DateValue value={line.date} />
                      </td>
                      <th scope="row">
                        <Show when={line.entryHref} fallback={line.description}>
                          <a href={line.entryHref}>{line.description}</a>
                        </Show>
                        <Show when={line.sequence}>
                          {(sequence) => (
                            <small>{ui.messages.register.entryNumber(sequence())}</small>
                          )}
                        </Show>
                      </th>
                      <td class="rt-number">
                        <Amount value={line.debit} />
                      </td>
                      <td class="rt-number">
                        <Amount value={line.credit} />
                      </td>
                      <td class="rt-number">
                        <Amount value={line.balance} />
                      </td>
                    </tr>
                  )}
                </For>
              </tbody>
            )}
          </For>
        </table>
      </section>
    </Show>
  );
}
