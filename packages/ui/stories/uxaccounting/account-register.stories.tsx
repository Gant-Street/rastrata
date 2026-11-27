import { createSignal, type JSX } from "solid-js";
import type { Meta, StoryObj } from "storybook-solidjs-vite";
import {
  AccountRegister,
  type AccountRegisterData,
  type AccountRegisterRow,
  PageHeader,
  UiProvider,
} from "../../src";

function Frame(props: { children: JSX.Element }): JSX.Element {
  return (
    <UiProvider locale="en-US">
      <div class="rt-theme rt-acct-page" style={{ padding: "1.5rem", "max-width": "78rem" }}>
        {props.children}
      </div>
    </UiProvider>
  );
}

const row = (
  sequence: number,
  date: string,
  narration: string,
  debit: string,
  credit: string,
  running: string,
): AccountRegisterRow => ({
  journalId: `journal-${sequence}`,
  postingId: `posting-${sequence}`,
  date,
  narration,
  postingSequence: String(sequence),
  debit,
  credit,
  runningBalance: running,
});

const ROWS: AccountRegisterRow[] = [
  row(1, "2026-03-01", "Opening balances", "12000.00", "0.00", "12000.00"),
  row(2, "2026-03-20", "LINEAR ORBIT", "0.00", "19.00", "11981.00"),
  row(3, "2026-03-20", "PERSONAL GROCERY MARKET", "0.00", "48.76", "11932.24"),
  row(
    4,
    "2026-03-21",
    "Stripe payout po_1Nxyz to Business checking",
    "1420.12",
    "0.00",
    "13352.36",
  ),
  row(6, "2026-03-22", "Tools purchase entered twice by mistake", "0.00", "75.00", "13277.36"),
  row(
    8,
    "2026-03-23",
    "Reversal of journal-6: Entered twice by mistake",
    "75.00",
    "0.00",
    "13352.36",
  ),
  // An entry that is not on this page is named without its identifier.
  row(
    9,
    "2026-03-24",
    "Reversal of source-0df97b9f28718c3c77df091eb7b13076a9bab47b2bab15d606a8d219f7faa224: Wrong account",
    "48.76",
    "0.00",
    "13401.12",
  ),
];

const DATA: AccountRegisterData = {
  account: { name: "Business checking" },
  currency: "USD",
  from: "2026-03-01",
  to: "2026-03-31",
  balanceKind: "cumulative",
  openingBalance: "0.00",
  closingBalance: "13352.36",
  totalDebit: "13495.12",
  totalCredit: "142.76",
  count: ROWS.length,
  page: 1,
  pageSize: 25,
  rows: ROWS,
};

function Register(props: { data?: Partial<AccountRegisterData>; ledger?: boolean }) {
  const [said, setSaid] = createSignal("");
  const data = (): AccountRegisterData => ({ ...DATA, ...props.data });
  return (
    <Frame>
      <PageHeader
        title="Business checking"
        description={
          props.ledger
            ? undefined
            : "13,352.36 in your books · Bank says 13,401.12 as of Mar 24, 2026 · 2 to review"
        }
        back={{ label: "Accounts", href: "/accounts" }}
      />
      <AccountRegister
        data={data()}
        entryHref={(id) => `/journal/${id}`}
        onPage={(page) => setSaid(`Page ${page} in this preview.`)}
        columns={props.ledger ? "ledger" : "money"}
      />
      <p role="status" class="rt-hint">
        {said()}
      </p>
    </Frame>
  );
}

const meta = {
  title: "Lanes/UXAccounting/Account register",
  component: Register,
  parameters: {
    layout: "fullscreen",
    docs: {
      description: {
        component:
          "An account's transactions: Date, Description, the two amounts (Spent and Received for a bank or card account, Debit and Credit for any other) and a running balance, with the balance before the period and the totals. An amount that is nothing on a line is left blank, and a reversal reads in words. On a phone a transaction is two lines.",
      },
    },
  },
} satisfies Meta<typeof Register>;

export default meta;
type Story = StoryObj<typeof meta>;

export const Default: Story = {};

/** An account that is not a bank or card account says Debit and Credit, and has no line under its name. */
export const FiscalYearToDate: Story = {
  args: {
    ledger: true,
    data: {
      account: { name: "Software and subscriptions" },
      balanceKind: "fiscalYearToDate",
      openingBalance: "0.00",
      closingBalance: "19.00",
      totalDebit: "19.00",
      totalCredit: "0.00",
      count: 1,
      rows: [row(2, "2026-03-20", "LINEAR ORBIT", "19.00", "0.00", "19.00")],
    },
  },
};

export const NothingInThePeriod: Story = {
  args: {
    data: {
      from: "2026-06-01",
      to: "2026-06-30",
      openingBalance: "13352.36",
      closingBalance: "13352.36",
      totalDebit: "0.00",
      totalCredit: "0.00",
      count: 0,
      rows: [],
    },
  },
};

export const SecondPage: Story = {
  args: {
    data: {
      count: 40,
      page: 2,
      pageSize: 25,
      rows: ROWS.slice(0, 3),
    },
  },
};
