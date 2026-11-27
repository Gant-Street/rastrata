/** What the reconciliation report tests share: the acceptance month's book (the changes lane's cut of it, the
 * first two weeks of March on the Chase account) and the few moves a person makes on it, written as the
 * person makes them: start a reconciliation, tick the lines on the statement, finish it. */
import { cents, dec } from "../acceptance/month.ts";
import type { Caller, Json, MonthBook } from "../changes/support.ts";

export { agentCaller, memberCaller, monthBook, ownerCaller } from "../changes/support.ts";
export type { Caller, Json, MonthBook };

/** The fields of a line that a report and a draft both carry. */
export const lineFields = (line: Json): Json => ({
  postingId: line.postingId,
  journalId: line.journalId,
  date: line.date,
  narration: line.narration,
  amount: line.amount,
});

/** A reconciliation as a person leaves it, with the draft's working rows as they stood just before it was
 * finished (completing drops them, so a test that wants them has to take them first). */
export interface Finished {
  /** The completed record, as `reconcile.complete` answered. */
  readonly record: Json;
  /** The draft just before completing: every candidate line, each marked selected or not. */
  readonly draft: Json;
  readonly selected: Json[];
  readonly unselected: Json[];
}

/** Reconcile an account up to a date, leaving the lines `leave` picks off the statement. The statement
 * balance is what the lines left on come to, as the statement of a bank that showed exactly those would
 * print it. */
export async function reconcileTo(
  owner: Caller,
  accountId: string,
  statementDate: string,
  leave: (line: Json, index: number) => boolean = () => false,
): Promise<Finished> {
  let draft = await owner.ok("reconcile.start", {
    accountId,
    statementDate,
    statementBalance: "0.00",
  });
  const lines = draft.lines as Json[];
  // Asked once of each line, in the order the draft lists them, so a rule that counts can count.
  const leaving = new Set(
    lines.filter((line, index) => leave(line, index)).map((line) => line.postingId),
  );
  const kept = lines.filter((line) => !leaving.has(line.postingId));
  const balance = kept.reduce((sum, line) => sum + cents(line.amount), cents(draft.openingBalance));
  draft = await owner.ok("reconcile.setStatement", {
    id: draft.id,
    expectedVersion: draft.version,
    statementDate,
    statementBalance: dec(balance),
  });
  const progress = await owner.ok("reconcile.setCleared", {
    id: draft.id,
    expectedVersion: draft.version,
    reset: "all",
    deselect: [...leaving],
  });
  if (progress.difference !== "0.00") throw new Error(`the difference is ${progress.difference}`);
  const before = await owner.ok("reconcile.get", { id: draft.id });
  const record = await owner.ok("reconcile.complete", {
    id: before.id,
    expectedVersion: before.version,
  });
  return {
    record,
    draft: before,
    selected: (before.lines as Json[]).filter((line) => line.selected),
    unselected: (before.lines as Json[]).filter((line) => !line.selected),
  };
}

/** An entry that takes money out of the account (or puts it in, with a negative amount) and books it to an
 * expense, dated as asked: the kind of posting that arrives after a statement was finished. */
export async function postPayment(
  owner: Caller,
  input: { date: string; amount: string; narration: string; account?: string },
): Promise<Json> {
  const account = input.account ?? "1000";
  return owner.ok("journal.post", {
    data: {
      date: input.date,
      reference: `RP-${input.date}-${input.amount}`,
      narration: input.narration,
      lines: [
        { accountId: "6200", debit: input.amount, credit: "" },
        { accountId: account, debit: "", credit: input.amount },
      ],
    },
  });
}

/** The report for a reconciliation, as the service answers it. */
export const reportOf = (owner: Caller, id: string, extra: Record<string, unknown> = {}) =>
  owner.ok("reconcile.report", { id, ...extra });
