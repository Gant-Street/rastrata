import { Checkbox } from "@ark-ui/solid/checkbox";
import { RadioGroup } from "@ark-ui/solid/radio-group";
import { createUniqueId, For, Show, type JSX } from "solid-js";
import { FieldError } from "../field";

export interface ChoiceCard {
  readonly value: string;
  readonly title: string;
  /** What the choice means, in a sentence or two. Read after the title. */
  readonly description?: string | undefined;
}

/**
 * One choice from a short list, with an explanation for each: Ark's radio group, so the arrow keys and the
 * grouping are its own. The title names each radio and the explanation describes it, so a screen reader hears
 * them in that order and not as one run.
 */
export function ChoiceCards(props: {
  legend: string;
  /** Guidance under the legend, before the choices. */
  help?: string;
  name: string;
  value: string;
  choices: readonly ChoiceCard[];
  onChange: (value: string) => void;
  disabled?: boolean;
  error?: string;
  /** The id of the first radio, so an error summary can move focus into the group. */
  id?: string;
}): JSX.Element {
  const helpId = createUniqueId();
  const errorId = createUniqueId();
  const inputs = createUniqueId();
  // The first radio has the caller's id. Ark is told, so the card (a label for that id) still chooses it.
  const inputId = (value: string) =>
    props.id && value === props.choices[0]?.value ? props.id : `${inputs}-${value}`;
  return (
    <RadioGroup.Root
      class="rt-choice-cards"
      ids={{ itemHiddenInput: inputId }}
      name={props.name}
      value={props.value}
      disabled={props.disabled ?? false}
      invalid={Boolean(props.error)}
      aria-describedby={
        [props.help && helpId, props.error && errorId].filter(Boolean).join(" ") || undefined
      }
      onValueChange={(detail) => {
        if (detail.value !== null && detail.value !== props.value) props.onChange(detail.value);
      }}
    >
      <RadioGroup.Label class="rt-choice-cards-legend">{props.legend}</RadioGroup.Label>
      <Show when={props.help}>
        <p class="rt-hint" id={helpId}>
          {props.help}
        </p>
      </Show>
      <div class="rt-choice-card-list">
        <For each={props.choices}>
          {(choice) => {
            const titleId = createUniqueId();
            const descriptionId = createUniqueId();
            return (
              <RadioGroup.Item class="rt-choice-card" value={choice.value}>
                <RadioGroup.ItemControl class="rt-radio" />
                <span class="rt-choice-card-body">
                  <RadioGroup.ItemText class="rt-choice-card-title" id={titleId}>
                    {choice.title}
                  </RadioGroup.ItemText>
                  <Show when={choice.description}>
                    <span class="rt-choice-card-text" id={descriptionId}>
                      {choice.description}
                    </span>
                  </Show>
                </span>
                <RadioGroup.ItemHiddenInput
                  aria-labelledby={titleId}
                  aria-describedby={choice.description ? descriptionId : undefined}
                />
              </RadioGroup.Item>
            );
          }}
        </For>
      </div>
      <Show when={props.error}>
        <FieldError id={errorId}>{props.error}</FieldError>
      </Show>
    </RadioGroup.Root>
  );
}

/** A single yes or no with an explanation, in the same look as a choice card: Ark's checkbox. */
export function ChoiceCheck(props: {
  label: string;
  hint?: string;
  checked: boolean;
  onChange: (checked: boolean) => void;
  disabled?: boolean;
  id?: string;
}): JSX.Element {
  const titleId = createUniqueId();
  const hintId = createUniqueId();
  return (
    <Checkbox.Root
      class="rt-choice-card rt-choice-check"
      {...(props.id ? { ids: { hiddenInput: props.id } } : {})}
      checked={props.checked}
      disabled={props.disabled ?? false}
      onCheckedChange={(detail) => props.onChange(detail.checked === true)}
    >
      <Checkbox.Control class="rt-checkbox" />
      <span class="rt-choice-card-body">
        <Checkbox.Label class="rt-choice-card-title" id={titleId}>
          {props.label}
        </Checkbox.Label>
        <Show when={props.hint}>
          <span class="rt-choice-card-text" id={hintId}>
            {props.hint}
          </span>
        </Show>
      </span>
      <Checkbox.HiddenInput
        aria-labelledby={titleId}
        aria-describedby={props.hint ? hintId : undefined}
      />
    </Checkbox.Root>
  );
}
