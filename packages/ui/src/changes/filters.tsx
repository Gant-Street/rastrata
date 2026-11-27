import { createEffect, createMemo, createSignal, onCleanup, untrack } from "solid-js";
import { SelectField } from "../select-field";
import { TextField } from "../text-field";
import { type Choice, sinceChoices, whatChoices, whoChoices } from "./logic";
import type { MakerCountView, MakerView } from "./types";
import {
  isSinceChoice,
  isStartDate,
  isWhatGroup,
  type ChangesScreenState,
  SEARCH_MAX,
} from "./url-state";
import { words } from "./words";

/** The select needs a value for "anyone" and "everything" that is not empty text. */
const NOTHING = "-";
const asItem = (choice: Choice) => ({
  label: choice.label,
  value: choice.value === "" ? NOTHING : choice.value,
});

/** How long to wait after the last key before the words are looked for. */
export const SEARCH_DELAY_MS = 300;

/** What to show: where the list starts, who made the changes, what kind they are and the words to find.
 * A choice takes effect at once, and the words a moment after the last key (or at Enter). Every choice
 * is a list the person can read in full: nothing here is typed in a format it has to guess. */
export function ChangesFilters(props: {
  state: ChangesScreenState;
  actors: readonly MakerCountView[];
  caller?: MakerView | undefined;
  onChange: (patch: Partial<ChangesScreenState>) => void;
}) {
  const [typed, setTyped] = createSignal(props.state.text);
  let timer: ReturnType<typeof setTimeout> | undefined;
  const plain = (value: string) => value.replace(/\s+/g, " ").trim().slice(0, SEARCH_MAX);
  // Words changed from outside (the choices were cleared) replace what is in the box. What the person
  // is typing is left alone, spaces and all, while it says what the state says.
  createEffect(() => {
    const text = props.state.text;
    if (plain(untrack(typed)) !== text) setTyped(text);
  });
  onCleanup(() => clearTimeout(timer));

  const send = (value: string) => {
    clearTimeout(timer);
    const text = plain(value);
    if (text !== props.state.text) props.onChange({ text });
  };
  const type = (value: string) => {
    setTyped(value);
    clearTimeout(timer);
    timer = setTimeout(() => send(value), SEARCH_DELAY_MS);
  };

  const since = createMemo(() => sinceChoices(props.state.since).map(asItem));
  const who = createMemo(() => whoChoices(props.actors, props.caller, props.state.who).map(asItem));
  const what = createMemo(() => whatChoices().map(asItem));

  return (
    <form
      class="rt-changes-filters"
      aria-label={words.filtersLabel}
      onSubmit={(event) => {
        event.preventDefault();
        send(typed());
      }}
    >
      <SelectField
        label={words.since}
        items={since()}
        value={props.state.since}
        onChange={(value) => {
          if (value !== props.state.since && (isSinceChoice(value) || isStartDate(value)))
            props.onChange({ since: value });
        }}
      />
      <SelectField
        label={words.who}
        items={who()}
        value={props.state.who === "" ? NOTHING : props.state.who}
        onChange={(value) => {
          const next = value === NOTHING ? "" : value;
          if (next !== props.state.who) props.onChange({ who: next });
        }}
      />
      <SelectField
        label={words.what}
        items={what()}
        value={props.state.what === "" ? NOTHING : props.state.what}
        onChange={(value) => {
          const next = value === NOTHING ? "" : value;
          if (next !== props.state.what && (next === "" || isWhatGroup(next)))
            props.onChange({ what: next });
        }}
      />
      <TextField
        label={words.search}
        type="search"
        name="q"
        maxLength={SEARCH_MAX}
        autocomplete="off"
        value={typed()}
        onInput={(event) => type(event.currentTarget.value)}
      />
    </form>
  );
}
