import type { Meta, StoryObj } from "storybook-solidjs-vite";
import {
  BankAccounts,
  type BankAccountLine,
  type BankGroup,
  bankWords as words,
  UiProvider,
} from "../../src";

/** Bank accounts, as the application shows it. A story sends nothing: its buttons and menus do nothing. */
const actions = [
  { id: "change", label: words.actions.change, onSelect: () => undefined },
  { id: "disconnect", label: words.actions.disconnect, onSelect: () => undefined },
];
const checking: BankAccountLine = {
  id: "fca_1",
  name: "Checking",
  ending: "0730",
  ledger: { label: "Ramp Checking", href: "#account" },
  review: { count: 9, href: "#review" },
  balance: "48210.57",
  actions,
};
const reserve: BankAccountLine = {
  id: "fca_2",
  name: "Reserve",
  ending: "0960",
  ledger: { label: "Ramp Reserve", href: "#account" },
  review: { count: 0, href: "#review" },
  balance: "13634.62",
  actions,
};
const ramp: BankGroup = {
  institution: "Ramp",
  dateline: words.updated("today 9:41 AM"),
  accounts: [checking, reserve],
};
const chase: BankGroup = {
  institution: "Chase",
  dateline: words.lastUpdated("Nov 16"),
  attention: {
    text: words.signInAgain,
    action: { label: words.signIn("Chase"), onSelect: () => undefined },
  },
  accounts: [
    {
      id: "fca_3",
      name: "Business Complete Checking",
      ending: "4417",
      ledger: { label: "Business checking", href: "#account" },
      review: { count: 3, href: "#review" },
      balance: "22908.14",
      actions,
    },
  ],
};
const justConnected: BankGroup = {
  institution: "Ramp",
  dateline: words.waiting,
  accounts: [
    { ...checking, review: { count: 41, href: "#review" }, balance: null },
    {
      ...reserve,
      ledger: null,
      review: null,
      balance: null,
      question: { account: "Business savings", onYes: () => undefined, onNo: () => undefined },
    },
  ],
};
const member = (group: BankGroup): BankGroup => ({
  ...group,
  ...(group.attention ? { attention: { text: group.attention.text } } : {}),
  accounts: group.accounts.map((account) => ({ ...account, actions: [] })),
});

function Harness(props: { groups?: readonly BankGroup[]; member?: boolean; width?: string }) {
  return (
    <UiProvider locale="en-US">
      <div class="rt-theme" style={{ "max-width": props.width ?? "65rem" }}>
        <BankAccounts
          groups={(props.groups ?? []).map((group) => (props.member ? member(group) : group))}
          currency="USD"
          onConnect={props.member ? undefined : () => undefined}
          onImport={props.member ? undefined : () => undefined}
        />
      </div>
    </UiProvider>
  );
}

const meta = {
  title: "Lanes/UxBanking/BankAccounts",
  component: Harness,
} satisfies Meta<typeof Harness>;
export default meta;
type Story = StoryObj<typeof meta>;

/** One bank, working: where each account goes in the books, what waits and what the books hold. */
export const Working: Story = { args: { groups: [ramp] } };
/** Just back from the bank: one account is in the books already; the other could be one the books hold, and asks. */
export const JustConnected: Story = { args: { groups: [justConnected] } };
/** A bank that wants the person to sign in again: its rule is orange, and it holds the one action. */
export const NeedsSignIn: Story = { args: { groups: [chase, ramp] } };
/** No bank yet: one sentence and the two ways to bring transactions in. */
export const Empty: Story = { args: {} };
/** A person who may only look. */
export const Member: Story = { args: { groups: [chase, ramp], member: true } };
export const EmptyMember: Story = { args: { member: true } };
