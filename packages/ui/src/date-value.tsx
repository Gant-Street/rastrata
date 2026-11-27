import { createSignal, type JSX, onCleanup, Show } from "solid-js";
import { formatDate, formatInstant, isDate, isInstant, onDateFormatChange } from "./format";

export interface DateValueProps {
  /** A calendar day ("2026-03-20") or an instant ("2026-03-20T12:00:00Z"), as the book stores it. */
  value: string;
  /** For an instant: show the day it falls on and leave out the time of day. */
  dateOnly?: boolean;
  class?: string;
}

/** One date, or one instant, set the way the whole product sets it: "Mar 20, 2026", or for an instant
 * "Mar 20, 2026, 12:00 PM" on the viewer's own clock. It is a `<time>` that keeps the exact value, the
 * ISO form the API, the CLI and the exports use, in `datetime` and in `title`, so a tooltip says
 * "2026-03-20" and a script or an accessibility tool can read the date without parsing words. Give it
 * the stored value; it never turns it into a number. In a table, put it in a cell as it is: it does not
 * wrap and its figures are tabular, so a column of dates lines up.
 *
 * It is wrapped in `<bdi>` so the digits keep their order inside right-to-left text. Anything that is
 * not a date or an instant (an em dash for "no date", a half-typed value) shows as it came, and not as
 * a `<time>`. */
export function DateValue(props: DateValueProps): JSX.Element {
  // The book's date format can change while a page is open (the owner saves the Business settings).
  const [format, setFormat] = createSignal(0);
  onCleanup(onDateFormatChange(() => setFormat((count) => count + 1)));
  const text = () => {
    format();
    return props.dateOnly ? formatDate(props.value) : formatInstant(props.value);
  };
  return (
    <Show
      when={isDate(props.value) || isInstant(props.value)}
      fallback={<bdi class={props.class}>{props.value}</bdi>}
    >
      <time
        class={props.class ? `rt-date ${props.class}` : "rt-date"}
        datetime={props.value}
        title={props.value}
      >
        <bdi>{text()}</bdi>
      </time>
    </Show>
  );
}
