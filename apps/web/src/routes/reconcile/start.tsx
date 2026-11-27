import { canonicalStatementBalance, isCalendarDate } from "@rastrata/application/reconcile-engine";
import {
  accountOptions,
  formatDate,
  ReconcileStartDialog,
  reconcileWords as words,
  type StartFormErrors,
  type StartFormValues,
} from "@rastrata/ui";
import { createMemo, createSignal, onMount } from "solid-js";
import {
  ApplicationRequestError,
  BrowserApplicationClient,
  type PendingRequest,
} from "../../application-client";
import { createLoader } from "../../loader";
import { statementBalanceHint } from "./figures";

/** The retained-request key of starting a reconciliation: a reply that is lost is resumed under its
 * original identity, never replaced. */
const START = "reconcile:start";

/** Map a refusal to the field it is about, so the message sits where the person can fix it. */
function startErrors(cause: unknown): StartFormErrors {
  if (cause instanceof ApplicationRequestError) {
    if (cause.code.startsWith("statement_date")) return { date: cause.message };
    if (cause.code === "statement_balance_invalid") return { balance: cause.message };
    if (cause.code.startsWith("reconcile_account")) return { account: cause.message };
    return { form: cause.message };
  }
  return { form: words.startFailed };
}

/** The small form that starts a reconciliation, over whatever page it is opened from: an account's row on
 * Reconcile, "Reconcile an account" on that page, or "+ New" anywhere. It reads the accounts that can be
 * reconciled and the balance an imported statement reported, asks for the date and the balance, and opens
 * the reconciliation it made. A start whose reply was lost is shown with the button to resume it. */
export function StartReconciliation(props: {
  open: boolean;
  onClose: () => void;
  /** The account the form opens on (an account's row), or none. */
  account?: string | undefined;
}) {
  const client = new BrowserApplicationClient(window.localStorage);
  const status = createLoader(() => client.read("reconcile.status", { all: true }));
  // The balance a statement file reported, when one was imported. For review may be unavailable or
  // empty; either way the form simply has no suggestion.
  const checks = createLoader(async () => {
    try {
      return (await client.read("inbox.balanceChecks", {})).checks;
    } catch {
      return [];
    }
  });
  const [errors, setErrors] = createSignal<StartFormErrors>({});
  const [starting, setStarting] = createSignal(false);
  const [pending, setPending] = createSignal<PendingRequest | null>(null);
  const [chosen, setChosen] = createSignal(props.account ?? "");

  const accounts = createMemo(() =>
    accountOptions((status.value()?.accounts ?? []).map((row) => row.account)),
  );
  /** The newest imported statement balance for the chosen account (see `statementBalanceHint`: a
   * bank feed's balance is never offered as a statement's). */
  const hint = createMemo(() => {
    const row = status.value()?.accounts.find((item) => item.account.id === chosen());
    return row
      ? statementBalanceHint(checks.value() ?? [], row.account, row.lastReconciledDate)
      : undefined;
  });

  const syncPending = () => {
    try {
      setPending(client.pending(START));
    } catch (cause) {
      setErrors({ form: cause instanceof Error ? cause.message : words.startFailed });
    }
  };
  onMount(syncPending);

  const open = (id: string) => window.location.assign(`/reconcile/${encodeURIComponent(id)}`);

  async function start(values: StartFormValues) {
    const problems: StartFormErrors = {
      ...(isCalendarDate(values.date)
        ? {}
        : { date: `${formatDate(values.date)} is not a calendar date.` }),
      ...(canonicalStatementBalance(values.balance) === null
        ? { balance: words.statementBalanceHint }
        : {}),
    };
    setErrors(problems);
    if (Object.keys(problems).length > 0) return;
    setStarting(true);
    try {
      const draft = await client.write(
        "reconcile.start",
        {
          accountId: values.account,
          statementDate: values.date,
          statementBalance: values.balance,
        },
        START,
      );
      open(draft.id);
    } catch (cause) {
      if (!(cause instanceof ApplicationRequestError && cause.uncertain))
        setErrors(startErrors(cause));
    } finally {
      syncPending();
      setStarting(false);
    }
  }

  async function resume() {
    setStarting(true);
    try {
      const done = await client.resume(START);
      if (done.name === "reconcile.start") open(done.data.id);
      else syncPending();
    } catch (cause) {
      if (!(cause instanceof ApplicationRequestError && cause.uncertain))
        setErrors(startErrors(cause));
    } finally {
      syncPending();
      setStarting(false);
    }
  }

  return (
    <ReconcileStartDialog
      open={props.open}
      onOpenChange={(next) => {
        if (!next) {
          setErrors({});
          props.onClose();
        }
      }}
      accounts={accounts()}
      account={props.account}
      hint={hint()}
      onAccountChange={setChosen}
      errors={errors()}
      pending={starting()}
      retained={pending() !== null}
      onResume={() => void resume()}
      onSubmit={(values) => void start(values)}
    />
  );
}

/** Whether a start's reply was lost, so the page can open the form with its way to resume. */
export function hasRetainedStart(): boolean {
  try {
    return new BrowserApplicationClient(window.localStorage).pending(START) !== null;
  } catch {
    return false;
  }
}
