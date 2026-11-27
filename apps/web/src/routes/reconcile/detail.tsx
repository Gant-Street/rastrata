import type { Reconciliation } from "@rastrata/application/client-contracts";
import { canonicalStatementBalance } from "@rastrata/application/reconcile-engine";
import {
  Button,
  DateValue,
  Details,
  DetailsList,
  Dialog,
  DialogClose,
  formatDate,
  formatInstant,
  formatMoney,
  isNegativeMoney,
  listAccountLabel,
  Notice,
  PageHeader,
  ReconcileDiscardDialog,
  ReconcileFinishDialog,
  type ReconcileLine,
  ReconcileOutstanding,
  ReconcileRecordLines,
  ReconcileReportButton,
  ReconcileReportStatus,
  ReconcileSummary,
  ReconcileVoidDialog,
  reconcileWords as words,
  ReconcileWorkspace,
  type ReportFileState,
  Status,
  TextField,
  DateField,
} from "@rastrata/ui";
import { useParams } from "@tanstack/solid-router";
import { createMemo, createSignal, onMount, Show } from "solid-js";
import { ApplicationRequestError, BrowserApplicationClient } from "../../application-client";
import { saveFile } from "../../download";
import { createKeyedLoader, createLoader } from "../../loader";
import { createDraft } from "./draft-controller";
import { totalOf } from "./figures";
import { outstandingView, reportBlob, reportFileName } from "./report";

/** The account as a title and a sentence say it: its name, and its number first only when the owner asked
 * for numbers (Settings, Business). */
const accountName = (account: Reconciliation["account"]) =>
  listAccountLabel(account.name, account.code);

function toLine(line: Reconciliation["lines"][number], revision: string): ReconcileLine {
  return {
    id: line.postingId,
    date: line.date,
    description: line.narration,
    amount: line.amount,
    href: `/journal/${encodeURIComponent(line.journalId)}?revision=${encodeURIComponent(revision)}`,
  };
}

const message = (cause: unknown, fallback: string) =>
  cause instanceof Error ? cause.message : fallback;

/** One reconciliation: a draft you work in, or a completed or voided record you read. */
export function ReconcileDetailPage() {
  // The router's types know only the core routes; this lane's path carries one parameter, id.
  const params = useParams({ strict: false }) as () => { id?: string };
  return (
    <Show when={params().id} keyed>
      {(id) => <Detail id={id} />}
    </Show>
  );
}

function Detail(props: { id: string }) {
  const client = new BrowserApplicationClient(window.localStorage);
  // Held in plain signals (see loader.ts): reading the reconciliation never suspends the page.
  const loaded = createLoader(() => client.read("reconcile.get", { id: props.id }));
  const [replaced, setReplaced] = createSignal<{ view: Reconciliation; completed: boolean } | null>(
    null,
  );
  const current = () => replaced()?.view ?? loaded.value();
  return (
    <section class="rt-recon-page">
      {/* The page has a title while it opens and when it could not be opened; once the reconciliation
          is there, its own screen has one. */}
      <Show
        when={loaded.value() !== undefined || loaded.error() !== undefined}
        fallback={
          <>
            <PageHeader title="Reconciliation" />
            <p role="status">Opening the reconciliation…</p>
          </>
        }
      >
        <Show
          when={loaded.error() === undefined}
          fallback={
            <>
              <PageHeader title="Reconciliation" />
              <Notice title="This reconciliation could not be opened" tone="error" role="alert">
                <p>It may not exist, or the service could not be reached. Nothing was changed.</p>
                <Button
                  variant="secondary"
                  label="Try again"
                  onClick={() => void loaded.reload()}
                />{" "}
                <a href="/reconcile">Back to Reconcile</a>
              </Notice>
            </>
          }
        >
          <Show when={current()} keyed>
            {(view) =>
              view.status === "draft" ? (
                <DraftScreen
                  initial={view}
                  onCompleted={(done) => setReplaced({ view: done, completed: true })}
                />
              ) : (
                <RecordScreen
                  record={view}
                  completed={replaced()?.completed === true}
                  onChanged={(next) => setReplaced({ view: next, completed: false })}
                />
              )
            }
          </Show>
        </Show>
      </Show>
    </section>
  );
}

function DraftScreen(props: {
  initial: Reconciliation;
  onCompleted: (done: Reconciliation) => void;
}) {
  const draft = createDraft(props.initial.id, props.initial);
  const view = () => draft.draft() ?? props.initial;
  const [finishOpen, setFinishOpen] = createSignal(false);
  const [discardOpen, setDiscardOpen] = createSignal(false);
  const [editOpen, setEditOpen] = createSignal(false);
  const [busy, setBusy] = createSignal(false);
  const [dialogError, setDialogError] = createSignal<string | undefined>();
  let heading: HTMLHeadingElement | undefined;
  onMount(() => heading?.focus());

  const lines = createMemo(() => view().lines.map((line) => toLine(line, view().snapshotRevision)));
  const figures = () => {
    const mine = draft.figures();
    return {
      statementBalance: view().statementBalance,
      openingBalance: view().openingBalance,
      selectedCount: mine?.selectedCount ?? 0,
      selectedTotal: mine?.selectedTotal ?? "0.00",
      clearedBalance: mine?.clearedBalance ?? view().openingBalance,
      difference: mine?.difference ?? view().difference,
    };
  };
  const ready = () => figures().difference === "0.00";
  const saved = () => draft.saveState() === "saved";
  const hint = () =>
    view().stale
      ? words.finishNeedsFresh
      : !ready()
        ? words.finishNeedsZero
        : !saved()
          ? words.finishNeedsSave
          : words.finishReady;

  async function run(work: () => Promise<void>) {
    setBusy(true);
    setDialogError(undefined);
    try {
      await work();
    } catch (cause) {
      setDialogError(message(cause, "It could not be done."));
    } finally {
      setBusy(false);
    }
  }

  return (
    <>
      <PageHeader
        titleId="reconcile-title"
        titleRef={(element) => {
          heading = element;
        }}
        title={accountName(view().account)}
        status="Draft"
        description={
          <>
            Statement ending{" "}
            <strong>
              <DateValue value={view().statementDate} />
            </strong>{" "}
            with a balance of{" "}
            <strong class="rt-recon-amount">{formatMoney(view().statementBalance)}</strong>. Tick
            the transactions that are on the statement until the difference is 0.00.
          </>
        }
      />
      <Show when={draft.notice()}>
        <Notice title="Check this" tone="review" role="alert">
          <p>{draft.notice()}</p>
          <Button variant="secondary" label="Dismiss" onClick={draft.dismissNotice} />
        </Notice>
      </Show>
      <Show
        when={draft.loadState() !== "error"}
        fallback={
          <Notice title="The reconciliation could not be reloaded" tone="error" role="alert">
            <Button label="Try again" onClick={() => void draft.load()} />
          </Notice>
        }
      >
        <ReconcileWorkspace
          account={{
            code: view().account.code,
            name: view().account.name,
            kind: view().account.role === "liability" ? "liability" : "asset",
          }}
          figures={figures()}
          lines={lines()}
          selected={draft.selected()}
          columnTotals={draft.totals()}
          saveState={draft.saveState()}
          stale={view().stale}
          warnings={view().warnings.map((warning) => warning.message)}
          finish={{
            disabled: !ready() || !saved() || view().stale,
            hint: hint(),
            onFinish: () => {
              setDialogError(undefined);
              setFinishOpen(true);
            },
          }}
          onToggle={draft.toggle}
          onSelectAll={() => draft.setAll(true)}
          onClearAll={() => draft.setAll(false)}
          onEditStatement={() => {
            setDialogError(undefined);
            setEditOpen(true);
          }}
          onRefresh={() =>
            void run(() => draft.restate(view().statementDate, view().statementBalance))
          }
          onResume={() => void draft.resume()}
          onDiscard={() => {
            setDialogError(undefined);
            setDiscardOpen(true);
          }}
        />
      </Show>
      <ReconcileFinishDialog
        open={finishOpen()}
        onOpenChange={setFinishOpen}
        account={accountName(view().account)}
        statementDate={view().statementDate}
        lineCount={figures().selectedCount}
        statementBalance={view().statementBalance}
        pending={busy()}
        error={dialogError()}
        onConfirm={() =>
          void run(async () => {
            const done = await draft.finish();
            setFinishOpen(false);
            props.onCompleted(done);
          })
        }
      />
      <ReconcileDiscardDialog
        open={discardOpen()}
        onOpenChange={setDiscardOpen}
        pending={busy()}
        error={dialogError()}
        onConfirm={() =>
          void run(async () => {
            await draft.discard();
            window.location.assign("/reconcile");
          })
        }
      />
      <EditStatement
        open={editOpen()}
        onOpenChange={setEditOpen}
        date={view().statementDate}
        balance={view().statementBalance}
        pending={busy()}
        error={dialogError()}
        onSave={(date, balance) =>
          void run(async () => {
            await draft.restate(date, balance);
            setEditOpen(false);
          })
        }
      />
    </>
  );
}

function EditStatement(props: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  date: string;
  balance: string;
  pending: boolean;
  error: string | undefined;
  onSave: (date: string, balance: string) => void;
}) {
  const [date, setDate] = createSignal(props.date);
  const [balance, setBalance] = createSignal(props.balance);
  const [problem, setProblem] = createSignal("");
  return (
    <Dialog
      open={props.open}
      onOpenChange={(open) => {
        if (open) {
          setDate(props.date);
          setBalance(props.balance);
          setProblem("");
        }
        props.onOpenChange(open);
      }}
      title="Edit the statement"
      description="Correct the date or the ending balance. The transactions you ticked stay ticked when they still belong."
      footer={
        <>
          <DialogClose class="rt-button" data-variant="secondary" data-size="md">
            {words.cancel}
          </DialogClose>
          <Button
            label="Save statement"
            pending={props.pending}
            onClick={() => {
              if (!date().trim() || canonicalStatementBalance(balance().trim()) === null) {
                setProblem(words.statementBalanceHint);
                return;
              }
              props.onSave(date().trim(), balance().trim());
            }}
          />
        </>
      }
    >
      <DateField
        label={words.statementDate}
        required
        value={date()}
        onChange={(value) => setDate(value)}
      />
      <TextField
        label={words.statementBalanceField}
        required
        inputmode="decimal"
        autocomplete="off"
        hint={words.statementBalanceHint}
        value={balance()}
        onInput={(event) => setBalance(event.currentTarget.value)}
        {...(problem() ? { error: problem() } : {})}
      />
      <Show when={props.error}>
        <Notice title={words.dialogError} tone="error" role="alert">
          {props.error}
        </Notice>
      </Show>
    </Dialog>
  );
}

function RecordScreen(props: {
  record: Reconciliation;
  completed: boolean;
  onChanged: (next: Reconciliation) => void;
}) {
  const client = new BrowserApplicationClient(window.localStorage);
  const latest = createKeyedLoader(
    () => props.record.account.id,
    (accountId) => client.read("reconcile.status", { accountId }),
  );
  // What the statement did not show yet, worked out by the service from the record and the books as they were
  // when it was finished. The record above it does not wait for this.
  const report = createKeyedLoader(
    () => props.record.id,
    (id) => client.read("reconcile.report", { id }),
  );
  const outstanding = createMemo(() => {
    const read = report.value();
    return read === undefined ? undefined : outstandingView(read);
  });
  const outstandingState = () =>
    report.value() !== undefined
      ? "ready"
      : report.error() !== undefined && !report.loading()
        ? "error"
        : "loading";
  const [fileState, setFileState] = createSignal<ReportFileState>("idle");
  const [fileName, setFileName] = createSignal<string | undefined>();
  const [fileError, setFileError] = createSignal<string | undefined>();
  const [voidOpen, setVoidOpen] = createSignal(false);
  const [busy, setBusy] = createSignal(false);
  const [error, setError] = createSignal<string | undefined>();
  let heading: HTMLHeadingElement | undefined;
  onMount(() => heading?.focus());

  const record = () => props.record;
  const lines = createMemo(() =>
    record().lines.map((line) => toLine(line, record().snapshotRevision)),
  );
  const out = createMemo(() => lines().filter((line) => isNegativeMoney(line.amount)));
  const into = createMemo(() => lines().filter((line) => !isNegativeMoney(line.amount)));
  const kind = () => (record().account.role === "liability" ? "liability" : "asset");
  const canVoid = () =>
    record().status === "completed" &&
    latest.value()?.accounts[0]?.lastReconciliationId === record().id;

  /** Ask the service for the report as a spreadsheet and hand it to the browser to save. A press while the file
   * is being made does nothing; "saved" is said only after the browser has the file. */
  async function downloadReport() {
    if (fileState() === "preparing") return;
    setFileState("preparing");
    setFileError(undefined);
    try {
      const made = await client.read("reconcile.report", { id: record().id, file: "csv" });
      if (!made.file) throw new Error("The service sent no file.");
      const name = reportFileName(made.file.filename);
      saveFile(reportBlob(made.file), name);
      setFileName(name);
      setFileState("saved");
    } catch (cause) {
      setFileError(message(cause, "The service could not be reached."));
      setFileState("failed");
    }
  }

  async function voidIt(reason: string) {
    setBusy(true);
    setError(undefined);
    try {
      const next = await client.write(
        "reconcile.void",
        { id: record().id, reason },
        `reconcile:void:${record().id}`,
      );
      setVoidOpen(false);
      props.onChanged(next);
    } catch (cause) {
      setError(
        cause instanceof ApplicationRequestError && cause.uncertain
          ? `${cause.message} Reload this page to resume the original request.`
          : message(cause, "It could not be voided."),
      );
    } finally {
      setBusy(false);
    }
  }

  return (
    <>
      <PageHeader
        titleId="reconcile-title"
        titleRef={(element) => {
          heading = element;
        }}
        title={accountName(record().account)}
        description={
          <>
            Statement ending{" "}
            <strong>
              <DateValue value={record().statementDate} />
            </strong>{" "}
            <Status tone="neutral">
              {record().status === "voided" ? words.voided : words.completed}
            </Status>
          </>
        }
        actions={
          <ReconcileReportButton state={fileState()} onDownload={() => void downloadReport()} />
        }
      />
      <ReconcileReportStatus state={fileState()} fileName={fileName()} error={fileError()} />
      <Show when={props.completed}>
        <p role="status" class="rt-recon-done-note">
          Reconciliation completed. These transactions are now on a statement.
        </p>
      </Show>
      <Show when={record().void}>
        {(voided) => (
          <Notice title="This reconciliation was voided">
            <p>
              <bdi>{voided().reason}</bdi>
            </p>
            <p class="rt-hint">
              Voided {formatDate(voided().voidedAt)}. The record is kept as it was.
            </p>
          </Notice>
        )}
      </Show>
      <ReconcileSummary
        finished
        figures={{
          statementBalance: record().statementBalance,
          openingBalance: record().openingBalance,
          selectedCount: record().selectedCount,
          selectedTotal: record().selectedTotal,
          clearedBalance: record().clearedBalance,
          difference: record().difference,
        }}
      />
      <div class="rt-recon-columns">
        <ReconcileRecordLines
          title={words.moneyOut[kind()]}
          noun={words.noun.out[kind()]}
          lines={out()}
          total={totalOf(record().lines.filter((line) => isNegativeMoney(line.amount)))}
        />
        <ReconcileRecordLines
          title={words.moneyIn[kind()]}
          noun={words.noun.in[kind()]}
          lines={into()}
          total={totalOf(record().lines.filter((line) => !isNegativeMoney(line.amount)))}
        />
      </div>
      <ReconcileOutstanding
        view={outstanding()}
        state={outstandingState()}
        error={report.error() === undefined ? undefined : message(report.error(), "")}
        onRetry={() => void report.reload()}
      />
      <Show when={record().previous}>
        {(previous) => (
          <p class="rt-hint">
            Continues from{" "}
            <a href={`/reconcile/${previous().id}`}>
              the statement ending {formatDate(previous().statementDate)}
            </a>
            .
          </p>
        )}
      </Show>
      <Details summary="Details">
        <DetailsList
          items={[
            {
              label: "Completed",
              value: record().completedAt
                ? formatInstant(record().completedAt ?? "")
                : "not completed",
            },
            { label: "Book revision", value: record().snapshotRevision },
            ...(record().recordHash
              ? [
                  {
                    label: "Record fingerprint",
                    value: record().recordHash as string,
                    mono: true,
                    copy: true,
                  },
                ]
              : []),
          ]}
        />
      </Details>
      <div class="rt-recon-actions">
        <a href="/reconcile">Back to Reconcile</a>
        <Show when={record().status === "completed"}>
          <Show
            when={canVoid()}
            fallback={
              <p class="rt-hint">
                <Show when={!latest.loading} fallback="Checking whether this can be voided…">
                  Only the newest reconciliation of an account can be voided. Void the later ones
                  first.
                </Show>
              </p>
            }
          >
            <Button
              variant="danger"
              label={words.void}
              onClick={() => {
                setError(undefined);
                setVoidOpen(true);
              }}
            />
          </Show>
        </Show>
      </div>
      <ReconcileVoidDialog
        open={voidOpen()}
        onOpenChange={setVoidOpen}
        account={accountName(record().account)}
        statementDate={record().statementDate}
        pending={busy()}
        error={error()}
        onConfirm={(reason) => void voidIt(reason)}
      />
    </>
  );
}
