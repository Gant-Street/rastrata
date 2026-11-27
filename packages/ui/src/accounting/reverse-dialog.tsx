import { createEffect, For, type JSX, on, Show } from "solid-js";
import { Button } from "../button";
import { Dialog } from "../dialog";
import { DateValue } from "../date-value";
import { formatFiguresInText } from "../format";
import { Money } from "../money";
import { Notice } from "../notice";
import { DateField } from "../date-field";
import { TextField } from "../text-field";
import { accountingWords } from "./words";

export type ReverseStage = "compose" | "working" | "review";

export interface ReverseDialogProps {
  open: boolean;
  /** The entry being reversed: its number ("No. 28"), what it says, its date and its amount. */
  label: string;
  description: string;
  entryDate: string;
  amount: string;
  /** What is typed. */
  date: string;
  onDate: (value: string) => void;
  reason: string;
  onReason: (value: string) => void;
  /** Said under the field that is wrong. */
  dateError?: string | undefined;
  reasonError?: string | undefined;
  /** `compose`: asking for a date and a reason. `working`: a request is on its way. `review`: the plan
   * has something to read before it is posted (a warning), and the person decides. */
  stage: ReverseStage;
  warnings: readonly string[];
  /** Why the reversal cannot be posted, when the service refused it. */
  problems: readonly string[];
  /** A request failed with nothing to review. */
  error?: string | undefined;
  /** A request was sent and never answered: it must be resumed, not repeated. */
  uncertain?: boolean | undefined;
  onResume?: (() => void) | undefined;
  /** What the host offers beside the form, such as extending the calendar for a date outside it. */
  extra?: JSX.Element | undefined;
  onSubmit: () => void;
  /** Post the reversal in review, with its warnings read. */
  onConfirm: () => void;
  onCancel: () => void;
  /** Where focus goes when the dialog closes (the button that opened it). */
  returnFocus?: (() => HTMLElement | null) | undefined;
}

/** Reversing an entry: say when and why, and it is posted. The original is never changed; a linked
 * entry cancels it, so the history keeps both. When the service has something to say first (an account
 * already reconciled, a date it cannot post to) the dialog shows it and waits for a decision. */
export function ReverseDialog(props: ReverseDialogProps): JSX.Element {
  const w = accountingWords.reverse;
  let reason: HTMLInputElement | undefined;
  createEffect(
    on(
      () => props.stage,
      (stage) => {
        // After a failed attempt the reason is where to look first.
        if (stage === "compose" && props.reasonError) reason?.focus();
      },
      { defer: true },
    ),
  );
  const working = () => props.stage === "working";
  const review = () => props.stage === "review";
  let form: HTMLFormElement | undefined;
  /** Send it. A form the host refuses (a date or a reason left empty) puts the cursor on the first
   * field that needs a word, so the next key goes where it is wanted. */
  const submit = () => {
    props.onSubmit();
    queueMicrotask(() => form?.querySelector<HTMLElement>('[aria-invalid="true"]')?.focus());
  };
  return (
    <Dialog
      open={props.open}
      onOpenChange={(open) => {
        if (!open && !working()) props.onCancel();
      }}
      title={w.title(props.label)}
      closeLabel={w.close}
      initialFocusEl={() => reason ?? null}
      {...(props.returnFocus ? { finalFocusEl: props.returnFocus } : {})}
      footer={
        <>
          <Button variant="quiet" label={w.cancel} disabled={working()} onClick={props.onCancel} />
          <Show
            when={review()}
            fallback={
              <Button
                label={w.submit}
                pending={working()}
                pendingLabel={w.working}
                disabled={props.uncertain === true}
                onClick={submit}
              />
            }
          >
            <Button
              label={w.confirmWarnings}
              disabled={props.problems.length > 0 || props.uncertain === true}
              onClick={props.onConfirm}
            />
          </Show>
        </>
      }
    >
      <p class="rt-reverse-summary">
        <bdi>{props.description}</bdi>
        <span class="rt-reverse-facts">
          <DateValue value={props.entryDate} /> · <Money value={props.amount} />
        </span>
      </p>
      <p class="rt-hint">{w.intro}</p>
      <form
        ref={form}
        class="rt-reverse-form"
        noValidate
        onSubmit={(event) => {
          event.preventDefault();
          if (working() || review()) return;
          submit();
        }}
      >
        <DateField
          label={w.date}
          hint={w.dateHint}
          required
          onEnter={() => form?.requestSubmit()}
          value={props.date}
          disabled={working() || review()}
          onChange={(value) => props.onDate(value)}
          {...(props.dateError ? { error: props.dateError } : {})}
        />
        <TextField
          label={w.reason}
          hint={w.reasonHint}
          required
          maxLength={500}
          ref={reason}
          value={props.reason}
          disabled={working() || review()}
          onInput={(event) => props.onReason(event.currentTarget.value)}
          // Two boxes to type in and no button inside the form: a browser would not send it on Enter.
          onKeyDown={(event) => {
            if (event.key !== "Enter" || event.isComposing) return;
            event.preventDefault();
            form?.requestSubmit();
          }}
          {...(props.reasonError ? { error: props.reasonError } : {})}
        />
      </form>
      <Show when={props.warnings.length > 0}>
        <Notice title={w.checkTitle} tone="attention" role="status">
          <ul>
            <For each={props.warnings}>{(warning) => <li>{formatFiguresInText(warning)}</li>}</For>
          </ul>
        </Notice>
      </Show>
      <Show when={props.problems.length > 0}>
        <Notice title={w.problemTitle} tone="problem" role="alert">
          <ul>
            <For each={props.problems}>{(problem) => <li>{formatFiguresInText(problem)}</li>}</For>
          </ul>
        </Notice>
      </Show>
      <Show when={props.error}>
        {(message) => (
          <Notice title={w.problemTitle} tone="problem" role="alert">
            <p>{message()}</p>
          </Notice>
        )}
      </Show>
      <Show when={props.uncertain}>
        <Notice title={w.waitingTitle} tone="attention" role="status">
          <p>{w.retained}</p>
          <Show when={props.onResume}>
            <Button
              variant="secondary"
              label={w.resume}
              disabled={working()}
              onClick={() => props.onResume?.()}
            />
          </Show>
        </Notice>
      </Show>
      {props.extra}
    </Dialog>
  );
}
