import { createUniqueId, For, Index, Match, Show, Switch } from "solid-js";
import { Button } from "../button";
import { FieldError } from "../field";
import { Plus, Trash } from "../icons";
import { addPart, fieldId, removePart, setPartKind, updatePart, withActionKind } from "./draft";
import { RuleInput, RuleSelect } from "./fields";
import type { RuleActionKind, RuleDraft, RuleOption, RuleSplitPreview } from "./types";
import { words } from "./words";
import { formatMoney } from "../format";

type Errors = Readonly<Record<string, string>>;

const KINDS: readonly RuleActionKind[] = ["categorize", "split", "transfer", "exclude"];
const PARTS = ["percent", "amount", "rest"] as const;

/** The exact parts a split makes of an example amount, or why it cannot be made. The cents are the
 * service's own arithmetic (the same function the engine runs), never a calculation done here. */
function SplitExample(props: {
  amount: string;
  onAmount: (value: string) => void;
  preview: RuleSplitPreview | null;
}) {
  const problem = () => {
    const preview = props.preview;
    return preview && "problem" in preview ? preview.problem : null;
  };
  const done = () => {
    const preview = props.preview;
    return preview && "parts" in preview ? preview : null;
  };
  return (
    <div class="rt-rules-split-example">
      <RuleInput
        label={words.splitExampleAmount}
        hint={words.splitExampleHint}
        value={props.amount}
        inputMode="decimal"
        maxLength={20}
        onInput={props.onAmount}
      />
      <div role="status" aria-live="polite">
        <Show when={problem()}>{(message) => <p class="rt-error">{message()}</p>}</Show>
        <Show when={done()}>
          {(result) => (
            <table class="rt-table rt-rules-split-table">
              <caption>{words.splitExample(formatMoney(props.amount))}</caption>
              <thead>
                <tr>
                  <th scope="col">{words.splitAccount}</th>
                  <th scope="col" class="amount">
                    {words.sampleAmount}
                  </th>
                </tr>
              </thead>
              <tbody>
                <For each={result().parts}>
                  {(part) => (
                    <tr>
                      <th scope="row">
                        <bdi>{part.account}</bdi>
                      </th>
                      <td class="amount">{formatMoney(part.amount)}</td>
                    </tr>
                  )}
                </For>
              </tbody>
              <tfoot>
                <tr>
                  <th scope="row">{words.splitTotal}</th>
                  <td class="amount">{formatMoney(result().total)}</td>
                </tr>
              </tfoot>
            </table>
          )}
        </Show>
      </div>
    </div>
  );
}

function Split(props: {
  draft: RuleDraft;
  onChange: (next: RuleDraft) => void;
  accounts: readonly RuleOption[];
  errors: Errors;
  disabled?: boolean | undefined;
  amount: string;
  onAmount: (value: string) => void;
  preview: RuleSplitPreview | null;
}) {
  const kindOptions: readonly RuleOption[] = [
    { value: "percent", label: words.splitPercent },
    { value: "amount", label: words.splitAmount },
    { value: "rest", label: words.splitRest },
  ];
  return (
    <fieldset class="rt-rules-split" id={fieldId("action.allocations")} tabindex="-1">
      <legend>{words.splitTitle}</legend>
      <p class="rt-hint">{words.splitHint}</p>
      <Show when={props.errors["action.allocations"]}>
        {(message) => (
          <FieldError id={`${fieldId("action.allocations")}-error`}>{message()}</FieldError>
        )}
      </Show>
      <ol class="rt-rules-parts">
        <Index each={props.draft.action.parts}>
          {(part, index) => (
            <li class="rt-rules-part">
              <RuleSelect
                id={fieldId(`action.allocations[${index}].accountId`)}
                label={`${words.splitPart(index + 1)}: ${words.splitAccount}`}
                value={part().accountId}
                placeholder={words.actionAccountChoose}
                options={props.accounts}
                disabled={props.disabled}
                error={props.errors[`action.allocations[${index}].accountId`]}
                onChange={(accountId) =>
                  props.onChange(updatePart(props.draft, index, (item) => ({ ...item, accountId })))
                }
              />
              <RuleSelect
                label={`${words.splitPart(index + 1)}: ${words.splitKind}`}
                value={part().kind}
                options={kindOptions}
                disabled={props.disabled}
                onChange={(kind) =>
                  props.onChange(setPartKind(props.draft, index, kind as (typeof PARTS)[number]))
                }
              />
              <Show when={part().kind !== "rest"}>
                <RuleInput
                  id={fieldId(`action.allocations[${index}].value`)}
                  label={`${words.splitPart(index + 1)}: ${
                    part().kind === "percent" ? words.splitValuePercent : words.splitValueAmount
                  }`}
                  value={part().value}
                  inputMode="decimal"
                  maxLength={20}
                  placeholder={part().kind === "percent" ? "60" : "0.00"}
                  disabled={props.disabled}
                  onInput={(value) =>
                    props.onChange(updatePart(props.draft, index, (item) => ({ ...item, value })))
                  }
                />
              </Show>
              <Button
                class="rt-rules-remove"
                iconOnly
                variant="quiet"
                size="sm"
                label={words.splitRemove(index + 1)}
                icon={<Trash />}
                disabled={(props.disabled ?? false) || props.draft.action.parts.length <= 2}
                onClick={() => props.onChange(removePart(props.draft, index))}
              />
            </li>
          )}
        </Index>
      </ol>
      <Button
        variant="secondary"
        size="sm"
        label={words.splitAdd}
        icon={<Plus />}
        disabled={(props.disabled ?? false) || props.draft.action.parts.length >= 20}
        onClick={() => props.onChange(addPart(props.draft))}
      />
      <SplitExample amount={props.amount} onAmount={props.onAmount} preview={props.preview} />
    </fieldset>
  );
}

/** What a matching rule suggests: book the line to an account, split it across several, treat it as
 * a transfer between your own accounts, or leave it out of the books. A rule only suggests; the
 * section says so, and a person (or an agent with the right grant) still accepts the suggestion in
 * the Inbox. Splits are exact to the cent, and the section shows the parts of an example amount. */
export function RuleAction(props: {
  draft: RuleDraft;
  onChange: (next: RuleDraft) => void;
  /** Accounts a line can be booked to, grouped by kind. */
  accounts: readonly RuleOption[];
  /** The accounts a transfer can go to: your own asset and liability accounts. */
  transferAccounts: readonly RuleOption[];
  errors: Errors;
  disabled?: boolean | undefined;
  split: {
    amount: string;
    onAmount: (value: string) => void;
    preview: RuleSplitPreview | null;
  };
  /** The narration on the first line the rule matches, as it would read. */
  narrationExample?: string | undefined;
}) {
  const headingId = createUniqueId();
  const narrationId = fieldId("action.narration");
  const action = () => props.draft.action;
  const set = (patch: Partial<RuleDraft["action"]>) =>
    props.onChange({ ...props.draft, action: { ...action(), ...patch } });

  function insert(field: string) {
    const input = document.getElementById(narrationId);
    const text = `{${field}}`;
    const current = action().narration;
    const start =
      input instanceof HTMLInputElement ? (input.selectionStart ?? current.length) : current.length;
    const end =
      input instanceof HTMLInputElement ? (input.selectionEnd ?? current.length) : current.length;
    set({ narration: `${current.slice(0, start)}${text}${current.slice(end)}` });
    queueMicrotask(() => {
      if (!(input instanceof HTMLInputElement)) return;
      input.focus();
      input.setSelectionRange(start + text.length, start + text.length);
    });
  }

  return (
    <section class="rt-rules-section" aria-labelledby={headingId}>
      <h2 id={headingId}>{words.thenTitle}</h2>
      <RuleSelect
        id={fieldId("action.kind")}
        label={words.actionLabel}
        value={action().kind}
        options={KINDS.map((kind) => ({ value: kind, label: words.actionKinds[kind] ?? kind }))}
        disabled={props.disabled}
        error={props.errors["action.kind"]}
        onChange={(kind) =>
          props.onChange({
            ...props.draft,
            action: withActionKind(action(), kind as RuleActionKind),
          })
        }
      />
      <Switch>
        <Match when={action().kind === "categorize"}>
          <RuleSelect
            id={fieldId("action.accountId")}
            label={words.actionAccount}
            value={action().accountId}
            placeholder={words.actionAccountChoose}
            options={props.accounts}
            disabled={props.disabled}
            error={props.errors["action.accountId"]}
            onChange={(accountId) => set({ accountId })}
          />
        </Match>
        <Match when={action().kind === "transfer"}>
          <RuleSelect
            id={fieldId("action.accountId")}
            label={words.actionTransferAccount}
            hint={words.actionTransferHint}
            value={action().accountId}
            placeholder={words.actionAccountChoose}
            options={props.transferAccounts}
            disabled={props.disabled}
            error={props.errors["action.accountId"]}
            onChange={(accountId) => set({ accountId })}
          />
        </Match>
        <Match when={action().kind === "split"}>
          <Split
            draft={props.draft}
            onChange={props.onChange}
            accounts={props.accounts}
            errors={props.errors}
            disabled={props.disabled}
            amount={props.split.amount}
            onAmount={props.split.onAmount}
            preview={props.split.preview}
          />
        </Match>
        <Match when={action().kind === "exclude"}>
          <RuleInput
            id={fieldId("action.reason")}
            label={words.actionReason}
            hint={words.actionReasonHint}
            value={action().reason}
            maxLength={200}
            disabled={props.disabled}
            error={props.errors["action.reason"]}
            onInput={(reason) => set({ reason })}
          />
        </Match>
      </Switch>
      <Show when={action().kind !== "exclude"}>
        <div class="rt-rules-narration">
          <RuleInput
            id={narrationId}
            label={words.narration}
            value={action().narration}
            maxLength={200}
            disabled={props.disabled}
            error={props.errors["action.narration"]}
            onInput={(narration) => set({ narration })}
          />
          <fieldset class="rt-rules-insert">
            <legend class="rt-sr-only">{words.narrationInsertGroup}</legend>
            <For each={words.narrationFields}>
              {(field) => (
                <Button
                  variant="quiet"
                  size="sm"
                  label={`{${field}}`}
                  aria-label={words.narrationInsert(field)}
                  disabled={props.disabled ?? false}
                  onClick={() => insert(field)}
                />
              )}
            </For>
          </fieldset>
          <Show when={props.narrationExample}>
            {(example) => (
              <p class="rt-hint" role="status">
                {words.narrationExample} <q>{example()}</q>
              </p>
            )}
          </Show>
        </div>
      </Show>
    </section>
  );
}
