import type { JSX } from "solid-js";
import { formatMoney, isNegativeMoney } from "./format";
import { useUi } from "./locale";

/** One amount of money, set the way the whole product sets it: grouped digits, two decimals, a real
 * minus sign, tabular figures that never wrap. Give it the wire amount ("-1150.00"); it never turns
 * it into a number. In a table, put it in a cell with class `rt-number` so a column lines up on its
 * right edge.
 *
 * It is wrapped in `<bdi>` so the digits keep their order inside right-to-left text. Anything that
 * is not a wire amount (an em dash for "no amount", a typed draft) shows as it came. */
export function Money(props: { value: string; class?: string }): JSX.Element {
  const ui = useUi();
  return (
    <bdi
      class={props.class ? `rt-money ${props.class}` : "rt-money"}
      data-negative={isNegativeMoney(props.value) ? "" : undefined}
    >
      {formatMoney(props.value, ui.locale)}
    </bdi>
  );
}
