import {
  type AccountStatusRow,
  Button,
  listAccountLabel,
  PageHeader,
  ReconcileHistory,
  ReconcileStatusTable,
  reconcileWords as words,
  type ReconciliationRow,
} from "@rastrata/ui";
import { createMemo, createSignal, onMount } from "solid-js";
import { BrowserApplicationClient } from "../../application-client";
import { createKeyedLoader, createLoader } from "../../loader";
import { hasRetainedStart, StartReconciliation } from "./start";

/** Reconcile: the accounts first, with when each was last checked and what is not yet on a statement, and a
 * Reconcile button on each that opens a small form. Earlier reconciliations are below. The address
 * `?account=<id>` (from a bank tile) opens the form for that account at once. */
export function ReconcilePage() {
  const client = new BrowserApplicationClient(window.localStorage);
  // Every read is held in plain signals (see loader.ts): the page is never suspended, and the table keeps its
  // place while the numbers are read again.
  const status = createLoader(() => client.read("reconcile.status", { all: true }));
  const [page, setPage] = createSignal(1);
  const history = createKeyedLoader(page, (current) =>
    client.read("reconcile.list", { page: current }),
  );
  const wanted = new URLSearchParams(window.location.search).get("account") ?? "";
  // The form is open at once when the address names an account, or when a start is waiting to be resumed.
  const [form, setForm] = createSignal<{ open: boolean; account: string }>({
    open: wanted !== "" || hasRetainedStart(),
    account: wanted,
  });
  let heading: HTMLHeadingElement | undefined;
  onMount(() => {
    if (!form().open) heading?.focus();
  });

  const statusRows = createMemo((): AccountStatusRow[] =>
    (status.value()?.accounts ?? [])
      .filter((row) => row.tracked)
      .map((row) => ({
        id: row.account.id,
        account: listAccountLabel(row.account.name, row.account.code),
        tracked: row.tracked,
        lastReconciledDate: row.lastReconciledDate,
        lastReconciledBalance: row.lastReconciledBalance,
        unclearedCount: row.unclearedCount,
        unclearedTotal: row.unclearedTotal,
        oldestUnclearedDate: row.oldestUnclearedDate,
        draftHref: row.openReconciliationId ? `/reconcile/${row.openReconciliationId}` : null,
      })),
  );
  const historyRows = createMemo((): ReconciliationRow[] =>
    (history.value()?.items ?? []).map((item) => ({
      id: item.id,
      href: `/reconcile/${item.id}`,
      account: listAccountLabel(item.account.name, item.account.code),
      statementDate: item.statementDate,
      statementBalance: item.statementBalance,
      lineCount: item.lineCount,
      status: item.status,
      on: item.completedAt ?? item.createdAt,
    })),
  );

  return (
    <section class="rt-recon-page" aria-labelledby="reconcile-title">
      <PageHeader
        titleId="reconcile-title"
        titleRef={(element) => {
          heading = element;
        }}
        title="Reconcile"
        description={words.pageLine}
        actions={
          <Button
            variant="secondary"
            label={words.startAction}
            onClick={() => setForm({ open: true, account: "" })}
          />
        }
      />
      <ReconcileStatusTable
        rows={statusRows()}
        state={
          status.error() !== undefined
            ? "error"
            : status.value() === undefined
              ? "loading"
              : "ready"
        }
        busy={status.loading() && status.value() !== undefined}
        onRetry={() => void status.reload()}
        onStart={(account) => setForm({ open: true, account })}
      />
      <ReconcileHistory
        rows={historyRows()}
        count={history.value()?.count ?? 0}
        page={page()}
        pageSize={history.value()?.pageSize ?? 25}
        state={
          history.error() !== undefined
            ? "error"
            : history.value() === undefined
              ? "loading"
              : "ready"
        }
        busy={history.loading() && history.value() !== undefined}
        onPageChange={setPage}
        onRetry={() => void history.reload()}
      />
      <StartReconciliation
        open={form().open}
        account={form().account || undefined}
        onClose={() => setForm({ open: false, account: "" })}
      />
    </section>
  );
}
