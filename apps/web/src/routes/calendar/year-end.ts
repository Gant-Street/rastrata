import type {
  ApplicationOutputs,
  PeriodList,
  YearEndPlan,
  YearEndReceipt,
} from "@rastrata/application/client-contracts";
import { calendarWords, type YearEndStage } from "@rastrata/ui";
import { type Accessor, createEffect, createMemo, createSignal, untrack } from "solid-js";
import { ApplicationRequestError, type BrowserApplicationClient } from "../../application-client";
import { createKeyedLoader, createLoader, type Loader } from "../../loader";
import { buildChecklist, checklistSettled, type Read } from "./checklist";
import { nameOf, toReceipt, toStatements, toYearEndPlan } from "./convert";

/** The guided close of one fiscal year: what is read to fill the checklist, the plan the service
 * prepares for a reason, and the commit. Both writes go through the browser client under one workflow
 * key, so each is retained before it is sent: a reply lost in flight is "uncertain; resume" and the
 * same request is sent again with the same identity, never a new year-end. */
export const YEAR_END_WORKFLOW = "periods-year-end";

const REASON_LIMIT = 400;

/** A loader's state as the checklist reads it. A read that is under way is "loading" even when an
 * older answer is held, so a line is never shown as settled while it is being checked again. */
function readOf<T>(loader: Loader<T>): Read<T> {
  const value = loader.value();
  if (loader.loading()) return { state: "loading" };
  if (loader.error() !== undefined) return { state: "failed" };
  if (value !== undefined) return { state: "ready", value };
  return { state: "loading" };
}

const messageOf = (cause: unknown): string =>
  cause instanceof Error ? cause.message : "The request did not go through. Try again.";

/** A year-end write that was sent and never answered, found when the screen opens: whether there is
 * one, and the fiscal year it was for when the request says (a commit names only its plan). */
export function retainedYearEnd(
  client: BrowserApplicationClient,
): { readonly year: number | null } | null {
  try {
    const pending = client.pending(YEAR_END_WORKFLOW);
    if (!pending) return null;
    if (pending.name !== "periods.yearEnd") return { year: null };
    const year = (JSON.parse(pending.body) as { input?: { fiscalYear?: unknown } }).input
      ?.fiscalYear;
    return { year: typeof year === "number" && Number.isInteger(year) ? year : null };
  } catch {
    // An unreadable record still blocks a replacement write; the flow says so.
    return { year: null };
  }
}

export function createYearEndController(options: {
  client: BrowserApplicationClient;
  fiscalYear: Accessor<number>;
  list: Accessor<PeriodList | undefined>;
  /** Read the periods again, after a commit. */
  onChanged: () => Promise<void>;
  /** A resumed request turned out to be for another fiscal year than the one on show. */
  onYear: (year: number) => void;
}) {
  const { client } = options;
  const review = createKeyedLoader(options.fiscalYear, (year) =>
    client.read("periods.yearEndReview", { fiscalYear: year }),
  );
  /** The last period of the year: the month-end checklist is read for it. */
  const lastPeriod = createMemo(() => {
    const periods = (options.list()?.periods ?? []).filter(
      (period) => period.fiscalYear === options.fiscalYear(),
    );
    return periods.reduce<(typeof periods)[number] | undefined>(
      (last, period) => (last === undefined || period.endsOn > last.endsOn ? period : last),
      undefined,
    );
  });
  // A memo of the id, not of the period: the list is read again after every change, and the
  // month-end checklist must not be read again unless the last period is a different one.
  const lastPeriodId = createMemo(() => lastPeriod()?.id);
  const reconcile = createLoader(() => client.read("reconcile.status", {}));
  const cutover = createKeyedLoader(lastPeriodId, (periodId) =>
    client.read("cutover.checklist", { periodId }),
  );
  const inbox = createLoader(() => client.read("inbox.summary", {}));

  const checklist = createMemo(() => {
    const last = lastPeriod();
    return buildChecklist({
      review: readOf(review),
      reconcile: readOf(reconcile),
      cutover: readOf(cutover),
      inbox: readOf(inbox),
      endsOn: review.value()?.endsOn ?? last?.endsOn ?? "",
      lastPeriodLabel: last ? nameOf(last) : "the last period",
    });
  });
  const statements = createMemo(() => {
    const value = review.value()?.statements;
    return value ? toStatements(value) : null;
  });

  const [stage, setStage] = createSignal<YearEndStage>("checking");
  const [reason, setReason] = createSignal("");
  const [reasonError, setReasonError] = createSignal<string | undefined>(undefined);
  const [attempt, setAttempt] = createSignal(0);
  const [error, setError] = createSignal<string | undefined>(undefined);
  const [plan, setPlan] = createSignal<YearEndPlan | null>(null);
  const [receipt, setReceipt] = createSignal<YearEndReceipt | null>(null);
  const [uncertain, setUncertain] = createSignal(false);
  const [busy, setBusy] = createSignal(false);

  const syncPending = () => {
    try {
      setUncertain(client.pending(YEAR_END_WORKFLOW) !== null);
    } catch (cause) {
      setUncertain(true);
      setError(messageOf(cause));
    }
  };
  syncPending();

  // Once every read has answered (well or badly) the person can give a reason; until then the
  // checklist says it is checking.
  createEffect(() => {
    if (untrack(stage) === "checking" && checklistSettled(checklist())) setStage("reason");
  });

  const planView = createMemo(() => {
    const current = plan();
    return current ? toYearEndPlan(current) : null;
  });
  const planCurrent = createMemo(() => {
    const current = plan();
    return current !== null && current.reason === reason().trim();
  });
  const receiptView = createMemo(() => {
    const current = receipt();
    return current ? toReceipt(current) : null;
  });
  /** How many periods the year-end would close, once the year has been read. */
  const periodsToClose = createMemo(() => review.value()?.openCount ?? null);

  function failure(cause: unknown, fallback: YearEndStage) {
    // A request that was sent and not answered is shown as the retained request it is, with its
    // resume button; it is not also an error message.
    if (cause instanceof ApplicationRequestError && cause.uncertain) syncPending();
    else setError(messageOf(cause));
    setStage(plan() ? "plan" : fallback);
  }

  async function prepare() {
    if (busy()) return;
    const text = reason().trim();
    if (!text || text.length > REASON_LIMIT) {
      setReasonError(!text ? calendarWords.yearEndReasonRequired : calendarWords.yearEndReasonLong);
      setAttempt((count) => count + 1);
      return;
    }
    setReasonError(undefined);
    setError(undefined);
    setReceipt(null);
    setBusy(true);
    setStage("preparing");
    try {
      const prepared = await client.write(
        "periods.yearEnd",
        { fiscalYear: options.fiscalYear(), reason: text },
        YEAR_END_WORKFLOW,
      );
      setPlan(prepared);
      setStage("plan");
    } catch (cause) {
      failure(cause, "reason");
    } finally {
      syncPending();
      setBusy(false);
    }
  }

  async function finish(done: ApplicationOutputs["periods.commitYearEnd"]) {
    if (done.fiscalYear !== options.fiscalYear()) options.onYear(done.fiscalYear);
    setReceipt(done);
    // Whatever closed, the periods are read again so the screen never shows the old state.
    await options.onChanged();
    setStage("done");
  }

  async function commit() {
    const current = plan();
    if (busy() || !current || !current.valid || !planCurrent()) return;
    setError(undefined);
    setBusy(true);
    setStage("committing");
    try {
      await finish(
        await client.write(
          "periods.commitYearEnd",
          { planId: current.planId, planHash: current.planHash },
          YEAR_END_WORKFLOW,
        ),
      );
    } catch (cause) {
      failure(cause, "plan");
    } finally {
      syncPending();
      setBusy(false);
    }
  }

  async function resume() {
    if (busy()) return;
    setError(undefined);
    setBusy(true);
    try {
      const done = await client.resume(YEAR_END_WORKFLOW);
      if (done.name === "periods.yearEnd") {
        if (done.data.fiscalYear !== options.fiscalYear()) options.onYear(done.data.fiscalYear);
        setPlan(done.data);
        setReason(done.data.reason);
        setStage("plan");
      } else if (done.name === "periods.commitYearEnd") await finish(done.data);
      else setError("An unexpected request was retained. Nothing was changed.");
    } catch (cause) {
      failure(cause, plan() ? "plan" : "reason");
    } finally {
      syncPending();
      setBusy(false);
    }
  }

  /** Look at the year again after a commit that stopped part way: a fresh review and a fresh plan. */
  async function reviewAgain() {
    setPlan(null);
    setReceipt(null);
    setError(undefined);
    // The reads start before the stage changes, so the checklist is never shown as settled while it
    // is being read again.
    const reads = Promise.all([
      review.reload(),
      reconcile.reload(),
      cutover.reload(),
      inbox.reload(),
    ]);
    setStage("checking");
    await reads;
  }

  return {
    stage,
    checklist,
    statements,
    reason,
    setReason,
    reasonError,
    attempt,
    error,
    plan: planView,
    planCurrent,
    receipt: receiptView,
    uncertain,
    busy,
    periodsToClose,
    prepare,
    commit,
    resume,
    reviewAgain,
  };
}
