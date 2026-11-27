import { createSignal, type JSX } from "solid-js";
import type { Meta, StoryObj } from "storybook-solidjs-vite";
import { QuickEntryDialog, type QuickAccount, type QuickKind, UiProvider } from "../../src";
import { chart, longChart } from "./fixtures";

/** Spend money, Receive money and Transfer: one dialog for the three. "+ New, Transaction" opens it as "New
 * transaction" with a switch for the kind at its top (`switchable`); without the switch it is one kind.
 * Each is an ordinary two-line entry. The line under the fields says what it will record in plain words,
 * and Post is the only thing that changes the books. */
function Harness(props: {
  kind: QuickKind;
  switchable?: boolean;
  accounts?: readonly QuickAccount[] | undefined;
  failed?: boolean;
  pending?: "post" | "draft";
  error?: string;
  uncertain?: boolean;
  preset?: "owner-in" | "owner-out";
  today?: string | undefined;
  dir?: "rtl";
  gap?: JSX.Element;
}) {
  const [open, setOpen] = createSignal(true);
  const [kind, setKind] = createSignal(props.kind);
  const close = () => setOpen(false);
  return (
    <UiProvider locale="en-US">
      <div class="rt-theme" dir={props.dir}>
        {!open() && (
          <p class="rt-hint" role="status">
            The dialog is closed. Choose the story again to see it open.
          </p>
        )}
        <QuickEntryDialog
          kind={props.switchable ? kind() : props.kind}
          {...(props.switchable ? { onKind: setKind } : {})}
          open={open()}
          onClose={close}
          accounts={props.accounts}
          today={props.today}
          {...(props.failed ? { failed: true } : {})}
          {...(props.pending ? { pending: props.pending } : {})}
          {...(props.error ? { error: props.error } : {})}
          {...(props.uncertain ? { uncertain: true } : {})}
          {...(props.preset ? { preset: props.preset } : {})}
          {...(props.gap ? { gap: props.gap } : {})}
          onPost={close}
          onSaveDraft={close}
        />
      </div>
    </UiProvider>
  );
}

const meta = {
  title: "Lanes/UXEntries/QuickEntry",
  component: Harness,
  parameters: { layout: "padded", a11y: { test: "error" } },
} satisfies Meta<typeof Harness>;
export default meta;
type Story = StoryObj<typeof meta>;

/** "+ New, Transaction": the one form, opened on Spend money, with the switch for its kind. Changing the
 * kind keeps the date, the amount and the description, and the account the money moved through. */
export const Transaction: Story = {
  args: { kind: "spend", switchable: true, accounts: chart, today: "2026-10-04" },
};

/** Record money you paid out. The date starts at today; the accounts are your bank, card and cash accounts
 * to pay from, and expenses to put it under. */
export const SpendMoney: Story = { args: { kind: "spend", accounts: chart, today: "2026-10-04" } };

/** Receive money: the category is where the money came from (income first) and the deposit goes to a bank
 * account. */
export const ReceiveMoney: Story = {
  args: { kind: "receive", accounts: chart, today: "2026-10-04" },
};

/** A transfer is between two accounts of your own: from one, to another. */
export const Transfer: Story = { args: { kind: "transfer", accounts: chart, today: "2026-10-04" } };

/** The sole proprietor's commonest event: the owner took money out. The category is the owner's draw
 * account, the description is filled in, and the preview says the draw goes down as the bank does. */
export const OwnerTookMoneyOut: Story = {
  args: { kind: "spend", accounts: chart, today: "2026-10-04", preset: "owner-out" },
};

export const OwnerPutMoneyIn: Story = {
  args: { kind: "receive", accounts: chart, today: "2026-10-04", preset: "owner-in" },
};

/** None of the accounts is named for the preset: it says so and leaves the choice to the person. */
export const PresetWithoutAnAccount: Story = {
  args: {
    kind: "spend",
    accounts: chart.filter((account) => account.role !== "equity"),
    today: "2026-10-04",
    preset: "owner-out",
  },
};

export const Loading: Story = { args: { kind: "spend", accounts: undefined, today: undefined } };

export const LoadFailed: Story = {
  args: { kind: "spend", accounts: undefined, failed: true, today: undefined },
};

export const NoAccounts: Story = { args: { kind: "spend", accounts: [], today: "2026-10-04" } };

/** The save is under way: both buttons wait and the fields cannot change. */
export const Posting: Story = {
  args: { kind: "spend", accounts: chart, today: "2026-10-04", pending: "post" },
};

export const SavingADraft: Story = {
  args: { kind: "receive", accounts: chart, today: "2026-10-04", pending: "draft" },
};

/** The books turned the entry down: their own words, and nothing was posted. */
export const Refused: Story = {
  args: {
    kind: "spend",
    accounts: chart,
    today: "2026-03-20",
    error:
      "March 2026 (Mar 1, 2026 to Mar 31, 2026) is closed, so nothing can be posted into it. Reopen March 2026 first, post, then close it again.",
  },
};

/** A date before the book's first day: the books' own words, and the form stays as it was. */
export const BeforeTheBooks: Story = {
  args: {
    kind: "spend",
    accounts: chart,
    today: "2026-10-04",
    error:
      "Dec 30, 2025 is before the first day of the book's fiscal calendar. The book's fiscal calendar covers Jan 1, 2026 to Dec 31, 2026. A book cannot be posted to before its first period, and that date is fixed when the book is created; post on or after Jan 1, 2026.",
  },
};

/** A reply was lost: the original request is resumed, and nothing is sent twice. */
export const ReplyLost: Story = {
  args: { kind: "spend", accounts: chart, today: "2026-10-04", uncertain: true },
};

/** Long account names and a long chart: the dialog scrolls inside itself and never sideways. */
export const LongNames: Story = {
  args: { kind: "spend", accounts: longChart, today: "2026-10-04" },
};

export const RightToLeft: Story = {
  args: { kind: "transfer", accounts: chart, today: "2026-10-04", dir: "rtl" },
};
