import type {
  InboxRecategorizeInput,
  InboxRecategorizeReport,
  InboxRecategorizeResult,
} from "@rastrata/application/client-contracts";
import { moving } from "@rastrata/ui/catchall/logic";
import type { ChangeAccountStage, MoveRow } from "@rastrata/ui/catchall/types";
import { catchallWords } from "@rastrata/ui/catchall/words";
import { type AccountOption, type AccountRowLike, accountOptions } from "@rastrata/ui/kit/accounts";
import { createMemo, createSignal } from "solid-js";
import { ApplicationRequestError, type BrowserApplicationClient } from "../../application-client";
import { forPeople } from "../entries/messages";

/** The browser keeps one retained write for each key, so there is only ever one plan and one change of
 * account in hand. */
export const PLAN_WORKFLOW = "change-account-plan";
export const CHANGE_WORKFLOW = "change-account";

/** Transactions one request moves. A call moves a bounded number and says which it did not reach, so a long
 * list is sent in turns. */
export const TURN = 100;
/** The most turns one change makes: more than enough for `MOST_AT_ONCE`, and a limit on a loop. */
const MAX_TURNS = 30;
/** The most transactions one change names (what the service takes in one request). */
export const MOST_AT_ONCE = 500;

const messageOf = (cause: unknown): string =>
  cause instanceof Error ? forPeople(cause.message) : "The request could not be completed.";

/** What the service said of one transaction, as the dialog shows it. `names` says an account by its id. */
export function moveRow(
  result: InboxRecategorizeResult,
  names: (accountId: string | undefined) => string | undefined,
): MoveRow {
  // A transaction that failed after its old entry was reversed is left back in For review, or ready to post.
  const left =
    result.outcome === "failed" && result.reversalJournalId !== undefined
      ? result.status === "drafted"
        ? ("ready" as const)
        : ("review" as const)
      : undefined;
  return {
    id: result.journalId ?? result.itemId ?? "",
    outcome: result.outcome,
    date: result.date,
    description: result.description ?? "",
    amount: result.amount,
    from: names(result.fromAccountId),
    to: names(result.toAccountId),
    why: result.message === undefined ? undefined : forPeople(result.message),
    warnings: (result.warnings ?? []).map((warning) => forPeople(warning.message)),
    left,
  };
}

/** A request this screen sent and never saw answered: which one it was, and what it said. */
export interface WaitingChange {
  readonly which: "plan" | "change";
  readonly input: InboxRecategorizeInput;
}

/** The request that is retained for this screen, if there is one. A change is looked for before a plan. */
export function waitingChange(client: BrowserApplicationClient): WaitingChange | null {
  for (const [which, workflow] of [
    ["change", CHANGE_WORKFLOW],
    ["plan", PLAN_WORKFLOW],
  ] as const) {
    const pending = client.pending(workflow);
    if (pending?.name === "inbox.recategorize")
      return { which, input: JSON.parse(pending.body).input as InboxRecategorizeInput };
  }
  return null;
}

/** Changing the account of transactions selected on Transactions: choose the account, read the plan the
 * service makes (`dryRun`, which changes nothing), confirm, and the transactions that can move are moved in
 * turns. Every request is retained before it is sent, so a reply lost on the way is resumed and never sent
 * again as something new. */
export function createChangeAccountController(options: {
  client: BrowserApplicationClient;
  /** The chart, once it has been read. */
  accounts: () => readonly AccountRowLike[] | undefined;
  accountsState: () => "ready" | "loading" | "error";
  /** Read the chart (the first time the dialog is opened, and again when it could not be read). */
  loadAccounts: () => void;
  /** The dialog was closed over some work that was done: read the list again. `moved` is how many
   * transactions are on the new account now; it may be none. */
  onMoved: (moved: number, target: string) => void | Promise<void>;
}) {
  const w = catchallWords.change;
  const [ids, setIds] = createSignal<readonly string[]>([]);
  const [omitted, setOmitted] = createSignal(0);
  const [open, setOpen] = createSignal(false);
  const [stage, setStage] = createSignal<ChangeAccountStage>("choose");
  const [accountId, setAccountId] = createSignal("");
  const [reason, setReason] = createSignal("");
  const [accountError, setAccountError] = createSignal<string | undefined>(undefined);
  const [rows, setRows] = createSignal<readonly MoveRow[]>([]);
  const [progress, setProgress] = createSignal<{ done: number; total: number } | undefined>();
  const [error, setError] = createSignal<string | undefined>(undefined);
  const [uncertain, setUncertain] = createSignal<"plan" | "change" | null>(null);
  /** The account the service last named as the target, for when the chart has not been read. */
  const [named, setNamed] = createSignal<{ id: string; name: string } | undefined>(undefined);
  /** What the change has done so far, kept across a resumed turn. */
  let done: InboxRecategorizeResult[] = [];
  let todo: string[] = [];
  let busy = false;

  /** A request waiting for its answer, whether or not the dialog is open (an invalid one is none). */
  function readWaiting(): WaitingChange | null {
    try {
      return waitingChange(options.client);
    } catch {
      return null;
    }
  }
  const [waiting, setWaiting] = createSignal<WaitingChange | null>(readWaiting());

  const choices = createMemo<AccountOption[]>(() => accountOptions(options.accounts() ?? []));
  const nameOf = (id: string | undefined): string | undefined => {
    if (id === undefined) return undefined;
    const known = options.accounts()?.find((account) => account.id === id)?.name;
    return known ?? (named()?.id === id ? named()?.name : undefined);
  };
  const target = () => nameOf(accountId()) ?? "";

  const fail = (cause: unknown, which: "plan" | "change") => {
    const refused = cause instanceof ApplicationRequestError && cause.code === "permission_denied";
    // A refusal for permission did nothing, and nobody will send that request again: it is let go, so that
    // it does not stand in the way of the next one.
    if (refused) options.client.discard(which === "plan" ? PLAN_WORKFLOW : CHANGE_WORKFLOW);
    const lost = cause instanceof ApplicationRequestError && cause.uncertain && !refused;
    // The request in the way may be the other kind of request than the one that was being sent.
    setUncertain(lost ? (readWaiting()?.which ?? which) : null);
    // What a lost reply says is for developers; the dialog says what a person needs.
    setError(lost ? undefined : refused ? w.denied : messageOf(cause));
    setWaiting(readWaiting());
  };

  /** Open the dialog for these entries (the transactions the person ticked). A request that was sent and never
   * answered is shown first: it is resumed, not replaced. */
  function begin(selected: readonly string[] = []) {
    if (busy) return;
    let found: WaitingChange | null = null;
    let broken: string | undefined;
    try {
      found = waitingChange(options.client);
    } catch (cause) {
      broken = messageOf(cause);
    }
    if (found === null && selected.length === 0) return;
    done = [];
    todo = [];
    setRows([]);
    setProgress(undefined);
    setAccountError(undefined);
    setNamed(undefined);
    setError(broken);
    if (found) {
      setIds(found.input.journalIds ?? []);
      setOmitted(0);
      setAccountId(found.input.accountId);
      setReason(found.input.reason ?? "");
      setUncertain(found.which);
      setStage(found.which === "change" ? "working" : "choose");
    } else {
      setIds(selected.slice(0, MOST_AT_ONCE));
      setOmitted(Math.max(0, selected.length - MOST_AT_ONCE));
      setAccountId("");
      setReason("");
      setUncertain(null);
      setStage(broken === undefined ? "choose" : "failed");
    }
    if (options.accountsState() !== "ready") options.loadAccounts();
    setOpen(true);
  }

  function cancel() {
    if (busy) return;
    const applied = done.filter((result) => result.outcome === "applied").length;
    const touched = done.length > 0;
    const name = target();
    done = [];
    setOpen(false);
    setStage("choose");
    setWaiting(readWaiting());
    // Whatever was moved is on the list now; it is read again when the dialog goes.
    if (touched) void options.onMoved(applied, name);
  }

  async function plan() {
    if (busy || uncertain() !== null) return;
    if (accountId() === "") {
      setAccountError(w.accountRequired);
      return;
    }
    setAccountError(undefined);
    setError(undefined);
    busy = true;
    setStage("planning");
    try {
      const report = await options.client.write(
        "inbox.recategorize",
        {
          journalIds: [...ids()],
          accountId: accountId(),
          ...(reason().trim() ? { reason: reason().trim() } : {}),
          limit: ids().length,
          dryRun: true,
        },
        PLAN_WORKFLOW,
      );
      setNamed({ id: report.target.accountId, name: report.target.name });
      setRows(report.results.map((result) => moveRow(result, nameOf)));
      setUncertain(null);
      setWaiting(null);
      if (report.remaining > 0) {
        // The service stopped looking before it had seen them all: a plan that leaves some out is not a plan.
        setError(w.planIncomplete);
        setStage("failed");
      } else setStage("review");
    } catch (cause) {
      fail(cause, "plan");
      setStage(uncertain() === null ? "failed" : "choose");
    } finally {
      busy = false;
    }
  }

  /** Send the transactions that can move, a bounded number at a time, until every one has been reached. */
  async function run(first?: InboxRecategorizeReport) {
    const total = todo.length + done.length;
    const take = (report: InboxRecategorizeReport) => {
      done = [...done, ...report.results];
      const reached = new Set(report.results.flatMap((r) => (r.journalId ? [r.journalId] : [])));
      todo = todo.filter((id) => !reached.has(id));
      setNamed({ id: report.target.accountId, name: report.target.name });
      setProgress({ done: Math.min(total, done.length), total });
    };
    if (first) take(first);
    for (let turn = 0; turn < MAX_TURNS && todo.length > 0; turn++) {
      const before = todo.length;
      const report = await options.client.write(
        "inbox.recategorize",
        {
          journalIds: todo.slice(0, TURN),
          accountId: accountId(),
          ...(reason().trim() ? { reason: reason().trim() } : {}),
        },
        CHANGE_WORKFLOW,
      );
      take(report);
      // A call that reached nothing cannot be made to by asking again.
      if (todo.length === before) break;
    }
  }

  /** Show what was done: every answer the service gave, what the plan said could not move, and what the plan
   * said could move and was never reached, which is said and not hidden. */
  function finish() {
    const planned = rows();
    const missed = new Set(todo);
    setRows([
      ...done.map((result) => moveRow(result, nameOf)),
      ...planned.filter((row) => row.outcome !== "would_apply"),
      ...planned
        .filter((row) => missed.has(row.id))
        .map((row) => ({ ...row, outcome: "skipped" as const, why: w.result.notReached })),
    ]);
    setProgress(undefined);
    setStage("done");
  }

  async function confirm() {
    if (busy || stage() !== "review" || uncertain() !== null) return;
    todo = moving(rows()).map((row) => row.id);
    done = [];
    setError(undefined);
    busy = true;
    setProgress({ done: 0, total: todo.length });
    setStage("working");
    try {
      await run();
      setUncertain(null);
      setWaiting(null);
      finish();
    } catch (cause) {
      fail(cause, "change");
      // A request that was refused stops the change, and what it did before is shown. One that was not
      // answered waits, and is resumed.
      if (uncertain() === null) finish();
    } finally {
      busy = false;
    }
  }

  /** Finish a request that was sent and never answered, then carry on with what is left. */
  async function resume() {
    const which = uncertain();
    if (busy || which === null) return;
    busy = true;
    setError(undefined);
    try {
      if (which === "change") {
        // After a reload only the request is known: what it named and was not answered stays to do.
        const sent = waitingChange(options.client)?.input.journalIds ?? [];
        todo = [...new Set([...todo, ...sent])];
        setStage("working");
      }
      const completed = await options.client.resume(
        which === "plan" ? PLAN_WORKFLOW : CHANGE_WORKFLOW,
      );
      if (completed.name !== "inbox.recategorize") return;
      const report = completed.data;
      if (which === "plan") {
        setNamed({ id: report.target.accountId, name: report.target.name });
        setRows(report.results.map((result) => moveRow(result, nameOf)));
        setStage("review");
      } else {
        setProgress({ done: 0, total: todo.length });
        await run(report);
        finish();
      }
      setUncertain(null);
      setWaiting(null);
    } catch (cause) {
      fail(cause, which);
      if (which === "change" && uncertain() === null) finish();
    } finally {
      busy = false;
    }
  }

  return {
    open,
    count: () => ids().length,
    capped: () => (omitted() > 0 ? { included: ids().length, left: omitted() } : undefined),
    stage,
    accountOptions: choices,
    accountsState: options.accountsState,
    loadAccounts: options.loadAccounts,
    accountId,
    setAccountId: (value: string) => {
      setAccountId(value);
      setAccountError(undefined);
    },
    accountError,
    reason,
    setReason,
    rows,
    target,
    progress,
    error,
    uncertain: () => uncertain() !== null,
    /** A change was sent and never answered, and the dialog is shut: the page says so. */
    waiting: () => !open() && waiting() !== null,
    begin,
    cancel,
    back: () => {
      if (!busy) setStage("choose");
    },
    plan,
    confirm,
    resume,
  };
}
