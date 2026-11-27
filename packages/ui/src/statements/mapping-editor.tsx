import { createEffect, createSignal, createUniqueId, on, Show } from "solid-js";
import { NumberField } from "../number-field";
import { SelectField } from "../select-field";
import { CheckField } from "../accounting-controls";
import { TextField } from "../text-field";
import {
  emptyMapping,
  indexOf,
  isComplete,
  joinValues,
  missingParts,
  refFor,
  splitValues,
  withAmountColumn,
  withAmountKind,
  withOptional,
} from "./mapping-model";
import type { ColumnInfo, ImportMapping } from "./types";
import { words } from "./words";
import { Details } from "../kit/details";

/** A column picker: a native select, so a keyboard, a screen reader and a phone all work, listing
 * each column by position, header and a sample value so it can be recognised by what is in it. */
function ColumnSelect(props: {
  label: string;
  hint?: string;
  columns: readonly ColumnInfo[];
  /** The one-based position chosen, or 0 for none. */
  value: number;
  optional?: boolean;
  disabled?: boolean | undefined;
  onChange: (index: number) => void;
}) {
  return (
    <SelectField
      label={props.label}
      hint={props.hint}
      disabled={props.disabled}
      value={String(props.value)}
      items={[
        { value: "0", label: props.optional ? words.none : words.chooseColumn },
        ...props.columns.map((column) => ({
          value: String(column.index),
          label: words.columnOption(column.index, column.header, column.samples[0] ?? ""),
        })),
      ]}
      onChange={(value) => props.onChange(Number(value))}
    />
  );
}

function ChoiceSelect<T extends string>(props: {
  label: string;
  value: T;
  options: readonly { value: T; label: string }[];
  disabled?: boolean | undefined;
  onChange: (value: T) => void;
}) {
  return (
    <SelectField
      label={props.label}
      disabled={props.disabled}
      value={props.value}
      items={props.options}
      onChange={(value) => props.onChange(value as T)}
    />
  );
}

/** Choose which column of a CSV holds what, against a live preview. The editor keeps its own draft
 * so typing is never overwritten by the service's answer; it tells the page only when the draft is
 * complete enough to read the file, and starts again when `resetKey` changes (another file, or a
 * bank layout chosen elsewhere on the page). Until the person has changed a column themselves, a
 * different mapping from the service replaces the draft, so a layout chosen by name shows its
 * columns as soon as its preview arrives. */
export function ImportMappingEditor(props: {
  columns: readonly ColumnInfo[];
  /** The mapping the service applied, or none when it could not tell. */
  mapping: ImportMapping | null | undefined;
  /** The row the header was found on; 0 when the file has none. */
  headerRow: number;
  resetKey: string;
  disabled?: boolean | undefined;
  onChange: (mapping: ImportMapping) => void;
}) {
  const start = () => props.mapping ?? emptyMapping(props.headerRow);
  const [draft, setDraft] = createSignal<ImportMapping>(start());
  const [outText, setOutText] = createSignal(joinValues(start().amount.outValues));
  const [inText, setInText] = createSignal(joinValues(start().amount.inValues));
  /** Whether the person has changed a column since the draft was last taken from the service. */
  let touched = false;
  let seeded = JSON.stringify(props.mapping ?? null);
  const seed = () => {
    touched = false;
    seeded = JSON.stringify(props.mapping ?? null);
    setDraft(start());
    setOutText(joinValues(start().amount.outValues));
    setInText(joinValues(start().amount.inValues));
  };
  createEffect(on(() => props.resetKey, seed, { defer: true }));
  createEffect(
    on(
      () => props.mapping,
      (incoming) => {
        if (!touched && JSON.stringify(incoming ?? null) !== seeded) seed();
      },
      { defer: true },
    ),
  );
  const change = (next: ImportMapping) => {
    touched = true;
    setDraft(next);
    if (isComplete(next)) props.onChange(next);
  };
  const headerRow = () => draft().headerRow ?? props.headerRow;
  const ref = (index: number) =>
    index === 0 ? undefined : refFor(props.columns, index, headerRow());
  const missing = () => missingParts(draft());
  const amount = () => draft().amount;
  const second = () => draft().description[1];
  const idMore = createUniqueId();

  return (
    <div class="rt-imp-mapping">
      <div class="rt-imp-mapping-grid">
        <ColumnSelect
          label={words.dateColumn}
          columns={props.columns}
          value={indexOf(props.columns, draft().date)}
          disabled={props.disabled}
          onChange={(index) => change({ ...draft(), date: ref(index) ?? {} })}
        />
        <ChoiceSelect
          label={words.dateOrder}
          value={draft().dateOrder ?? "auto"}
          disabled={props.disabled}
          options={[
            { value: "auto", label: words.dateOrderAuto },
            { value: "mdy", label: words.dateOrderMdy },
            { value: "dmy", label: words.dateOrderDmy },
            { value: "ymd", label: words.dateOrderYmd },
          ]}
          onChange={(dateOrder) => change({ ...draft(), dateOrder })}
        />
        <ChoiceSelect
          label={words.amountStyle}
          value={amount().kind}
          disabled={props.disabled}
          options={[
            { value: "signed", label: words.amountSigned },
            { value: "debitCredit", label: words.amountSplit },
            { value: "direction", label: words.amountDirection },
          ]}
          onChange={(kind) => change({ ...draft(), amount: withAmountKind(amount(), kind) })}
        />
        <Show when={amount().kind === "signed" || amount().kind === "direction"}>
          <ColumnSelect
            label={words.amountColumn}
            columns={props.columns}
            value={indexOf(props.columns, amount().amount)}
            disabled={props.disabled}
            onChange={(index) =>
              change({ ...draft(), amount: withAmountColumn(amount(), "amount", ref(index)) })
            }
          />
        </Show>
        <Show when={amount().kind === "debitCredit"}>
          <ColumnSelect
            label={words.debitColumn}
            columns={props.columns}
            value={indexOf(props.columns, amount().debit)}
            disabled={props.disabled}
            onChange={(index) =>
              change({ ...draft(), amount: withAmountColumn(amount(), "debit", ref(index)) })
            }
          />
          <ColumnSelect
            label={words.creditColumn}
            columns={props.columns}
            value={indexOf(props.columns, amount().credit)}
            disabled={props.disabled}
            onChange={(index) =>
              change({ ...draft(), amount: withAmountColumn(amount(), "credit", ref(index)) })
            }
          />
        </Show>
        <Show when={amount().kind === "direction"}>
          <ColumnSelect
            label={words.directionColumn}
            columns={props.columns}
            value={indexOf(props.columns, amount().direction)}
            disabled={props.disabled}
            onChange={(index) =>
              change({ ...draft(), amount: withAmountColumn(amount(), "direction", ref(index)) })
            }
          />
          <TextField
            label={words.outValues}
            hint={words.valuesHint}
            value={outText()}
            disabled={props.disabled ?? false}
            onInput={(event) => {
              setOutText(event.currentTarget.value);
              change({
                ...draft(),
                amount: { ...amount(), outValues: splitValues(event.currentTarget.value) },
              });
            }}
          />
          <TextField
            label={words.inValues}
            hint={words.valuesHint}
            value={inText()}
            disabled={props.disabled ?? false}
            onInput={(event) => {
              setInText(event.currentTarget.value);
              change({
                ...draft(),
                amount: { ...amount(), inValues: splitValues(event.currentTarget.value) },
              });
            }}
          />
        </Show>
        <div class="rt-imp-mapping-wide">
          <CheckField
            label={words.flip}
            checked={amount().invert === true}
            disabled={props.disabled ?? false}
            onChange={(checked) => {
              const { invert: _gone, ...rest } = amount();
              change({ ...draft(), amount: checked ? { ...rest, invert: true } : rest });
            }}
          />
          <p class="rt-hint">{words.flipHint}</p>
        </div>
        <ColumnSelect
          label={words.descriptionColumn}
          columns={props.columns}
          value={indexOf(props.columns, draft().description[0])}
          disabled={props.disabled}
          onChange={(index) => {
            const rest = draft().description.slice(1);
            const first = ref(index);
            change({ ...draft(), description: first ? [first, ...rest] : rest });
          }}
        />
        <ColumnSelect
          label={words.descriptionExtra}
          columns={props.columns}
          optional
          value={indexOf(props.columns, second())}
          disabled={props.disabled}
          onChange={(index) => {
            const first = draft().description[0];
            const extra = ref(index);
            change({
              ...draft(),
              description: [...(first ? [first] : []), ...(extra ? [extra] : [])],
            });
          }}
        />
        <ColumnSelect
          label={words.referenceColumn}
          columns={props.columns}
          optional
          value={indexOf(props.columns, draft().reference)}
          disabled={props.disabled}
          onChange={(index) => change(withOptional(draft(), "reference", ref(index)))}
        />
        <ColumnSelect
          label={words.balanceColumn}
          columns={props.columns}
          optional
          value={indexOf(props.columns, draft().balance)}
          disabled={props.disabled}
          onChange={(index) => change(withOptional(draft(), "balance", ref(index)))}
        />
      </div>
      <Details class="rt-imp-more" flush id={idMore} summary={words.moreOptions}>
        <div class="rt-imp-mapping-grid">
          <NumberField
            label={words.headerRow}
            hint={words.headerRowHint}
            min={0}
            max={1000}
            value={String(headerRow())}
            disabled={props.disabled}
            onChange={(text) => {
              const value = Number(text);
              if (text !== "" && Number.isInteger(value) && value >= 0 && value <= 1000)
                change({ ...draft(), headerRow: value });
            }}
          />
          <ChoiceSelect
            label={words.delimiter}
            value={draft().delimiter ?? ","}
            disabled={props.disabled}
            options={[
              { value: ",", label: words.delimiterComma },
              { value: ";", label: words.delimiterSemicolon },
              { value: "\t", label: words.delimiterTab },
              { value: "|", label: words.delimiterPipe },
            ]}
            onChange={(delimiter) => change({ ...draft(), delimiter })}
          />
          <div class="rt-imp-mapping-wide">
            <CheckField
              label={words.decimalComma}
              checked={draft().decimal === ","}
              disabled={props.disabled ?? false}
              onChange={(checked) => {
                const { decimal: _gone, ...rest } = draft();
                change(checked ? { ...rest, decimal: "," } : rest);
              }}
            />
          </div>
        </div>
      </Details>
      <Show when={missing().length > 0}>
        <p class="rt-hint" role="status">
          {words.stillToChoose(missing().join(", "))}
        </p>
      </Show>
    </div>
  );
}
