import type { BookState } from "@rastrata/kernel";

/** A problem a plan carries: the kernel's code and a message for a person, a script or an agent. */
export interface PlanProblem {
  readonly code: string;
  readonly message: string;
}

const CLOSED = /^Fiscal period (.+) is closed$/;
const PROSPECTIVE = "Configuration evolution must be prospective relative to canonical journals";
const CORRECTION =
  "A journal in a closed population cannot be corrected until its period is explicitly reopened";

/** The kernel refuses with short, exact diagnostics. Three of them stop a person in the middle of
 * ordinary work: an entry dated in a closed month and a correction of an entry that sits in one ("Fiscal
 * period period-03 is closed": an internal id, not the month, and nothing about what to do), and a change
 * to the chart dated on or before the latest entry ("Configuration evolution must be prospective ...":
 * no date to use instead). This says which month, or which date, and the way forward, for every caller of
 * the service alike: the screens, the command line and an agent read the same words. The code is kept,
 * so anything that branches on it still can. */
export function explainProblem(
  state: BookState,
  problem: PlanProblem,
  command: { readonly type: string },
): PlanProblem {
  if (problem.code !== "fiscal_period_admission") return problem;
  const closed = CLOSED.exec(problem.message);
  if (closed) {
    const period = state.periods.find((item) => item.id === closed[1]);
    if (!period) return problem;
    const name = `${period.label} ${period.startsOn.slice(0, 4)}`;
    return {
      code: problem.code,
      message: `${name} (${period.startsOn} to ${period.endsOn}) is closed, so nothing can be posted into it. Reopen ${name} first (periods.prepare with operation "reopen"), post, then close it again.`,
    };
  }
  if (problem.message === PROSPECTIVE) {
    const latest = state.journals.reduce<string | null>(
      (last, booked) =>
        last === null || booked.journal.accountingDate > last
          ? booked.journal.accountingDate
          : last,
      null,
    );
    if (latest === null) return problem;
    // The same date the Accounts screen offers (`suggestedEffectiveOn`): the day after the latest entry.
    const next = new Date(Date.parse(`${latest}T00:00:00Z`) + 86_400_000)
      .toISOString()
      .slice(0, 10);
    return {
      code: problem.code,
      message: `A change to the chart (a new account, for one) takes effect after the latest entry in your books, which is dated ${latest}. Use ${next} or later.`,
    };
  }
  if (problem.message === CORRECTION && "originalJournalId" in command) {
    const original = state.journals.find((item) => item.journal.id === command.originalJournalId);
    const period = state.periods.find((item) => item.id === original?.fiscalPeriodId);
    if (!original || !period) return problem;
    const name = `${period.label} ${period.startsOn.slice(0, 4)}`;
    return {
      code: problem.code,
      message: `The entry is dated ${original.journal.accountingDate}, in ${name} (${period.startsOn} to ${period.endsOn}), which is closed, so it cannot be corrected or reversed yet. Reopen ${name} first (periods.prepare with operation "reopen"), correct the entry, then close it again.`,
    };
  }
  return problem;
}

export const explainProblems = (
  state: BookState,
  problems: readonly PlanProblem[],
  command: { readonly type: string },
): PlanProblem[] => problems.map((problem) => explainProblem(state, problem, command));
