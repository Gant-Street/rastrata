import { createEffect, createMemo, createSignal, createUniqueId, on, Show } from "solid-js";
import { Button } from "../button";
import { CheckField } from "../accounting-controls";
import { ErrorSummary, type FormError } from "../error-summary";
import { Notice } from "../notice";
import { TextField } from "../text-field";
import { words } from "./words";
import type { SettingsView } from "./types";

export type SettingsFormState = "idle" | "saving" | "saved" | "error";

type Field = "interval" | "daily" | "weekly" | "monthly" | "warn";

const RANGES: Readonly<Record<Field, readonly [number, number]>> = {
  interval: [1, 720],
  daily: [1, 365],
  weekly: [0, 520],
  monthly: [0, 240],
  warn: [1, 8760],
};

const WHOLE = /^[0-9]{1,5}$/;

/** Read a whole number a person typed; null when it is not one. */
const wholeNumber = (text: string): number | null =>
  WHOLE.test(text.trim()) ? Number(text.trim()) : null;

/**
 * The automatic backup settings. Plain language, one setting per line, and nothing saved until the
 * button is pressed. The owner can change them; anyone else sees them read-only with the reason. A
 * problem is named beside its field and gathered in an error summary that links to it. Keeping fewer
 * backups than before warns, because it deletes older automatic ones.
 */
export function BackupSettingsForm(props: {
  settings: SettingsView;
  ownerAccess: boolean;
  state: SettingsFormState;
  error?: string | undefined;
  onSave: (values: SettingsView) => void;
}) {
  const prefix = createUniqueId();
  const id = (name: string) => `${prefix}-${name}`;
  const [enabled, setEnabled] = createSignal(props.settings.enabled);
  const [onShutdown, setOnShutdown] = createSignal(props.settings.onShutdown);
  const [verifyAfter, setVerifyAfter] = createSignal(props.settings.verifyAfterBackup);
  const [interval, setInterval] = createSignal(String(props.settings.intervalHours));
  const [daily, setDaily] = createSignal(String(props.settings.keepDaily));
  const [weekly, setWeekly] = createSignal(String(props.settings.keepWeekly));
  const [monthly, setMonthly] = createSignal(String(props.settings.keepMonthly));
  const [warn, setWarn] = createSignal(String(props.settings.warnAfterHours));
  const [errors, setErrors] = createSignal<readonly (FormError & { field: Field })[]>([]);
  const [attempt, setAttempt] = createSignal(0);

  // New settings from the service (after a save, or another window) replace what is in the fields.
  createEffect(
    on(
      () => props.settings,
      (next) => {
        setEnabled(next.enabled);
        setOnShutdown(next.onShutdown);
        setVerifyAfter(next.verifyAfterBackup);
        setInterval(String(next.intervalHours));
        setDaily(String(next.keepDaily));
        setWeekly(String(next.keepWeekly));
        setMonthly(String(next.keepMonthly));
        setWarn(String(next.warnAfterHours));
        setErrors([]);
      },
      { defer: true },
    ),
  );

  const labels: Record<Field, string> = {
    interval: words.interval,
    daily: words.keepDaily,
    weekly: words.keepWeekly,
    monthly: words.keepMonthly,
    warn: words.warnAfter,
  };

  const parsed = createMemo(() => ({
    interval: wholeNumber(interval()),
    daily: wholeNumber(daily()),
    weekly: wholeNumber(weekly()),
    monthly: wholeNumber(monthly()),
    warn: wholeNumber(warn()),
  }));

  const problems = (): (FormError & { field: Field })[] => {
    const found: (FormError & { field: Field })[] = [];
    for (const field of Object.keys(RANGES) as Field[]) {
      const value = parsed()[field];
      const [low, high] = RANGES[field];
      if (value === null || value < low || value > high)
        found.push({ field, id: id(field), message: words.errorRange(labels[field], low, high) });
    }
    const { interval: every, warn: after } = parsed();
    if (
      enabled() &&
      every !== null &&
      after !== null &&
      after < every &&
      !found.some((e) => e.field === "warn")
    )
      found.push({ field: "warn", id: id("warn"), message: words.errorWarn });
    return found;
  };

  const fewer = () => {
    const now = parsed();
    return (
      enabled() &&
      ((now.daily !== null && now.daily < props.settings.keepDaily) ||
        (now.weekly !== null && now.weekly < props.settings.keepWeekly) ||
        (now.monthly !== null && now.monthly < props.settings.keepMonthly))
    );
  };

  const fieldError = (field: Field) => errors().find((error) => error.field === field)?.message;
  const locked = () => !props.ownerAccess;

  function submit(event: SubmitEvent) {
    event.preventDefault();
    if (locked() || props.state === "saving") return;
    const found = problems();
    setErrors(found);
    if (found.length > 0) {
      setAttempt(attempt() + 1);
      return;
    }
    const now = parsed();
    props.onSave({
      enabled: enabled(),
      intervalHours: now.interval as number,
      onShutdown: onShutdown(),
      verifyAfterBackup: verifyAfter(),
      keepDaily: now.daily as number,
      keepWeekly: now.weekly as number,
      keepMonthly: now.monthly as number,
      warnAfterHours: now.warn as number,
    });
  }

  const numberField = (
    field: Field,
    value: () => string,
    set: (next: string) => void,
    hint?: string,
  ) => (
    <TextField
      id={id(field)}
      label={labels[field]}
      type="text"
      inputmode="numeric"
      autocomplete="off"
      value={value()}
      disabled={locked()}
      {...(hint ? { hint } : {})}
      {...(fieldError(field) ? { error: fieldError(field) as string } : {})}
      onInput={(event) => {
        set(event.currentTarget.value);
        if (errors().length > 0) setErrors([]);
      }}
    />
  );

  return (
    <section class="rt-safe-settings" aria-labelledby={id("title")}>
      <h2 id={id("title")}>{words.settingsTitle}</h2>
      <p class="rt-hint">{words.settingsIntro}</p>
      <Show when={locked()}>
        <Notice title={words.settingsOwnerOnly} tone="review">
          {words.settingsOwnerOnlyBody}
        </Notice>
      </Show>
      <Show when={errors().length > 0}>
        <ErrorSummary errors={errors()} title={words.errorTitle} attempt={attempt()} />
      </Show>
      <form onSubmit={submit} novalidate>
        <fieldset class="rt-safe-fieldset" disabled={locked()}>
          <legend>{words.scheduleTitle}</legend>
          <CheckField
            label={words.enabled}
            checked={enabled()}
            onChange={setEnabled}
            disabled={locked()}
          />
          {numberField("interval", interval, setInterval, words.intervalHint)}
          <CheckField
            label={words.onShutdown}
            checked={onShutdown()}
            onChange={setOnShutdown}
            disabled={locked()}
          />
          <CheckField
            label={words.verifyAfter}
            checked={verifyAfter()}
            onChange={setVerifyAfter}
            disabled={locked()}
          />
          <p class="rt-hint">{words.verifyAfterHint}</p>
        </fieldset>
        <fieldset class="rt-safe-fieldset" disabled={locked()}>
          <legend>{words.keepTitle}</legend>
          <p class="rt-hint">{words.keepHint}</p>
          <div class="rt-safe-keep">
            {numberField("daily", daily, setDaily)}
            {numberField("weekly", weekly, setWeekly)}
            {numberField("monthly", monthly, setMonthly)}
          </div>
          <Show when={fewer()}>
            <p class="rt-safe-fewer" role="status">
              {words.lowerWarning}
            </p>
          </Show>
        </fieldset>
        <fieldset class="rt-safe-fieldset" disabled={locked()}>
          <legend>{words.warnTitle}</legend>
          {numberField("warn", warn, setWarn, words.warnAfterHint)}
        </fieldset>
        <div class="rt-safe-form-actions">
          <Button
            type="submit"
            label={words.save}
            pending={props.state === "saving"}
            pendingLabel={words.saving}
            disabled={locked()}
          />
          <Show when={props.state === "saved"}>
            <p role="status">{words.saved}</p>
          </Show>
          <Show when={props.state === "error"}>
            <p role="alert" class="rt-safe-form-error">
              {props.error ?? words.saveFailed}
            </p>
          </Show>
        </div>
      </form>
    </section>
  );
}
