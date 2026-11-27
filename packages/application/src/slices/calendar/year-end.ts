import { hashCanonical } from "@rastrata/kernel";
import type {
  YearEndPlan,
  YearEndReceipt,
  YearEndReview,
  YearEndStep,
  YearEndStepReceipt,
} from "../../client-contracts.gen.ts";
import { closePeriodCommand, reopenPeriodCommand } from "../../calendar/commands.ts";
import { MAX_EXTENSION_YEARS, fiscalYearRange } from "../../calendar/extend.ts";
import { periodViews } from "../../calendar/periods.ts";
import {
  yearEndChecks,
  yearEndReopenReason,
  yearEndStepId,
  yearEndStepReason,
} from "../../calendar/year-end.ts";
import { ApplicationError } from "../../errors.ts";
import { compileCoreReports } from "../../reports.ts";
import type { ApplicationService } from "../../service.ts";
import { booksBeganOn } from "../shadow/cutover-date.ts";

/** Problems the plan carries, in the shape the contract uses. */
type Problem = { code: string; message: string };

const MAX_REASON = 400;

/** What a year-end looks at: the fiscal year's periods, the checklist and the statements, read from the
 * book as it stands. The read-only review and the prepared plan are both built from it.
 *
 * A year-end brings every period of the year to a current close. A period needs it when it is open, and
 * also when it is locked but its close was superseded by the reopening of an earlier period (the
 * kernel keeps it locked, so it has to be reopened before it can be closed again). */
async function reviewYear(service: ApplicationService, fiscalYear: number) {
  const { aggregate } = await service.readAggregate();
  const state = aggregate.state;
  const today = service.today();
  const booksBegan = booksBeganOn(service);
  const views = periodViews(state, today, booksBegan);
  const year = views.filter((period) => period.fiscalYear === fiscalYear);
  const range = fiscalYearRange(state);
  if (year.length === 0)
    throw new ApplicationError(
      "calendar_not_configured",
      fiscalYear > range.last
        ? `Fiscal year ${fiscalYear} is not in the book's calendar, which runs through fiscal year ${range.last}. ${
            fiscalYear - range.last <= MAX_EXTENSION_YEARS
              ? `Extend the calendar through fiscal year ${fiscalYear} first (periods.extend).`
              : "Extend the calendar first (periods.extend)."
          }`
        : `Fiscal year ${fiscalYear} is before the book's first fiscal year, ${range.first}.`,
      409,
      [{ path: "input.fiscalYear", message: `Fiscal year ${fiscalYear} is not in the calendar` }],
    );
  const startsOn = year.reduce(
    (first, period) => (period.startsOn < first ? period.startsOn : first),
    year[0]?.startsOn ?? "",
  );
  const endsOn = year.reduce(
    (last, period) => (period.endsOn > last ? period.endsOn : last),
    year[0]?.endsOn ?? "",
  );
  const needsClose = year.filter((period) => period.status === "open" || period.closeSuperseded);
  const report = compileCoreReports(state, endsOn);
  const earlierOpen = views.filter(
    (period) =>
      period.fiscalYear < fiscalYear &&
      !period.beforeBooks &&
      (period.status === "open" || period.closeSuperseded),
  );
  const drafts = service
    .listDrafts()
    .filter((draft) => draft.data.date >= startsOn && draft.data.date <= endsOn).length;
  const checks = yearEndChecks({
    fiscalYear,
    startsOn,
    endsOn,
    today,
    open: needsClose,
    earlierOpen,
    beforeBooks: year.filter((period) => period.beforeBooks),
    booksBegan,
    drafts,
    currency: report.currency,
    debit: report.trialBalance.debit,
    credit: report.trialBalance.credit,
    balanced: report.trialBalance.balanced,
    revenue: report.profitAndLoss.revenue,
    expenses: report.profitAndLoss.expenses,
    netIncome: report.profitAndLoss.netIncome,
  });
  const statements = {
    asOf: report.asOf,
    periodStart: report.periodStart,
    currency: report.currency,
    basis: report.basis,
    compilerVersion: report.compilerVersion,
    populationHash: report.populationHash,
    debit: report.trialBalance.debit,
    credit: report.trialBalance.credit,
    balanced: report.trialBalance.balanced,
    revenue: report.profitAndLoss.revenue,
    expenses: report.profitAndLoss.expenses,
    netIncome: report.profitAndLoss.netIncome,
    assets: report.balanceSheet.assets,
    liabilities: report.balanceSheet.liabilities,
    equity: report.balanceSheet.equity,
    priorEarnings: report.balanceSheet.priorEarnings,
    currentEarnings: report.balanceSheet.currentEarnings,
  };
  return {
    aggregate,
    state,
    today,
    year,
    booksBegan,
    needsClose,
    superseded: needsClose.filter((period) => period.closeSuperseded).length,
    startsOn,
    endsOn,
    checks,
    statements,
  };
}

/** Read what closing a fiscal year would involve, without preparing anything: the periods in order,
 * the checklist and the year's statements. It changes nothing and retains nothing, so a screen or an
 * agent can look at a year as often as it likes before choosing a reason. */
export async function reviewYearEnd(
  service: ApplicationService,
  input: { fiscalYear: number },
): Promise<YearEndReview> {
  const review = await reviewYear(service, input.fiscalYear);
  return {
    bookRevision: review.state.bookRevision.toString(),
    today: review.today,
    fiscalYear: input.fiscalYear,
    startsOn: review.startsOn,
    endsOn: review.endsOn,
    openCount: review.needsClose.length,
    supersededCount: review.superseded,
    closedCount: review.year.length - review.needsClose.length,
    periods: review.year.map((period, index) => ({
      order: index + 1,
      periodId: period.id,
      label: period.label,
      startsOn: period.startsOn,
      endsOn: period.endsOn,
      status: period.status,
      closeSuperseded: period.closeSuperseded,
      ended: period.ended,
      beforeBooks: period.beforeBooks,
    })),
    checks: review.checks,
    statements: review.statements,
  };
}

/** Prepare bringing every period of one fiscal year to a current close, in order.
 *
 * Each command is a sealed kernel command of its own, with its own plan and hash: a close for an open
 * period, and a reopening followed by a close for a locked period whose close was superseded. They are
 * sealed one after another, each against the book as the commands before it will leave it, so the
 * whole sequence can be reviewed at once and then committed. The identity of each is a function of
 * this request's identity, the period and the kind, so the same request always means the same
 * commands: asking again, after a crash or a lost reply, returns the plan already made and never a
 * second set.
 *
 * Closing does not change a balance, so the statements shown are those of the book as it stands. */
export async function prepareYearEnd(
  service: ApplicationService,
  input: { fiscalYear: number; reason: string },
  operationId: string,
): Promise<YearEndPlan> {
  return service.retainAsyncRequest(operationId, "periods.yearEnd", input, async () => {
    const reason = input.reason.trim();
    if (!reason || reason.length > MAX_REASON)
      throw new ApplicationError(
        "invalid_input",
        `A year-end reason is required (at most ${MAX_REASON} characters)`,
        400,
        [{ path: "input.reason", message: "Say why the year is being closed" }],
      );
    const review = await reviewYear(service, input.fiscalYear);
    const { year, needsClose, state, startsOn, endsOn } = review;
    if (needsClose.length === 0)
      throw new ApplicationError(
        "year_already_closed",
        `Every period of fiscal year ${input.fiscalYear} (${startsOn} to ${endsOn}) already has a current close. To correct it, reopen a period with periods.prepare; that supersedes the closes of the periods after it, and this year-end then closes them again.`,
        409,
        [{ path: "input.fiscalYear", message: "Nothing to close" }],
      );

    // Seal each command against the state the previous one leaves, and preview it on that state. What
    // a period needs is read from that state too: reopening a period supersedes the close of every
    // later period that still had a current one, and those need closing again in turn.
    let chain = review.aggregate;
    let valid = true;
    const problems: Problem[] = [];
    const steps: YearEndStep[] = [];
    for (const [index, original] of year.entries()) {
      const period =
        periodViews(chain.state, review.today, review.booksBegan).find(
          (item) => item.id === original.id,
        ) ?? original;
      const base = {
        order: index + 1,
        periodId: period.id,
        label: period.label,
        startsOn: period.startsOn,
        endsOn: period.endsOn,
        status: original.status,
        closeSuperseded: original.closeSuperseded,
      };
      const todo = period.status === "open" || period.closeSuperseded;
      if (!todo || !valid) {
        steps.push({ ...base, plans: [] });
        continue;
      }
      const plans: YearEndStep["plans"][number][] = [];
      const kinds = period.closeSuperseded ? (["reopen", "close"] as const) : (["close"] as const);
      for (const kind of kinds) {
        if (!valid) break;
        const actionId = yearEndStepId(operationId, period.id, kind);
        const stepReason =
          kind === "close"
            ? yearEndStepReason(input.fiscalYear, period.label, reason)
            : yearEndReopenReason(input.fiscalYear, period.label, reason);
        const request = {
          yearEnd: operationId,
          fiscalYear: input.fiscalYear,
          periodId: period.id,
          kind,
          reason,
        };
        const context = { actionId, actor: service.commandActor };
        const actionKind = kind === "close" ? "closePeriod" : "reopenPeriod";
        await service.retainAction(actionId, actionKind, request, () =>
          kind === "close"
            ? closePeriodCommand(chain.state, context, period.id, stepReason)
            : reopenPeriodCommand(chain.state, context, period.id, stepReason),
        );
        const { prepared, next } = await service.previewChained(actionId, actionKind, chain);
        // `previewChained` always builds a plan whose disposition is "prepared".
        plans.push(prepared as YearEndStep["plans"][number]);
        if (next) chain = next;
        else {
          valid = false;
          problems.push(...prepared.problems);
        }
      }
      steps.push({ ...base, plans });
    }

    // The periods this plan closes: those found needing it at review, and any a reopening in the
    // chain superseded further on.
    const closes = steps.reduce(
      (sum, step) => sum + step.plans.filter((command) => command.kind === "closePeriod").length,
      0,
    );
    const planHash = hashCanonical({
      type: "ApplicationYearEndPlan",
      id: operationId,
      fiscalYear: String(input.fiscalYear),
      reason,
      bookRevision: state.bookRevision,
      steps: steps.map((step) => ({
        periodId: step.periodId,
        plans: step.plans.map((plan) => ({ planId: plan.planId, planHash: plan.planHash })),
      })),
    }).digest;
    return {
      disposition: "prepared",
      operationId,
      planId: operationId,
      planHash,
      bookRevision: state.bookRevision.toString(),
      fiscalYear: input.fiscalYear,
      startsOn,
      endsOn,
      reason,
      valid,
      openCount: valid ? closes : needsClose.length,
      supersededCount: review.superseded,
      closedCount: year.length - needsClose.length,
      diagnostics: problems.map((problem) => problem.message),
      problems,
      steps,
      checks: review.checks,
      statements: review.statements,
    };
  });
}

/** Commit a prepared year-end: every command, in order, each under its own plan hash.
 *
 * It stops at the first command the book rejects (the book changed after the review, so a later
 * command is no longer sealed against the right state) and says how many periods were closed; the
 * ones that were stay closed. It can be run again with the same identity after any interruption: a
 * command that already committed returns its retained receipt and is never submitted twice, and the
 * first one that did not continues from the exact bytes sealed at review time. */
export async function commitYearEnd(
  service: ApplicationService,
  input: { planId: string; planHash: string },
  operationId: string,
  by: string,
): Promise<YearEndReceipt> {
  return service.retainAsyncRequest(operationId, "periods.commitYearEnd", input, async () => {
    const notFound = () =>
      new ApplicationError(
        "year_end_plan_not_found",
        "No prepared year-end has this plan id. Prepare one with periods.yearEnd first.",
        404,
      );
    const retained = await service.operation(input.planId).catch((error: unknown) => {
      throw error instanceof ApplicationError && error.code === "operation_not_found"
        ? notFound()
        : error;
    });
    if (retained.kind !== "periods.yearEnd" || retained.disposition !== "completed")
      throw notFound();
    const plan = (retained as { result: YearEndPlan }).result;
    if (plan.planHash !== input.planHash)
      throw new ApplicationError(
        "plan_hash_conflict",
        "Prepared operation content does not match the reviewed plan",
        409,
      );
    if (!plan.valid)
      throw new ApplicationError(
        "plan_invalid",
        "This year-end plan is not valid and cannot be committed. Prepare a new one.",
        409,
        plan.problems.map((problem) => ({ path: "plan", message: problem.message })),
      );
    const receipts: YearEndStepReceipt[] = [];
    let closed = 0;
    let lastSequence: string | null = null;
    let failure: { diagnostics: readonly string[]; problems: readonly Problem[] } | null = null;
    for (const step of plan.steps) {
      for (const command of step.plans) {
        const kind = command.kind === "reopenPeriod" ? "reopenPeriod" : "closePeriod";
        if (failure) {
          receipts.push({
            periodId: step.periodId,
            kind,
            disposition: "skipped",
            outcomeSequence: null,
            diagnostics: [],
            problems: [],
          });
          continue;
        }
        const receipt = await service.commitAction(command.planId, command.planHash, {
          by,
          operation: "periods.commitYearEnd",
        });
        const committed = receipt.disposition === "committed";
        receipts.push({
          periodId: step.periodId,
          kind,
          disposition: committed ? "committed" : "rejected",
          outcomeSequence: receipt.outcomeSequence,
          diagnostics: [...receipt.diagnostics],
          problems: [...receipt.problems],
        });
        if (committed) {
          if (kind === "closePeriod") closed += 1;
          lastSequence = receipt.outcomeSequence;
        } else failure = { diagnostics: receipt.diagnostics, problems: receipt.problems };
      }
    }
    return {
      disposition: failure ? "rejected" : "committed",
      operationId,
      outcomeSequence: lastSequence,
      diagnostics: failure
        ? [
            `Closed ${closed} of ${plan.openCount} periods; the book rejected the next command: ${failure.diagnostics.join("; ") || "it changed after the review"}. The periods already closed stay closed. Review the year again before closing the rest.`,
          ]
        : [],
      problems: failure ? [...failure.problems] : [],
      planId: plan.planId,
      planHash: plan.planHash,
      fiscalYear: plan.fiscalYear,
      closedCount: closed,
      totalCount: plan.openCount,
      steps: receipts,
    };
  });
}
