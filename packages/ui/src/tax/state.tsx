import { type JSX, Show } from "solid-js";
import { Button, buttonAttrs } from "../button";
import { formatFiguresInText } from "../format";
import { EmptyState } from "../kit";
import { Notice } from "../notice";
import { words } from "./words";

/** A state the Tax screen can be in that is not a failure: there is no book yet, or the book's calendar does
 * not cover the year. Each says what is true and where to go next, and shows no figure. A person who follows a
 * bookmark on a new install meets the first one, so it is plain and it is not an error: it is the kit's empty
 * state, one sentence and the one place to go. */
export function TaxState(props: {
  state: "noBook" | "calendar";
  /** The service's own words about the calendar (it names the date and the range the book covers). */
  detail?: string | undefined;
  /** What the screen can do about it, when it can: "Let Rastrata choose the year". */
  onChooseYear?: (() => void) | undefined;
  /** A link, so the application can use its router. */
  renderLink?: ((href: string, children: JSX.Element) => JSX.Element) | undefined;
}) {
  return (
    <Show
      when={props.state === "calendar"}
      fallback={
        <EmptyState
          title={words.noBookTitle}
          live
          action={
            props.renderLink ? (
              props.renderLink("/", words.noBookLink)
            ) : (
              <a {...buttonAttrs({ variant: "secondary" })} href="/">
                {words.noBookLink}
              </a>
            )
          }
        >
          {words.noBookBody}
        </EmptyState>
      }
    >
      <Notice title={words.calendarTitle} tone="attention" role="status">
        <Show when={props.detail}>
          <p>{formatFiguresInText(props.detail ?? "")}</p>
        </Show>
        <p>{words.calendarBody}</p>
        <Show when={props.onChooseYear}>
          <p class="rt-tax-state-actions">
            <Button
              variant="secondary"
              label={words.calendarChoose}
              onClick={() => props.onChooseYear?.()}
            />
          </p>
        </Show>
      </Notice>
    </Show>
  );
}
