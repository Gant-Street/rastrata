import {
  createMemo,
  createSignal,
  createUniqueId,
  For,
  type JSX,
  Match,
  onMount,
  Show,
  Switch,
} from "solid-js";
import { CheckField } from "../accounting-controls";
import { Button } from "../button";
import { enterSubmits } from "../chart/enter-submits";
import { Dialog } from "../dialog";
import { ErrorSummary, type FormError } from "../error-summary";
import { ToneMarker } from "../kit";
import { Notice } from "../notice";
import { TextArea, TextField } from "../text-field";
import {
  formErrors,
  hasErrors,
  NAME_MAX,
  NOTE_MAX,
  type PayeeFormErrors,
  parseWords,
  testSentences,
  wouldRefuse,
} from "./logic";
import type { PayeeFormValues, PayeeTestData } from "./types";
import { words } from "./words";

/** `error` only when there is one: the fields take it as an optional string, not as undefined. */
const maybeError = (message: string | undefined): { error?: string } =>
  message ? { error: message } : {};

/** What the words typed so far would find, as the service last said it. A check that is under way keeps the
 * last answer in view, marked busy, so the sentences do not flash while a person types. */
function WhatTheyFind(props: {
  typed: boolean;
  test: PayeeTestData | undefined;
  checking: boolean;
  failed: boolean;
}): JSX.Element {
  const id = createUniqueId();
  const sentences = createMemo(() => (props.test ? testSentences(props.test) : []));
  return (
    <section
      class="rt-payees-test"
      aria-labelledby={id}
      aria-live="polite"
      aria-busy={props.checking}
    >
      <h3 id={id}>{words.testTitle}</h3>
      <Switch>
        <Match when={!props.typed}>
          <p class="rt-hint">{words.testIdle}</p>
        </Match>
        <Match when={props.test === undefined && props.failed}>
          <p class="rt-hint">{words.testFailed}</p>
        </Match>
        <Match when={props.test === undefined}>
          <p class="rt-hint">{words.testReading}</p>
        </Match>
        <Match when={props.test !== undefined}>
          <ul class="rt-payees-sentences" data-checking={props.checking ? "" : undefined}>
            <For each={sentences()}>
              {(sentence) => (
                <li>
                  <ToneMarker tone={sentence.tone} />
                  <span>{sentence.text}</span>
                </li>
              )}
            </For>
          </ul>
          <Show when={props.failed}>
            <p class="rt-hint">{words.testFailed}</p>
          </Show>
        </Match>
      </Switch>
    </section>
  );
}

/** Name a payee out of what a bank wrote, or change one: its name, the words that find it, a note and
 * whether it is retired. A side sheet, so the report stays in view behind it. Under the words it says what
 * they would find, before anything is saved: how many transactions, what moves from another payee, what
 * would be tied. A problem is said beside its field and in a summary that moves focus there; a refusal
 * from the service is shown above the form and every answer stays. Closing leaves nothing changed, and
 * saving posts nothing: only which row a transaction is in changes. */
export function PayeeDrawer(props: {
  mode: "name" | "edit";
  /** What the bank wrote, when the payee is being named out of it. */
  from?: string | undefined;
  initial: PayeeFormValues;
  /** The payee is also a 1099 vendor: its name and words are kept the same there. */
  hasTaxDetails?: boolean | undefined;
  /** What the words typed so far would find, as the service last said it. */
  test: PayeeTestData | undefined;
  /** A check is under way. */
  checking?: boolean | undefined;
  /** The last check could not be made. */
  checkFailed?: boolean | undefined;
  /** The words changed: ask what they would find. The page waits for a pause in typing. */
  onWords: (value: string) => void;
  saving?: boolean | undefined;
  /** What the service said when it refused or could not be reached. */
  failure?: string | undefined;
  /** A save was sent and its answer was lost: it is sent again as it was, never as a new one. */
  uncertain?: boolean | undefined;
  onSave: (values: PayeeFormValues) => void;
  onClose: () => void;
  /** Where focus goes when the sheet closes (the button that opened it). */
  returnFocus?: (() => HTMLElement | null) | undefined;
}): JSX.Element {
  const naming = () => props.mode === "name";
  const [values, setValues] = createSignal<PayeeFormValues>(props.initial);
  const [shown, setShown] = createSignal<PayeeFormErrors>({});
  const [attempt, setAttempt] = createSignal(0);
  let nameInput: HTMLInputElement | undefined;
  const dirty = () => {
    const now = values();
    const first = props.initial;
    return (
      now.name !== first.name ||
      now.words !== first.words ||
      now.note !== first.note ||
      now.retired !== first.retired
    );
  };
  onMount(() => {
    if (parseWords(props.initial.words).length > 0) props.onWords(props.initial.words);
  });
  /** A problem is said until the person changes what it is about: then it goes, and what is still wrong
   * stays said. */
  const set = <K extends keyof PayeeFormValues>(key: K, value: PayeeFormValues[K]) => {
    setValues((current) => ({ ...current, [key]: value }));
    if (key === "name") setShown((current) => ({ ...current, name: undefined }));
    if (key === "words") {
      setShown((current) => ({ ...current, words: undefined }));
      props.onWords(String(value));
    }
  };
  const summary = createMemo<FormError[]>(() => {
    const errors = shown();
    return (
      [
        ["name", errors.name],
        ["words", errors.words],
      ] as const
    ).flatMap(([id, message]) => (message ? [{ id: `payee-${id}`, message }] : []));
  });
  const blocked = () => wouldRefuse(props.test);
  const submit = () => {
    if (props.saving) return;
    const errors = formErrors(values(), naming());
    setShown(errors);
    if (hasErrors(errors)) {
      setAttempt((count) => count + 1);
      return;
    }
    props.onSave(values());
  };
  return (
    <Dialog
      open
      placement="end"
      title={naming() ? words.nameTitle : words.changeTitle}
      closeLabel={words.closeDialog}
      class="rt-payees-sheet rt-payees-formsheet"
      closeOnInteractOutside={!dirty()}
      onOpenChange={(open) => {
        if (!open && !props.saving) props.onClose();
      }}
      initialFocusEl={() => nameInput ?? null}
      {...(props.returnFocus ? { finalFocusEl: props.returnFocus } : {})}
      footer={
        <>
          <Button
            variant="quiet"
            label={words.cancel}
            disabled={props.saving ?? false}
            onClick={props.onClose}
          />
          <Button
            variant="primary"
            label={naming() ? words.saveAndName : words.save}
            pending={props.saving ?? false}
            pendingLabel={words.saving}
            disabled={blocked()}
            onClick={submit}
          />
        </>
      }
    >
      <form
        class="rt-payees-form"
        noValidate
        onSubmit={(event) => {
          event.preventDefault();
          submit();
        }}
        onKeyDown={(event) => enterSubmits(event, submit)}
      >
        <Show when={props.from}>
          <p class="rt-payees-from">
            <span class="rt-payees-from-label">{words.nameFrom}</span>
            <span class="rt-payees-text">{props.from}</span>
          </p>
        </Show>
        <Show when={props.failure}>
          <Notice title={props.failure ?? ""} tone="error" role="alert" />
        </Show>
        <Show when={props.uncertain}>
          <Notice title={words.uncertain} tone="attention" role="status" />
        </Show>
        <Show when={summary().length > 0}>
          <ErrorSummary errors={summary()} attempt={attempt()} title={words.errorsTitle} />
        </Show>
        <TextField
          id="payee-name"
          ref={(element: HTMLInputElement) => {
            nameInput = element;
          }}
          label={words.fieldName}
          hint={words.fieldNameHint}
          value={values().name}
          maxLength={NAME_MAX}
          autocomplete="off"
          required
          {...maybeError(shown().name)}
          onInput={(event) => set("name", event.currentTarget.value)}
        />
        <TextArea
          id="payee-words"
          label={words.fieldWords}
          hint={words.fieldWordsHint}
          rows={3}
          value={values().words}
          autocomplete="off"
          spellcheck={false}
          {...maybeError(shown().words)}
          onInput={(event) => set("words", event.currentTarget.value)}
        />
        <WhatTheyFind
          typed={parseWords(values().words).length > 0}
          test={props.test}
          checking={props.checking ?? false}
          failed={props.checkFailed ?? false}
        />
        <TextArea
          id="payee-note"
          label={words.fieldNote}
          hint={words.fieldNoteHint}
          rows={2}
          maxLength={NOTE_MAX}
          value={values().note}
          onInput={(event) => set("note", event.currentTarget.value)}
        />
        <Show when={!naming()}>
          <div class="rt-payees-retired">
            <CheckField
              label={words.fieldRetired}
              checked={values().retired}
              onChange={(retired) => set("retired", retired)}
            />
            <p class="rt-hint">{words.fieldRetiredHint}</p>
          </div>
        </Show>
        <Show when={props.hasTaxDetails}>
          <p class="rt-hint">{words.formTax}</p>
        </Show>
      </form>
    </Dialog>
  );
}
