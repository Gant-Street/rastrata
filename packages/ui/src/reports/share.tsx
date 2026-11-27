import { Show } from "solid-js";
import { formatShare, isNegativeShare } from "../format";
import { useUi } from "../locale";

/** One share of income in a statement: "30.2%", with a real minus sign for a loss, set in the same tabular
 * figures as an amount so a column of shares lines up. Give it the share as the service wrote it ("30.2");
 * it never turns it into a number. An empty value is a line the report had no share for (its period had no
 * income to take one of): a dash for the eye, and "No share of income" for a screen reader, so a gap is
 * never mistaken for a zero. */
export function Share(props: { value: string }) {
  const ui = useUi();
  return (
    <Show
      when={props.value !== ""}
      fallback={
        <span class="rt-share rt-share-none">
          <span aria-hidden="true">—</span>
          <span class="rt-sr-only">{ui.messages.reports.share.none}</span>
        </span>
      }
    >
      <bdi class="rt-money rt-share" data-negative={isNegativeShare(props.value) ? "" : undefined}>
        {formatShare(props.value, ui.locale)}
      </bdi>
    </Show>
  );
}
