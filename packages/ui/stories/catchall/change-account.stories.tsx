import { createSignal, type JSX } from "solid-js";
import type { Meta, StoryObj } from "storybook-solidjs-vite";
import {
  Button,
  ChangeAccountDialog,
  type ChangeAccountDialogProps,
  type ChangeAccountStage,
  type MoveRow,
  UiProvider,
} from "../../src";
import {
  chart,
  done,
  doneWithLeftBehind,
  planAll,
  planLong,
  planMany,
  planNone,
  planReconciled,
  planSome,
} from "./fixtures";

function Frame(props: { children: JSX.Element }): JSX.Element {
  return (
    <UiProvider locale="en-US">
      <div class="rt-theme" style={{ padding: "1.5rem" }}>
        {props.children}
      </div>
    </UiProvider>
  );
}

type Preview = {
  stage?: ChangeAccountStage;
  rows?: MoveRow[];
  accountsState?: ChangeAccountDialogProps["accountsState"];
  accountError?: string;
  error?: string;
  uncertain?: boolean;
  count?: number;
  capped?: { included: number; left: number };
  startAccount?: string;
  startReason?: string;
  progress?: { done: number; total: number };
};

/** The dialog with a button that opens it again, so Escape and Cancel can be tried. Nothing is sent. */
function Changing(props: Preview) {
  const [open, setOpen] = createSignal(true);
  const [account, setAccount] = createSignal(props.startAccount ?? "");
  const [reason, setReason] = createSignal(props.startReason ?? "");
  const [said, setSaid] = createSignal("");
  return (
    <Frame>
      {/* Out of the tab order: while the dialog is open the page behind it is hidden from assistive
          technology. Focus still returns to it. */}
      <Button
        label="Change account"
        variant="secondary"
        tabIndex={-1}
        onClick={() => setOpen(true)}
      />
      <p role="status" class="rt-hint">
        {said()}
      </p>
      <ChangeAccountDialog
        open={open()}
        count={props.count ?? props.rows?.length ?? 3}
        capped={props.capped}
        stage={props.stage ?? "choose"}
        accounts={chart}
        accountsState={props.accountsState ?? "ready"}
        onRetryAccounts={() => setSaid("Read again in this preview.")}
        accountId={account()}
        onAccount={setAccount}
        accountError={props.accountError}
        reason={reason()}
        onReason={setReason}
        target="Software and subscriptions"
        rows={props.rows ?? []}
        progress={props.progress}
        error={props.error}
        uncertain={props.uncertain}
        onResume={() => setSaid("Resumed in this preview.")}
        onPlan={() => setSaid("Checked in this preview.")}
        onBack={() => setSaid("Back in this preview.")}
        onConfirm={() => setSaid("Moved in this preview.")}
        onCancel={() => setOpen(false)}
        returnFocus={() => document.querySelector<HTMLElement>("button.rt-button")}
      />
    </Frame>
  );
}

const meta = {
  title: "Lanes/Catchall/Change account",
  component: Changing,
  parameters: {
    layout: "fullscreen",
    docs: {
      description: {
        component:
          "Changing the account of transactions that came from For review: choose the account, read what will happen to each one (and which cannot move, and why), confirm. The old entries stay and a linked entry cancels each one; nothing is edited or deleted. Text a bank wrote is shown as text and cut short.",
      },
    },
  },
} satisfies Meta<typeof Changing>;

export default meta;
type Story = StoryObj<typeof meta>;

export const Choose: Story = { args: { stage: "choose", count: 3 } };
export const ChooseOne: Story = { args: { stage: "choose", count: 1 } };
export const MoreSelectedThanOneChangeTakes: Story = {
  args: { stage: "choose", count: 500, capped: { included: 500, left: 112 } },
};
export const NoAccountChosen: Story = {
  args: { stage: "choose", accountError: "Choose the account to move them to." },
};
export const LoadingAccounts: Story = { args: { stage: "choose", accountsState: "loading" } };
export const AccountsFailed: Story = { args: { stage: "choose", accountsState: "error" } };
export const Checking: Story = {
  args: { stage: "planning", startAccount: "6200", startReason: "Software, not other" },
};
export const PlanAllWillMove: Story = { args: { stage: "review", rows: planAll } };
export const PlanSomeCannotMove: Story = { args: { stage: "review", rows: planSome } };
export const PlanNoneCanMove: Story = { args: { stage: "review", rows: planNone } };
export const PlanWithAWarning: Story = { args: { stage: "review", rows: planReconciled } };
export const LongText: Story = { args: { stage: "review", rows: planLong } };
export const ManyRows: Story = { args: { stage: "review", rows: planMany, count: 60 } };
export const Working: Story = {
  args: { stage: "working", count: 38, progress: { done: 12, total: 38 } },
};
export const Done: Story = { args: { stage: "done", rows: done } };
export const DoneWithSomeLeftBehind: Story = {
  args: { stage: "done", rows: doneWithLeftBehind },
};
export const Stopped: Story = {
  args: {
    stage: "done",
    rows: doneWithLeftBehind,
    error: "Your access does not allow changing accounts. Ask the owner for access.",
  },
};
export const PlanFailed: Story = {
  args: {
    stage: "failed",
    error: "The service could not be reached. Nothing was changed.",
    startAccount: "6200",
  },
};
export const WaitingForAnAnswer: Story = {
  args: {
    stage: "working",
    count: 38,
    progress: { done: 12, total: 38 },
    uncertain: true,
  },
};
