import { Show } from "solid-js";
import { Check } from "../icons";
import type { ReconcileFigures } from "./types";
import { words } from "./words";
import { formatMoney, formatMoneyAbsolute, isNegativeMoney } from "../format";

/** The figure a reconciliation exists to state is the difference, so it is the largest thing on
 * the page. It is announced politely as it changes. Balanced is a word and a check mark, never a
 * color. The other figures show how it is made: the statement balance, what earlier statements
 * cleared, and what is ticked now. */
export function ReconcileSummary(props: {
  figures: ReconcileFigures;
  currency?: string;
  /** A finished record: balanced is a fact, not an invitation to finish. */
  finished?: boolean;
}) {
  const balanced = () => props.figures.difference === "0.00";
  const note = () =>
    isNegativeMoney(props.figures.difference)
      ? words.lower(formatMoneyAbsolute(props.figures.difference))
      : words.higher(formatMoney(props.figures.difference));
  return (
    <section
      class="rt-recon-summary"
      aria-label={words.figures}
      data-balanced={balanced() ? "" : undefined}
    >
      <div class="rt-recon-difference">
        <span class="rt-recon-label">{words.difference}</span>
        <div aria-live="polite" aria-atomic="true">
          <span class="rt-recon-difference-figure">{formatMoney(props.figures.difference)}</span>
          <span class="rt-recon-difference-note">
            <Show when={balanced()} fallback={note()}>
              <Check aria-hidden="true" /> {props.finished ? words.balancedRecord : words.balanced}
            </Show>
          </span>
        </div>
      </div>
      <dl class="rt-recon-figures">
        <div>
          <dt>{words.statementBalance}</dt>
          <dd class="rt-recon-amount">{formatMoney(props.figures.statementBalance)}</dd>
        </div>
        <div>
          <dt>{words.opening}</dt>
          <dd class="rt-recon-amount">{formatMoney(props.figures.openingBalance)}</dd>
        </div>
        <div>
          <dt>{words.selected(props.figures.selectedCount)}</dt>
          <dd class="rt-recon-amount">{formatMoney(props.figures.selectedTotal)}</dd>
        </div>
        <div>
          <dt>{words.clearedBalance}</dt>
          <dd class="rt-recon-amount">{formatMoney(props.figures.clearedBalance)}</dd>
        </div>
      </dl>
    </section>
  );
}
