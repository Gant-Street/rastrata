import type { JSX } from "solid-js";
import { buttonAttrs } from "../button";
import { formatCount, formatDate } from "../format";
import type { ButtonLinkProps } from "../settings/button-link";
import { historyWords as w } from "./words";

/** What a finished import says: how many entries are in the books, the day the books begin, and the two
 * places to go next. */
export function HistoryDone(props: {
  entries: number;
  booksBegan: string | null;
  /** Draws a link the way the application navigates (through its router). */
  link?: (props: ButtonLinkProps) => JSX.Element;
}): JSX.Element {
  const links = [
    { href: "/reports", label: w.next.reports, variant: "secondary" as const },
    { href: "/periods", label: w.next.close, variant: "primary" as const },
  ];
  return (
    <div class="rt-stack rt-history-done" role="status">
      <h2>{w.doneTitle(formatCount(props.entries))}</h2>
      <p>{w.doneBody(props.booksBegan === null ? null : formatDate(props.booksBegan))}</p>
      <p class="rt-history-done-links">
        {links.map((item) => {
          const attrs = buttonAttrs({ variant: item.variant });
          return props.link ? (
            props.link({ ...attrs, href: item.href, children: item.label })
          ) : (
            <a {...attrs} href={item.href}>
              {item.label}
            </a>
          );
        })}
      </p>
    </div>
  );
}
