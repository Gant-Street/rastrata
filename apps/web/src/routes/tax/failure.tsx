import { Button, Notice, TaxState, taxWords } from "@rastrata/ui";
import { formatFiguresInText } from "@rastrata/ui/format";
import { Show } from "solid-js";
import { ApplicationRequestError } from "../../application-client";

export type TaxFailureKind = "noBook" | "calendar" | "failed";

/** What went wrong with a read, as the state the screen shows for it. No book yet and a calendar that does not
 * cover the year are what the books are like, so each has a plain notice with a way forward; they are not
 * errors. The service's messages are written for a person (they name the date, the range and what to do), so
 * they are shown as they are; anything else is said plainly and never as a stack. */
export function describeFailure(error: unknown): { state: TaxFailureKind; detail?: string } {
  if (error instanceof ApplicationRequestError) {
    if (error.code === "book_not_configured") return { state: "noBook" };
    if (error.code === "calendar_not_configured")
      return { state: "calendar", detail: error.message };
    return { state: "failed", detail: error.message };
  }
  return { state: "failed" };
}

/** What a failed read or write says, in words a person can act on. */
export function failureText(error: unknown, fallback: string): string {
  const failure = describeFailure(error);
  if (failure.state === "noBook") return taxWords.noBook;
  return failure.detail !== undefined ? formatFiguresInText(failure.detail) : fallback;
}

/** A read that failed: what the service said and a way to try again. */
export function TaxFailure(props: {
  error: unknown;
  title?: string;
  retry?: () => void;
  /** For a year the calendar does not cover: go back to the year the service would choose. */
  onChooseYear?: (() => void) | undefined;
}) {
  const failure = () => describeFailure(props.error);
  return (
    <Show
      when={failure().state === "failed"}
      fallback={
        <TaxState
          state={failure().state === "noBook" ? "noBook" : "calendar"}
          detail={failure().detail}
          onChooseYear={props.onChooseYear}
        />
      }
    >
      <Notice title={props.title ?? taxWords.failed} tone="error" role="alert">
        <p>{failureText(props.error, taxWords.failed)}</p>
        <Show when={props.retry}>
          <Button variant="secondary" label={taxWords.retry} onClick={() => props.retry?.()} />
        </Show>
      </Notice>
    </Show>
  );
}
