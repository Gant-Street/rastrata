import { createSignal, type JSX } from "solid-js";
import type { Meta, StoryObj } from "storybook-solidjs-vite";
import {
  ClassifierCard,
  type ClassifierView,
  RuleDeleteDialog,
  RuleHistory,
  UiProvider,
} from "../../src";
import {
  classifierLongHistory,
  classifierNotReady,
  classifierOff,
  classifierReady,
  classifierStale,
  revisions,
} from "./fixtures";

const Frame = (props: { children: JSX.Element }) => (
  <UiProvider>
    <div class="rt-theme rt-rules-page">{props.children}</div>
  </UiProvider>
);

const noop = () => {};

function Card(props: {
  view: ClassifierView;
  training?: boolean;
  saving?: boolean;
  message?: { tone: "ok" | "error"; text: string };
}) {
  return (
    <ClassifierCard
      state="ready"
      view={props.view}
      training={props.training}
      saving={props.saving}
      message={props.message}
      onTrain={noop}
      onSave={noop}
    />
  );
}

const meta = {
  title: "Lanes/Rules/Classifier",
  parameters: { layout: "padded", a11y: { test: "error" } },
} satisfies Meta;
export default meta;
type Story = StoryObj<typeof meta>;

/** Precision and recall are exact counts from replaying this book's own history in date order, with
 * a sweep over confidence, per-account figures and the commonest mistakes behind disclosures. */
export const Ready: Story = {
  render: () => (
    <Frame>
      <Card view={classifierReady} />
    </Frame>
  ),
};

export const NotReady: Story = {
  render: () => (
    <Frame>
      <Card view={classifierNotReady} />
    </Frame>
  ),
};

/** The one state with a button: a history too long to learn from on the side, which Train now
 * learns from all of. (On a book it has learned nothing from, the card is not shown at all: see
 * Lanes/Rules/List, Empty book.) */
export const LongHistory: Story = {
  render: () => (
    <Frame>
      <Card view={classifierLongHistory} />
    </Frame>
  ),
};

export const SwitchedOff: Story = {
  render: () => (
    <Frame>
      <Card view={classifierOff} />
    </Frame>
  ),
};

/** The book has moved on since it last learned: the card says so, and that it learns again when For
 * review is next read. */
export const OutOfDate: Story = {
  render: () => (
    <Frame>
      <Card view={classifierStale} />
    </Frame>
  ),
};

export const Training: Story = {
  render: () => (
    <Frame>
      <Card view={classifierLongHistory} training />
    </Frame>
  ),
};

export const SavingThresholds: Story = {
  render: () => (
    <Frame>
      <Card view={classifierReady} saving />
    </Frame>
  ),
};

export const Trained: Story = {
  render: () => (
    <Frame>
      <Card
        view={classifierReady}
        message={{ tone: "ok", text: "Trained again on the book as it is now." }}
      />
    </Frame>
  ),
};

export const TrainingFailed: Story = {
  render: () => (
    <Frame>
      <Card
        view={classifierReady}
        message={{
          tone: "error",
          text: "The classifier could not be trained. Nothing has been changed.",
        }}
      />
    </Frame>
  ),
};

export const LoadFailed: Story = {
  render: () => (
    <Frame>
      <ClassifierCard state="error" onTrain={noop} onSave={noop} onRetry={noop} />
    </Frame>
  ),
};

export const History: Story = {
  render: () => (
    <Frame>
      <RuleHistory revisions={revisions} />
    </Frame>
  ),
};

export const HistoryEmpty: Story = {
  render: () => (
    <Frame>
      <RuleHistory revisions={[]} />
    </Frame>
  ),
};

/** Deleting retires a rule: it stops suggesting at once and cannot be switched back on, so the safe
 * choice has the first focus and the dialog names the alternative. */
export const DeleteDialog: Story = {
  render: () => {
    const [open, setOpen] = createSignal(true);
    return (
      <Frame>
        <RuleDeleteDialog
          open={open()}
          onOpenChange={setOpen}
          name="GitHub subscriptions"
          onConfirm={noop}
        />
      </Frame>
    );
  },
};

export const DeleteDialogFailed: Story = {
  render: () => (
    <Frame>
      <RuleDeleteDialog
        open
        onOpenChange={noop}
        name="GitHub subscriptions"
        error="This rule changed since you read it. Read it again and reapply your change."
        onConfirm={noop}
      />
    </Frame>
  ),
};
