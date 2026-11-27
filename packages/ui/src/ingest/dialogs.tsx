import { createEffect, createSignal, createUniqueId, For, on, Show } from "solid-js";
import { AccountPicker } from "../kit/account-picker";
import { Button } from "../button";
import { Dialog } from "../dialog";
import { ErrorSummary } from "../error-summary";
import { Notice } from "../notice";
import { DateField } from "../date-field";
import { TextArea } from "../text-field";
import { words } from "./words";
import type { AcceptMode, AccountOption, InboxSourceView } from "./types";

/** Ask why, then do it. Used to set lines aside and to return them to review: both keep the reason
 * with the lines, and both can be undone, so the dialog is a question and not a warning. */
export function ReasonDialog(props: {
  open: boolean;
  title: string;
  body: string;
  confirm: string;
  quick?: readonly string[];
  /** Said when the action applies to everything matching the filter. */
  scope?: string;
  busy?: boolean;
  onConfirm: (reason: string) => void;
  onClose: () => void;
}) {
  // Every dialog keeps its own field id: a closed dialog can stay mounted, and two fields with one id
  // would leave a label pointing at the wrong one.
  const REASON_FIELD = `${createUniqueId()}-reason`;
  const [reason, setReason] = createSignal("");
  const [attempt, setAttempt] = createSignal(0);
  const [error, setError] = createSignal("");
  createEffect(
    on(
      () => props.open,
      (open) => {
        if (open) {
          setReason("");
          setError("");
        }
      },
    ),
  );
  const submit = () => {
    if (reason().trim() === "") {
      setError(words.reasonRequired);
      setAttempt(attempt() + 1);
      return;
    }
    setError("");
    props.onConfirm(reason().trim());
  };
  return (
    <Dialog
      open={props.open}
      onOpenChange={(open) => !open && props.onClose()}
      title={props.title}
      description={props.body}
      closeLabel={words.close}
      footer={
        <>
          <Button variant="secondary" label={words.cancel} onClick={props.onClose} />
          <Button
            label={props.confirm}
            pending={props.busy ?? false}
            pendingLabel={words.working}
            onClick={submit}
          />
        </>
      }
    >
      <Show when={error()}>
        <ErrorSummary errors={[{ id: REASON_FIELD, message: error() }]} attempt={attempt()} />
      </Show>
      <Show when={props.scope}>
        <Notice title={props.scope ?? ""} tone="review" />
      </Show>
      <Show when={props.quick && props.quick.length > 0}>
        <ul class="rt-inbox-quick" aria-label="Common reasons">
          <For each={props.quick}>
            {(text) => (
              <li>
                <Button
                  variant="secondary"
                  size="sm"
                  label={text}
                  onClick={() => setReason(text)}
                />
              </li>
            )}
          </For>
        </ul>
      </Show>
      <TextArea
        id={REASON_FIELD}
        label={words.excludeReason}
        hint={words.excludeReasonHint}
        rows={3}
        required
        value={reason()}
        error={error()}
        onInput={(event) => setReason(event.currentTarget.value)}
      />
    </Dialog>
  );
}

/** Categorize several transactions at once to one category: each is recorded against it, or saved as a
 * draft when that is how the person chose to accept. */
export function CategorizeDialog(props: {
  open: boolean;
  count: number;
  accounts: readonly AccountOption[];
  /** Whether it records them or saves drafts; the words say which. */
  mode?: AcceptMode;
  scope?: string;
  busy?: boolean;
  onConfirm: (choice: { accountId: string; narration?: string }) => void;
  onClose: () => void;
}) {
  const [accountId, setAccountId] = createSignal("");
  const [narration, setNarration] = createSignal("");
  createEffect(
    on(
      () => props.open,
      (open) => {
        if (open) {
          setAccountId("");
          setNarration("");
        }
      },
    ),
  );
  return (
    <Dialog
      open={props.open}
      onOpenChange={(open) => !open && props.onClose()}
      title={words.categorizeDialogTitle(props.count)}
      description={
        props.mode === "draft" ? words.categorizeDialogBodyDraft : words.categorizeDialogBody
      }
      closeLabel={words.close}
      footer={
        <>
          <Button variant="secondary" label={words.cancel} onClick={props.onClose} />
          <Button
            label={
              props.mode === "draft"
                ? words.categorizeConfirmManyDraft(props.count)
                : words.categorizeConfirmMany(props.count)
            }
            disabled={accountId() === "" || (props.busy ?? false)}
            pending={props.busy ?? false}
            pendingLabel={words.working}
            onClick={() =>
              props.onConfirm({
                accountId: accountId(),
                ...(narration().trim() ? { narration: narration().trim() } : {}),
              })
            }
          />
        </>
      }
    >
      <Show when={props.scope}>
        <Notice title={props.scope ?? ""} tone="review" />
      </Show>
      <AccountPicker
        label={words.chooseAccount}
        accounts={props.accounts}
        value={accountId()}
        onChange={setAccountId}
      />
      <TextArea
        label={words.narration}
        rows={2}
        value={narration()}
        onInput={(event) => setNarration(event.currentTarget.value)}
      />
    </Dialog>
  );
}

/** Posting changes the books, so it asks once, plainly, and says what happens. */
export function PostDialog(props: {
  open: boolean;
  count: number;
  scope?: string;
  busy?: boolean;
  onConfirm: () => void;
  onClose: () => void;
}) {
  return (
    <Dialog
      open={props.open}
      onOpenChange={(open) => !open && props.onClose()}
      role="alertdialog"
      title={words.postDialogTitle(props.count)}
      description={words.postDialogBody}
      closeLabel={words.close}
      footer={
        <>
          <Button variant="secondary" label={words.cancel} onClick={props.onClose} />
          <Button
            label={words.postConfirm(props.count)}
            pending={props.busy ?? false}
            pendingLabel={words.working}
            onClick={props.onConfirm}
          />
        </>
      }
    >
      <Show when={props.scope}>
        <Notice title={props.scope ?? ""} tone="review" />
      </Show>
    </Dialog>
  );
}

/** A provider account's chart account and the first date that belongs in the books. */
export function SourceDialog(props: {
  open: boolean;
  source: InboxSourceView | null;
  /** How the provider account is named to a person. */
  sourceLabel: (source: InboxSourceView) => string;
  accounts: readonly AccountOption[];
  busy?: boolean;
  error?: string;
  onSave: (change: { ledgerAccountId?: string; startOn?: string }) => void;
  onClose: () => void;
}) {
  const [accountId, setAccountId] = createSignal("");
  const [startOn, setStartOn] = createSignal("");
  createEffect(
    on(
      () => [props.open, props.source] as const,
      ([open, source]) => {
        if (open) {
          setAccountId(source?.ledgerAccountId ?? "");
          setStartOn(source?.startOn ?? "");
        }
      },
    ),
  );
  const mapped = () => props.source?.ledgerAccountId != null;
  return (
    <Dialog
      open={props.open}
      onOpenChange={(open) => !open && props.onClose()}
      title={words.sourceDialogTitle}
      description={words.sourceDialogBody}
      closeLabel={words.close}
      footer={
        <>
          <Button variant="secondary" label={words.cancel} onClick={props.onClose} />
          <Button
            label={words.sourceSave}
            pending={props.busy ?? false}
            pendingLabel={words.sourceSaving}
            disabled={accountId() === "" && startOn() === ""}
            onClick={() =>
              props.onSave({
                ...(accountId() !== "" && accountId() !== props.source?.ledgerAccountId
                  ? { ledgerAccountId: accountId() }
                  : {}),
                ...(startOn() !== "" && startOn() !== props.source?.startOn
                  ? { startOn: startOn() }
                  : {}),
              })
            }
          />
        </>
      }
    >
      <Show when={props.error}>
        <Notice title={props.error ?? ""} tone="error" role="alert" />
      </Show>
      <Show when={props.source}>
        {(source) => (
          <p>
            <strong>
              <bdi>{props.sourceLabel(source())}</bdi>
            </strong>
          </p>
        )}
      </Show>
      <AccountPicker
        label={words.sourceChartAccount}
        accounts={props.accounts.filter(
          (account) => account.role === "asset" || account.role === "liability",
        )}
        value={accountId()}
        disabled={
          mapped() && (props.source?.counts.drafted ?? 0) + (props.source?.counts.posted ?? 0) > 0
        }
        onChange={setAccountId}
      />
      <DateField
        label={words.sourceStartOn}
        hint={words.sourceStartHint}
        value={startOn()}
        onChange={(value) => setStartOn(value)}
      />
    </Dialog>
  );
}
