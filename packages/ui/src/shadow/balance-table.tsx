import { Index, Show } from "solid-js";
import { Check, ChevronDown, ChevronRight } from "../icons";
import { formatMoney } from "../format";
import { accountLabel, balanceInputId, sideAmount } from "./labels";
import type { BalanceSection, OffsetView, TotalsView } from "./types";
import { words } from "./words";

/** The table where each account's opening balance is typed. Controlled: the parent keeps what was
 * typed and works out, in exact cents, what each amount means as a debit or a credit, the totals
 * and the offset; this lays them out and moves between fields from the keyboard.
 *
 * Rows are keyed by position (`Index`), not by object: the parent builds new row objects on every
 * keystroke, and a keyed list would rebuild the field being typed in and drop the focus.
 *
 * From any amount: Down or Enter moves to the next account's amount, Up to the previous one.
 * An amount that cannot be read says why under its field and in the review; it never counts. */
export function BalanceTable(props: {
  sections: readonly BalanceSection[];
  offset: OffsetView | null;
  /** The sum of the typed balances on each side, before the offset. */
  entered: TotalsView;
  /** What the entry comes to with the offset: the two sides agree. */
  totals: TotalsView;
  disabled?: boolean | undefined;
  onInput: (accountId: string, value: string) => void;
  onBlur: (accountId: string) => void;
  onToggle: (sectionId: string) => void;
}) {
  let table: HTMLTableElement | undefined;
  const move = (event: KeyboardEvent, direction: 1 | -1) => {
    const inputs = Array.from(
      table?.querySelectorAll<HTMLInputElement>("input[data-balance-input]:not(:disabled)") ?? [],
    );
    const next = inputs[inputs.indexOf(event.currentTarget as HTMLInputElement) + direction];
    if (!next) return;
    event.preventDefault();
    next.focus();
    next.select();
  };
  const onKey = (event: KeyboardEvent) => {
    if (event.key === "ArrowDown" || event.key === "Enter") move(event, 1);
    else if (event.key === "ArrowUp") move(event, -1);
  };
  // Both sides are exact decimal strings of the same form, so equal text is equal money.
  const agree = () => props.totals.debit === props.totals.credit;
  return (
    <section class="rt-table-scroll" tabindex="0" aria-label={words.balancesCaption}>
      <table class="rt-table rt-shadow-balances" ref={table}>
        <caption class="rt-sr-only">{words.balancesCaption}</caption>
        <thead>
          <tr>
            <th scope="col">{words.account}</th>
            <th scope="col" class="amount">
              {words.balance}
            </th>
            <th scope="col" class="amount">
              {words.debit}
            </th>
            <th scope="col" class="amount">
              {words.credit}
            </th>
          </tr>
        </thead>
        <Index each={props.sections}>
          {(section) => (
            <tbody>
              <tr class="rt-shadow-group">
                <th scope="colgroup" colspan="4">
                  <Show when={section().collapsible} fallback={section().title}>
                    <button
                      type="button"
                      class="rt-shadow-disclosure"
                      aria-expanded={!section().collapsed}
                      onClick={() => props.onToggle(section().id)}
                    >
                      <Show
                        when={section().collapsed}
                        fallback={<ChevronDown aria-hidden="true" />}
                      >
                        <ChevronRight aria-hidden="true" />
                      </Show>
                      {section().title}
                    </button>
                  </Show>
                  <Show when={section().hint && !section().collapsed}>
                    <small>{section().hint}</small>
                  </Show>
                </th>
              </tr>
              <Show when={!section().collapsed}>
                <Index each={section().rows}>
                  {(row) => (
                    <tr>
                      <th scope="row">
                        <bdi>{accountLabel(row())}</bdi>
                      </th>
                      <td class="amount">
                        <input
                          id={balanceInputId(row().id)}
                          class="rt-input rt-shadow-amount"
                          type="text"
                          inputmode="decimal"
                          autocomplete="off"
                          spellcheck={false}
                          data-balance-input=""
                          value={row().value}
                          disabled={props.disabled === true}
                          aria-label={words.balanceFor(accountLabel(row()))}
                          aria-invalid={row().error ? true : undefined}
                          aria-describedby={
                            row().error ? `${balanceInputId(row().id)}-error` : undefined
                          }
                          onInput={(event) => props.onInput(row().id, event.currentTarget.value)}
                          onBlur={() => props.onBlur(row().id)}
                          onKeyDown={onKey}
                        />
                        <Show when={row().error}>
                          <small id={`${balanceInputId(row().id)}-error`} class="rt-error">
                            {row().error}
                          </small>
                        </Show>
                      </td>
                      <td class="amount">{sideAmount(row().debit)}</td>
                      <td class="amount">{sideAmount(row().credit)}</td>
                    </tr>
                  )}
                </Index>
              </Show>
            </tbody>
          )}
        </Index>
        <tfoot>
          <tr class="rt-shadow-entered">
            <th scope="row" colspan="2">
              {words.entered}
            </th>
            <td class="amount">{formatMoney(props.entered.debit)}</td>
            <td class="amount">{formatMoney(props.entered.credit)}</td>
          </tr>
          <tr class="rt-shadow-offset">
            <th scope="row" colspan="2">
              <Show when={props.offset} fallback={words.offsetMissing}>
                {(offset) => (
                  <>
                    <bdi>{words.offsetRow(accountLabel(offset()))}</bdi>
                    <small>{words.offsetNote}</small>
                  </>
                )}
              </Show>
            </th>
            <td class="amount">
              {props.offset?.side === "debit" ? formatMoney(props.offset.amount) : ""}
            </td>
            <td class="amount">
              {props.offset?.side === "credit" ? formatMoney(props.offset.amount) : ""}
            </td>
          </tr>
          <tr class="rt-shadow-total">
            <th scope="row" colspan="2">
              {words.total}
            </th>
            <td class="amount">{formatMoney(props.totals.debit)}</td>
            <td class="amount">{formatMoney(props.totals.credit)}</td>
          </tr>
        </tfoot>
      </table>
      <p class="rt-shadow-balanced" data-facts>
        <Show when={agree()} fallback={words.entryUnbalanced}>
          <Check aria-hidden="true" /> {words.totalsBalanced}
        </Show>
      </p>
    </section>
  );
}
