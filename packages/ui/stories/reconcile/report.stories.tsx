import { createSignal, type JSX } from "solid-js";
import type { Meta, StoryObj } from "storybook-solidjs-vite";
import {
  formatDate,
  Notice,
  PageHeader,
  ReconcileOutstanding,
  type ReconcileOutstandingView,
  ReconcileRecordLines,
  ReconcileReportButton,
  ReconcileReportStatus,
  ReconcileSummary,
  type ReportFileState,
  Status,
  UiProvider,
} from "../../src";
import { cents, january, longMemos, manyLines, money } from "./fixtures";

const Frame = (props: { children: JSX.Element; dir?: "rtl" }) => (
  <UiProvider>
    <div class="rt-theme rt-recon-story" dir={props.dir}>
      {props.children}
    </div>
  </UiProvider>
);

type Row = { id: string; date: string; description: string; amount: string };

/** What a finished reconciliation's page says about the statement: the books are the statement plus what is
 * not on it yet. The service works these figures out; the stories do the sum in cents so that they agree. */
function outstandingOf(
  date: string,
  statementBalance: string,
  lines: readonly Row[],
): ReconcileOutstandingView {
  const total = lines.reduce((sum, line) => sum + cents(line.amount), 0n);
  return {
    statementDate: date,
    statementBalance,
    bookBalance: money(cents(statementBalance) + total),
    total: money(total),
    lines: lines.map((line) => ({ ...line, href: `/journal/${line.id}?revision=19` })),
  };
}

/** January on the checking account: three transactions are on the statement, which ends at 1,209.90, and the
 * software subscription of the 20th was not yet. */
const SOFTWARE: readonly Row[] = [
  { id: "o1", date: "2026-01-20", description: "Software subscription", amount: "-19.90" },
];
const cleared = january.slice(0, 3);
const outMoney = cleared.filter((line) => cents(line.amount) < 0n);
const inMoney = cleared.filter((line) => cents(line.amount) >= 0n);
const totalOf = (lines: readonly { amount: string }[]) =>
  money(lines.reduce((sum, line) => sum + cents(line.amount), 0n));
const FILE = "reconciliation-1000-2026-01-31.csv";

/** The finished record's page as the application puts it together from these parts. The report's state is the
 * story's own; in the interactive story, pressing the button walks through making the file. */
function RecordPage(props: {
  voided?: boolean;
  outstanding?: ReconcileOutstandingView | undefined;
  state?: "ready" | "loading" | "error";
  error?: string;
  file?: ReportFileState;
  fileError?: string;
  interactive?: boolean;
  card?: boolean;
}) {
  const [file, setFile] = createSignal<ReportFileState>(props.file ?? "idle");
  const press = () => {
    if (!props.interactive) return;
    setFile("preparing");
    setTimeout(() => setFile("saved"), 700);
  };
  const side = props.card ? "liability" : "asset";
  return (
    <section class="rt-recon-page">
      <PageHeader
        title={props.card ? "Card" : "Checking"}
        back={{ label: "Reconcile", href: "/reconcile" }}
        description={
          <>
            Statement ending <strong>{formatDate("2026-01-31")}</strong>{" "}
            <Status tone="neutral">{props.voided ? "Voided" : "Completed"}</Status>
          </>
        }
        actions={<ReconcileReportButton state={file()} onDownload={press} />}
      />
      <ReconcileReportStatus state={file()} fileName={FILE} error={props.fileError} />
      {props.voided ? (
        <Notice title="This reconciliation was voided">
          <p>
            <bdi>Wrong statement balance</bdi>
          </p>
          <p class="rt-hint">Voided Feb 3, 2026. The record is kept as it was.</p>
        </Notice>
      ) : null}
      <ReconcileSummary
        finished
        figures={{
          statementBalance: "1209.90",
          openingBalance: "0.00",
          selectedCount: 3,
          selectedTotal: "1209.90",
          clearedBalance: "1209.90",
          difference: "0.00",
        }}
      />
      <div class="rt-recon-columns">
        <ReconcileRecordLines
          title={side === "asset" ? "Money out" : "Payments and credits"}
          noun={side === "asset" ? "money out" : "payments and credits"}
          lines={outMoney}
          total={totalOf(outMoney).replace("-", "")}
        />
        <ReconcileRecordLines
          title={side === "asset" ? "Money in" : "Charges"}
          noun={side === "asset" ? "money in" : "charges"}
          lines={inMoney}
          total={totalOf(inMoney)}
        />
      </div>
      <ReconcileOutstanding
        view={props.outstanding}
        state={props.state ?? "ready"}
        error={props.error}
        onRetry={() => {}}
      />
    </section>
  );
}

const meta = {
  title: "Lanes/Reconcile/Report",
  parameters: { layout: "padded", a11y: { test: "error" } },
} satisfies Meta;
export default meta;
type Story = StoryObj<typeof meta>;

/** A finished reconciliation: what the statement showed, what it did not yet, and the sum that gets to the books. */
export const FinishedWithOneNotYetOnTheStatement: Story = {
  render: () => (
    <Frame>
      <RecordPage outstanding={outstandingOf("2026-01-31", "1209.90", SOFTWARE)} />
    </Frame>
  ),
};

/** Nothing was outstanding: the books and the statement are the same figure, and the page says so. */
export const NothingOutstanding: Story = {
  render: () => (
    <Frame>
      <RecordPage outstanding={outstandingOf("2026-01-31", "1190.00", [])} />
    </Frame>
  ),
};

/** The list is being worked out. The rest of the record is already there to read. */
export const WorkingItOut: Story = {
  render: () => (
    <Frame>
      <RecordPage state="loading" />
    </Frame>
  ),
};

/** The list could not be worked out. The service's own words say why; the record above is still true. */
export const CouldNotBeWorkedOut: Story = {
  render: () => (
    <Frame>
      <RecordPage
        state="error"
        error="Posting p4 on reconciliation r1 is not in the books as they stood at revision 19."
      />
    </Frame>
  ),
};

/** A voided reconciliation: still reported on, with its lines as they were. */
export const Voided: Story = {
  render: () => (
    <Frame>
      <RecordPage voided outstanding={outstandingOf("2026-01-31", "1209.90", SOFTWARE)} />
    </Frame>
  ),
};

/** Pressing the button makes the file; the page says so while it does and when it is done. */
export const DownloadingTheReport: Story = {
  render: () => (
    <Frame>
      <RecordPage interactive outstanding={outstandingOf("2026-01-31", "1209.90", SOFTWARE)} />
    </Frame>
  ),
};

export const PreparingTheFile: Story = {
  render: () => (
    <Frame>
      <RecordPage file="preparing" outstanding={outstandingOf("2026-01-31", "1209.90", SOFTWARE)} />
    </Frame>
  ),
};

export const FileSaved: Story = {
  render: () => (
    <Frame>
      <RecordPage file="saved" outstanding={outstandingOf("2026-01-31", "1209.90", SOFTWARE)} />
    </Frame>
  ),
};

/** The file could not be made: the reason, that nothing in the books changed, and the button to try again. */
export const FileCouldNotBeMade: Story = {
  render: () => (
    <Frame>
      <RecordPage
        file="failed"
        fileError="The service could not be reached."
        outstanding={outstandingOf("2026-01-31", "1209.90", SOFTWARE)}
      />
    </Frame>
  ),
};

/** Text from a bank: a very long memo, a formula, markup and a direction override stay text, in their own
 * direction, and the amounts keep their places. */
export const LongAndAwkwardText: Story = {
  render: () => (
    <Frame>
      <RecordPage
        outstanding={outstandingOf("2026-03-31", "9000.00", [
          // The memos of the long-memo fixture, with the amounts of a month's lines.
          ...longMemos.map((line, at) => ({
            ...line,
            amount: ["2450.37", "-12.00", "-1234.56", "-87.10", "-0.01"][at] ?? line.amount,
          })),
          {
            id: "o9",
            date: "2026-03-06",
            description: "INVOICE 8841 ‮gnp.exe‬ ⁦PAID⁩ now",
            amount: "-8.88",
          },
        ])}
      />
    </Frame>
  ),
};

/** A great many transactions left off one statement: the list scrolls inside its own box. */
export const ManyTransactions: Story = {
  render: () => (
    <Frame>
      <RecordPage outstanding={outstandingOf("2026-12-31", "12000.00", manyLines(400))} />
    </Frame>
  ),
};

/** A card: what is not on the statement is a charge not yet billed, and it raises the balance owed. */
export const ACard: Story = {
  render: () => (
    <Frame>
      <RecordPage
        card
        outstanding={outstandingOf("2026-01-31", "1300.00", [
          { id: "c9", date: "2026-01-30", description: "Hosting, Fly.io", amount: "20.00" },
        ])}
      />
    </Frame>
  ),
};

export const RightToLeft: Story = {
  render: () => (
    <Frame dir="rtl">
      <RecordPage outstanding={outstandingOf("2026-01-31", "1209.90", SOFTWARE)} />
    </Frame>
  ),
};
