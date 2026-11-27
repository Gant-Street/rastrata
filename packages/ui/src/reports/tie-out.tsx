import { For, Show } from "solid-js";
import { useUi } from "../locale";
import { Status } from "../notice";
import { Amount } from "./amount";

/** A check the statement makes on itself, shown rather than assumed: the accounting equation
 * (assets equal liabilities plus equity), debits equal credits, or cash at the end equals cash at
 * the start plus the change. It is one quiet line in the report's own type: the terms with their
 * amounts, then the result in words, and nothing shouts while it holds. If the figures ever disagree
 * the check says so plainly, with the difference, and tells the reader not to rely on the report.
 * The section is a landmark named for what it checks, so a screen reader can go straight to it. */
export function TieOut(props: {
  /** What the check proves, as the name of the section: "The accounting equation". */
  title: string;
  /** The single figure on the left of the equals sign. */
  total: { label: string; amount: string };
  /** The figures that add up to it. */
  parts: readonly { label: string; amount: string }[];
  /** `total` less the sum of `parts`, as the service computed it. */
  difference: string;
  /** What the check proves, in a sentence: "Equals the cash on the balance sheet." */
  note?: string | undefined;
  /** The words of the result, for a check that is not a balance ("Adds up.", "Does not add up"). Left
   * out, the check says it balances. */
  result?:
    | { readonly holds: string; readonly broken: string; readonly brokenBody: string }
    | undefined;
}) {
  const ui = useUi();
  const standard = () => ui.messages.reports.tie;
  const t = () =>
    props.result
      ? {
          ...standard(),
          balanced: props.result.holds,
          notBalanced: props.result.broken,
          notBalancedBody: props.result.brokenBody,
        }
      : standard();
  const balanced = () => props.difference === "0.00";
  return (
    <section
      class="rt-tie"
      data-state={balanced() ? "balanced" : "broken"}
      aria-label={props.title}
    >
      <p class="rt-tie-line">
        <span class="rt-tie-term">
          <span class="rt-tie-label">{props.total.label}</span>
          <Amount value={props.total.amount} />
        </span>
        <span class="rt-tie-operator" aria-hidden="true">
          =
        </span>
        <span class="rt-sr-only"> {t().equals} </span>
        <For each={props.parts}>
          {(part, index) => (
            <>
              <Show when={index() > 0}>
                <span class="rt-tie-operator" aria-hidden="true">
                  +
                </span>
                <span class="rt-sr-only"> {t().plus} </span>
              </Show>
              <span class="rt-tie-term">
                <span class="rt-tie-label">{part.label}</span>
                <Amount value={part.amount} />
              </span>
            </>
          )}
        </For>
      </p>
      <Show
        when={balanced()}
        fallback={
          <>
            <p class="rt-tie-result">
              <Status tone="problem">
                {t().notBalanced} · {t().difference} <Amount value={props.difference} />
              </Status>
            </p>
            <p role="alert" class="rt-error-text">
              {t().notBalancedBody}
            </p>
          </>
        }
      >
        <p class="rt-tie-result">
          {t().balanced}
          <Show when={props.note}>{(note) => <> {note()}</>}</Show>
        </p>
      </Show>
    </section>
  );
}
