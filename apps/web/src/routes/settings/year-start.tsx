import type { PreparedOperation } from "@rastrata/application/client-contracts";
import {
  settingsWords,
  YearStartBlock,
  type YearStartReview,
  type YearStartStage,
} from "@rastrata/ui";
import { createSignal } from "solid-js";
import { ApplicationRequestError, type BrowserApplicationClient } from "../../application-client";
import { CHANGE_WORKFLOW } from "../calendar/change";

const words = settingsWords.business.yearStart;

/** What the prepared plan says the calendar becomes: its first and last day and how many fiscal years. */
export function reviewOf(plan: PreparedOperation): YearStartReview | null {
  const periods = plan.effects.calendar ?? [];
  const first = periods[0];
  const last = periods[periods.length - 1];
  if (!first || !last) return null;
  return {
    firstDate: first.startsOn,
    lastDate: last.endsOn,
    years: new Set(periods.map((period) => period.fiscalYear)).size,
  };
}

/** Settings, Business: the month fiscal years start in, changeable until the book has an entry. The
 * change draws the calendar again, so it is reviewed first and committed as exactly the plan that was
 * reviewed. It shares the retained write of the Periods screen (`CHANGE_WORKFLOW`), so a reply lost here
 * is resumed there and the two cannot run over each other. */
export function YearStartPanel(props: {
  client: BrowserApplicationClient;
  month: number;
  onChanged: () => void;
}) {
  const [stage, setStage] = createSignal<YearStartStage>("closed");
  const [chosen, setChosen] = createSignal(props.month);
  const [plan, setPlan] = createSignal<PreparedOperation | null>(null);
  const [problem, setProblem] = createSignal("");
  const [changed, setChanged] = createSignal(false);
  const [blocked, setBlocked] = createSignal(false);

  const sync = () => {
    try {
      setBlocked(props.client.pending(CHANGE_WORKFLOW) !== null);
    } catch {
      setBlocked(true);
    }
  };
  sync();

  function failed(cause: unknown) {
    sync();
    setProblem(
      cause instanceof ApplicationRequestError && cause.uncertain
        ? "The request did not get an answer. Resume it before changing anything else."
        : cause instanceof Error
          ? cause.message
          : words.failed,
    );
    setStage(plan() ? "review" : "choosing");
  }

  async function review() {
    if (stage() === "preparing" || blocked() || chosen() === props.month) return;
    setProblem("");
    setChanged(false);
    setStage("preparing");
    try {
      const prepared = await props.client.write(
        "periods.changeYearStart",
        { fiscalYearStartMonth: chosen() },
        CHANGE_WORKFLOW,
      );
      if (!prepared.valid || reviewOf(prepared) === null) {
        setProblem(prepared.diagnostics.join("; ") || words.failed);
        setPlan(null);
        setStage("choosing");
        return;
      }
      setPlan(prepared);
      setStage("review");
    } catch (cause) {
      failed(cause);
    }
  }

  async function commit() {
    const current = plan();
    if (!current?.valid || stage() === "committing" || blocked()) return;
    setProblem("");
    setStage("committing");
    try {
      const receipt = await props.client.write(
        "operations.commit",
        { planId: current.planId, planHash: current.planHash },
        CHANGE_WORKFLOW,
      );
      sync();
      if (receipt.disposition === "committed") {
        setPlan(null);
        setChanged(true);
        setStage("closed");
        props.onChanged();
      } else {
        setProblem(receipt.diagnostics.join("; ") || words.failed);
        setPlan(null);
        setStage("choosing");
      }
    } catch (cause) {
      failed(cause);
    }
  }

  return (
    <YearStartBlock
      month={props.month}
      stage={stage()}
      chosen={chosen()}
      review={
        stage() === "review" || stage() === "committing"
          ? plan() && reviewOf(plan() as PreparedOperation)
          : null
      }
      problem={problem()}
      blocked={blocked()}
      changed={changed()}
      onOpen={() => {
        setChosen(props.month);
        setProblem("");
        setChanged(false);
        setStage("choosing");
      }}
      onChoose={(month) => {
        setChosen(month);
        setPlan(null);
        setProblem("");
        if (stage() === "review") setStage("choosing");
      }}
      onReview={() => void review()}
      onCommit={() => void commit()}
      onCancel={() => {
        setPlan(null);
        setProblem("");
        setStage("closed");
      }}
    />
  );
}
