import { createSignal, type JSX } from "solid-js";
import type { Meta, StoryObj } from "storybook-solidjs-vite";
import {
  type AccountView,
  BankRows,
  type ChartGroupId,
  ChartGroups,
  EditAccountDrawer,
  type EditAccountValues,
  groupAccounts,
  ListSearch,
  NewAccountDrawer,
  type NewAccountValues,
  openAtRest,
  searchAccounts,
  suggestCode,
  UiProvider,
} from "../../src";
import { card, checking, links, stripeIdle } from "../uxbanking/fixtures";

function Frame(props: { children: JSX.Element }): JSX.Element {
  return (
    <UiProvider locale="en-US">
      <div class="rt-theme rt-acct-page" style={{ padding: "1.5rem", "max-width": "78rem" }}>
        {props.children}
      </div>
    </UiProvider>
  );
}

const view = (
  code: string,
  name: string,
  role: string,
  balance: string,
  more: Partial<AccountView> = {},
): AccountView => ({
  id: `acct-${code}`,
  code,
  name,
  role,
  parentCode: null,
  openedOn: "2026-03-01",
  closedOn: null,
  balance,
  tags: {},
  ...more,
});

const accounts: AccountView[] = [
  view("1000", "Business checking", "asset", "12400.50", { tags: { cashFlowClass: "cash" } }),
  view("1010", "Business savings", "asset", "5000.00", { tags: { cashFlowClass: "cash" } }),
  view("1100", "Stripe balance", "asset", "320.00", {
    tags: { cashFlowClass: "operating", roleKey: "stripe.balance" },
  }),
  view("1500", "Equipment and computers", "asset", "2400.00"),
  view("2000", "Business credit card", "liability", "-640.25", {
    tags: { cashFlowClass: "operating" },
  }),
  view("3000", "Owner's investment", "equity", "-12000.00"),
  view("3100", "Owner's draw", "equity", "48.76"),
  view("4000", "Sales", "income", "-1420.12", { tags: { taxLine: "scheduleC.line1" } }),
  view("6200", "Software and subscriptions", "expense", "19.00", {
    tags: { taxLine: "scheduleC.line18" },
  }),
  view("6290", "Other expenses", "expense", "0.00"),
  view("6280", "Old account", "expense", "0.00", { closedOn: "2026-01-31" }),
];
const taxLineText = (id: string) =>
  id === "scheduleC.line1"
    ? "Schedule C line 1 · Gross receipts or sales"
    : id === "scheduleC.line18"
      ? "Schedule C line 18 · Office expense"
      : undefined;

/** Balances add up in cents: the stories have no service to do the sum. */
const total = (rows: readonly AccountView[]): string => {
  const cents = rows.reduce((sum, row) => sum + Math.round(Number(row.balance) * 100), 0);
  return (cents / 100).toFixed(2);
};

function Chart(props: { empty?: boolean; open?: readonly ChartGroupId[]; width?: string }) {
  const rows = () =>
    props.empty ? accounts.map((account) => ({ ...account, balance: "0.00" })) : accounts;
  const [query, setQuery] = createSignal("");
  const [said, setSaid] = createSignal("");
  const groups = () => groupAccounts(searchAccounts(rows(), query(), taxLineText));
  const [open, setOpen] = createSignal<readonly ChartGroupId[] | undefined>(props.open);
  const opened = () => open() ?? openAtRest(groups());
  const [full, setFull] = createSignal<readonly ChartGroupId[]>([]);
  return (
    <Frame>
      <div style={{ "max-width": props.width ?? "none" }}>
        <section class="rt-accounts-section" aria-labelledby="story-bank-title">
          <div class="rt-accounts-section-head">
            <h2 id="story-bank-title" class="rt-accounts-section-title">
              Bank and cards
            </h2>
          </div>
          <BankRows
            label="Bank and cards"
            tiles={props.empty ? [stripeIdle] : [checking, card, stripeIdle]}
            links={links}
            onReconcile={(tile) => setSaid(`Reconcile ${tile.name}`)}
          />
        </section>
        <section class="rt-accounts-section" aria-labelledby="story-chart-title">
          <div class="rt-accounts-section-head">
            <h2 id="story-chart-title" class="rt-accounts-section-title">
              Chart of accounts
            </h2>
            <ListSearch
              label="Search accounts"
              placeholder="Search accounts"
              value={query()}
              onInput={setQuery}
            />
          </div>
          {groups().length === 0 ? (
            <p role="status">No accounts match</p>
          ) : (
            <ChartGroups
              groups={groups()}
              total={(group) => total(group.accounts)}
              open={opened()}
              onToggle={(id, isOpen) =>
                setOpen(
                  isOpen ? [...new Set([...opened(), id])] : opened().filter((kind) => kind !== id),
                )
              }
              full={full()}
              onFull={(id, isFull) =>
                setFull(isFull ? [...full(), id] : full().filter((kind) => kind !== id))
              }
              searching={query().trim() !== ""}
              accountHref={(account) => `/ledger?accountId=${account.id}`}
            />
          )}
        </section>
      </div>
      <p role="status" class="rt-hint">
        {said()}
      </p>
    </Frame>
  );
}

const taxLines = [
  { value: "scheduleC.line18", label: "Schedule C · Line 18 · Office expense" },
  { value: "scheduleC.line25", label: "Schedule C · Line 25 · Utilities" },
];

type NewPreview = Partial<NewAccountValues> & {
  stage?: "compose" | "working" | "review";
  warnings?: string[];
  problems?: string[];
  error?: string;
};

function NewAccount(props: NewPreview) {
  const [open, setOpen] = createSignal(true);
  const [values, setValues] = createSignal<NewAccountValues>({
    name: props.name ?? "",
    kind: props.kind ?? "expense",
    code: props.code ?? suggestCode(accounts, props.kind ?? "expense"),
    parentId: "",
    effectiveOn: "2026-03-21",
    cashFlowClass: "",
    taxLine: "",
    roleKey: "",
  });
  const [typed, setTyped] = createSignal(props.code !== undefined);
  const [said, setSaid] = createSignal("");
  return (
    <Frame>
      <button
        type="button"
        class="rt-button"
        data-variant="secondary"
        tabindex="-1"
        onClick={() => setOpen(true)}
      >
        New account
      </button>
      <p role="status" class="rt-hint">
        {said()}
      </p>
      <NewAccountDrawer
        open={open()}
        values={values()}
        onChange={(patch) =>
          setValues((previous) => {
            const next = { ...previous, ...patch };
            if (patch.code !== undefined) setTyped(true);
            if (patch.kind !== undefined && !typed()) next.code = suggestCode(accounts, patch.kind);
            return next;
          })
        }
        accounts={accounts}
        taxLines={() => taxLines}
        suggestedCode={suggestCode(accounts, values().kind)}
        stage={props.stage ?? "compose"}
        warnings={props.warnings ?? []}
        problems={props.problems ?? []}
        error={props.error}
        onSubmit={() => {
          setSaid(`Adding ${values().code} ${values().name} in this preview.`);
          setOpen(false);
        }}
        onConfirm={() => {
          setSaid("Added anyway in this preview.");
          setOpen(false);
        }}
        onCancel={() => setOpen(false)}
        returnFocus={() => document.querySelector<HTMLElement>("button.rt-button[tabindex]")}
      />
    </Frame>
  );
}

function EditAccount(props: {
  start?: Partial<EditAccountValues>;
  stage?: "compose" | "working" | "review";
  problems?: string[];
}) {
  const [open, setOpen] = createSignal(true);
  const [values, setValues] = createSignal<EditAccountValues>({
    name: "Software and subscriptions",
    close: false,
    effectiveOn: "2026-03-21",
    ...props.start,
  });
  const [said, setSaid] = createSignal("");
  return (
    <Frame>
      <button
        type="button"
        class="rt-button"
        data-variant="secondary"
        tabindex="-1"
        onClick={() => setOpen(true)}
      >
        Edit account
      </button>
      <p role="status" class="rt-hint">
        {said()}
      </p>
      <EditAccountDrawer
        open={open()}
        account={{ name: "Software and subscriptions", code: "6200" }}
        values={values()}
        onChange={(patch) => setValues((previous) => ({ ...previous, ...patch }))}
        stage={props.stage ?? "compose"}
        warnings={[]}
        problems={props.problems ?? []}
        onSubmit={() => {
          setSaid("Saved in this preview.");
          setOpen(false);
        }}
        onConfirm={() => setOpen(false)}
        onCancel={() => setOpen(false)}
      />
    </Frame>
  );
}

const meta = {
  title: "Lanes/UXAccounting/Chart of accounts",
  component: Chart,
  parameters: {
    layout: "fullscreen",
    docs: {
      description: {
        component:
          'Accounts: the bank and card accounts as rows (what the bank says, the balance, Reconcile), then the Chart of accounts folded by kind, each kind with how many accounts it has and what they add up to. An open kind lists the accounts that hold something; the rest are counted under it. "New account" and "Edit account" open in a drawer whose footer says what saving will do.',
      },
    },
  },
} satisfies Meta<typeof Chart>;

export default meta;
type Story = StoryObj<typeof meta>;

/** A working book: income and expenses are open because they hold something. */
export const Default: Story = {};
/** Every kind open. */
export const EveryKindOpen: Story = {
  args: { open: ["asset", "liability", "equity", "income", "expense"] },
};
/** A new book: nothing holds anything, so every kind is one closed line. */
export const NewBook: Story = { args: { empty: true } };
/** A phone: a bank row is two lines, and the chart keeps the name and the balance on one. */
export const AtPhoneWidth: Story = { args: { width: "22.5rem" } };

export const NewAccountDrawerOpen: StoryObj = {
  render: () => <NewAccount name="Software" />,
};
export const NewAccountEmpty: StoryObj = { render: () => <NewAccount /> };
export const NewBankAccount: StoryObj = { render: () => <NewAccount kind="bank" name="Savings" /> };
export const NewAccountWarning: StoryObj = {
  render: () => (
    <NewAccount
      name="Software"
      stage="review"
      warnings={["The effective date is in a month that is already closed."]}
    />
  ),
};
export const NewAccountRefused: StoryObj = {
  render: () => (
    <NewAccount
      name="Software"
      code="6200"
      stage="review"
      problems={["Account code 6200 is already used."]}
    />
  ),
};
export const EditAccountDrawerOpen: StoryObj = { render: () => <EditAccount /> };
export const EditAccountClosing: StoryObj = {
  render: () => <EditAccount start={{ close: true }} />,
};
