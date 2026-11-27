import { ReportState } from "@rastrata/ui";
import { ApplicationRequestError } from "../../application-client";

/** What went wrong with a read, as the state the page shows for it. The service's messages are
 * written for a person (they name the date, the covered range and what to do), so they are shown as
 * they are. A report that is older than the book is its own state: it is never shown as current. */
export function describeFailure(error: unknown): {
  state: "failed" | "calendar" | "stale" | "noBook";
  detail?: string;
} {
  if (error instanceof ApplicationRequestError) {
    if (error.code === "calendar_not_configured")
      return { state: "calendar", detail: error.message };
    if (error.code === "report_population_changed") return { state: "stale" };
    if (error.code === "book_not_configured") return { state: "noBook" };
    return { state: "failed", detail: error.message };
  }
  return { state: "failed" };
}

export function Failure(props: { error: unknown; retry?: () => void; staleRetry?: () => void }) {
  const failure = () => describeFailure(props.error);
  const retry = () =>
    failure().state === "stale" ? (props.staleRetry ?? props.retry) : props.retry;
  return (
    <ReportState
      state={failure().state}
      onRetry={retry()}
      {...(failure().detail !== undefined ? { detail: failure().detail as string } : {})}
    />
  );
}
