import type { PeriodList } from "@rastrata/application/client-contracts";
import {
  calendarWords as words,
  type PeriodChangePlan,
  type PeriodChangeStage,
} from "@rastrata/ui";
import { type Accessor, createEffect, createMemo, createSignal } from "solid-js";
import { createPostingWorkflow } from "../../posting-workflow";
import { toChangePlan, toPeriod } from "./convert";

/** What is being reviewed on the Periods screen: closing or reopening one period. (Extending the calendar
 * was a change here until 2026-11-06; a posting grows the calendar itself now.) */
export type Change = {
  readonly kind: "period";
  readonly periodId: string;
  readonly operation: "close" | "reopen";
};

/** The browser keeps one retained write for this key, so there is only ever one change in hand. */
export const CHANGE_WORKFLOW = "periods";

const REASON_LIMIT = 500;

/** What a reviewed plan was for, kept in the browser so that a commit resumed after a reload can say
 * what it did. Best effort: when storage is unavailable the message is the general one. */
const REVIEWED = "rastrata:periods:reviewed:";
const remember = (planId: string, change: Change) => {
  try {
    window.localStorage.setItem(REVIEWED + planId, JSON.stringify(change));
  } catch {
    // The message after a resume is less specific; nothing else depends on it.
  }
};
const forget = (planId: string) => {
  try {
    window.localStorage.removeItem(REVIEWED + planId);
  } catch {
    // Nothing to do.
  }
};
const recall = (planId: string): Change | null => {
  try {
    const found = JSON.parse(
      window.localStorage.getItem(REVIEWED + planId) ?? "null",
    ) as Change | null;
    if (found?.kind === "period" && typeof found.periodId === "string") return found;
    return null;
  } catch {
    return null;
  }
};

/** One change at a time, in two steps: ask the service to prepare it (for a period, with a reason),
 * then commit exactly the plan that came back. The plan on screen is only committed while it is the
 * plan for what is typed now. */
export function createChangeController(options: {
  list: Accessor<PeriodList | undefined>;
  /** Read the periods again; the screen shows what the book now says. */
  reload: () => Promise<void>;
  /** A change was committed: say so. `done` is what was changed, when it is known (it is not after a
   * reload that resumed the commit and had nothing remembered). */
  committed: (message: string, done: Change | null) => void;
}) {
  const [change, setChange] = createSignal<Change | null>(null);
  const [reason, setReason] = createSignal("");
  const [reasonError, setReasonError] = createSignal<string | undefined>(undefined);
  const [attempt, setAttempt] = createSignal(0);
  const [phase, setPhase] = createSignal<"idle" | "preparing" | "committing">("idle");

  const workflow = createPostingWorkflow(
    CHANGE_WORKFLOW,
    async (receipt) => {
      await options.reload();
      // For a commit, the operation's identity is its plan's.
      const done = change() ?? recall(receipt.operationId);
      forget(receipt.operationId);
      if (receipt.disposition !== "committed") return;
      setChange(null);
      setReason("");
      options.committed(done === null ? words.recordedAfterResume : words.recorded, done);
    },
    (request) => {
      // A request that was resumed after a reload: open the review it belongs to. An extension retained by a
      // session from before the screen stopped offering one is resumed too; its plan has no review here and
      // goes when the next change starts.
      if (request.name === "periods.prepare") {
        setReason(request.input.reason);
        setChange({
          kind: "period",
          periodId: request.input.periodId,
          operation: request.input.operation,
        });
      }
    },
  );

  // Whatever plan is on screen, remember what it is for (also after a plan is restored on resume).
  createEffect(() => {
    const planned = workflow.plan();
    const open = change();
    if (planned && open) remember(planned.planId, open);
  });

  /** What the plan on screen must have been prepared for. */
  const input = createMemo(() => {
    const current = change();
    return current
      ? { periodId: current.periodId, operation: current.operation, reason: reason().trim() }
      : null;
  });

  const stage = createMemo(
    (): PeriodChangeStage =>
      phase() === "preparing" ? "preparing" : workflow.plan() ? "review" : "compose",
  );
  const current = createMemo(() => {
    const wanted = input();
    return wanted !== null && workflow.current(wanted);
  });

  const period = createMemo(() => {
    const open = change();
    const list = options.list();
    return open && list ? toPeriod(list, open.periodId) : undefined;
  });
  const plan = createMemo((): PeriodChangePlan | null => {
    const prepared = workflow.plan();
    const open = change();
    const list = options.list();
    if (!prepared || !list || !open) return null;
    const shown = list.periods.find((item) => item.id === open.periodId);
    return toChangePlan(
      prepared,
      list,
      open.operation === "close" ? (shown?.endsOn ?? null) : null,
    );
  });

  async function prepare() {
    const open = change();
    if (!open || workflow.blocked()) return;
    const text = reason().trim();
    if (!text || text.length > REASON_LIMIT) {
      setReasonError(!text ? words.reasonRequired : words.reasonLong);
      setAttempt((count) => count + 1);
      return;
    }
    setReasonError(undefined);
    setPhase("preparing");
    try {
      // Closing is one click when the plan has nothing to read; reopening is always reviewed, because it
      // can undo later closes.
      await workflow.prepare(
        "periods.prepare",
        { periodId: open.periodId, operation: open.operation, reason: text },
        open.operation === "close",
      );
    } finally {
      setPhase("idle");
    }
  }

  /** Open a review. */
  function begin(next: Change) {
    if (workflow.blocked()) return;
    leave();
    setReason("");
    setReasonError(undefined);
    setChange(next);
  }

  /** Close one period in one step. Its reason starts as given and the person is not asked for more: the plan
   * is committed at once when it is valid and says nothing to read, and shown for review when it does. */
  async function closeNow(periodId: string, because: string) {
    if (workflow.blocked()) return;
    leave();
    setReasonError(undefined);
    setReason(because);
    setChange({ kind: "period", periodId, operation: "close" });
    await prepare();
  }

  async function commit() {
    if (phase() !== "idle" || !current()) return;
    setPhase("committing");
    try {
      await workflow.commit();
    } finally {
      setPhase("idle");
    }
  }

  /** Drop the plan on screen, and what was remembered about it. */
  function leave() {
    const planned = workflow.plan();
    if (planned) forget(planned.planId);
    workflow.discard();
  }

  function cancel() {
    leave();
    setChange(null);
    setReason("");
    setReasonError(undefined);
  }

  return {
    change,
    reason,
    setReason,
    reasonError,
    attempt,
    stage,
    current,
    period,
    plan,
    /** A request is being sent. */
    busy: () => phase() === "committing",
    /** Something is retained, or a request is in flight: nothing else may start. */
    blocked: workflow.blocked,
    retained: () => workflow.pending() !== null,
    /** The service refused or a request failed, with nothing to review. */
    error: () => (workflow.plan() ? "" : workflow.error()),
    begin,
    closeNow,
    prepare,
    commit,
    cancel,
    resume: workflow.resume,
    working: workflow.busy,
  };
}
