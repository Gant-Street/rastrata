import { createSignal, type JSX, Show } from "solid-js";
import type { Meta, StoryObj } from "storybook-solidjs-vite";
import {
  canChangeAccount,
  JournalRegister,
  type RegisterEntry,
  type SelectionAction,
  UiProvider,
} from "../../src";
import { accounts, corrections, transactions } from "../uxaccounting/fixtures";

function Frame(props: { children: JSX.Element }): JSX.Element {
  return (
    <UiProvider locale="en-US">
      <div class="rt-theme" style={{ padding: "1.5rem", "max-width": "78rem" }}>
        {props.children}
      </div>
    </UiProvider>
  );
}

/** The Transactions list as the application puts it on the page, with boxes on the rows that can be
 * moved to another account (a posted entry that came from a bank and that no reversal links). */
function Transactions(props: { entries: RegisterEntry[]; allowed: boolean }) {
  const [said, setSaid] = createSignal("");
  const linked = new Set(
    corrections.flatMap((link) => [link.originalJournalId, link.correctionJournalId]),
  );
  const actions: readonly SelectionAction[] = [
    {
      id: "change-account",
      label: "Change account",
      onSelect: (ids) => setSaid(`Change account for ${ids.length} chosen in this preview.`),
    },
  ];
  return (
    <Frame>
      <JournalRegister
        state="ready"
        entries={props.entries}
        accounts={accounts}
        corrections={corrections}
        typeOptions={["bank", "stripe", "manual", "opening"]}
        context={{
          bookName: "Willow Lane Studio",
          currency: "USD",
          description: "Persisted book entries",
          savedMessage: "Draft saved",
        }}
        newEntryHref="/journal/new"
        entryLabel={(entry) => (entry.postingSequence ? `No. ${entry.postingSequence}` : "Draft")}
        rowSelectable={(entry) => props.allowed && canChangeAccount(entry, linked.has(entry.id))}
        selectionActions={actions}
        server={{
          page: 1,
          pageSize: 25,
          count: props.entries.length,
          text: "",
          from: "",
          to: "",
          accountId: "",
          status: "",
          type: "",
          onChange: () => {},
        }}
      />
      <Show when={said()}>
        <p role="status" class="rt-hint">
          {said()}
        </p>
      </Show>
    </Frame>
  );
}

const meta = {
  title: "Lanes/Catchall/Transactions to change",
  component: Transactions,
  parameters: {
    layout: "fullscreen",
    docs: {
      description: {
        component:
          "The Transactions list with a box on each row that can change account: a posted entry that came from a bank and that no reversal links. Entries typed by hand, Stripe payouts, opening balances and entries already reversed have no box, and ticking the page leaves them out. Ticked rows show Change account above the list.",
      },
    },
  },
  args: { entries: transactions, allowed: true },
} satisfies Meta<typeof Transactions>;

export default meta;
type Story = StoryObj<typeof meta>;

export const WithBoxes: Story = {};

/** A person who may not correct, draft and post is offered no boxes. */
export const NotAllowed: Story = { args: { allowed: false } };

/** Nothing on the page can be moved: no column of boxes at all. */
export const NothingToMove: Story = {
  args: { entries: transactions.filter((entry) => entry.type !== "bank") },
};
