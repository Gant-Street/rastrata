import { createUniqueId, Index, Show, type JSX } from "solid-js";
import { Button } from "../button";
import { Notice } from "../notice";
import { DateField } from "../date-field";
import type { ReconciledStepView } from "./xero-types";
import { xeroWords as words } from "./xero-words";
import { listAccountLabel } from "../entries/display";

/** Step four: where Xero was reconciled. The comparison trusts Xero only through the date each of
 * its bank and card accounts was reconciled to its statement, read from Xero's own reconciliation
 * screen. A date is typed, never guessed; empty means not reconciled. */
export function ReconciledStep(props: { step: ReconciledStepView }): JSX.Element {
  const uid = createUniqueId();
  const step = () => props.step;
  return (
    <section class="rt-shadow-step" aria-labelledby={`${uid}-title`}>
      <h2 id={`${uid}-title`}>{words.reconciledTitle}</h2>
      <p class="rt-hint">{words.reconciledIntro}</p>
      <Show when={step().rows.length > 0} fallback={<p class="rt-hint">{words.reconciledNone}</p>}>
        <form
          class="rt-xero-reconciled"
          onSubmit={(event) => {
            event.preventDefault();
            if (step().save.canSave && !step().save.pending) step().save.onSave();
          }}
          noValidate
        >
          <ul class="rt-xero-dates">
            <Index each={step().rows}>
              {(row) => (
                <li>
                  <DateField
                    label={words.reconciledThrough(listAccountLabel(row().name, row().code))}
                    hint={words.reconciledHint}
                    value={row().through}
                    onChange={(value) => step().onThrough(row().code, value)}
                    {...(row().error ? { error: row().error as string } : {})}
                  />
                </li>
              )}
            </Index>
          </ul>
          <Show when={step().save.error}>
            <Notice title={words.requestFailed} tone="error" role="alert">
              {step().save.error}
            </Notice>
          </Show>
          <div class="rt-shadow-actions">
            <Button
              type="submit"
              label={words.saveReconciled}
              pendingLabel={words.savingReconciled}
              pending={step().save.pending}
              disabled={!step().save.canSave}
            />
          </div>
          <p role="status" class="rt-xero-status">
            {step().save.message ?? ""}
          </p>
        </form>
      </Show>
    </section>
  );
}
