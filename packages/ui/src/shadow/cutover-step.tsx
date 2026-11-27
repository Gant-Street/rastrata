import { createUniqueId, For, Show } from "solid-js";
import { CheckField } from "../accounting-controls";
import { Button } from "../button";
import { Check } from "../icons";
import { Notice } from "../notice";
import { DateField } from "../date-field";
import { accountLabel } from "./labels";
import { SourceEffects } from "./source-effects";
import type { SourceView, StatementAccountView } from "./types";
import { words } from "./words";

/** Step one of the opening balances screen: the cutover date and the accounts that have statements.
 * The date is the first day of the books; recording it hands it to the Inbox as the start date of
 * each statement source, so earlier history is set aside where it can be seen and restored. The
 * sources table shows what the date would do before it is recorded. Controlled: the parent owns the
 * date and the choices and passes back what the service says. What the date means (`words.dateIntro`) is
 * the page's "How this works", so the date is the first thing in the step.
 *
 * Once the opening entry is posted the date cannot move, so it is read, not edited: the step says what was
 * recorded and where each statement source starts (the page above says why it is fixed and how to change
 * it), and offers no field, no choices and no button to leave disabled. */
export function CutoverStep(props: {
  date: string;
  dateError?: string | undefined;
  accounts: readonly StatementAccountView[];
  sources: readonly SourceView[];
  previewing?: boolean | undefined;
  recorded: { date: string; recordedAt: string; by: string } | null;
  /** The opening entry is posted, so the date cannot move. */
  locked: boolean;
  /** Nothing differs from what is recorded. */
  unchanged?: boolean | undefined;
  pending?: boolean | undefined;
  /** Another write is waiting to be resumed, so this one is held back. */
  held?: boolean | undefined;
  error?: string | undefined;
  notes?: readonly string[] | undefined;
  stripeNote?: string | undefined;
  onDate: (value: string) => void;
  onToggle: (accountId: string, chosen: boolean) => void;
  onSubmit: () => void;
}) {
  const uid = createUniqueId();
  const reasonWord = (reason: string): string =>
    reason === "reconciled"
      ? words.becauseReconciled
      : reason === "imported"
        ? words.becauseImported
        : reason === "stripe"
          ? words.becauseStripe
          : reason === "card"
            ? words.becauseCard
            : words.becauseCash;
  const aside = () => (
    <>
      <Show when={props.stripeNote}>
        <p class="rt-hint">
          <bdi>{props.stripeNote}</bdi>
        </p>
      </Show>
      <Show when={(props.notes ?? []).length > 0}>
        <ul class="rt-shadow-notes-list" data-facts>
          <For each={props.notes}>{(note) => <li>{note}</li>}</For>
        </ul>
      </Show>
    </>
  );
  return (
    <section class="rt-shadow-step" aria-labelledby={`${uid}-title`}>
      <h2 id={`${uid}-title`}>{words.stepDate}</h2>
      <Show when={props.recorded}>
        {(recorded) => (
          <p class="rt-shadow-recorded" role="status" data-facts>
            <Check aria-hidden="true" />
            <span>
              <strong>{words.recorded(recorded().date)}</strong>{" "}
              <span class="rt-hint">{words.recordedBy(recorded().by, recorded().recordedAt)}</span>
            </span>
          </p>
        )}
      </Show>
      <Show
        when={!props.locked}
        fallback={
          <>
            <SourceEffects sources={props.sources} busy={props.previewing === true} current />
            {aside()}
          </>
        }
      >
        <form
          class="rt-shadow-cutover-form"
          onSubmit={(event) => {
            event.preventDefault();
            if (!props.pending && !props.held) props.onSubmit();
          }}
          noValidate
        >
          <DateField
            id={`${uid}-date`}
            label={words.dateLabel}
            required
            value={props.date}
            onChange={(value) => props.onDate(value)}
            {...(props.dateError ? { error: props.dateError } : {})}
          />
          <Show
            when={props.accounts.length > 0}
            fallback={<p class="rt-hint">{words.statementsNone}</p>}
          >
            <fieldset class="rt-shadow-fieldset">
              <legend>{words.statementsLegend}</legend>
              <ul class="rt-shadow-checks">
                <For each={props.accounts}>
                  {(account) => (
                    <li>
                      <CheckField
                        label={<bdi>{accountLabel(account)}</bdi>}
                        hint={
                          <>
                            {words.kind[account.kind]}.{" "}
                            {account.selectable
                              ? account.suggested
                                ? words.suggestedBecause(reasonWord(account.suggested))
                                : words.notSuggested
                              : words.stripeNotHere}
                          </>
                        }
                        checked={account.chosen}
                        disabled={!account.selectable}
                        onChange={(checked) => props.onToggle(account.id, checked)}
                      />
                    </li>
                  )}
                </For>
              </ul>
            </fieldset>
          </Show>
          <SourceEffects sources={props.sources} busy={props.previewing === true} />
          {aside()}
          <Show when={props.error}>
            <Notice title={words.recordFailed} tone="error" role="alert">
              {props.error}
            </Notice>
          </Show>
          <div class="rt-shadow-actions">
            <Button
              type="submit"
              variant={props.recorded && props.unchanged ? "secondary" : "primary"}
              label={words.record}
              pendingLabel={words.recording}
              pending={props.pending === true}
              disabled={props.held === true || props.unchanged === true}
            />
          </div>
        </form>
      </Show>
    </section>
  );
}
