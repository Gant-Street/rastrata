/** Closing a run of months in one step, as "Close January to September 2026" does: each month is checked
 * and closed exactly as its own button would, oldest first, and the run stops at the first month that is
 * not ready or whose close did not go through. What was closed before it stays closed; the page then shows
 * that month as the next to close, with what stands in its way. Nothing here reads the book: the host says
 * how a month is checked and how it is closed. */
export interface CloseRunSteps {
  /** Read the month's checklist afresh: true when every step is done. */
  readonly ready: (id: string) => Promise<boolean>;
  /** Close the month the way its own button does: true when the close was committed. */
  readonly close: (id: string) => Promise<boolean>;
}

export interface CloseRunResult {
  /** The months that closed, in order. */
  readonly closed: readonly string[];
  /** The first month that would not close, when one did; null when every month closed. */
  readonly stoppedAt: string | null;
}

export async function closeRun(
  ids: readonly string[],
  steps: CloseRunSteps,
): Promise<CloseRunResult> {
  const closed: string[] = [];
  for (const id of ids) {
    if (!(await steps.ready(id)) || !(await steps.close(id))) return { closed, stoppedAt: id };
    closed.push(id);
  }
  return { closed, stoppedAt: null };
}
