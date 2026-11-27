import type { InboxUndoResult } from "@rastrata/application/client-contracts";
import { undoWords } from "@rastrata/ui/entries/words";
import { forPeople } from "./messages";
import type { BrowserApplicationClient } from "../../application-client";

/** What an undo did, said once for every line it was asked about. */
export interface UndoSummary {
  /** The lines now back in For review (the Inbox). */
  readonly undone: readonly string[];
  /** The lines that stayed as they were, with the books' words for why. */
  readonly refused: readonly {
    readonly itemId: string;
    readonly code: string;
    readonly message: string;
  }[];
  /** Advisory notes from the books, once each (a transaction on a finished reconciliation). */
  readonly warnings: readonly string[];
  /** Lines the calls did not reach before they gave up. */
  readonly remaining: number;
  /** Lines that were only unlinked from an entry that was booked by hand. */
  readonly unlinked: number;
}

/** The most calls one undo makes. Each reaches up to a hundred lines, and stops after a few seconds. */
const MAX_ROUNDS = 25;

/** Take lines back (`inbox.undo`) and keep going until every line has been reached: each call handles a
 * bounded number and says how many remain. Every call is a retained write, so a reply lost on the way is
 * resumed by the caller (`ApplicationRequestError.uncertain`) and never undone twice. `workflow` is the
 * retained-request key the screen already uses for its actions, so two writes never run at once. */
export async function undoLines(
  client: BrowserApplicationClient,
  itemIds: readonly string[],
  workflow: string,
  options: { readonly reason?: string } = {},
): Promise<UndoSummary> {
  let todo = [...new Set(itemIds)];
  const results: InboxUndoResult[] = [];
  for (let round = 0; round < MAX_ROUNDS && todo.length > 0; round++) {
    const report = await client.write(
      "inbox.undo",
      { itemIds: todo.slice(0, 100), ...(options.reason ? { reason: options.reason } : {}) },
      workflow,
    );
    results.push(...report.results);
    const reached = new Set(report.results.map((result) => result.itemId));
    const next = todo.filter((id) => !reached.has(id));
    // A call that reached nothing cannot be made to by asking again.
    if (next.length === todo.length) break;
    todo = next;
  }
  return summarize(results, todo.length);
}

/** Take back lines that were only drafted (Accept with "save it as a draft"): nothing is in the books, so
 * there is nothing to reverse, and the lines go back to For review (`inbox.restore`, which needs a reason
 * and only `draft` permission). Same summary as `undoLines`, so the toast reads the same. */
export async function restoreDrafts(
  client: BrowserApplicationClient,
  itemIds: readonly string[],
  workflow: string,
): Promise<UndoSummary> {
  let todo = [...new Set(itemIds)];
  const results: InboxUndoResult[] = [];
  for (let round = 0; round < MAX_ROUNDS && todo.length > 0; round++) {
    const report = await client.write(
      "inbox.restore",
      { itemIds: todo.slice(0, 500), reason: undoWords.restoreReason },
      workflow,
    );
    results.push(...report.results);
    const reached = new Set(report.results.map((result) => result.itemId));
    const next = todo.filter((id) => !reached.has(id));
    if (next.length === todo.length) break;
    todo = next;
  }
  return summarize(results, todo.length, false);
}

/** What `summarize` reads of one result: the line, what happened to it, and the books' words. The results
 * of `inbox.restore` have the same fields except for the reversal and the warnings. */
type Taken = Pick<InboxUndoResult, "itemId" | "outcome"> & Partial<InboxUndoResult>;

/** What a set of results comes to. `reversed` is false for drafts, which have no entry to have reversed. */
export function summarize(
  results: readonly Taken[],
  remaining: number,
  reversed = true,
): UndoSummary {
  const undone = results.filter((result) => result.outcome === "applied");
  const warnings = [
    ...new Set(
      undone.flatMap((result) => (result.warnings ?? []).map((warning) => warning.message)),
    ),
  ];
  return {
    undone: undone.map((result) => result.itemId),
    refused: results
      .filter((result) => result.outcome !== "applied")
      .map((result) => ({
        itemId: result.itemId,
        code: result.code ?? "refused",
        message: forPeople(result.message ?? undoWords.notPosted),
      })),
    warnings,
    remaining,
    unlinked: reversed
      ? undone.filter((result) => result.reversalJournalId === undefined).length
      : 0,
  };
}

/** What to tell the person, as a toast: a few sentences, with the tone they deserve. A refusal says what the
 * books said (the month that is closed, how to reopen it) and that nothing was changed for that line. An
 * entry that was on a finished reconciliation is undone all the same, and the toast says that the books
 * now differ from that statement, so it is not found out later. */
export function undoMessage(summary: UndoSummary): {
  message: string;
  tone: "calm" | "attention" | "problem";
} {
  const done = summary.undone.length;
  const warned = done > 0 && summary.warnings.length > 0;
  if (summary.refused.length === 0 && summary.remaining === 0) {
    const said =
      done === 0
        ? undoWords.nothing
        : summary.unlinked === done
          ? undoWords.linkOnly
          : undoWords.done(done);
    return warned
      ? { message: `${said} ${undoWords.afterReconciled}`, tone: "attention" }
      : { message: said, tone: "calm" };
  }
  const first = summary.refused[0];
  const sentences = [
    ...(done > 0 ? [undoWords.doneFrom(done)] : []),
    ...(warned ? [undoWords.afterReconciled] : []),
    ...(first ? [first.message] : []),
    ...(summary.refused.length > 1 ? [undoWords.failed(summary.refused.length)] : []),
    ...(summary.remaining > 0 ? [undoWords.remaining(summary.remaining)] : []),
  ];
  return { message: sentences.join(" "), tone: "problem" };
}
