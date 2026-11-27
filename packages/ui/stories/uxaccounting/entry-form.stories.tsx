import { createSignal, type JSX, Show } from "solid-js";
import type { Meta, StoryObj } from "storybook-solidjs-vite";
import {
  accountOptions,
  blankEntryLine,
  EntryBar,
  type EntryLine,
  EntrySource,
  entryIds,
  entryProblems,
  entryTotals,
  ErrorSummary,
  JournalLines,
  TextField,
  UiProvider,
} from "../../src";

/** The accounts of a small book, as `accounts.list` gives them. One is closed, and one is a group the
 * others sit under, which a picker does not offer. */
const rows = [
  { id: "bank", code: "1000", name: "Business checking", role: "asset" },
  { id: "savings", code: "1010", name: "Business savings", role: "asset" },
  { id: "equipment", code: "1500", name: "Equipment and computers", role: "asset" },
  { id: "card", code: "2000", name: "Business credit card", role: "liability" },
  { id: "invest", code: "3000", name: "Owner's investment", role: "equity" },
  { id: "draw", code: "3100", name: "Owner's draw", role: "equity" },
  { id: "sales", code: "4000", name: "Sales", role: "income" },
  { id: "ops", code: "6000", name: "Operating expenses", role: "expense" },
  {
    id: "software",
    code: "6200",
    name: "Software and subscriptions",
    role: "expense",
    parentId: "ops",
  },
  {
    id: "intl",
    code: "6210",
    name: "Professional services: International consulting and translation for the studio",
    role: "expense",
    parentId: "ops",
  },
  {
    id: "old",
    code: "6900",
    name: "Old account",
    role: "expense",
    parentId: "ops",
    closedOn: "2026-01-31",
  },
];
const accounts = accountOptions(rows);

function Frame(props: { children: JSX.Element }): JSX.Element {
  return (
    <UiProvider locale="en-US">
      <div class="rt-theme rt-acct-page" style={{ padding: "1.5rem", "max-width": "78rem" }}>
        {props.children}
      </div>
    </UiProvider>
  );
}

type Preview = {
  start?: EntryLine[];
  /** What a refused Save draft or Post has already listed. */
  attempted?: "draft" | "post";
  /** The form opened for a source: the event the entry records, shown under "Where this entry came from". */
  source?: { id: string; description: string; evidence: string };
  description?: string;
};

/** The form's fields, lines and bar, with nothing behind them: Save draft and Post only say what they would
 * do. It keeps its own lines, so typing, tidying and the totals can be tried. */
function EntryForm(props: Preview) {
  const [lines, setLines] = createSignal<EntryLine[]>(
    props.start ?? [blankEntryLine(), blankEntryLine()],
  );
  const [date, setDate] = createSignal("2026-03-21");
  const [description, setDescription] = createSignal(props.description ?? "");
  const [reference, setReference] = createSignal("");
  const [attempted, setAttempted] = createSignal(props.attempted ?? null);
  const [attempt, setAttempt] = createSignal(0);
  const [sourceOpen, setSourceOpen] = createSignal(true);
  const [said, setSaid] = createSignal("");
  const source = () => ({
    id: props.source?.id ?? "",
    description: props.source?.description ?? "",
  });
  const problems = () => {
    const purpose = attempted();
    return purpose === null
      ? []
      : entryProblems({
          date: date(),
          description: description(),
          lines: lines(),
          source: source(),
          purpose,
        });
  };
  const byId = () =>
    Object.fromEntries(problems().map((problem) => [problem.id, problem.short])) as Record<
      string,
      string
    >;
  const ask = (purpose: "draft" | "post") => {
    const found = entryProblems({
      date: date(),
      description: description(),
      lines: lines(),
      source: source(),
      purpose,
    });
    if (found.length > 0) {
      setAttempted(purpose);
      setAttempt((count) => count + 1);
      setSaid("");
      return;
    }
    setSaid(purpose === "draft" ? "Draft saved in this preview." : "Posted in this preview.");
  };
  return (
    <Frame>
      <form
        class="rt-entry-form"
        noValidate
        aria-label="New journal entry"
        onSubmit={(event) => event.preventDefault()}
      >
        <Show when={problems().length > 0}>
          <ErrorSummary
            title="This entry is not ready"
            errors={problems().map(({ id, message }) => ({ id, message }))}
            attempt={attempt()}
          />
        </Show>
        <div class="rt-entry-fields">
          <TextField
            id={entryIds.date}
            label="Date"
            type="date"
            required
            value={date()}
            onInput={(event) => setDate(event.currentTarget.value)}
          />
          <TextField
            id={entryIds.description}
            label="Description"
            required
            value={description()}
            onInput={(event) => setDescription(event.currentTarget.value)}
          />
          <TextField
            label="Reference (optional)"
            value={reference()}
            onInput={(event) => setReference(event.currentTarget.value)}
          />
        </div>
        <JournalLines
          lines={lines()}
          accounts={accounts}
          problems={byId()}
          onChange={(index, patch) =>
            setLines((previous) =>
              previous.map((line, position) => (position === index ? { ...line, ...patch } : line)),
            )
          }
          onAdd={() => setLines((previous) => [...previous, blankEntryLine()])}
          onRemove={(index) =>
            setLines((previous) => previous.filter((_, position) => position !== index))
          }
        />
        <Show when={props.source}>
          {(known) => (
            <EntrySource
              open={sourceOpen()}
              onOpenChange={setSourceOpen}
              sourceId={known().id}
              description={known().description}
              evidence={known().evidence}
              onInspect={() => setSaid("Inspecting the source in this preview.")}
            />
          )}
        </Show>
        <p role="status" class="rt-hint">
          {said()}
        </p>
        <EntryBar
          totals={entryTotals(lines())}
          currency="USD"
          busy={null}
          cancelHref="/journal"
          onSaveDraft={() => ask("draft")}
          onPost={() => ask("post")}
        />
      </form>
    </Frame>
  );
}

const meta = {
  title: "Lanes/UXAccounting/New entry",
  component: EntryForm,
  parameters: {
    layout: "fullscreen",
    docs: {
      description: {
        component:
          'The new-entry form: a date, a description and an optional reference, the lines with the one account picker, and a bar that stays in view with the totals, Save draft and Post. An entry typed by hand has no fold for a source; a form opened for one (from an entry\'s details, or a draft that carries one) shows the event it records under "Where this entry came from", which is how the ledger refuses to book it twice.',
      },
    },
  },
} satisfies Meta<typeof EntryForm>;

export default meta;
type Story = StoryObj<typeof meta>;

export const Empty: Story = {};

export const Balanced: Story = {
  args: {
    description: "Software subscription",
    start: [
      { accountId: "software", debit: "100.00", credit: "" },
      { accountId: "bank", debit: "", credit: "100.00" },
    ],
  },
};

export const OutOfBalance: Story = {
  args: {
    description: "Hardware purchase",
    start: [
      { accountId: "equipment", debit: "1250.50", credit: "" },
      { accountId: "card", debit: "", credit: "1000.00" },
    ],
  },
};

export const RefusedPost: Story = {
  args: {
    attempted: "post",
    start: [
      { accountId: "", debit: "100.00", credit: "" },
      { accountId: "sales", debit: "50", credit: "20" },
      { accountId: "bank", debit: "12.345", credit: "" },
      blankEntryLine(),
    ],
  },
};

export const ManyLines: Story = {
  args: {
    description: "Month-end allocation",
    start: Array.from({ length: 14 }, (_, index) =>
      index % 2 === 0
        ? { accountId: "software", debit: `${(index + 1) * 10}.00`, credit: "" }
        : { accountId: "bank", debit: "", credit: `${index * 10 + 10}.00` },
    ),
  },
};

export const LongAccountName: Story = {
  args: {
    description: "Consulting",
    start: [
      { accountId: "intl", debit: "420.00", credit: "" },
      { accountId: "bank", debit: "", credit: "420.00" },
    ],
  },
};

export const ClosedAccountInADraft: Story = {
  args: {
    description: "Entered before the account was closed",
    start: [
      { accountId: "old", debit: "75.00", credit: "" },
      { accountId: "bank", debit: "", credit: "75.00" },
    ],
  },
};

/** Opened for a source: the facts of the event, kept as the source gave them, under one fold. */
export const FromSource: Story = {
  args: {
    source: {
      id: "invoice-1042",
      description: "Invoice 1042 to Harbor Studio",
      evidence: "invoices/1042.pdf",
    },
    description: "Invoice 1042",
  },
};
