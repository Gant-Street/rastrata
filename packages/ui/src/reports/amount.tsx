import { Show } from "solid-js";
import { useUi } from "../locale";
import { Money } from "../money";

/** One amount of a statement, set the way the whole product sets money (see `Money`): grouped
 * digits, a real minus sign for a negative figure, tabular figures.
 *
 * Given an `href` it is a link to the transactions behind it. It says so before it is pressed: the
 * figure is underlined when the pointer or the keyboard is on it, and a tooltip says "View
 * transactions". `context` (for example "activity for 1000 Cash") is added after the figure as hidden
 * text so the link says where it goes to someone who cannot see the underline. The figure itself
 * stays the visible text, so the link's name always contains what is on screen. */
export function Amount(props: { value: string; href?: string | undefined; context?: string }) {
  const ui = useUi();
  const content = () => <Money value={props.value} class="rt-amount" />;
  return (
    <Show when={props.href} fallback={content()}>
      <a
        class="rt-amount-link"
        href={props.href}
        title={ui.messages.reports.table.viewTransactions}
      >
        {content()}
        <Show when={props.context}>
          <span class="rt-sr-only">, {props.context}</span>
        </Show>
      </a>
    </Show>
  );
}
