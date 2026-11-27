import type { PeriodList } from "@rastrata/application/client-contracts";
import { accountingWords, localToday } from "@rastrata/ui";
import { type Accessor, createMemo, createSignal } from "solid-js";
import { createPostingWorkflow } from "../posting-workflow";
import { reversalDate } from "./journal-date";

/** What is being reversed, as the dialog says it. `label` is the entry's number ("No. 28"). */
export type ReverseTarget = {
  readonly id: string;
  readonly label: string;
  readonly description: string;
  /** The date of the entry. */
  readonly date: string;
  readonly amount: string;
};

/** The browser keeps one retained write for this key, so there is only ever one reversal in hand. */
export const REVERSAL_WORKFLOW = "reversal";

/** Reversing an entry from the list or from its page: the dialog asks for a date and a reason, prepares the
 * reversal and, when the plan has nothing to read, posts it in the same click. A plan with a warning (an
 * account already reconciled) or a problem (a closed period) waits in the dialog for a decision. Every
 * write is retained before it is sent, so a lost reply is resumed and never repeated. */
export function createReverseController(options: {
  periods: Accessor<PeriodList | undefined>;
  /** The entry for a journal id the page knows, so a reversal resumed after a reload can say which entry
   * it is. */
  lookup: (journalId: string) => ReverseTarget | undefined;
  /** The reversal was posted. The target is not known when a reply lost before a reload is resumed. */
  onReversed: (target: ReverseTarget | undefined) => void | Promise<void>;
}) {
  const w = accountingWords.reverse;
  const [target, setTarget] = createSignal<ReverseTarget | null>(null);
  const [date, setDate] = createSignal("");
  const [reason, setReason] = createSignal("");
  const [errors, setErrors] = createSignal<{ date?: string; reason?: string }>({});
  const [phase, setPhase] = createSignal<"idle" | "working">("idle");

  const workflow = createPostingWorkflow(
    REVERSAL_WORKFLOW,
    async (receipt) => {
      if (receipt.disposition !== "committed") return;
      const done = target() ?? undefined;
      setTarget(null);
      setReason("");
      await options.onReversed(done);
    },
    (request) => {
      // A request resumed after a reload: open the dialog it belongs to.
      if (request.name !== "journal.prepareReverse") return;
      const known = options.lookup(request.input.journalId);
      setTarget(
        known ?? {
          id: request.input.journalId,
          label: "this transaction",
          description: "",
          date: request.input.accountingDate,
          amount: "",
        },
      );
      setDate(request.input.accountingDate);
      setReason(request.input.reason);
    },
    { chain: true },
  );

  const periodList = () => options.periods();
  const lockedPeriods = () =>
    (periodList()?.periods ?? [])
      .filter((period) => period.status === "closed")
      .map((period) => ({ startsOn: period.startsOn, endsOn: period.endsOn }));

  /** `review` when the plan has something to read before it is posted; `working` while a request is
   * on its way. */
  const stage = createMemo(() =>
    phase() === "working" ? "working" : workflow.plan() ? "review" : "compose",
  );
  const warnings = () => (workflow.plan()?.warnings ?? []).map((warning) => warning.message);
  const problems = () => {
    const plan = workflow.plan();
    return plan && !plan.valid ? [...plan.diagnostics] : [];
  };

  /** Open the dialog for an entry. */
  function begin(entry: ReverseTarget) {
    if (workflow.blocked() && !target()) return;
    workflow.discard();
    setErrors({});
    setReason("");
    const calendar = periodList()?.calendar;
    setDate(
      reversalDate({
        entryDate: entry.date,
        today: calendar?.today ?? localToday(),
        calendar: calendar
          ? { firstDate: calendar.firstDate, lastDate: calendar.lastDate }
          : undefined,
        locked: lockedPeriods(),
      }),
    );
    setTarget(entry);
  }

  async function submit() {
    const entry = target();
    if (!entry || phase() === "working" || workflow.blocked()) return;
    const trimmed = reason().trim();
    const found = {
      ...(date() ? {} : { date: w.dateRequired }),
      ...(trimmed ? {} : { reason: w.reasonRequired }),
    };
    setErrors(found);
    if (found.date || found.reason) return;
    setPhase("working");
    try {
      await workflow.prepare("journal.prepareReverse", {
        journalId: entry.id,
        accountingDate: date(),
        reason: trimmed,
      });
    } finally {
      setPhase("idle");
    }
  }

  /** Post a reversal whose warnings the person has read. */
  async function confirm() {
    if (phase() === "working") return;
    setPhase("working");
    try {
      await workflow.commit();
    } finally {
      setPhase("idle");
    }
  }

  function cancel() {
    if (phase() === "working") return;
    workflow.discard();
    setTarget(null);
    setErrors({});
  }

  return {
    target,
    date,
    setDate,
    reason,
    setReason,
    errors,
    stage,
    warnings,
    problems,
    begin,
    submit,
    confirm,
    cancel,
    resume: workflow.resume,
    /** A write is retained or under way. */
    pending: workflow.pending,
    blocked: workflow.blocked,
    /** What went wrong when there is no plan to read. */
    error: () => (workflow.plan() ? "" : workflow.error()),
  };
}
