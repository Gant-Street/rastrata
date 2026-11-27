import { createSignal, type JSX, Show } from "solid-js";
import type { Meta, StoryObj } from "storybook-solidjs-vite";
import {
  JournalRegister,
  type JournalRegisterProps,
  type RegisterEntry,
  UiProvider,
} from "../../src";
import { accounts, corrections, longTransactions, transactions } from "./fixtures";

/** The page the application puts the register on: the theme class and a measure as wide as the header. */
function Frame(props: { children: JSX.Element }): JSX.Element {
  return (
    <UiProvider locale="en-US">
      <div class="rt-theme" style={{ padding: "1.5rem", "max-width": "78rem" }}>
        {props.children}
      </div>
    </UiProvider>
  );
}

function Transactions(props: {
  entries: RegisterEntry[];
  state?: JournalRegisterProps["state"];
  count?: number;
  /** The book's fiscal calendar is given, so the dates and the account are chosen with the kit's controls. */
  kit?: boolean;
  /** The entries have no page of their own: a row's name opens the entry in a sheet beside the list. */
  sheet?: boolean;
}) {
  const [text, setText] = createSignal("");
  const [type, setType] = createSignal("");
  const [status, setStatus] = createSignal("");
  const [from, setFrom] = createSignal("");
  const [to, setTo] = createSignal("");
  const [accountId, setAccountId] = createSignal("");
  const [done, setDone] = createSignal("");
  const reversed = new Set(
    corrections.flatMap((link) => [link.originalJournalId, link.correctionJournalId]),
  );
  return (
    <Frame>
      <JournalRegister
        state={props.state ?? "ready"}
        selectable={false}
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
        {...(props.kit
          ? {
              fiscal: {
                years: [{ startsOn: "2026-01-01", endsOn: "2026-12-31" }],
                today: "2026-03-23",
              },
              fiscalState: "ready" as const,
            }
          : {})}
        newEntryHref="/journal/new"
        // What the Journal route does: an entry is "No. 23", a draft has no number yet.
        entryLabel={(entry) => (entry.postingSequence ? `No. ${entry.postingSequence}` : "Draft")}
        {...(props.sheet
          ? {}
          : {
              entryHref: (entry: RegisterEntry) =>
                entry.postingSequence ? `/journal/${entry.id}` : undefined,
            })}
        // A posted entry that no reversal links can be reversed; a draft is edited.
        rowActions={(entry) =>
          entry.status === "Draft"
            ? [
                {
                  id: "edit",
                  label: "Edit draft",
                  onSelect: () => setDone(`Edit ${entry.reference}`),
                },
              ]
            : reversed.has(entry.id)
              ? []
              : [
                  {
                    id: "reverse",
                    label: "Reverse",
                    onSelect: () => setDone(`Reverse No. ${entry.postingSequence}`),
                  },
                ]
        }
        server={{
          page: 1,
          pageSize: 25,
          count: props.count ?? props.entries.length,
          text: text(),
          from: from(),
          to: to(),
          accountId: accountId(),
          status: status(),
          type: type(),
          onChange: (change) => {
            if (change.text !== undefined) setText(change.text);
            if (change.type !== undefined) setType(change.type);
            if (change.status !== undefined) setStatus(change.status);
            if (change.from !== undefined) setFrom(change.from);
            if (change.to !== undefined) setTo(change.to);
            if (change.accountId !== undefined) setAccountId(change.accountId);
          },
        }}
      />
      <Show when={done()}>
        <p role="status" class="rt-hint">
          {done()} chosen in this preview. No entries changed.
        </p>
      </Show>
      <output class="rt-hint" aria-label="What the filters chose" style={{ display: "block" }}>
        {`dates ${from() || "all"} to ${to() || "all"} · account ${accountId() || "all"} · status ${status() || "all"}`}
      </output>
    </Frame>
  );
}

const meta = {
  title: "Lanes/UXAccounting/Transactions",
  component: Transactions,
  parameters: {
    layout: "fullscreen",
    docs: {
      description: {
        component:
          "The Transactions register as the Journal screen shows it: a search box with one button for the filters (dates, account, type, status), then Date, Description, Category and Amount on one screen, never a sideways scroll at desktop width. An entry is named by what it says and goes to its own page, where its number is (No. 23) and the long identifier the ledger gives it is under Details; a state is said only when it is not the normal one (a draft, a reversed entry). The accounts read as money moving, from the credited account to the debited one, and the menu at the end of a row offers what can be done to it.",
      },
    },
  },
  args: { entries: transactions },
} satisfies Meta<typeof Transactions>;

export default meta;
type Story = StoryObj<typeof meta>;

export const Default: Story = {};
/** The book's fiscal calendar is given: the period list (everything starts on "All dates") and the account picker
 * ("All accounts") are the kit's, as in every report. */
export const KitFilters: Story = { args: { kit: true } };
/** A list whose entries have no page of their own: a row's name opens the entry in a sheet beside the list. */
export const SideSheet: Story = { args: { sheet: true } };
export const Empty: Story = { args: { entries: [], count: 0, state: "empty" } };
export const Loading: Story = { args: { state: "loading" } };
export const Failed: Story = { args: { state: "error" } };
export const Refreshing: Story = { args: { state: "refreshing" } };
export const LongContent: Story = { args: { entries: longTransactions } };
