import { createSignal } from "solid-js";
import type { Meta, StoryObj } from "storybook-solidjs-vite";
import {
  HistoryCompare,
  HistoryDone,
  HistoryReview,
  type HistoryPreviewView,
  type TieOutView,
} from "../../src";
import { Frame } from "../statements/frame";

const options = [
  { value: "1000", label: "Cash (1000)" },
  { value: "3000", label: "Capital (3000)" },
  { value: "4000", label: "Sales (4000)" },
  { value: "5000", label: "Expense (5000)" },
];

const row = (
  label: string,
  lines: number,
  account: string | null,
  accountName: string | null,
  extra: Partial<HistoryPreviewView["accounts"][number]> = {},
): HistoryPreviewView["accounts"][number] => ({
  label,
  lines,
  account,
  accountName,
  add: null,
  suggestedRole: null,
  ...extra,
});

const ready: HistoryPreviewView = {
  entries: 2410,
  lines: 5120,
  firstDate: "2016-01-04",
  lastDate: "2025-12-30",
  dateOrderAssumed: false,
  years: Array.from({ length: 10 }, (_, index) => ({
    fiscalYear: 2016 + index,
    entries: 230 + index * 6,
    total: `${(184_200.5 + index * 21_350.25).toFixed(2)}`,
  })),
  accounts: [
    row("1000 Cash", 2210, "1000", "Cash"),
    row("4000 Sales", 880, "4000", "Sales"),
    row("5000 Expense", 1130, "5000", "Expense"),
    row("6500 Consulting Costs", 96, "6500", "Consulting Costs", {
      add: "expense",
      suggestedRole: "expense",
    }),
    row("Owner Investment", 4, "3010", "Owner Investment", {
      add: "equity",
      suggestedRole: "equity",
    }),
  ],
  unmapped: 0,
  problems: [],
  problemCount: 0,
  conflicts: [],
  alreadyImported: 0,
  remaining: 2410,
  ready: true,
};

function Review(props: {
  preview: HistoryPreviewView;
  stage?: "review" | "importing" | "stopped";
}) {
  const [choices, setChoices] = createSignal<Record<string, string>>({});
  return (
    <Frame width="56rem">
      <HistoryReview
        preview={props.preview}
        options={options}
        choices={choices()}
        onChoose={(label, value) => setChoices({ ...choices(), [label]: value })}
        stage={props.stage ?? "review"}
        progress={props.stage === "importing" ? { done: 600, total: 2410 } : null}
        stopped={
          props.stage === "stopped"
            ? "Stopped at entry J-1204, dated Mar 3, 2019: A period from Mar 1, 2019 to Mar 31, 2019 is closed. Everything before it is posted. Fix the cause, then import again: nothing is posted twice."
            : undefined
        }
        onImport={() => {}}
      />
    </Frame>
  );
}

const meta = {
  title: "Lanes/Settings/Bring in history",
  component: Review,
  args: { preview: ready },
} satisfies Meta<typeof Review>;
export default meta;
type Story = StoryObj<typeof meta>;

export const ReadyToImport: Story = {};

export const Importing: Story = { args: { stage: "importing" } };

export const Stopped: Story = { args: { stage: "stopped" } };

export const AccountsToChoose: Story = {
  args: {
    preview: {
      ...ready,
      ready: false,
      unmapped: 2,
      accounts: [
        ...ready.accounts.slice(0, 3),
        row("Bank Fees", 120, null, null),
        row("Uncategorized Income", 12, null, null, { suggestedRole: "income" }),
      ],
    },
  },
};

export const WithProblems: Story = {
  args: {
    preview: {
      ...ready,
      ready: false,
      problemCount: 12,
      problems: [
        { row: 14, message: "The debits and credits of entry J-7 differ by 1.00." },
        { row: 22, message: 'The date "2019-02-30" is not a date.' },
        { row: 31, message: "The amount ten is not a number." },
      ],
      conflicts: [
        "A period from Mar 1, 2019 to Mar 31, 2019 is closed, and nothing can be posted into it. Reopen it first.",
      ],
    },
  },
};

export const DatesToChoose: Story = {
  render: (args) => (
    <Frame width="56rem">
      <HistoryReview
        preview={{ ...args.preview, dateOrderAssumed: true }}
        options={options}
        choices={{}}
        onChoose={() => {}}
        dateOrder={{ value: "mdy", onChange: () => {} }}
        stage="review"
        progress={null}
        onImport={() => {}}
      />
    </Frame>
  ),
};

export const PartlyImported: Story = {
  args: { preview: { ...ready, alreadyImported: 1200, remaining: 1210 } },
};

export const AllImported: Story = {
  args: { preview: { ...ready, alreadyImported: 2410, remaining: 0 } },
};

export const Done: Story = {
  render: () => (
    <Frame width="56rem">
      <HistoryDone entries={2410} booksBegan="2016-01-04" />
    </Frame>
  ),
};

const compared = (over: Partial<TieOutView> = {}): TieOutView => ({
  asOf: "2018-12-31",
  tied: true,
  differing: 0,
  accounts: [],
  unmapped: [],
  problems: [],
  problemCount: 0,
  ...over,
});

function Compare(props: { result: TieOutView | null; busy?: boolean; problem?: string }) {
  return (
    <Frame width="56rem">
      <HistoryCompare
        state="idle"
        fileName={props.result ? "trial-balance-2018.csv" : undefined}
        fileSize={props.result ? 4096 : undefined}
        onFile={() => {}}
        date={props.result ? "2018-12-31" : ""}
        onDate={() => {}}
        problem={props.problem}
        busy={props.busy ?? false}
        ready={props.result !== null}
        onCompare={() => {}}
        result={props.result}
      />
    </Frame>
  );
}

export const CompareEmpty: Story = {
  render: () => <Compare result={null} />,
};

export const CompareTied: Story = {
  render: () => <Compare result={compared()} />,
};

export const CompareDiffers: Story = {
  render: () => (
    <Compare
      result={compared({
        tied: false,
        differing: 2,
        accounts: [
          {
            account: "1000",
            name: "Cash",
            file: "2521.00",
            book: "2520.00",
            difference: "-1.00",
          },
          {
            account: "6100",
            name: "Rent & Lease",
            file: "7800.00",
            book: "7150.00",
            difference: "-650.00",
          },
        ],
        unmapped: ["9999 Mystery: -1.00"],
      })}
    />
  ),
};

export const CompareFileProblem: Story = {
  render: () => (
    <Compare
      result={compared({
        tied: false,
        problemCount: 1,
        problems: [{ row: 4, message: "The amount ten is not a number." }],
      })}
    />
  ),
};

export const CompareFailed: Story = {
  render: () => <Compare result={null} problem="The comparison could not be made. Try again." />,
};
