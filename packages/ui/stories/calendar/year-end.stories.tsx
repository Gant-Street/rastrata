import { createSignal } from "solid-js";
import type { Meta, StoryObj } from "storybook-solidjs-vite";
import {
  PeriodChangePanel,
  YearEndFlow,
  type PeriodChangeStage,
  type YearEndStage,
} from "../../src";
import {
  checklistAttention,
  checklistLoading,
  checklistReady,
  checklistUnavailable,
  monthlyYear,
  plan,
  planInvalid,
  planWithReclose,
  statements,
} from "./fixtures";
import { Frame } from "./frame";

type FlowArgs = {
  stage: YearEndStage;
  checklist: typeof checklistReady;
  withStatements?: boolean;
  reason?: string;
  reasonError?: string;
  plan?: typeof plan | null;
  planCurrent?: boolean;
  receipt?: Parameters<typeof YearEndFlow>[0]["receipt"];
  uncertain?: boolean;
  periodsToClose?: number | null;
  locale?: string;
};

function Flow(props: FlowArgs) {
  const [reason, setReason] = createSignal(props.reason ?? "");
  return (
    <Frame {...(props.locale ? { locale: props.locale } : {})}>
      <YearEndFlow
        fiscalYear={2027}
        startsOn="2027-10-01"
        endsOn="2028-09-30"
        stage={props.stage}
        checklist={props.checklist}
        statements={props.withStatements === false ? null : statements}
        reason={reason()}
        onReason={setReason}
        reasonError={props.reasonError}
        plan={props.plan ?? null}
        planCurrent={props.planCurrent ?? true}
        receipt={props.receipt ?? null}
        uncertain={props.uncertain ?? false}
        periodsToClose={props.periodsToClose === undefined ? 7 : props.periodsToClose}
        onPrepare={() => undefined}
        onCommit={() => undefined}
        onResume={() => undefined}
        onBack={() => undefined}
        onReviewAgain={() => undefined}
      />
    </Frame>
  );
}

const meta = {
  title: "Lanes/Calendar/Close the year",
  component: Flow,
  parameters: {
    layout: "fullscreen",
    docs: {
      description: {
        component:
          "Closing a fiscal year as three steps on one page: check the books, say why, review the prepared year-end and close. Every check says its state in words, and one that could not be read is never shown as fine. Nothing changes until the last button, which names the year. Closing posts no entries and moves no balance.",
      },
    },
  },
} satisfies Meta<typeof Flow>;

export default meta;
type Story = StoryObj<typeof meta>;

export const Checking: Story = {
  args: {
    stage: "checking",
    checklist: checklistLoading,
    withStatements: false,
    periodsToClose: null,
  },
};

export const NothingToClose: Story = {
  args: { stage: "reason", checklist: checklistReady, periodsToClose: 0 },
};

export const ReadyToClose: Story = {
  args: { stage: "reason", checklist: checklistReady, reason: "Reviewed with my bookkeeper" },
};

export const NeedsAttention: Story = {
  args: { stage: "reason", checklist: checklistAttention },
};

export const SomeChecksCouldNotBeRead: Story = {
  args: { stage: "reason", checklist: checklistUnavailable },
};

export const ReasonMissing: Story = {
  args: {
    stage: "reason",
    checklist: checklistReady,
    reasonError: "Say why you are closing the year.",
  },
};

export const Preparing: Story = {
  args: {
    stage: "preparing",
    checklist: checklistReady,
    reason: "Reviewed with my bookkeeper",
  },
};

export const ReviewThePlan: Story = {
  args: {
    stage: "plan",
    checklist: checklistAttention,
    reason: "Reviewed with my bookkeeper",
    plan,
  },
};

export const PlanThatClosesAgain: Story = {
  args: {
    stage: "plan",
    checklist: checklistAttention,
    reason: "Reviewed with my bookkeeper",
    plan: planWithReclose,
  },
};

export const PlanNoLongerMatchesTheReason: Story = {
  args: {
    stage: "plan",
    checklist: checklistReady,
    reason: "A different reason",
    plan,
    planCurrent: false,
  },
};

export const PlanCannotBeCommitted: Story = {
  args: {
    stage: "plan",
    checklist: checklistReady,
    reason: "Reviewed with my bookkeeper",
    plan: planInvalid,
  },
};

export const Committing: Story = {
  args: {
    stage: "committing",
    checklist: checklistReady,
    reason: "Reviewed with my bookkeeper",
    plan,
  },
};

export const Done: Story = {
  args: {
    stage: "done",
    checklist: checklistReady,
    reason: "Reviewed with my bookkeeper",
    plan,
    receipt: { disposition: "committed", closed: 7, total: 7, message: "" },
  },
};

export const OnlyPartlyDone: Story = {
  args: {
    stage: "done",
    checklist: checklistReady,
    reason: "Reviewed with my bookkeeper",
    plan,
    receipt: {
      disposition: "rejected",
      closed: 3,
      total: 7,
      message:
        "Closed 3 of 7 periods; the book rejected the next command: Command was evaluated against a stale book revision. The periods already closed stay closed. Review the year again before closing the rest.",
    },
  },
};

export const ReplyLost: Story = {
  args: {
    stage: "plan",
    checklist: checklistReady,
    reason: "Reviewed with my bookkeeper",
    plan,
    uncertain: true,
  },
};

export const RightToLeft: Story = {
  args: { stage: "reason", checklist: checklistAttention, locale: "ar" },
};

function Change(props: {
  operation: "close" | "reopen";
  stage: PeriodChangeStage;
  reason?: string;
  reasonError?: string;
  warnings?: string[];
  valid?: boolean;
  current?: boolean;
  blocked?: boolean;
  closed?: number;
}) {
  const [reason, setReason] = createSignal(props.reason ?? "");
  const periods = monthlyYear(2027, { closed: props.closed ?? 9 });
  const period = periods[5];
  if (!period) throw new Error("fixture");
  return (
    <Frame>
      <PeriodChangePanel
        operation={props.operation}
        period={period}
        reason={reason()}
        onReason={setReason}
        reasonError={props.reasonError}
        stage={props.stage}
        plan={
          props.stage === "review"
            ? {
                bookRevision: "412",
                valid: props.valid ?? true,
                problems:
                  props.valid === false ? ["Close requires one currently open fiscal period"] : [],
                warnings: props.warnings ?? [],
                supersedes: props.operation === "reopen" ? period.supersedes : [],
                reportHref: props.operation === "close" ? "/reports?asOf=2028-03-31" : undefined,
              }
            : null
        }
        current={props.current ?? true}
        blocked={props.blocked ?? false}
        onPrepare={() => undefined}
        onCommit={() => undefined}
        onCancel={() => undefined}
      />
    </Frame>
  );
}

export const CloseOnePeriod: StoryObj<typeof Change> = {
  render: (args) => <Change {...args} />,
  args: { operation: "close", stage: "compose", closed: 5 },
};

export const CloseReview: StoryObj<typeof Change> = {
  render: (args) => <Change {...args} />,
  args: {
    operation: "close",
    stage: "review",
    reason: "March reviewed",
    closed: 5,
    warnings: [
      "1 earlier period is still open or needs closing again, the oldest January 2028 (2028-01-01 to 2028-01-31). Closing out of order leaves a gap in the locked books.",
    ],
  },
};

export const ReopenWithConsequences: StoryObj<typeof Change> = {
  render: (args) => <Change {...args} />,
  args: {
    operation: "reopen",
    stage: "compose",
    reason: "A supplier restated March",
    closed: 9,
  },
};

export const ReopenReview: StoryObj<typeof Change> = {
  render: (args) => <Change {...args} />,
  args: {
    operation: "reopen",
    stage: "review",
    reason: "A supplier restated March",
    closed: 9,
  },
};

export const ChangeCannotBeMade: StoryObj<typeof Change> = {
  render: (args) => <Change {...args} />,
  args: { operation: "close", stage: "review", reason: "Again", valid: false, closed: 9 },
};

export const ChangeBlockedByARetainedWrite: StoryObj<typeof Change> = {
  render: (args) => <Change {...args} />,
  args: { operation: "close", stage: "compose", reason: "Month end", blocked: true, closed: 5 },
};

export const ChangePreparing: StoryObj<typeof Change> = {
  render: (args) => <Change {...args} />,
  args: { operation: "close", stage: "preparing", reason: "Month end", closed: 5 },
};
