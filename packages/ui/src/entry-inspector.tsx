import { Dialog as ArkDialog } from "@ark-ui/solid/dialog";
import { createEffect, createSignal, For, on, onCleanup, onMount, Show } from "solid-js";
import { Portal } from "solid-js/web";
import { Button } from "./button";
import { Dialog } from "./dialog";
import { Details, DetailsList } from "./kit/details";
import { Money } from "./money";
import { Notice, Status } from "./notice";
import { TextField } from "./text-field";
import { useUi } from "./locale";
import type {
  AccountChoice,
  DraftSaveResult,
  JournalContext,
  RegisterEntry,
  RowAction,
} from "./accounting-types";
import { DateValue } from "./date-value";

/**
 * Displays supplied accounting facts. Persistence and audit history belong to the caller.
 * The inspector resets itself when it is given a different entry.
 */
export function EntryInspector(props: {
  entry: RegisterEntry;
  open: boolean;
  returnFocus: () => HTMLElement | null;
  onClose: () => void;
  onSave?: ((entry: RegisterEntry, reference: string) => Promise<DraftSaveResult>) | undefined;
  accounts: readonly AccountChoice[];
  context: JournalContext;
  detailHref?: string | undefined;
  /** What can be done to this entry, as buttons under its title (for example Reverse). */
  actions?: readonly RowAction[];
  /** Ctrl/Cmd+S saves the draft. Turn off if the host page owns that shortcut. */
  shortcuts?: boolean;
  /** Friendlier name shown as the title; the full ID is then shown beneath it. */
  entryLabel?: (entry: RegisterEntry) => string;
}) {
  const ui = useUi();
  const m = () => ui.messages.inspector;
  const [reference, setReference] = createSignal(props.entry.reference);
  const [savedEntry, setSavedEntry] = createSignal(props.entry);
  const [saveState, setSaveState] = createSignal<"idle" | "saving" | "saved" | "error" | "unknown">(
    "idle",
  );
  const [confirmLeave, setConfirmLeave] = createSignal(false);
  const [accountId, setAccountId] = createSignal("");
  // Validation waits until the person has left the field, so typing is never scolded.
  const [touched, setTouched] = createSignal(false);
  const history = () => savedEntry().history;
  const label = () => props.entryLabel?.(props.entry) ?? props.entry.id;
  let disposed = false;
  let keepEditing: HTMLButtonElement | undefined;
  let closeButton: HTMLButtonElement | undefined;
  let accountHeading: HTMLHeadingElement | undefined;
  const accountButtons = new Map<string, HTMLButtonElement>();
  const dirty = () => reference() !== savedEntry().reference;
  const saving = () => saveState() === "saving";
  const editable = () => props.entry.status === "Draft" && !!props.onSave;
  const uncertain = () => saveState() === "unknown";
  const empty = () => !reference().trim();
  const selectedAccount = () => props.accounts.find((account) => account.value === accountId());
  const accountLabel = (accountId: string) =>
    props.accounts.find((account) => account.value === accountId)?.label ?? accountId;
  const linesTitle = () =>
    props.entry.status === "Draft"
      ? m().draftLines(props.context.currency)
      : m().postedLines(props.context.currency);
  const beforeUnload = (event: BeforeUnloadEvent) => {
    if (props.open && dirty()) {
      event.preventDefault();
      event.returnValue = "";
    }
  };
  onMount(() => window.addEventListener("beforeunload", beforeUnload));
  onCleanup(() => {
    window.removeEventListener("beforeunload", beforeUnload);
    disposed = true;
  });
  // A different entry starts clean; the same entry keeps the person's work.
  createEffect(
    on(
      () => props.entry.id,
      () => {
        setReference(props.entry.reference);
        setSavedEntry(props.entry);
        setSaveState("idle");
        setConfirmLeave(false);
        setAccountId("");
        setTouched(false);
      },
      { defer: true },
    ),
  );
  const close = () => {
    if (saving()) return;
    if (dirty()) setConfirmLeave(true);
    else props.onClose();
  };
  const finishClose = () => {
    setConfirmLeave(false);
    props.onClose();
  };
  const revert = () => {
    setReference(savedEntry().reference);
    setSaveState("idle");
    setTouched(false);
  };
  const save = async (leave = false) => {
    if (saving() || uncertain() || !dirty() || empty() || !editable() || !props.onSave) return;
    const submitted = reference();
    setSaveState("saving");
    let result: DraftSaveResult;
    try {
      result = await props.onSave(savedEntry(), submitted);
    } catch {
      result = { status: "unknown" };
    }
    if (disposed) return;
    if (result.status !== "saved") {
      setSaveState(result.status === "rejected" ? "error" : "unknown");
      return;
    }
    setReference(result.entry.reference);
    setSavedEntry(result.entry);
    setSaveState("saved");
    if (leave) finishClose();
  };
  const statusText = () =>
    saving()
      ? m().saving
      : uncertain()
        ? m().saveUnknown
        : dirty()
          ? empty()
            ? m().referenceRequired
            : m().unsaved
          : saveState() === "saved"
            ? props.context.savedMessage
            : m().noUnsaved;
  return (
    <ArkDialog.Root
      open={props.open}
      onOpenChange={(detail) => {
        if (!detail.open) close();
      }}
      initialFocusEl={() => closeButton ?? null}
      finalFocusEl={props.returnFocus}
    >
      <Portal>
        <ArkDialog.Backdrop class="rt-backdrop" />
        <ArkDialog.Positioner class="rt-positioner rt-inspector-positioner">
          <ArkDialog.Content
            class="rt-dialog rt-theme rt-inspector"
            onKeyDown={(event) => {
              if (
                props.shortcuts !== false &&
                (event.metaKey || event.ctrlKey) &&
                event.key.toLowerCase() === "s" &&
                editable()
              ) {
                event.preventDefault();
                void save();
              }
            }}
          >
            <div class="rt-inspector-header">
              <div class="rt-inspector-title-row">
                <div class="rt-inspector-title-group">
                  <ArkDialog.Title>
                    <bdi>{label()}</bdi>
                  </ArkDialog.Title>
                  <Status>{ui.messages.status[props.entry.status] ?? props.entry.status}</Status>
                </div>
                <Button
                  ref={closeButton}
                  variant="secondary"
                  size="sm"
                  label={m().back}
                  onClick={close}
                  disabled={saving()}
                />
              </div>
              {/* The identifier that names the entry in the book is machine detail: one click away. */}
              <Show when={label() !== props.entry.id}>
                <div class="rt-inspector-details">
                  <Details summary={m().details}>
                    <DetailsList
                      items={[
                        { label: m().entryId, value: props.entry.id, mono: true, copy: true },
                      ]}
                    />
                  </Details>
                </div>
              </Show>
              <Show when={(props.actions ?? []).length > 0}>
                <div class="rt-inspector-actions">
                  <For each={props.actions}>
                    {(action) => (
                      <Button
                        variant="secondary"
                        size="sm"
                        label={action.label}
                        onClick={() => action.onSelect()}
                      />
                    )}
                  </For>
                </div>
              </Show>
              <ArkDialog.Description class="rt-inspector-description">
                {/* Each value is isolated so Arabic, Latin and digits never reorder each other. */}
                <bdi>{props.context.bookName}</bdi> · <DateValue value={props.entry.isoDate} /> ·{" "}
                <bdi>{props.context.currency}</bdi>. <bdi>{props.context.description}</bdi>
              </ArkDialog.Description>
              <div class="rt-inspector-meta-strip">
                <div class="rt-inspector-meta-item">
                  <span class="rt-inspector-meta-label">{m().postingDate}</span>
                  <strong class="rt-inspector-meta-value">
                    <DateValue value={props.entry.isoDate} />
                  </strong>
                </div>
                <div class="rt-inspector-meta-item">
                  <span class="rt-inspector-meta-label">{m().currency}</span>
                  <strong class="rt-inspector-meta-value">
                    <bdi>{props.context.currency}</bdi>
                  </strong>
                </div>
                <div class="rt-inspector-meta-item">
                  <span class="rt-inspector-meta-label">{m().totalAmount}</span>
                  <strong class="rt-inspector-meta-value">
                    <Money value={props.entry.amount} />
                  </strong>
                </div>
              </div>
            </div>

            <Show
              when={selectedAccount()}
              fallback={
                <div class="rt-inspector-body rt-stack">
                  <Show when={!editable()}>
                    <div class="rt-inspector-readonly-banner">
                      {props.entry.status === "Posted" ? m().postedReadOnly : m().draftReadOnly}
                    </div>
                  </Show>
                  <form
                    onSubmit={(event) => {
                      event.preventDefault();
                      setTouched(true);
                      void save();
                    }}
                    class="rt-inspector-form-card rt-stack"
                  >
                    <TextField
                      label={m().reference}
                      help={editable() ? m().referenceHelp : undefined}
                      value={reference()}
                      readOnly={!editable()}
                      disabled={saving() || uncertain()}
                      required
                      error={touched() && empty() ? m().referenceRequired : ""}
                      onBlur={() => setTouched(true)}
                      onInput={(event) => {
                        setReference(event.currentTarget.value);
                        setSaveState("idle");
                      }}
                    />
                    <Show when={editable()}>
                      <div class="rt-save-bar">
                        <p
                          role="status"
                          class="rt-inspector-save-status"
                          data-dirty={dirty() ? "" : undefined}
                        >
                          {statusText()}
                        </p>
                        <div class="rt-row">
                          <Show when={dirty() && !saving() && !uncertain()}>
                            <Button variant="quiet" size="sm" label={m().revert} onClick={revert} />
                          </Show>
                          <Button
                            type="submit"
                            label={m().saveDraft}
                            pending={saving()}
                            pendingLabel={m().saving}
                            disabled={!dirty() || uncertain() || empty()}
                          />
                        </div>
                      </div>
                      <Show when={saveState() === "error"}>
                        <Notice tone="error" title={m().saveFailedTitle}>
                          <p>{m().saveFailedBody}</p>
                        </Notice>
                      </Show>
                    </Show>
                    <Show when={uncertain()}>
                      <Notice tone="error" title={m().unknownTitle}>
                        {m().unknownBody}
                      </Notice>
                    </Show>
                  </form>

                  <Show when={props.detailHref}>
                    {(href) => (
                      <a href={href()}>
                        {props.entry.status === "Draft" ? m().editDraft : m().viewEntry}
                      </a>
                    )}
                  </Show>
                  <div class="rt-inspector-section">
                    <div class="rt-inspector-section-head">
                      <h3>{linesTitle()}</h3>
                      <span class="rt-inspector-section-note">{m().selectAccount}</span>
                    </div>
                    <section class="rt-table-scroll" tabindex={0} aria-label={m().linesScroll}>
                      <table class="rt-table">
                        <caption class="rt-sr-only">{linesTitle()}</caption>
                        <thead>
                          <tr>
                            <th scope="col">{m().columnAccount}</th>
                            <th scope="col" class="rt-number">
                              {m().columnDebit}
                            </th>
                            <th scope="col" class="rt-number">
                              {m().columnCredit}
                            </th>
                          </tr>
                        </thead>
                        <tbody>
                          <For each={props.entry.lines}>
                            {(line) => (
                              <tr>
                                <th scope="row">
                                  <button
                                    ref={(element) => accountButtons.set(line.accountId, element)}
                                    type="button"
                                    class="rt-text-button rt-inspector-account-btn"
                                    disabled={
                                      !props.accounts.some(
                                        (account) => account.value === line.accountId,
                                      )
                                    }
                                    onClick={() => {
                                      setAccountId(line.accountId);
                                      queueMicrotask(() => accountHeading?.focus());
                                    }}
                                  >
                                    <bdi>{accountLabel(line.accountId)}</bdi>
                                  </button>
                                </th>
                                <td class="rt-number">
                                  <Show when={line.debit}>
                                    {(value) => <Money value={value()} />}
                                  </Show>
                                </td>
                                <td class="rt-number">
                                  <Show when={line.credit}>
                                    {(value) => <Money value={value()} />}
                                  </Show>
                                </td>
                              </tr>
                            )}
                          </For>
                        </tbody>
                        <tfoot>
                          <tr>
                            <th scope="row">{m().total}</th>
                            <td class="rt-number">
                              <Money value={props.entry.debitTotal} />
                            </td>
                            <td class="rt-number">
                              <Money value={props.entry.creditTotal} />
                            </td>
                          </tr>
                        </tfoot>
                      </table>
                    </section>
                  </div>

                  <section class="rt-inspector-section" aria-label={m().historyRegion}>
                    <div class="rt-inspector-section-head">
                      <h3>{m().history}</h3>
                      <span class="rt-inspector-section-note">{m().auditTrail}</span>
                    </div>
                    <ol class="rt-history">
                      <For each={history()}>
                        {(event) => (
                          <li>
                            <time datetime={event.isoAt}>
                              <bdi>{event.at}</bdi>
                            </time>
                            <span>{event.description}</span>
                          </li>
                        )}
                      </For>
                    </ol>
                  </section>
                </div>
              }
            >
              {(account) => (
                <section class="rt-inspector-account-card rt-stack">
                  <div>
                    <Button
                      variant="secondary"
                      size="sm"
                      label={m().backToEntry}
                      onClick={() => {
                        const id = accountId();
                        setAccountId("");
                        queueMicrotask(() => accountButtons.get(id)?.focus());
                      }}
                    />
                  </div>
                  <div class="rt-inspector-account-detail">
                    <span class="rt-inspector-meta-label">{m().accountContext}</span>
                    <h3 ref={accountHeading} tabindex={-1}>
                      <bdi>{account().label}</bdi>
                    </h3>
                    <p class="rt-inspector-account-path">
                      <bdi>{account().path}</bdi>
                    </p>
                    <p class="rt-hint">{m().accountId(account().value)}</p>
                    <p class="rt-inspector-account-note">{m().accountNote(label())}</p>
                  </div>
                </section>
              )}
            </Show>

            <Dialog
              role="alertdialog"
              portal={false}
              class="rt-leave-dialog"
              open={confirmLeave()}
              onOpenChange={(open) => {
                if (!saving()) setConfirmLeave(open);
              }}
              initialFocusEl={() => keepEditing ?? null}
              title={m().leaveTitle}
              description={m().leaveBody(label())}
              footer={
                <div class="rt-leave-actions">
                  <Button
                    ref={keepEditing}
                    variant="secondary"
                    label={m().keepEditing}
                    disabled={saving()}
                    onClick={() => setConfirmLeave(false)}
                  />
                  <Button
                    label={m().discard}
                    variant="danger"
                    disabled={saving()}
                    onClick={finishClose}
                  />
                  <Button
                    label={m().saveAndLeave}
                    pending={saving()}
                    pendingLabel={m().saving}
                    disabled={uncertain() || empty()}
                    onClick={() => void save(true)}
                  />
                </div>
              }
            >
              <Show when={saveState() === "error"}>
                <Notice tone="error" title={m().saveFailedTitle}>
                  {m().leaveFailedBody}
                </Notice>
              </Show>
              <p role="status" class="rt-inspector-leave-status">
                {saving() ? m().saving : ""}
              </p>
              <Show when={uncertain()}>
                <Notice tone="error" title={m().unknownTitle}>
                  {m().leaveUnknownBody}
                </Notice>
              </Show>
            </Dialog>
          </ArkDialog.Content>
        </ArkDialog.Positioner>
      </Portal>
    </ArkDialog.Root>
  );
}
