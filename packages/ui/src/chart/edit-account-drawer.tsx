import { createMemo, createSignal, For, Show, type JSX } from "solid-js";
import { CheckField } from "../accounting-controls";
import { chartWords } from "../accounting/chart-words";
import { Button } from "../button";
import { Dialog } from "../dialog";
import { Details } from "../kit/details";
import { Notice } from "../notice";
import { DateField } from "../date-field";
import { TextField } from "../text-field";
import { editAccountProblems, editSentence, type EditAccountValues } from "./account-form";
import { enterSubmits } from "./enter-submits";

export interface EditAccountDrawerProps {
  open: boolean;
  /** The account as it stands: its name is what a rename starts from, and what the footer names. */
  account: { readonly name: string; readonly code: string };
  values: EditAccountValues;
  onChange: (patch: Partial<EditAccountValues>) => void;
  stage: "compose" | "working" | "review";
  warnings: readonly string[];
  problems: readonly string[];
  error?: string | undefined;
  uncertain?: boolean | undefined;
  onResume?: (() => void) | undefined;
  onSubmit: () => void;
  onConfirm: () => void;
  onCancel: () => void;
  returnFocus?: (() => HTMLElement | null) | undefined;
  extra?: JSX.Element | undefined;
}

/** "Edit account": rename an account or close it. As in the new-account drawer the form is the review: its
 * footer says what saving will do, and its button does it. */
export function EditAccountDrawer(props: EditAccountDrawerProps): JSX.Element {
  const w = chartWords.edit;
  const v = () => props.values;
  const working = () => props.stage === "working";
  const review = () => props.stage === "review";
  const locked = () => working() || review();
  const problems = createMemo(() => editAccountProblems(v(), props.account));
  const [asked, setAsked] = createSignal(false);
  let nameInput: HTMLInputElement | undefined;
  const submit = () => {
    const found = problems();
    if (found.name || found.effectiveOn || found.nothing) {
      setAsked(true);
      queueMicrotask(() =>
        document
          .getElementById(
            found.name
              ? "edit-account-name"
              : found.effectiveOn
                ? "edit-account-date"
                : "edit-account-name",
          )
          ?.focus(),
      );
      return;
    }
    props.onSubmit();
  };
  return (
    <Dialog
      open={props.open}
      placement="end"
      title={w.title}
      description={w.description}
      closeLabel={w.close}
      onOpenChange={(open) => {
        if (!open && !working()) props.onCancel();
      }}
      initialFocusEl={() => nameInput ?? null}
      {...(props.returnFocus ? { finalFocusEl: props.returnFocus } : {})}
      footer={
        <div class="rt-account-drawer-foot">
          <p class="rt-account-summary">{editSentence(v(), props.account, problems())}</p>
          <div class="rt-account-drawer-actions">
            <Button
              variant="quiet"
              label={w.cancel}
              disabled={working()}
              onClick={props.onCancel}
            />
            <Show
              when={review()}
              fallback={
                <Button
                  label={v().close ? w.submitClose : w.submit}
                  pending={working()}
                  pendingLabel={w.working}
                  disabled={props.uncertain === true}
                  onClick={submit}
                />
              }
            >
              <Button
                label={w.confirm}
                disabled={props.problems.length > 0 || props.uncertain === true}
                onClick={props.onConfirm}
              />
            </Show>
          </div>
        </div>
      }
    >
      <form
        class="rt-account-form"
        noValidate
        onSubmit={(event) => {
          event.preventDefault();
          if (!locked()) submit();
        }}
        onKeyDown={(event) =>
          enterSubmits(event, () => {
            if (!locked()) submit();
          })
        }
      >
        <TextField
          id="edit-account-name"
          ref={nameInput}
          label={w.name}
          required
          maxLength={120}
          autocomplete="off"
          disabled={locked()}
          value={v().name}
          onInput={(event) => props.onChange({ name: event.currentTarget.value })}
          {...(asked() && problems().name ? { error: problems().name as string } : {})}
        />
        <div class="rt-account-close">
          <CheckField
            label={w.closeAccount}
            checked={v().close}
            disabled={locked()}
            onChange={(close) => props.onChange({ close })}
          />
          <p class="rt-hint">{w.closeHint}</p>
        </div>
        <Details summary={w.advanced}>
          <div class="rt-account-advanced">
            <DateField
              id="edit-account-date"
              label={w.effective}
              required
              disabled={locked()}
              value={v().effectiveOn}
              onChange={(value) => props.onChange({ effectiveOn: value })}
              {...(asked() && problems().effectiveOn
                ? { error: problems().effectiveOn as string }
                : {})}
            />
          </div>
        </Details>
      </form>
      <Show when={asked() && problems().nothing}>
        <p class="rt-hint" role="status">
          {problems().nothing}
        </p>
      </Show>
      <Show when={props.warnings.length > 0}>
        <Notice title={w.checkTitle} tone="attention" role="status">
          <ul>
            <For each={props.warnings}>{(warning) => <li>{warning}</li>}</For>
          </ul>
        </Notice>
      </Show>
      <Show when={props.problems.length > 0}>
        <Notice title={w.problemTitle} tone="problem" role="alert">
          <ul>
            <For each={props.problems}>{(problem) => <li>{problem}</li>}</For>
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
        <Notice title={chartWords.add.waitingTitle} tone="attention" role="status">
          <p>{chartWords.add.retained}</p>
          <Show when={props.onResume}>
            <Button
              variant="secondary"
              label={chartWords.resume}
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
