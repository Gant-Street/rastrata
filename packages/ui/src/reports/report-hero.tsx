import { Show } from "solid-js";
import { Amount } from "./amount";

/** The one figure a statement exists to state, set larger than anything else on the page. */
export function ReportHero(props: { label: string; amount: string; note?: string | undefined }) {
  return (
    <p class="rt-report-hero">
      <span class="rt-report-hero-label">{props.label}</span>
      <span class="rt-report-hero-amount">
        <Amount value={props.amount} />
      </span>
      <Show when={props.note}>
        <span class="rt-report-hero-note">{props.note}</span>
      </Show>
    </p>
  );
}
