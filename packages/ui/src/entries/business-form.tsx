import { createEffect, createMemo, createSignal, createUniqueId, on, Show } from "solid-js";
import { CheckField } from "../accounting-controls";
import { Button } from "../button";
import { ErrorSummary, type FormError } from "../error-summary";
import { Notice } from "../notice";
import { SelectField } from "../select-field";
import { TextField } from "../text-field";
import { cleanEntryText } from "./quick-entry";
import { businessWords as words } from "./words";

export type BusinessDateFormat = "medium" | "numeric" | "iso";
export type BusinessAcceptMode = "post" | "draft";

/** What the form edits: the business name and how the app shows things. */
export interface BusinessValues {
  readonly name: string;
  readonly dateFormat: BusinessDateFormat;
  readonly showAccountNumbers: boolean;
  readonly acceptMode: BusinessAcceptMode;
}

const MAX_NAME = 120;

/** What differs between what the book has and what the form holds, ready to send: only the names of
 * what changed. A name that differs only in spacing is not a change. */
export function changesIn(saved: BusinessValues, wanted: BusinessValues): Partial<BusinessValues> {
  const name = cleanEntryText(wanted.name, MAX_NAME);
  return {
    ...(name !== cleanEntryText(saved.name, MAX_NAME) ? { name } : {}),
    ...(wanted.dateFormat !== saved.dateFormat ? { dateFormat: wanted.dateFormat } : {}),
    ...(wanted.showAccountNumbers !== saved.showAccountNumbers
      ? { showAccountNumbers: wanted.showAccountNumbers }
      : {}),
    ...(wanted.acceptMode !== saved.acceptMode ? { acceptMode: wanted.acceptMode } : {}),
  };
}

/** The business name, how dates read, whether lists show account numbers and what accepting a suggestion
 * does. The parent saves and passes back what the book now holds as `saved`; the form keeps what is being
 * typed until then, and says plainly when there is nothing to save. */
export function BusinessSettingsForm(props: {
  saved: BusinessValues;
  pending?: boolean | undefined;
  /** What happened last, read out politely: "Saved." */
  message?: string | undefined;
  /** A refusal in words. */
  error?: string | undefined;
  /** An earlier save whose reply was lost: resume it, never save again. */
  uncertain?: boolean | undefined;
  onResume?: () => void;
  /** An example date for each format, rendered by the formatter. */
  dateExamples?: Partial<Record<BusinessDateFormat, string>> | undefined;
  onSave: (values: BusinessValues) => void;
}) {
  const uid = createUniqueId();
  const nameId = `${uid}-name`;
  const [name, setName] = createSignal(props.saved.name);
  const [dateFormat, setDateFormat] = createSignal<BusinessDateFormat>(props.saved.dateFormat);
  const [accountNumbers, setAccountNumbers] = createSignal(props.saved.showAccountNumbers);
  const [acceptMode, setAcceptMode] = createSignal<BusinessAcceptMode>(props.saved.acceptMode);
  const [attempt, setAttempt] = createSignal(0);
  const [problem, setProblem] = createSignal<string | undefined>(undefined);

  // What the book holds changed (it was saved, or read again): the form holds that now.
  createEffect(
    on(
      () => props.saved,
      (saved) => {
        setName(saved.name);
        setDateFormat(saved.dateFormat);
        setAccountNumbers(saved.showAccountNumbers);
        setAcceptMode(saved.acceptMode);
        setProblem(undefined);
      },
      { defer: true },
    ),
  );

  const wanted = (): BusinessValues => ({
    name: name(),
    dateFormat: dateFormat(),
    showAccountNumbers: accountNumbers(),
    acceptMode: acceptMode(),
  });
  const changed = createMemo(() => Object.keys(changesIn(props.saved, wanted())).length > 0);

  const submit = (event: SubmitEvent) => {
    event.preventDefault();
    if (props.pending) return;
    const clean = cleanEntryText(name(), MAX_NAME);
    if (clean.length < 2) {
      setProblem(words.nameRequired);
      setAttempt((count) => count + 1);
      return;
    }
    setProblem(undefined);
    if (!changed()) return;
    props.onSave({ ...wanted(), name: clean });
  };

  const items = (): { value: BusinessDateFormat; label: string }[] =>
    (["medium", "numeric", "iso"] as const).map((value) => {
      const example = props.dateExamples?.[value];
      return {
        value,
        label: example ? `${words.dateOptions[value]} (${example})` : words.dateOptions[value],
      };
    });
  const errors = (): FormError[] =>
    problem() ? [{ id: nameId, message: problem() as string }] : [];

  return (
    <form class="rt-business-form rt-stack" onSubmit={submit} novalidate aria-label={words.title}>
      <Show when={errors().length > 0}>
        <ErrorSummary errors={errors()} title="Fix this before you save" attempt={attempt()} />
      </Show>
      <Show when={props.error}>
        <Notice title={words.failed} tone="error" role="alert">
          {props.error}
        </Notice>
      </Show>
      <Show when={props.uncertain}>
        <Notice title={words.uncertain} tone="review" role="status">
          <Button
            type="button"
            label={words.resume}
            variant="secondary"
            size="sm"
            onClick={() => props.onResume?.()}
          />
        </Notice>
      </Show>
      <TextField
        id={nameId}
        label={words.nameLabel}
        autocomplete="organization"
        maxLength={MAX_NAME}
        required
        disabled={props.pending ?? false}
        value={name()}
        onInput={(event) => setName(event.currentTarget.value)}
        {...(problem() ? { error: problem() as string } : {})}
      />
      <SelectField
        label={words.dateLabel}
        items={items()}
        value={dateFormat()}
        onChange={(value) => setDateFormat(value as BusinessDateFormat)}
        disabled={props.pending ?? false}
      />
      <CheckField
        label={words.accountNumbersLabel}
        checked={accountNumbers()}
        onChange={setAccountNumbers}
        disabled={props.pending ?? false}
      />
      <SelectField
        label={words.acceptLabel}
        items={[
          { value: "post", label: words.acceptOptions.post },
          { value: "draft", label: words.acceptOptions.draft },
        ]}
        value={acceptMode()}
        onChange={(value) => setAcceptMode(value as BusinessAcceptMode)}
        disabled={props.pending ?? false}
      />
      <div class="rt-row">
        <Button
          type="submit"
          label={words.save}
          pendingLabel={words.saving}
          pending={props.pending ?? false}
          disabled={!changed() && !props.pending}
        />
        <Show when={props.message}>
          <p class="rt-business-status" role="status">
            {props.message}
          </p>
        </Show>
      </div>
    </form>
  );
}
