import { createSignal, Index, Show, type JSX } from "solid-js";
import { Button } from "../button";
import { FieldError } from "../field";
import { Plus, Trash } from "../icons";
import { AccountPicker, type AccountOption } from "../kit/account-picker";
import { entryAmountProblem, entryIds, normalizeEntryAmount, type EntryLine } from "./entry-logic";
import { entryWords } from "./entry-words";

export interface JournalLinesProps {
  lines: readonly EntryLine[];
  /** The accounts to post to, from `accountOptions(rows)`. A closed account shows and cannot be chosen. */
  accounts: readonly AccountOption[];
  /** `loading` and `error` say so in the picker, in words, rather than showing an empty list. */
  accountState?: "ready" | "loading" | "error" | undefined;
  /** What is wrong, by the id of the control (see `entryIds`), after Save draft or Post was refused. The
   * short sentence is said beside the control. */
  problems?: Readonly<Record<string, string>> | undefined;
  disabled?: boolean | undefined;
  /** One line changed. Typing an amount on one side empties the other, so a line is never both. */
  onChange: (index: number, patch: Partial<EntryLine>) => void;
  onAdd: () => void;
  onRemove: (index: number) => void;
}

/** An amount box: right-aligned figures, named for its line, tidied into two decimals when it is left
 * ("100" becomes "100.00"). What is wrong with it is said beside it once it has been left, or at once
 * after a refused Save draft or Post. */
function AmountBox(props: {
  id: string;
  label: string;
  heading: string;
  value: string;
  problem?: string | undefined;
  disabled?: boolean | undefined;
  onInput: (value: string) => void;
  onTidy: (value: string) => void;
}): JSX.Element {
  const [left, setLeft] = createSignal(false);
  const said = () => props.problem ?? (left() ? entryAmountProblem(props.value) : undefined);
  return (
    <div class="rt-entry-amount" data-heading={props.heading}>
      <input
        id={props.id}
        class="rt-input"
        type="text"
        inputmode="decimal"
        autocomplete="off"
        spellcheck={false}
        aria-label={props.label}
        aria-invalid={said() ? true : undefined}
        aria-describedby={said() ? `${props.id}-error` : undefined}
        placeholder={entryWords.lines.amountPlaceholder}
        value={props.value}
        disabled={props.disabled}
        onInput={(event) => props.onInput(event.currentTarget.value)}
        onBlur={(event) => {
          setLeft(true);
          const tidy = normalizeEntryAmount(event.currentTarget.value);
          if (tidy !== undefined && tidy !== event.currentTarget.value) props.onTidy(tidy);
        }}
      />
      <Show when={said()}>
        <FieldError id={`${props.id}-error`}>{said()}</FieldError>
      </Show>
    </div>
  );
}

/** The lines of an entry: for each, the account (the one account picker) and a debit or a credit. The
 * column names are on screen at desktop width and each control carries its line's number for assistive
 * technology ("Debit for line 2").
 *
 * The lines are listed by position (`Index`), not by object: a keystroke makes a new line object, and a
 * list keyed by object would build the row again and take focus from the box being typed in. */
export function JournalLines(props: JournalLinesProps): JSX.Element {
  const w = entryWords.lines;
  return (
    <section class="rt-entry-lines" aria-labelledby="entry-lines-title">
      <h2 id="entry-lines-title">{w.title}</h2>
      <div class="rt-entry-line-head" aria-hidden="true">
        <span>{w.columnAccount}</span>
        <span class="rt-number">{w.columnDebit}</span>
        <span class="rt-number">{w.columnCredit}</span>
        <span />
      </div>
      <Index each={props.lines}>
        {(line, index) => {
          const number = index + 1;
          const say = (id: string) => props.problems?.[id];
          return (
            // biome-ignore lint/a11y/useSemanticElements: the row is a layout grid, and a fieldset brings its own legend, border and minimum width (and is not a reliable grid container in every engine); the group only names the line for a screen reader
            <div class="rt-entry-line" role="group" aria-label={w.group(number)}>
              <AccountPicker
                compact
                hideLabel
                id={entryIds.account(index)}
                label={w.accountFor(number)}
                accounts={props.accounts}
                state={props.accountState}
                value={line().accountId}
                disabled={props.disabled}
                error={say(entryIds.account(index))}
                onChange={(accountId) => props.onChange(index, { accountId })}
              />
              <AmountBox
                id={entryIds.debit(index)}
                label={w.debitFor(number)}
                heading={w.columnDebit}
                value={line().debit}
                problem={say(entryIds.debit(index))}
                disabled={props.disabled}
                onInput={(debit) =>
                  props.onChange(index, debit.trim() === "" ? { debit } : { debit, credit: "" })
                }
                onTidy={(debit) => props.onChange(index, { debit })}
              />
              <AmountBox
                id={entryIds.credit(index)}
                label={w.creditFor(number)}
                heading={w.columnCredit}
                value={line().credit}
                problem={say(entryIds.credit(index))}
                disabled={props.disabled}
                onInput={(credit) =>
                  props.onChange(index, credit.trim() === "" ? { credit } : { credit, debit: "" })
                }
                onTidy={(credit) => props.onChange(index, { credit })}
              />
              <Button
                variant="quiet"
                size="sm"
                iconOnly
                label={w.removeLine(number)}
                icon={<Trash aria-hidden="true" />}
                disabled={props.disabled || props.lines.length <= 2}
                onClick={() => props.onRemove(index)}
              />
            </div>
          );
        }}
      </Index>
      <Button
        variant="secondary"
        size="sm"
        label={w.addLine}
        icon={<Plus aria-hidden="true" />}
        disabled={props.disabled}
        onClick={props.onAdd}
      />
    </section>
  );
}
