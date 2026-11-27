import { createSignal } from "solid-js";
import type { Meta, StoryObj } from "storybook-solidjs-vite";
import {
  accountOptions,
  type AccountStatusRow,
  ReconcileDiscardDialog,
  ReconcileFinishDialog,
  ReconcileHistory,
  ReconcileLines,
  ReconcileRecordLines,
  ReconcileStartDialog,
  ReconcileStatusTable,
  ReconcileSummary,
  ReconcileVoidDialog,
  type ReconciliationRow,
  UiProvider,
} from "../../src";
import { columnTotals, figuresFor, january, januaryBalance } from "./fixtures";

const Frame = (props: { children: import("solid-js").JSX.Element }) => (
  <UiProvider>
    <div class="rt-theme rt-recon-story">{props.children}</div>
  </UiProvider>
);

const accounts = accountOptions([
  { id: "1000", code: "1000", name: "Checking", role: "asset" },
  { id: "1100", code: "1100", name: "Savings", role: "asset" },
  { id: "2000", code: "2000", name: "Card", role: "liability" },
]);

const statusRows: AccountStatusRow[] = [
  {
    id: "1000",
    account: "Checking",
    tracked: true,
    lastReconciledDate: "2026-01-31",
    lastReconciledBalance: "1190.00",
    unclearedCount: 3,
    unclearedTotal: "1200.00",
    oldestUnclearedDate: "2026-02-03",
    draftHref: null,
  },
  {
    id: "2000",
    account: "Card",
    tracked: true,
    lastReconciledDate: null,
    lastReconciledBalance: null,
    unclearedCount: 12,
    unclearedTotal: "2310.45",
    oldestUnclearedDate: "2026-01-10",
    draftHref: "/reconcile/d-1",
  },
  {
    id: "1100",
    account: "Savings",
    tracked: true,
    lastReconciledDate: "2026-02-28",
    lastReconciledBalance: "5000.00",
    unclearedCount: 0,
    unclearedTotal: "0.00",
    oldestUnclearedDate: null,
    draftHref: null,
  },
];

const historyRows: ReconciliationRow[] = [
  {
    id: "d-1",
    href: "/reconcile/d-1",
    account: "Card",
    statementDate: "2026-02-28",
    statementBalance: "980.00",
    lineCount: 0,
    status: "draft",
    on: "2026-03-02",
  },
  {
    id: "r-2",
    href: "/reconcile/r-2",
    account: "Savings",
    statementDate: "2026-02-28",
    statementBalance: "5000.00",
    lineCount: 4,
    status: "completed",
    on: "2026-03-01",
  },
  {
    id: "r-1",
    href: "/reconcile/r-1",
    account: "Checking",
    statementDate: "2026-01-31",
    statementBalance: "1190.00",
    lineCount: 4,
    status: "voided",
    on: "2026-02-03",
  },
];

const meta = {
  title: "Lanes/Reconcile/Parts",
  parameters: { layout: "padded", a11y: { test: "error" } },
} satisfies Meta;
export default meta;
type Story = StoryObj<typeof meta>;

/** The small form over the page, opened from an account's row: the account is chosen, so the cursor starts on
 * the date. */
export const StartDialogForAnAccount: Story = {
  render: () => (
    <Frame>
      <p>The form is open over this page.</p>
      <ReconcileStartDialog
        open
        onOpenChange={() => {}}
        accounts={accounts}
        account="1000"
        onSubmit={() => {}}
      />
    </Frame>
  ),
};

/** Opened from "Reconcile an account" or "+ New": no account yet, so the cursor starts on the account. */
export const StartDialogChoosingAnAccount: Story = {
  render: () => (
    <Frame>
      <p>The form is open over this page.</p>
      <ReconcileStartDialog open onOpenChange={() => {}} accounts={accounts} onSubmit={() => {}} />
    </Frame>
  ),
};

/** Errors are listed in a summary that takes focus and links to each field, and each field says
 * what is wrong beside it. Valid answers stay in the form. */
export const StartDialogWithErrors: Story = {
  render: () => (
    <Frame>
      <p>The form is open over this page.</p>
      <ReconcileStartDialog
        open
        onOpenChange={() => {}}
        accounts={accounts}
        account="1000"
        errors={{
          date: "Enter the date the statement ends.",
          balance:
            "Enter the statement balance exactly as printed, with two decimal places (for example 1234.50 or -12.00).",
        }}
        onSubmit={() => {}}
      />
    </Frame>
  ),
};

export const StartDialogPending: Story = {
  render: () => (
    <Frame>
      <p>The form is open over this page.</p>
      <ReconcileStartDialog
        open
        onOpenChange={() => {}}
        accounts={accounts}
        account="1000"
        pending
        onSubmit={() => {}}
      />
    </Frame>
  ),
};

/** An imported statement file reported its own ending balance for this account. It fills the
 * empty date and balance and says where it came from; typed values are never overwritten. */
export const StartDialogWithImportedBalance: Story = {
  render: () => (
    <Frame>
      <p>The form is open over this page.</p>
      <ReconcileStartDialog
        open
        onOpenChange={() => {}}
        accounts={accounts}
        account="1000"
        hint={{ date: "2026-01-31", balance: "1190.00" }}
        onSubmit={() => {}}
      />
    </Frame>
  ),
};

/** A start whose reply was lost: it is resumed, never replaced, so starting another waits. */
export const StartDialogWithALostReply: Story = {
  render: () => (
    <Frame>
      <p>The form is open over this page.</p>
      <ReconcileStartDialog
        open
        onOpenChange={() => {}}
        accounts={accounts}
        account="1000"
        retained
        onResume={() => {}}
        onSubmit={() => {}}
      />
    </Frame>
  ),
};

export const StatusTable: Story = {
  render: () => (
    <Frame>
      <ReconcileStatusTable rows={statusRows} onStart={() => {}} />
    </Frame>
  ),
};
export const StatusTableEmpty: Story = {
  render: () => (
    <Frame>
      <ReconcileStatusTable rows={[]} onStart={() => {}} />
    </Frame>
  ),
};
export const StatusTableLoading: Story = {
  render: () => (
    <Frame>
      <ReconcileStatusTable rows={[]} state="loading" onStart={() => {}} />
    </Frame>
  ),
};
export const StatusTableFailed: Story = {
  render: () => (
    <Frame>
      <ReconcileStatusTable rows={[]} state="error" onStart={() => {}} onRetry={() => {}} />
    </Frame>
  ),
};

export const History: Story = {
  render: () => {
    const [page, setPage] = createSignal(1);
    return (
      <Frame>
        <ReconcileHistory
          rows={historyRows}
          count={60}
          page={page()}
          pageSize={25}
          onPageChange={setPage}
        />
      </Frame>
    );
  },
};
export const HistoryEmpty: Story = {
  render: () => (
    <Frame>
      <ReconcileHistory rows={[]} count={0} page={1} pageSize={25} onPageChange={() => {}} />
    </Frame>
  ),
};
export const HistoryFailed: Story = {
  render: () => (
    <Frame>
      <ReconcileHistory
        rows={[]}
        count={0}
        page={1}
        pageSize={25}
        state="error"
        onPageChange={() => {}}
        onRetry={() => {}}
      />
    </Frame>
  ),
};

export const SummaryNotBalanced: Story = {
  render: () => (
    <Frame>
      <ReconcileSummary
        figures={figuresFor(january, new Set(["p1", "p2", "p3"]), januaryBalance)}
      />
    </Frame>
  ),
};
export const SummaryBalanced: Story = {
  render: () => (
    <Frame>
      <ReconcileSummary
        figures={figuresFor(january, new Set(january.map((line) => line.id)), januaryBalance)}
      />
    </Frame>
  ),
};
export const SummaryOverSelected: Story = {
  render: () => (
    <Frame>
      <ReconcileSummary
        figures={figuresFor(january, new Set(january.map((line) => line.id)), "1000.00")}
      />
    </Frame>
  ),
};

/** One column on its own: the money out of the January statement. */
export const MoneyOutColumn: Story = {
  render: () => {
    const [selected, setSelected] = createSignal<ReadonlySet<string>>(new Set(["p3"]));
    const lines = january.filter((line) => line.amount.startsWith("-"));
    const totals = () => columnTotals(january, selected()).out;
    return (
      <Frame>
        <ReconcileLines
          title="Money out"
          noun="money out"
          lines={lines}
          totalCount={lines.length}
          selected={selected()}
          selectedCount={totals().count}
          selectedTotal={totals().total}
          onToggle={(ids, on) =>
            setSelected((current) => {
              const next = new Set(current);
              for (const id of ids) on ? next.add(id) : next.delete(id);
              return next;
            })
          }
        />
      </Frame>
    );
  },
};

/** A completed record's lines: read-only, nothing to tick. */
export const RecordLines: Story = {
  render: () => (
    <Frame>
      <div class="rt-recon-columns">
        <ReconcileRecordLines
          title="Money out"
          noun="money out"
          lines={january.filter((line) => line.amount.startsWith("-"))}
          total="60.00"
        />
        <ReconcileRecordLines title="Money in" noun="money in" lines={[]} total="0.00" />
      </div>
    </Frame>
  ),
};

/** The confirmation before a reconciliation is frozen. Cancel, the safe choice, has focus. */
export const FinishDialog: Story = {
  render: () => (
    <Frame>
      <p>The dialog is open over this page.</p>
      <ReconcileFinishDialog
        open
        onOpenChange={() => {}}
        account="Checking"
        statementDate="2026-01-31"
        lineCount={4}
        statementBalance="1190.00"
        onConfirm={() => {}}
      />
    </Frame>
  ),
};
export const FinishDialogFailed: Story = {
  render: () => (
    <Frame>
      <p>The dialog is open over this page.</p>
      <ReconcileFinishDialog
        open
        onOpenChange={() => {}}
        account="Checking"
        statementDate="2026-01-31"
        lineCount={4}
        statementBalance="1190.00"
        error="One of these lines was reconciled by another reconciliation while this one was being completed. Refresh the lines."
        onConfirm={() => {}}
      />
    </Frame>
  ),
};
export const VoidDialog: Story = {
  render: () => (
    <Frame>
      <p>The dialog is open over this page.</p>
      <ReconcileVoidDialog
        open
        onOpenChange={() => {}}
        account="Checking"
        statementDate="2026-01-31"
        onConfirm={() => {}}
      />
    </Frame>
  ),
};
export const DiscardDialog: Story = {
  render: () => (
    <Frame>
      <p>The dialog is open over this page.</p>
      <ReconcileDiscardDialog open onOpenChange={() => {}} onConfirm={() => {}} />
    </Frame>
  ),
};
