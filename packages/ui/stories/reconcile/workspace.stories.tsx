import { createMemo, createSignal, Show } from "solid-js";
import type { Meta, StoryObj } from "storybook-solidjs-vite";
import { type ReconcileLine, ReconcileWorkspace, type SaveState, UiProvider } from "../../src";
import {
  cardLines,
  columnTotals,
  figuresFor,
  january,
  januaryBalance,
  longMemos,
  manyLines,
  money,
  cents,
} from "./fixtures";

type Scenario = {
  lines: ReconcileLine[];
  statementBalance: string;
  openingBalance?: string;
  kind?: "asset" | "liability";
  selected?: string[];
  saveState?: SaveState;
  stale?: boolean;
  state?: "ready" | "loading" | "error";
  warnings?: string[];
  locale?: string;
};

/** The real workspace over fictional lines. Ticking changes the figures at once, like the screen,
 * and Finish becomes available only at exactly 0.00. Nothing is stored or sent. */
function Harness(props: Scenario) {
  const [selected, setSelected] = createSignal<ReadonlySet<string>>(new Set(props.selected ?? []));
  const [message, setMessage] = createSignal("");
  const figures = createMemo(() =>
    figuresFor(props.lines, selected(), props.statementBalance, props.openingBalance ?? "0.00"),
  );
  const toggle = (ids: readonly string[], on: boolean) =>
    setSelected((current) => {
      const next = new Set(current);
      for (const id of ids) on ? next.add(id) : next.delete(id);
      return next;
    });
  const saved = () => (props.saveState ?? "saved") === "saved";
  const ready = () => figures().difference === "0.00";
  return (
    <UiProvider locale={props.locale ?? "en-US"}>
      <div class="rt-theme rt-recon-story">
        <ReconcileWorkspace
          account={{ code: "1000", name: "Checking", kind: props.kind ?? "asset" }}
          figures={figures()}
          lines={props.lines}
          selected={selected()}
          columnTotals={columnTotals(props.lines, selected())}
          saveState={props.saveState ?? "saved"}
          stale={props.stale ?? false}
          {...(props.state ? { state: props.state } : {})}
          {...(props.warnings ? { warnings: props.warnings } : {})}
          finish={{
            disabled: !ready() || !saved() || (props.stale ?? false),
            hint: ready()
              ? saved()
                ? "Ready: the difference is 0.00."
                : "You can finish when your changes are saved."
              : "You can finish when the difference is exactly 0.00.",
            onFinish: () => setMessage("Finish confirmed in this preview. Nothing was stored."),
          }}
          onToggle={toggle}
          onSelectAll={() => setSelected(new Set(props.lines.map((line) => line.id)))}
          onClearAll={() => setSelected(new Set())}
          onEditStatement={() => setMessage("Edit statement opens a dialog in the application.")}
          onRefresh={() => setMessage("Refresh reads the books again in the application.")}
          onResume={() => setMessage("Resume sends the original request again, exactly as it was.")}
          onDiscard={() => setMessage("Discard asks for confirmation in the application.")}
        />
        <Show when={message()}>
          <p class="rt-hint" role="status">
            {message()}
          </p>
        </Show>
      </div>
    </UiProvider>
  );
}

const meta = {
  title: "Lanes/Reconcile/Workspace",
  component: Harness,
  parameters: { layout: "padded", a11y: { test: "error" } },
} satisfies Meta<typeof Harness>;
export default meta;
type Story = StoryObj<typeof meta>;

/** Four lines, nothing ticked: the difference is the whole statement balance. Try it with the
 * keyboard: Tab to a column, j and k to move, space or x to tick, / to find an amount. */
export const Default: Story = { args: { lines: january, statementBalance: januaryBalance } };

/** Every line ticked: the difference is 0.00, it says so in words, and Finish is available. */
export const Balanced: Story = {
  args: {
    lines: january,
    statementBalance: januaryBalance,
    selected: january.map((line) => line.id),
  },
};

/** One line left out: the difference is exactly that line, with its sign. */
export const OneLineShort: Story = {
  args: {
    lines: january,
    statementBalance: januaryBalance,
    selected: ["p1", "p2", "p3"],
  },
};

/** A second statement continues from the first: the opening balance is what January cleared. */
export const SecondStatement: Story = {
  args: {
    lines: [
      {
        id: "f1",
        date: "2026-02-03",
        description: "Invoice 1051 paid, Alder & Sons",
        amount: "100.00",
      },
      { id: "f2", date: "2026-02-17", description: "Domain renewal", amount: "-14.00" },
    ],
    statementBalance: "1276.00",
    openingBalance: januaryBalance,
    selected: ["f1"],
  },
};

/** A card statement: charges raise the balance owed (positive), payments lower it. */
export const CardLiability: Story = {
  args: { lines: cardLines, statementBalance: "980.00", kind: "liability", selected: ["c1", "c2"] },
};

export const Saving: Story = {
  args: {
    lines: january,
    statementBalance: januaryBalance,
    selected: january.map((line) => line.id),
    saveState: "saving",
  },
};

/** The reply to a save was lost. Nothing is shown as saved, the controls stop, and the only way
 * forward is to resume the original request. */
export const SaveUncertain: Story = {
  args: {
    lines: january,
    statementBalance: januaryBalance,
    selected: ["p1", "p2"],
    saveState: "uncertain",
  },
};

export const SaveFailed: Story = {
  args: { lines: january, statementBalance: januaryBalance, selected: ["p1"], saveState: "failed" },
};

/** New entries arrived after the lines were read: Finish waits for a refresh. */
export const Stale: Story = {
  args: {
    lines: january,
    statementBalance: januaryBalance,
    selected: january.map((line) => line.id),
    stale: true,
  },
};

export const WithWarnings: Story = {
  args: {
    lines: january,
    statementBalance: januaryBalance,
    selected: january.map((line) => line.id),
    warnings: [
      "1000 Checking: 2 postings dated through 2026-01-31 are not on a reconciliation (never reconciled). Outstanding items are normal; unexpected ones are worth finding.",
    ],
  },
};

export const NoLines: Story = { args: { lines: [], statementBalance: "0.00" } };
export const Loading: Story = { args: { lines: [], statementBalance: "0.00", state: "loading" } };
export const LoadFailed: Story = { args: { lines: [], statementBalance: "0.00", state: "error" } };

/** Long memos, markup and formula text, huge amounts and a single cent: all shown as text, none
 * of it acted on. */
export const LongContent: Story = {
  args: {
    lines: longMemos,
    statementBalance: money(longMemos.reduce((sum, line) => sum + cents(line.amount), 0n)),
    selected: longMemos.map((line) => line.id),
  },
};

/** A thousand lines: one tab stop per column, scrolling inside the table, and the find box. */
export const ManyLines: Story = {
  args: { lines: manyLines(1000), statementBalance: "0.00" },
};

/** Right-to-left page direction. Descriptions, dates and amounts stay in their own direction. */
export const RightToLeft: Story = {
  args: {
    lines: january,
    statementBalance: januaryBalance,
    selected: ["p1", "p3"],
    locale: "ar",
  },
};
