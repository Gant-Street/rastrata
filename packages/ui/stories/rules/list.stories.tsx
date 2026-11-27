import { createSignal, type JSX } from "solid-js";
import type { Meta, StoryObj } from "storybook-solidjs-vite";
import {
  ClassifierCard,
  RuleList,
  RulesDecided,
  RulesFacts,
  type RuleRow,
  UiProvider,
} from "../../src";
import {
  classifierEmptyBook,
  figure,
  figureEmptyBook,
  figureNotes,
  longRule,
  manyRules,
  mixedDirectionRule,
  rules,
  unmeasured,
} from "./fixtures";

const Frame = (props: { children: JSX.Element }) => (
  <UiProvider>
    <div class="rt-theme rt-rules-page">{props.children}</div>
  </UiProvider>
);

const noop = () => {};

/** A list that really reorders itself, so the keys and the buttons can be tried by hand. */
function Reorderable(props: { rows: readonly RuleRow[]; saving?: boolean }) {
  const [rows, setRows] = createSignal(props.rows);
  return (
    <RuleList
      rows={rows()}
      usage="ready"
      days={90}
      newHref="/rules/new"
      saving={props.saving ?? false}
      onMove={(id, direction) => {
        const list = [...rows()];
        const at = list.findIndex((row) => row.id === id);
        const to = direction === "up" ? at - 1 : at + 1;
        const moved = list[at];
        const target = list[to];
        if (!moved || !target) return;
        list[at] = target;
        list[to] = moved;
        setRows(list);
      }}
      onToggle={(id, enabled) =>
        setRows(rows().map((row) => (row.id === id ? { ...row, enabled } : row)))
      }
    />
  );
}

const meta = {
  title: "Lanes/Rules/List",
  parameters: { layout: "padded", a11y: { test: "error" } },
} satisfies Meta;
export default meta;
type Story = StoryObj<typeof meta>;

/** The first enabled rule that matches decides, so the order is the first thing in each row. The
 * move buttons and Alt with an arrow key change it; every move is announced. */
export const Default: Story = {
  render: () => (
    <Frame>
      <Reorderable rows={rules} />
    </Frame>
  ),
};

export const Empty: Story = {
  render: () => (
    <Frame>
      <RuleList
        rows={[]}
        usage="ready"
        days={90}
        newHref="/rules/new"
        onMove={noop}
        onToggle={noop}
      />
    </Frame>
  ),
};

export const Loading: Story = {
  render: () => (
    <Frame>
      <RuleList
        rows={[]}
        state="loading"
        days={90}
        newHref="/rules/new"
        onMove={noop}
        onToggle={noop}
      />
    </Frame>
  ),
};

export const LoadFailed: Story = {
  render: () => (
    <Frame>
      <RuleList
        rows={[]}
        state="error"
        days={90}
        newHref="/rules/new"
        onMove={noop}
        onToggle={noop}
        onRetry={noop}
      />
    </Frame>
  ),
};

/** The counts arrive after the rules do, so until they have the cells say they are being measured. */
export const MeasuringUsage: Story = {
  render: () => (
    <Frame>
      <RuleList
        rows={unmeasured}
        usage="loading"
        days={90}
        newHref="/rules/new"
        onMove={noop}
        onToggle={noop}
      />
    </Frame>
  ),
};

export const UsageUnavailable: Story = {
  render: () => (
    <Frame>
      <RuleList
        rows={unmeasured}
        usage="unavailable"
        days={90}
        newHref="/rules/new"
        onMove={noop}
        onToggle={noop}
      />
    </Frame>
  ),
};

/** While a new order is being saved the moves wait for it, and the status says so. */
export const SavingTheOrder: Story = {
  render: () => (
    <Frame>
      <Reorderable rows={rules} saving />
    </Frame>
  ),
};

/** Long names, long notes, huge counts and four problems: nothing overflows the page. */
export const LongContent: Story = {
  render: () => (
    <Frame>
      <Reorderable rows={[longRule, ...rules.slice(0, 2)]} />
    </Frame>
  ),
};

/** Right-to-left names and notes are isolated, so they read correctly inside left-to-right text. */
export const MixedDirections: Story = {
  render: () => (
    <Frame>
      <Reorderable rows={[mixedDirectionRule, ...rules.slice(0, 2)]} />
    </Frame>
  ),
};

export const ManyRules: Story = {
  render: () => (
    <Frame>
      <Reorderable rows={manyRules} />
    </Frame>
  ),
};

export const FigureReady: Story = {
  render: () => (
    <Frame>
      <RulesDecided state="ready" data={figure} />
      <RulesFacts data={figure} />
    </Frame>
  ),
};

export const FigureWithNotes: Story = {
  render: () => (
    <Frame>
      <RulesDecided state="ready" data={figureNotes} />
      <RulesFacts data={figureNotes} />
    </Frame>
  ),
};

/** A book with nothing posted and nothing waiting in For review: the page is the list alone. The
 * figure, the facts behind it and the classifier's card have nothing to say and are not shown. */
export const EmptyBook: Story = {
  render: () => (
    <Frame>
      <RulesDecided state="ready" data={figureEmptyBook} />
      <RuleList
        rows={[]}
        usage="ready"
        days={90}
        newHref="/rules/new"
        onMove={noop}
        onToggle={noop}
      />
      <RulesFacts data={figureEmptyBook} />
      <ClassifierCard state="ready" view={classifierEmptyBook} onTrain={noop} onSave={noop} />
    </Frame>
  ),
};

export const FigureNotMeasured: Story = {
  render: () => (
    <Frame>
      <RulesDecided state="ready" data={{ ...figure, window: null }} />
      <RulesFacts data={{ ...figure, window: null }} />
    </Frame>
  ),
};

export const FigureLoading: Story = {
  render: () => (
    <Frame>
      <RulesDecided state="loading" />
    </Frame>
  ),
};

export const FigureFailed: Story = {
  render: () => (
    <Frame>
      <RulesDecided state="error" onRetry={noop} />
    </Frame>
  ),
};
