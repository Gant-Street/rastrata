import {
  createEffect,
  createMemo,
  createSignal,
  createUniqueId,
  For,
  on,
  onMount,
  Show,
  type JSX,
} from "solid-js";
import { Button } from "../button";
import { Dialog } from "../dialog";
import { ErrorSummary, type FormError } from "../error-summary";
import { AccountPicker, type AccountOption } from "../kit/account-picker";
import { Notice } from "../notice";
import { Segment } from "../segment";
import { DateField } from "../date-field";
import { TextField } from "../text-field";
import {
  emptyQuickValues,
  parseEntryAmount,
  QUICK_KINDS,
  QUICK_PRESETS,
  quickChoices,
  quickLabels,
  quickPresetAccount,
  quickPreview,
  quickPreviewSentence,
  quickProblems,
  quickSwitchKind,
  type QuickAccount,
  type QuickField,
  type QuickKind,
  type QuickPreset,
  type QuickSide,
  type QuickValues,
} from "./quick-entry";
import { quickWords as words } from "./words";

export interface QuickEntryDialogProps {
  kind: QuickKind;
  /** Given, the form is "New transaction" with a switch for its kind at the top, and this is told when the
   * person changes it (the parent then gives the new `kind`). What was typed is kept where it still fits. */
  onKind?: ((kind: QuickKind) => void) | undefined;
  open: boolean;
  onClose: () => void;
  /** The chart; `undefined` while it is being read. */
  accounts: readonly QuickAccount[] | undefined;
  /** The chart could not be read. */
  failed?: boolean;
  onRetry?: () => void;
  /** Where the date starts: today, held inside the book's calendar. `undefined` until it is known. */
  today: string | undefined;
  /** Which save is under way. Both buttons wait while one is. */
  pending?: "post" | "draft" | undefined;
  /** The books' own words when they refused, or what went wrong. */
  error?: string | undefined;
  /** An earlier request whose reply was lost: resume it, never start another. */
  uncertain?: boolean;
  onResume?: () => void;
  /** Start with a preset applied ("Owner took money out"). */
  preset?: QuickPreset | undefined;
  onPost: (values: QuickValues) => void;
  onSaveDraft: (values: QuickValues) => void;
}

/** Spend money, Receive money and Transfer in one dialog: pick the accounts, say how much, read what it
 * will record in plain words, then post it or keep it as a draft. Nothing in the books changes until Post.
 * With `onKind` it is the one form "+ New, Transaction" opens: the three are a switch at its top.
 *
 * The fields scroll and the line that says what will be recorded stays beside the buttons, so the entry
 * is always in view when it is posted. The fields run in the order a person says it in (where the money
 * moved, who with, what for, how much) and two to a row where there is room. */
export function QuickEntryDialog(props: QuickEntryDialogProps) {
  const uid = createUniqueId();
  const formId = `${uid}-form`;
  const ids: Record<QuickField, string> = {
    date: `${uid}-date`,
    from: `${uid}-from`,
    to: `${uid}-to`,
    amount: `${uid}-amount`,
  };
  const [values, setValues] = createSignal<QuickValues>(emptyQuickValues(props.today ?? ""));
  const [dateTouched, setDateTouched] = createSignal(false);
  const [attempt, setAttempt] = createSignal(0);
  const [attempted, setAttempted] = createSignal(false);
  const [presetOn, setPresetOn] = createSignal<QuickPreset | null>(null);
  const [presetMissing, setPresetMissing] = createSignal(false);
  const set = (change: Partial<QuickValues>) => setValues((now) => ({ ...now, ...change }));

  // The date starts at today once the calendar is known, unless the person has chosen one already.
  createEffect(
    on(
      () => props.today,
      (today) => {
        if (today && !dateTouched()) set({ date: today });
      },
    ),
  );

  const accounts = () => props.accounts ?? [];
  const labels = () => quickLabels(props.kind);
  const problems = createMemo(() => quickProblems(props.kind, values()));
  const shown = (field: QuickField): string | undefined =>
    attempted() ? problems().find((problem) => problem.field === field)?.message : undefined;
  const summary = (): FormError[] =>
    problems().map((problem) => ({ id: ids[problem.field], message: problem.message }));
  const preview = createMemo(() => quickPreview(values(), accounts()));
  const busy = () => props.pending !== undefined;

  // The account the money moves through comes first (paid from, deposit to, from); the other is the
  // category (or, for a transfer, the account it goes to).
  const bankSide = (): QuickSide => (props.kind === "receive" ? "to" : "from");
  const otherSide = (): QuickSide => (bankSide() === "from" ? "to" : "from");

  // A book with one bank account has only one answer for the account the money moves through.
  createEffect(() => {
    if (!props.accounts) return;
    const side = bankSide();
    if (values()[side] !== "") return;
    const only = quickChoices(props.kind, side, accounts());
    const first = only[0];
    if (only.length === 1 && first) set({ [side]: first.id } as Partial<QuickValues>);
  });

  const applyPreset = (preset: QuickPreset) => {
    const info = QUICK_PRESETS[preset];
    if (presetOn() === preset) {
      // Pressed again: take it back, leaving what the person typed.
      const account = quickPresetAccount(preset, accounts());
      if (account && values()[info.side] === account)
        set({ [info.side]: "" } as Partial<QuickValues>);
      setPresetOn(null);
      setPresetMissing(false);
      return;
    }
    const account = quickPresetAccount(preset, accounts());
    setPresetOn(preset);
    setPresetMissing(account === undefined);
    set({
      ...(account ? ({ [info.side]: account } as Partial<QuickValues>) : {}),
      ...(values().description === "" ? { description: info.label } : {}),
    });
  };
  onMount(() => {
    if (props.preset) applyPreset(props.preset);
  });
  // A preset waits for the chart if it was asked for before the chart arrived.
  createEffect(
    on(
      () => props.accounts,
      (chart) => {
        const wanted = props.preset;
        if (
          chart &&
          wanted &&
          presetOn() === wanted &&
          values()[QUICK_PRESETS[wanted].side] === ""
        ) {
          const account = quickPresetAccount(wanted, chart);
          setPresetMissing(account === undefined);
          if (account) set({ [QUICK_PRESETS[wanted].side]: account } as Partial<QuickValues>);
        }
      },
      { defer: true },
    ),
  );

  const submit = (action: "post" | "draft") => {
    if (busy() || !props.accounts) return;
    setAttempted(true);
    if (problems().length > 0) {
      setAttempt((count) => count + 1);
      return;
    }
    // Hand the parent the amount the books will see ("25" is "25.00").
    const amount = parseEntryAmount(values().amount);
    const clean = { ...values(), ...(amount.ok ? { amount: amount.value } : {}) };
    if (action === "post") props.onPost(clean);
    else props.onSaveDraft(clean);
  };

  /** What a picker offers for one side: the name first, the code muted after it, under the heading of the
   * group a person looks in (their banks, expenses first). The order is the one `quickChoices` made. */
  const choicesFor = (side: QuickSide): AccountOption[] =>
    quickChoices(props.kind, side, accounts(), values()[side === "from" ? "to" : "from"]).map(
      (choice) => ({
        value: choice.id,
        label: choice.name,
        code: choice.code,
        group: choice.group,
      }),
    );

  const picker = (side: QuickSide): JSX.Element => {
    const field: QuickField = side;
    return (
      <AccountPicker
        // The error summary links to the field by this id.
        id={ids[field]}
        label={labels()[side]}
        required
        // The dialog only offers accounts that can be chosen, and the list shows each one's number, so the
        // line under the box that explains the choice is left out and the dialog stays short.
        compact
        accounts={choicesFor(side)}
        value={values()[side]}
        error={shown(field)}
        disabled={busy()}
        state={props.accounts ? "ready" : props.failed ? "error" : "loading"}
        onChange={(id) => set({ [side]: id } as Partial<QuickValues>)}
      />
    );
  };

  const presetFor = (): QuickPreset | undefined =>
    props.kind === "spend" ? "owner-out" : props.kind === "receive" ? "owner-in" : undefined;

  /** The person chose another kind: what was typed moves to where it fits, and nothing chosen for the old
   * kind (a preset, an error shown for a field that is now another) is left standing. */
  const switchKind = (next: QuickKind) => {
    if (!props.onKind || next === props.kind || busy()) return;
    setValues((now) => quickSwitchKind(now, props.kind, next, accounts()));
    setPresetOn(null);
    setPresetMissing(false);
    setAttempted(false);
    props.onKind(next);
  };

  const form = (
    <form
      id={formId}
      class="rt-quick-form rt-stack"
      novalidate
      onSubmit={(event) => {
        event.preventDefault();
        submit("post");
      }}
      // Enter in a list of accounts chooses one of them; it must not also post the entry.
      onKeyDown={(event) => {
        const target = event.target as HTMLElement;
        if (event.key === "Enter" && target.getAttribute("role") === "combobox") {
          if (target.getAttribute("aria-expanded") === "true") event.preventDefault();
        }
      }}
    >
      <Show when={props.accounts !== undefined && attempted() && summary().length > 0}>
        <ErrorSummary errors={summary()} title={words.fixErrors} attempt={attempt()} />
      </Show>
      <Show when={props.failed && !props.accounts}>
        <Notice title={words.loadFailed} tone="error" role="alert">
          <Button
            type="button"
            label={words.retry}
            variant="secondary"
            size="sm"
            onClick={() => props.onRetry?.()}
          />
        </Notice>
      </Show>
      <Show when={props.accounts && props.accounts.length === 0}>
        <Notice title={words.noAccounts} tone="info" />
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
      <Show when={props.error}>
        <Notice title={props.error ?? ""} tone="error" role="alert" />
      </Show>
      <Show when={props.onKind}>
        <Segment
          label={words.transaction.kind}
          value={props.kind}
          options={QUICK_KINDS.map((kind) => ({ value: kind, label: words[kind].title }))}
          disabled={busy()}
          onChange={switchKind}
        />
      </Show>
      <Show when={presetFor()}>
        {(preset) => (
          <fieldset class="rt-quick-presets">
            <legend class="rt-sr-only">{words.presetsLabel}</legend>
            <div class="rt-quick-presets-row">
              <span class="rt-quick-presets-label" aria-hidden="true">
                {words.presetsLabel}
              </span>
              <Button
                type="button"
                variant="secondary"
                size="sm"
                label={QUICK_PRESETS[preset()].label}
                aria-pressed={presetOn() === preset()}
                disabled={busy() || !props.accounts}
                onClick={() => applyPreset(preset())}
              />
              <Show when={presetOn() === preset()}>
                <p class="rt-hint rt-quick-presets-hint">
                  {presetMissing() ? words.presetMissing : QUICK_PRESETS[preset()].hint}
                </p>
              </Show>
            </div>
          </fieldset>
        )}
      </Show>
      {/* Date and the account the money moved through, who it was with and what it was for, how much and
          what to call it: two to a row, in the order they are read. */}
      <div class="rt-quick-fields">
        <DateField
          id={ids.date}
          label={words.dateLabel}
          required
          disabled={busy()}
          value={values().date}
          onChange={(value) => {
            setDateTouched(true);
            set({ date: value });
          }}
          {...(shown("date") ? { error: shown("date") as string } : {})}
        />
        {picker(bankSide())}
        <Show when={props.kind !== "transfer"}>
          <TextField
            label={props.kind === "spend" ? words.spend.partyLabel : words.receive.partyLabel}
            hint={props.kind === "spend" ? words.spend.partyHint : words.receive.partyHint}
            autocomplete="off"
            maxLength={80}
            disabled={busy()}
            value={values().party}
            onInput={(event) => set({ party: event.currentTarget.value })}
          />
        </Show>
        {picker(otherSide())}
        <TextField
          id={ids.amount}
          label={words.amountLabel}
          inputMode="decimal"
          autocomplete="off"
          placeholder="0.00"
          required
          disabled={busy()}
          value={values().amount}
          onInput={(event) => set({ amount: event.currentTarget.value })}
          onBlur={() => {
            const amount = parseEntryAmount(values().amount);
            if (amount.ok) set({ amount: amount.value });
          }}
          {...(shown("amount") ? { error: shown("amount") as string } : {})}
        />
        <div class="rt-quick-description" data-wide={props.kind === "transfer" ? "" : undefined}>
          <TextField
            label={words.descriptionLabel}
            autocomplete="off"
            maxLength={1000}
            disabled={busy()}
            value={values().description}
            onInput={(event) => set({ description: event.currentTarget.value })}
          />
        </div>
      </div>
    </form>
  );

  const previewId = `${uid}-preview`;
  return (
    <Dialog
      open={props.open}
      onOpenChange={(open) => {
        if (!open && !busy()) props.onClose();
      }}
      title={props.onKind ? words.transaction.title : words[props.kind].title}
      description={words[props.kind].intro}
      closeLabel="Close"
      class="rt-quick"
      // What has been typed is not thrown away by a stray click: Escape and Cancel close it.
      closeOnInteractOutside={false}
      initialFocusEl={() => document.getElementById(ids.date)}
      footer={
        <>
          <section class="rt-quick-preview" aria-labelledby={previewId}>
            <h3 id={previewId}>{words.previewTitle}</h3>
            <Show when={preview()} fallback={<p class="rt-hint">{words.previewEmpty}</p>}>
              {(lines) => (
                <>
                  <ul>
                    <For each={lines()}>
                      {(line) => (
                        <li>
                          <span class="rt-quick-name">{line.name}</span>
                          <bdi
                            class="rt-money rt-quick-change"
                            data-negative={line.change.startsWith("-") ? "" : undefined}
                          >
                            {line.shown}
                          </bdi>
                        </li>
                      )}
                    </For>
                  </ul>
                  <p class="rt-sr-only" role="status">
                    {quickPreviewSentence(lines())}
                  </p>
                </>
              )}
            </Show>
          </section>
          <div class="rt-quick-buttons">
            <Button
              type="button"
              label={words.cancel}
              variant="quiet"
              disabled={busy()}
              onClick={() => props.onClose()}
            />
            <div class="rt-quick-save">
              <Button
                type="button"
                label={words.saveDraft}
                pendingLabel={words.savingDraft}
                pending={props.pending === "draft"}
                variant="secondary"
                disabled={busy() || !props.accounts}
                onClick={() => submit("draft")}
              />
              <Button
                type="submit"
                form={formId}
                label={words.post}
                pendingLabel={words.posting}
                pending={props.pending === "post"}
                disabled={busy() || !props.accounts}
              />
            </div>
          </div>
        </>
      }
    >
      {form}
    </Dialog>
  );
}
