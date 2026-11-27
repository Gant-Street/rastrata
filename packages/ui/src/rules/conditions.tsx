import { createUniqueId, For, Index, Match, Show, Switch } from "solid-js";
import { Button } from "../button";
import { FieldError } from "../field";
import { Plus, Trash } from "../icons";
import {
  addCondition,
  addGroup,
  amountBoxes,
  conditionPath,
  fieldId,
  isTextField,
  opsFor,
  PROVIDERS,
  RULE_FIELDS,
  removeCondition,
  removeGroup,
  setGroupMode,
  updateCondition,
  withField,
  withOp,
} from "./draft";
import { RuleInput, RuleSelect } from "./fields";
import type {
  RuleConditionAt,
  RuleConditionDraft,
  RuleDraft,
  RuleFieldName,
  RuleOption,
} from "./types";
import { words } from "./words";

type Errors = Readonly<Record<string, string>>;

const fieldOptions: readonly RuleOption[] = RULE_FIELDS.map((field) => ({
  value: field,
  label: words.fieldNames[field],
}));
const modeOptions = (all: string, any: string): readonly RuleOption[] => [
  { value: "all", label: all },
  { value: "any", label: any },
];

/** The words for one choice in the "how" list. */
const opLabel = (field: RuleFieldName, op: string): string =>
  (isTextField(field) ? words.textOps : field === "amount" ? words.amountOps : words.isOps)[op] ??
  op;

function ConditionRow(props: {
  condition: RuleConditionDraft;
  at: RuleConditionAt;
  /** "Condition 2" or "Group 1, condition 2", for the names assistive technology reads. */
  name: string;
  /** The word that joins this row to the one above: "When", "and", "or". */
  lead: string;
  lineAccounts: readonly RuleOption[];
  errors: Errors;
  disabled?: boolean | undefined;
  onChange: (next: (condition: RuleConditionDraft) => RuleConditionDraft) => void;
  onRemove: () => void;
}) {
  const path = (part: string) => conditionPath(props.at, part);
  const error = (part: string) => props.errors[path(part)];
  const named = (what: string) => `${props.name}: ${what}`;
  const providerOptions = (): readonly RuleOption[] => {
    const known = PROVIDERS.map((provider) => ({
      value: provider,
      label: words.providers[provider] ?? provider,
    }));
    const current = props.condition.value;
    // A rule made elsewhere may name a source this list does not know; keep it selectable.
    return current && !PROVIDERS.includes(current)
      ? [...known, { value: current, label: current }]
      : known;
  };
  return (
    <li class="rt-rules-condition">
      <span class="rt-rules-lead">{props.lead}</span>
      <RuleSelect
        id={fieldId(path("field"))}
        hideLabel
        label={named(words.fieldLabel)}
        value={props.condition.field}
        options={fieldOptions}
        disabled={props.disabled}
        error={error("field")}
        onChange={(value) =>
          props.onChange((condition) => withField(condition, value as RuleFieldName))
        }
      />
      <RuleSelect
        id={fieldId(path("operator"))}
        hideLabel
        label={named(words.operatorLabel)}
        value={props.condition.op}
        options={opsFor(props.condition.field).map((op) => ({
          value: op,
          label: opLabel(props.condition.field, op),
        }))}
        disabled={props.disabled}
        error={error("operator")}
        onChange={(value) => props.onChange((condition) => withOp(condition, value))}
      />
      <div class="rt-rules-values">
        <Switch>
          <Match when={isTextField(props.condition.field)}>
            <RuleInput
              id={fieldId(path("value"))}
              hideLabel
              label={named(words.valueLabel)}
              value={props.condition.value}
              maxLength={200}
              disabled={props.disabled}
              error={error("value")}
              onInput={(value) => props.onChange((condition) => ({ ...condition, value }))}
            />
          </Match>
          <Match when={props.condition.field === "amount"}>
            <For each={amountBoxes(props.condition.op)}>
              {(box) => (
                <RuleInput
                  id={fieldId(path(box))}
                  hideLabel
                  label={named(
                    box === "value"
                      ? words.amountLabel
                      : box === "min"
                        ? words.amountMin
                        : words.amountMax,
                  )}
                  value={props.condition[box]}
                  placeholder={
                    box === "min"
                      ? words.amountMinPlaceholder
                      : box === "max"
                        ? words.amountMaxPlaceholder
                        : words.amountPlaceholder
                  }
                  inputMode="decimal"
                  maxLength={20}
                  disabled={props.disabled}
                  error={error(box)}
                  onInput={(value) =>
                    props.onChange((condition) => ({ ...condition, [box]: value }))
                  }
                />
              )}
            </For>
          </Match>
          <Match when={props.condition.field === "direction"}>
            <RuleSelect
              id={fieldId(path("value"))}
              hideLabel
              label={named(words.directionLabel)}
              value={props.condition.value}
              placeholder={words.directionChoose}
              options={[
                { value: "in", label: words.directionIn },
                { value: "out", label: words.directionOut },
              ]}
              disabled={props.disabled}
              error={error("value")}
              onChange={(value) => props.onChange((condition) => ({ ...condition, value }))}
            />
          </Match>
          <Match when={props.condition.field === "account"}>
            <RuleSelect
              id={fieldId(path("value"))}
              hideLabel
              label={named(words.accountLabel)}
              value={props.condition.value}
              placeholder={words.accountChoose}
              options={props.lineAccounts}
              disabled={props.disabled}
              error={error("value")}
              onChange={(value) => props.onChange((condition) => ({ ...condition, value }))}
            />
          </Match>
          <Match when={props.condition.field === "provider"}>
            <RuleSelect
              id={fieldId(path("value"))}
              hideLabel
              label={named(words.providerLabel)}
              value={props.condition.value}
              placeholder={words.providerChoose}
              options={providerOptions()}
              disabled={props.disabled}
              error={error("value")}
              onChange={(value) => props.onChange((condition) => ({ ...condition, value }))}
            />
          </Match>
        </Switch>
      </div>
      <Button
        class="rt-rules-remove"
        iconOnly
        variant="quiet"
        size="sm"
        label={words.removeCondition(props.name)}
        icon={<Trash />}
        disabled={props.disabled ?? false}
        onClick={props.onRemove}
      />
    </li>
  );
}

/** The "when a line" part of a rule: conditions on what the bank line says, joined by "and" or
 * "or", and groups for the cases that need both. Text is compared without regard to case, accents
 * or punctuation; there are no regular expressions, and the section says so. Rows stay in place as
 * they are edited, so typing never loses its place. */
export function RuleConditions(props: {
  draft: RuleDraft;
  onChange: (next: RuleDraft) => void;
  /** The accounts a bank line can be on, for the "account" test. */
  lineAccounts: readonly RuleOption[];
  errors: Errors;
  disabled?: boolean | undefined;
}) {
  const headingId = createUniqueId();
  const hintId = createUniqueId();
  let addButton: HTMLButtonElement | undefined;
  const total = () => props.draft.conditions.length + props.draft.groups.length;
  const focusSoon = (id: string) => queueMicrotask(() => document.getElementById(id)?.focus());
  const joiner = (mode: "all" | "any") => (mode === "all" ? words.leadAnd : words.leadOr);

  return (
    <section
      class="rt-rules-section"
      id={fieldId("conditions")}
      tabindex="-1"
      aria-labelledby={headingId}
      aria-describedby={hintId}
    >
      <h2 id={headingId}>{words.whenTitle}</h2>
      <p class="rt-hint" id={hintId}>
        {words.conditionsHint}
      </p>
      <Show when={props.errors.conditions}>
        {(message) => <FieldError id={`${fieldId("conditions")}-error`}>{message()}</FieldError>}
      </Show>
      <Show when={total() > 1}>
        <RuleSelect
          label={words.matchLabel}
          value={props.draft.match}
          options={modeOptions(words.matchAll, words.matchAny)}
          disabled={props.disabled}
          onChange={(match) => props.onChange({ ...props.draft, match: match as "all" | "any" })}
        />
      </Show>
      <Show when={props.draft.conditions.length > 0}>
        <ol class="rt-rules-conditions" aria-label={words.whenTitle}>
          <Index each={props.draft.conditions}>
            {(condition, index) => (
              <ConditionRow
                condition={condition()}
                at={{ group: null, index }}
                name={words.conditionLabel(index + 1)}
                lead={index === 0 ? words.leadWhen : joiner(props.draft.match)}
                lineAccounts={props.lineAccounts}
                errors={props.errors}
                disabled={props.disabled}
                onChange={(next) =>
                  props.onChange(updateCondition(props.draft, { group: null, index }, next))
                }
                onRemove={() => {
                  props.onChange(removeCondition(props.draft, { group: null, index }));
                  queueMicrotask(() => addButton?.focus());
                }}
              />
            )}
          </Index>
        </ol>
      </Show>
      <Index each={props.draft.groups}>
        {(group, groupIndex) => (
          <fieldset class="rt-rules-group" id={fieldId(`groups[${groupIndex}]`)} tabindex="-1">
            <legend>{words.groupTitle(groupIndex + 1)}</legend>
            <div class="rt-rules-group-head">
              <RuleSelect
                label={words.groupModeLabel(groupIndex + 1)}
                value={group().mode}
                options={modeOptions(words.groupMatchAll, words.groupMatchAny)}
                disabled={props.disabled}
                onChange={(mode) =>
                  props.onChange(setGroupMode(props.draft, groupIndex, mode as "all" | "any"))
                }
              />
              <Button
                variant="quiet"
                size="sm"
                label={words.removeGroupShort}
                aria-label={words.removeGroup(groupIndex + 1)}
                icon={<Trash />}
                disabled={props.disabled ?? false}
                onClick={() => {
                  props.onChange(removeGroup(props.draft, groupIndex));
                  queueMicrotask(() => addButton?.focus());
                }}
              />
            </div>
            <Show when={props.errors[`groups[${groupIndex}]`]}>
              {(message) => (
                <FieldError id={`${fieldId(`groups[${groupIndex}]`)}-error`}>
                  {message()}
                </FieldError>
              )}
            </Show>
            <ol class="rt-rules-conditions" aria-label={words.groupTitle(groupIndex + 1)}>
              <Index each={group().conditions}>
                {(condition, index) => (
                  <ConditionRow
                    condition={condition()}
                    at={{ group: groupIndex, index }}
                    name={words.groupConditionLabel(groupIndex + 1, index + 1)}
                    lead={index === 0 ? words.leadIf : joiner(group().mode)}
                    lineAccounts={props.lineAccounts}
                    errors={props.errors}
                    disabled={props.disabled}
                    onChange={(next) =>
                      props.onChange(
                        updateCondition(props.draft, { group: groupIndex, index }, next),
                      )
                    }
                    onRemove={() =>
                      props.onChange(removeCondition(props.draft, { group: groupIndex, index }))
                    }
                  />
                )}
              </Index>
            </ol>
            <Button
              variant="secondary"
              size="sm"
              label={words.addToGroup}
              aria-label={words.addToGroupNamed(groupIndex + 1)}
              icon={<Plus />}
              disabled={props.disabled ?? false}
              onClick={() => {
                const next = group().conditions.length;
                props.onChange(addCondition(props.draft, groupIndex));
                focusSoon(fieldId(conditionPath({ group: groupIndex, index: next }, "field")));
              }}
            />
          </fieldset>
        )}
      </Index>
      <div class="rt-rules-add">
        <Button
          ref={(element: HTMLButtonElement) => {
            addButton = element;
          }}
          variant="secondary"
          label={words.addCondition}
          icon={<Plus />}
          disabled={props.disabled ?? false}
          onClick={() => {
            const next = props.draft.conditions.length;
            props.onChange(addCondition(props.draft, null));
            focusSoon(fieldId(conditionPath({ group: null, index: next }, "field")));
          }}
        />
        <Button
          variant="quiet"
          label={words.addGroup}
          icon={<Plus />}
          disabled={(props.disabled ?? false) || props.draft.groups.length >= 10}
          onClick={() => {
            const next = props.draft.groups.length;
            props.onChange(addGroup(props.draft));
            focusSoon(fieldId(conditionPath({ group: next, index: 0 }, "field")));
          }}
        />
      </div>
    </section>
  );
}
