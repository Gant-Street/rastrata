import { createSignal, Show } from "solid-js";
import type { Meta, StoryObj } from "storybook-solidjs-vite";
import {
  type AccountChoice,
  JournalRegister,
  type JournalRegisterProps,
  type RegisterEntry,
  UiProvider,
} from "../src";
import { Catalog } from "./catalog";
import { accounts } from "./accounts";
import { registerEntries } from "./register-data";

function Register(props: {
  state: JournalRegisterProps["state"];
  compact: boolean;
  failFirstSave: boolean;
  unknownOutcome?: boolean;
}) {
  const [state, setState] = createSignal(props.state);
  const [entries, setEntries] = createSignal(registerEntries);
  const [reviewed, setReviewed] = createSignal("");
  let attempts = 0;
  return (
    <Catalog
      section="05 / Transaction register"
      title="Every entry, in its place."
      description="North Workshop · September 2026 · USD. A register for finding and reviewing entries, not an editable spreadsheet."
    >
      <JournalRegister
        state={state()}
        compact={props.compact}
        entries={entries()}
        accounts={accounts}
        context={{
          bookName: "North Workshop",
          currency: "USD",
          description: "Changes stay in this preview; reloading clears them.",
          savedMessage: "Draft saved in this preview.",
        }}
        newEntryHref="?id=patterns-journal--review&viewMode=story"
        footnote="Search, sort, filter, inspect entries, and change pages. All actions stay in this preview."
        onRetry={() => setState("ready")}
        onReviewSelected={(ids) => setReviewed(`Selected: ${ids.join(", ")}. No entries changed.`)}
        onSave={async (entry, reference) => {
          // Storage simulation is confined to the workshop, never shipped as application behavior.
          await new Promise((resolve) => setTimeout(resolve, 600));
          attempts += 1;
          if (props.unknownOutcome) return { status: "unknown" };
          if (props.failFirstSave && attempts === 1) return { status: "rejected" };
          const saved = {
            ...entry,
            reference,
            history: [
              ...entry.history,
              { at: "This session", description: `Draft reference saved: ${reference}` },
            ],
          };
          setEntries((rows) => rows.map((row) => (row.id === saved.id ? saved : row)));
          return { status: "saved", entry: saved };
        }}
      />
      <Show when={reviewed()}>
        <p role="status" class="rt-hint rt-register-feedback-status">
          {reviewed()}
        </p>
      </Show>
    </Catalog>
  );
}
export default {
  title: "Patterns/Register",
  component: Register,
  args: { state: "ready", compact: false, failFirstSave: false },
  argTypes: {
    state: { control: "select", options: ["ready", "loading", "empty", "error", "refreshing"] },
  },
  parameters: { layout: "fullscreen", options: { showPanel: false } },
} satisfies Meta<typeof Register>;
type Story = StoryObj<typeof Register>;
export const Review: Story = {};
export const Compact: Story = { args: { compact: true } };
export const Loading: Story = { args: { state: "loading" } };
export const Refreshing: Story = { args: { state: "refreshing" } };
export const Empty: Story = { args: { state: "empty" } };
export const Failed: Story = { args: { state: "error" } };
export const DraftSaveRecovery: Story = { args: { failFirstSave: true } };
export const UnknownSave: Story = { args: { unknownOutcome: true } };

export const SplitEntry: Story = {
  render: () => (
    <Catalog
      section="Display contract"
      title="A split entry."
      description="Fictional EUR fixture. Amounts and history are supplied, not reconstructed by the interface."
    >
      <JournalRegister
        state="ready"
        accounts={accounts}
        context={{
          bookName: "European Workshop",
          currency: "EUR",
          description: "Read-only accounting fixture.",
          savedMessage: "Saved.",
        }}
        entries={[
          {
            id: "EUR-001",
            date: "23 Sep 2026",
            isoDate: "2026-09-23",
            reference: "Equipment and supplies",
            status: "Posted",
            amount: "9,007,199,254,741.03",
            debitTotal: "9,007,199,254,741.03",
            creditTotal: "9,007,199,254,741.03",
            lines: [
              { id: "line-1", accountId: "equipment", debit: "9,007,199,254,740.93", credit: null },
              { id: "line-2", accountId: "office", debit: "0.10", credit: null },
              { id: "line-3", accountId: "payable", debit: null, credit: "9,007,199,254,741.03" },
            ],
            history: [{ at: "23 Sep 2026", description: "Imported by Finance team" }],
          },
        ]}
      />
    </Catalog>
  ),
};

// Mixed-direction data: Arabic names and references beside Latin entry numbers, dates and
// amounts. Interface copy stays English here; a translation is supplied through UiProvider.
const rtlAccounts: AccountChoice[] = [
  { label: "1000 · الصندوق", value: "cash", path: "الأصول / الأصول المتداولة", group: "الأصول" },
  {
    label: "2000 · الموردون",
    value: "payable",
    path: "الخصوم / الخصوم المتداولة",
    group: "الخصوم",
  },
  {
    label: "6100 · مصروفات المكتب",
    value: "office",
    path: "المصروفات / التشغيل",
    group: "المصروفات",
  },
];
const rtlRow = (id: string, date: string, iso: string, reference: string, amount: string) => ({
  id,
  date,
  isoDate: iso,
  reference,
  amount,
  status: "Posted" as const,
  lines: [
    { id: `${id}/1`, accountId: "office", debit: amount, credit: null },
    { id: `${id}/2`, accountId: "cash", debit: null, credit: amount },
  ],
  debitTotal: amount,
  creditTotal: amount,
  history: [{ at: date, isoAt: iso, description: "Created and posted" }],
});
// JRN-100 follows JRN-99 within their day: entry numbers sort by their digits, not as text.
const rtlEntries: RegisterEntry[] = [
  rtlRow("JRN-98", "21 Sep 2026", "2026-09-21", "مصروفات المكتب JRN-98", "128.40"),
  rtlRow("JRN-99", "23 Sep 2026", "2026-09-23", "دفعة العميل", "2,450.00"),
  rtlRow("JRN-100", "23 Sep 2026", "2026-09-23", "شراء معدات الورشة", "4,800.00"),
];
export const RightToLeft: Story = {
  render: () => (
    <UiProvider locale="ar-EG">
      <Catalog
        section="05 / Right to left"
        title="Mixed direction, kept in order."
        description="Arabic references and account names beside Latin entry numbers, dates and amounts. Each value is isolated so numbers never reorder, and arrows and edges flip with the page."
      >
        <JournalRegister
          state="ready"
          accounts={rtlAccounts}
          entries={rtlEntries}
          context={{
            bookName: "ورشة الشمال",
            currency: "EGP",
            description: "Read-only accounting fixture.",
            savedMessage: "Saved.",
          }}
        />
      </Catalog>
    </UiProvider>
  ),
};
