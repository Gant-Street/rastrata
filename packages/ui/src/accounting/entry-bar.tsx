import { createEffect, createSignal, on, onCleanup, Show, type JSX } from "solid-js";
import { Button } from "../button";
import { formatMoney } from "../format";
import { Money } from "../money";
import type { EntryTotals } from "./entry-logic";
import { entryWords } from "./entry-words";

export interface EntryBarProps {
  /** The sums, or `null` while an amount is not one. */
  totals: EntryTotals | null;
  currency: string;
  /** Which request is on its way, if one is: nothing can be sent twice. */
  busy: "draft" | "post" | null;
  /** Something else holds the form (a retained request waits to be resumed, the draft is not editable). */
  blocked?: boolean | undefined;
  /** A saved draft exists, so it can be discarded. */
  canDiscard?: boolean | undefined;
  /** Where Cancel goes: back to the list, leaving whatever was saved. */
  cancelHref: string;
  onSaveDraft: () => void;
  onPost: () => void;
  onDiscard?: (() => void) | undefined;
}

const nothingYet = (totals: EntryTotals): boolean =>
  totals.debit === "0.00" && totals.credit === "0.00";

/** The totals of an entry and what can be done with it, in one bar that stays at the foot of the window
 * while the lines scroll: "Debits 100.00 · Credits 100.00 · Difference 0.00 · Balanced", then Cancel, Save
 * draft and Post. Both buttons are always on: a Post that cannot go says why, in a list, and takes the
 * person to the first thing to fix, where a button that is only grey says nothing.
 *
 * The totals are not announced as they change (that would be a sentence per keystroke). A short line in a
 * polite live region says whether the entry balances, a moment after the typing stops. */
export function EntryBar(props: EntryBarProps): JSX.Element {
  const w = entryWords.bar;
  // What is said about the totals, settled after a pause: nothing while there is nothing yet (or an amount is
  // not one), then whether the entry balances and, if not, by how much.
  const [settled, setSettled] = createSignal<{ balanced: boolean; difference: string } | undefined>(
    undefined,
  );
  let timer: ReturnType<typeof setTimeout> | undefined;
  createEffect(
    on(
      () => props.totals,
      (totals) => {
        clearTimeout(timer);
        const next =
          totals && !nothingYet(totals)
            ? { balanced: totals.balanced, difference: totals.difference }
            : undefined;
        timer = setTimeout(() => setSettled(next), 700);
      },
    ),
  );
  onCleanup(() => clearTimeout(timer));
  const spoken = () => {
    const now = settled();
    if (now === undefined) return "";
    return now.balanced ? w.balanced : w.outOfBalance(formatMoney(now.difference));
  };
  return (
    // biome-ignore lint/a11y/useSemanticElements: the bar is a sticky row of totals and buttons, not a set of fields, so a fieldset says the wrong thing; the group names it for a screen reader
    <div class="rt-entry-bar" role="group" aria-label={w.label}>
      <p class="rt-entry-totals">
        <Show when={props.totals} fallback={<span>{w.unreadable}</span>}>
          {(totals) => (
            <>
              <span>
                {w.debits} <Money value={totals().debit} />
              </span>
              <span aria-hidden="true">·</span>
              <span>
                {w.credits} <Money value={totals().credit} />
              </span>
              <span aria-hidden="true">·</span>
              <span data-unbalanced={totals().balanced ? undefined : ""}>
                {w.differenceLabel} <Money value={totals().difference} /> {props.currency}
              </span>
              <Show when={!nothingYet(totals())}>
                <span class="rt-entry-flag" data-balanced={totals().balanced ? "" : undefined}>
                  {totals().balanced ? w.balancedFlag : w.unbalancedFlag}
                </span>
              </Show>
            </>
          )}
        </Show>
      </p>
      <p class="rt-sr-only" role="status">
        {spoken()}
      </p>
      <div class="rt-entry-actions">
        <a class="rt-button" data-variant="quiet" href={props.cancelHref}>
          {w.cancel}
        </a>
        <Show when={props.canDiscard}>
          <Button
            variant="quiet"
            label={w.discard}
            disabled={props.busy !== null || props.blocked === true}
            onClick={() => props.onDiscard?.()}
          />
        </Show>
        <Button
          variant="secondary"
          label={w.saveDraft}
          disabled={props.blocked === true || props.busy === "post"}
          pending={props.busy === "draft"}
          pendingLabel={w.working}
          onClick={props.onSaveDraft}
        />
        <Button
          label={w.post}
          disabled={props.blocked === true || props.busy === "draft"}
          pending={props.busy === "post"}
          pendingLabel={w.working}
          onClick={props.onPost}
        />
      </div>
    </div>
  );
}
