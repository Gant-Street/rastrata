import { createEffect, createSignal, createUniqueId, on, Show } from "solid-js";
import { CheckField } from "../accounting-controls";
import { Button } from "../button";
import { Notice } from "../notice";
import type { BankfeedSettingsView } from "./types";
import { words } from "./words";

/** The optional daily sync. Off until the owner turns it on; the installed service then syncs once a
 * day at the chosen local time, with the same request budget as pressing Sync now. A copy of Rastrata
 * that does not run the timer says so instead of pretending. */
export function BankfeedDaily(props: {
  settings: BankfeedSettingsView;
  /** Whether this copy of Rastrata runs the daily sync at all. */
  scheduler: boolean;
  saving?: boolean;
  saved?: boolean;
  failure?: string | null;
  onSave: (settings: BankfeedSettingsView) => void;
}) {
  const uid = createUniqueId();
  const [enabled, setEnabled] = createSignal(props.settings.dailySync);
  const [at, setAt] = createSignal(props.settings.dailyAt);
  createEffect(
    on(
      () => props.settings,
      (settings) => {
        setEnabled(settings.dailySync);
        setAt(settings.dailyAt);
      },
      { defer: true },
    ),
  );
  const submit = (event: SubmitEvent) => {
    event.preventDefault();
    props.onSave({ dailySync: enabled(), dailyAt: at() });
  };
  return (
    <form
      class="rt-bankfeed-section rt-bankfeed-daily"
      onSubmit={submit}
      noValidate
      aria-labelledby="rt-bankfeed-daily"
    >
      <h2 id="rt-bankfeed-daily">{words.dailyTitle}</h2>
      <p class="rt-hint">{words.dailyIntro}</p>
      <Show when={!props.scheduler}>
        <Notice title={words.dailyNotRunningTitle} tone="info">
          {words.dailyNotRunning}
        </Notice>
      </Show>
      <Show when={props.failure}>
        <Notice title={words.dailyFailed} tone="error" role="alert">
          <bdi>{props.failure}</bdi>
        </Notice>
      </Show>
      <CheckField label={words.dailyOn} checked={enabled()} onChange={setEnabled} />
      <div class="rt-field">
        <div class="rt-label-row">
          <label for={`${uid}-at`}>{words.dailyAt}</label>
        </div>
        <input
          id={`${uid}-at`}
          class="rt-input"
          type="time"
          value={at()}
          aria-describedby={`${uid}-at-hint`}
          onInput={(event) => setAt(event.currentTarget.value)}
        />
        <p class="rt-hint" id={`${uid}-at-hint`}>
          {words.dailyAtHint}
        </p>
      </div>
      <div class="rt-bankfeed-actions">
        <Button
          type="submit"
          label={words.dailySave}
          pendingLabel={words.dailySaving}
          pending={props.saving ?? false}
        />
        <Show when={props.saved && !props.saving}>
          <p class="rt-hint" role="status">
            {words.dailySaved}
          </p>
        </Show>
      </div>
    </form>
  );
}
