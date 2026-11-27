import { createMemo, createSignal, Index, onCleanup, onMount } from "solid-js";
import type { Meta, StoryObj } from "storybook-solidjs-vite";
import { AccountPicker, accountOptions, Button, type AccountRowLike } from "../../src";
import { darkUnlessAsked, Frame } from "./frame";

/** What `accounts.list` returns, trimmed to what a picker reads: the chart of a small business, with
 * "Operating expenses" a group (three accounts sit under it) and two accounts called "Professional
 * services" that only their parents tell apart. */
const chart: AccountRowLike[] = [
  { id: "bank", code: "1000", name: "Business checking", role: "asset" },
  { id: "savings", code: "1010", name: "Business savings", role: "asset" },
  { id: "stripe", code: "1050", name: "Stripe balance", role: "asset" },
  { id: "card", code: "2100", name: "Business credit card", role: "liability" },
  { id: "equity", code: "3000", name: "Owner's equity", role: "equity" },
  { id: "draw", code: "3100", name: "Owner's draw", role: "equity" },
  { id: "sales", code: "4000", name: "Sales", role: "income" },
  { id: "interest", code: "4900", name: "Interest income", role: "income" },
  { id: "opex", code: "6000", name: "Operating expenses", role: "expense" },
  { id: "office", code: "6100", name: "Office supplies", role: "expense", parentId: "opex" },
  {
    id: "software",
    code: "6200",
    name: "Software and subscriptions",
    role: "expense",
    parentId: "opex",
  },
  { id: "dom", code: "6300", name: "Domestic operations", role: "expense", parentId: "opex" },
  { id: "pro-dom", code: "6310", name: "Professional services", role: "expense", parentId: "dom" },
  { id: "intl", code: "6400", name: "International operations", role: "expense", parentId: "opex" },
  {
    id: "pro-intl",
    code: "6410",
    name: "Professional services",
    role: "expense",
    parentId: "intl",
  },
  { id: "legacy", code: "6900", name: "Legacy expenses", role: "expense", closedOn: "2025-12-31" },
];

function PickerDemo(props: {
  id?: string;
  allLabel?: string;
  rows?: AccountRowLike[];
  value?: string;
  allowGroups?: boolean;
  create?: boolean;
  required?: boolean;
  hideLabel?: boolean;
  compact?: boolean;
  error?: string;
  state?: "ready" | "loading" | "error";
  label?: string;
  width?: string;
  disabled?: boolean;
}) {
  const [value, setValue] = createSignal(props.value ?? "");
  const [asked, setAsked] = createSignal<string | undefined>();
  const options = createMemo(() => accountOptions(props.rows ?? chart));
  return (
    <Frame width={props.width ?? "30rem"}>
      <AccountPicker
        accounts={options()}
        value={value()}
        onChange={setValue}
        {...(props.id ? { id: props.id } : {})}
        {...(props.allLabel ? { allLabel: props.allLabel } : {})}
        {...(props.label ? { label: props.label } : {})}
        {...(props.error ? { error: props.error } : {})}
        {...(props.state ? { state: props.state } : {})}
        {...(props.allowGroups ? { allowGroups: true } : {})}
        {...(props.required ? { required: true } : {})}
        {...(props.hideLabel ? { hideLabel: true } : {})}
        {...(props.compact ? { compact: true } : {})}
        {...(props.disabled ? { disabled: true } : {})}
        {...(props.create ? { onCreate: (typed: string) => setAsked(typed) } : {})}
      />
      <div class="rt-stack" style={{ "margin-top": "1rem" }}>
        <output class="rt-hint" aria-label="Chosen account">
          {value() ? `Chosen: ${value()}` : "Nothing chosen."}
        </output>
        <output class="rt-hint" aria-label="New account requested">
          {asked() === undefined
            ? "No new account requested."
            : `New account requested${asked() ? `: ${asked()}` : "."}`}
        </output>
        <div style={{ display: "flex", gap: "0.5rem" }}>
          <Button
            label="Choose Sales"
            variant="secondary"
            size="sm"
            onClick={() => setValue("sales")}
          />
          <Button label="Clear" variant="quiet" size="sm" onClick={() => setValue("")} />
        </div>
      </div>
    </Frame>
  );
}

const meta = {
  title: "Lanes/UXKit/AccountPicker",
  component: PickerDemo,
  parameters: { layout: "fullscreen", a11y: { test: "error" } },
} satisfies Meta<typeof PickerDemo>;
export default meta;
type Story = StoryObj<typeof meta>;

/** Type a name, a code or where it sits, in any order ("pro intl", "6100"); the name is first and the code
 * muted after it. Operating expenses, which holds other accounts, is not offered: nothing is posted to a
 * group. Closed accounts are listed and say why they cannot be chosen. */
export const Default: Story = { args: {} };

/** With a way to add one: "New account…" ends the list, also when nothing matches, and is called with what
 * was typed so the form it opens can start with that as the name. */
export const WithNewAccount: Story = { args: { create: true, value: "bank" } };

/** A group account is offered when the picker is asked to, for a report filter where a group stands for
 * everything under it. */
export const AllowGroups: Story = { args: { allowGroups: true } };

/** A chosen account shows its code and where it sits under the box. */
export const Chosen: Story = { args: { value: "pro-intl" } };

/** A book with no accounts says so, and still offers to add one. */
export const Empty: Story = { args: { rows: [], create: true } };

/** While the chart is being read the list says so; nothing is offered that has not been read. */
export const Loading: Story = { args: { state: "loading" } };

/** A chart that could not be read says so, and is not the same as "no match". */
export const ErrorState: Story = { args: { state: "error" } };

/** What is wrong with the choice, said beside the field and read out with it. */
export const Invalid: Story = {
  args: { error: "Choose an account for this line.", required: true },
};

/** Long names wrap inside a phone-width column and never widen the page. */
export const LongContent: Story = {
  args: {
    width: "20rem",
    value: "long",
    rows: [
      ...chart.slice(0, 4),
      {
        id: "long",
        code: "6555",
        name: "Pneumonoultramicroscopicsilicovolcanoconiosis Professional Consulting Services Incorporated",
        role: "expense",
        parentId: "opex",
      },
      {
        id: "opex",
        code: "6000",
        name: "Operating expenses with a rather long name",
        role: "expense",
      },
    ],
  },
};

/** Where a column heading already names it (a line of a journal), the label is kept for assistive technology. */
export const HiddenLabel: Story = { args: { hideLabel: true, label: "Account for line 1" } };

function JournalLines() {
  const options = accountOptions(chart);
  const [lines, setLines] = createSignal(["bank", ""]);
  return (
    <Frame width="48rem">
      <table class="rt-table" style={{ "table-layout": "fixed" }}>
        <caption class="rt-sr-only">Lines of a journal entry</caption>
        <thead>
          <tr>
            <th scope="col" style={{ width: "55%" }}>
              Account
            </th>
            <th scope="col" class="amount">
              Debit
            </th>
            <th scope="col" class="amount">
              Credit
            </th>
          </tr>
        </thead>
        <tbody>
          {/* Rows by position, so choosing an account does not make the rows anew: the picker that has
              focus is the one that stays, as on a screen whose lines are kept. */}
          <Index each={lines()}>
            {(line, index) => (
              <tr>
                <td>
                  <AccountPicker
                    compact
                    hideLabel
                    label={`Account for line ${index + 1}`}
                    accounts={options}
                    value={line()}
                    onCreate={() => undefined}
                    onChange={(value) =>
                      setLines((all) => all.map((item, at) => (at === index ? value : item)))
                    }
                  />
                </td>
                <td class="amount">
                  <input
                    class="rt-input"
                    inputmode="decimal"
                    aria-label={`Debit for line ${index + 1}`}
                  />
                </td>
                <td class="amount">
                  <input
                    class="rt-input"
                    inputmode="decimal"
                    aria-label={`Credit for line ${index + 1}`}
                  />
                </td>
              </tr>
            )}
          </Index>
        </tbody>
      </table>
    </Frame>
  );
}

/** In a dense row (a line of a journal): the label is for assistive technology only, nothing sits under the
 * box, and it fills its cell. Type a name or a code, Enter or a click chooses. */
export const Compact: Story = { render: () => <JournalLines /> };

/** An account that was chosen and is no longer in the chart is kept and said, even in a dense row where
 * nothing else sits under the box: that is not a detail, it is a warning. */
export const CompactUnavailable: Story = {
  args: {
    compact: true,
    hideLabel: true,
    label: "Account for line 3",
    value: "removed-account-7100",
  },
};

function LateDemo() {
  const [rows, setRows] = createSignal<AccountRowLike[]>([]);
  const [state, setState] = createSignal<"loading" | "ready">("loading");
  onMount(() => {
    const timer = setTimeout(() => {
      setRows(chart);
      setState("ready");
    }, 800);
    onCleanup(() => clearTimeout(timer));
  });
  return (
    <Frame width="30rem">
      <AccountPicker accounts={accountOptions(rows())} state={state()} value="sales" />
    </Frame>
  );
}

/** A saved line is on screen before the chart has been read: the box does not say the account is gone while
 * the chart is being read, and shows its name when the chart arrives. */
export const LateAccounts: Story = { render: () => <LateDemo /> };

function OnMountDemo() {
  const [value, setValue] = createSignal("");
  // A parent that sets the value as it mounts: after the picker is made, before the picker first runs.
  onMount(() => setValue("sales"));
  return (
    <Frame width="30rem">
      <AccountPicker accounts={accountOptions(chart)} value={value()} onChange={setValue} />
      <output class="rt-hint" aria-label="Chosen account">
        {value() ? `Chosen: ${value()}` : "Nothing chosen."}
      </output>
    </Frame>
  );
}

/** A value set in the same tick the picker is made (a dialog applying a preset as it opens, a form filled as it
 * mounts) is shown: the box says the account's name and the list marks it as the chosen one. */
export const ValueSetOnMount: Story = { render: () => <OnMountDemo /> };

/** A filter: "All accounts" heads the list and is what the box says while nothing is chosen. Choosing it
 * clears the choice (`onChange("")`), so a filter can be cleared and a cleared one reads as what it is. Nothing
 * says "choose a posting account", because a filter is not a posting. */
export const AllAccounts: Story = { args: { allLabel: "All accounts" } };

/** A screen that links to the field by id (an error summary's link focuses it) gives the box its id; the
 * label's `for` follows it, so the label still names the field. */
export const WithId: Story = { args: { id: "paid-from", label: "Paid from", required: true } };

/** The dark theme. */
export const Dark: Story = {
  args: { create: true, value: "software" },
  decorators: [darkUnlessAsked],
};
