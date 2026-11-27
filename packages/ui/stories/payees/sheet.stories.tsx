import { createSignal, Show } from "solid-js";
import type { Meta, StoryObj } from "storybook-solidjs-vite";
import { Button, PayeeSheet, type PayeeDetailData, type PayeeSubject } from "../../src";
import {
  ambiguousDetail,
  amazon,
  byHandDetail,
  emptyDetail,
  longDetail,
  LONG_WORD,
  stripeDetail,
  unnamedDetail,
} from "./fixtures";
import { Frame } from "./frame";

const noop = () => undefined;

function Demo(props: {
  subject: PayeeSubject;
  detail: PayeeDetailData | undefined;
  loading?: boolean;
  failure?: string;
}) {
  const [open, setOpen] = createSignal(true);
  return (
    <Frame>
      <Button label="Open the sheet" onClick={() => setOpen(true)} />
      <Show when={open()}>
        <PayeeSheet
          subject={props.subject}
          detail={props.detail}
          loading={props.loading}
          failure={props.failure}
          onRetry={noop}
          onPage={noop}
          entryHref={(id) => `/journal/${id}`}
          onChange={noop}
          onName={noop}
          taxHref="/tax?tab=vendors"
          onClose={() => setOpen(false)}
        />
      </Show>
    </Frame>
  );
}

const meta = {
  title: "Lanes/Payees/Transactions of a row",
  parameters: { layout: "padded", controls: { disable: true } },
} satisfies Meta;
export default meta;
type Story = StoryObj<typeof meta>;

/** A payee: the words that find it, what was recorded, its earlier versions, and a page of its transactions,
 * each leading to its entry. */
export const Payee: Story = {
  render: () => (
    <Demo
      subject={{ kind: "payee", payeeId: "pay_stripe", label: "Stripe" }}
      detail={stripeDetail}
    />
  ),
};

/** A 1099 vendor is a payee: the sheet says so and leads to the vendors. */
export const PayeeThatIsAVendor: Story = {
  render: () => (
    <Demo
      subject={{ kind: "payee", payeeId: "pay_stripe", label: "Stripe" }}
      detail={{
        ...stripeDetail,
        payee: stripeDetail.payee ? { ...stripeDetail.payee, hasTaxDetails: true } : null,
      }}
    />
  ),
};

/** A text nobody has named, with a button to name a payee from it. */
export const NotNamedYet: Story = {
  render: () => (
    <Demo
      subject={{
        kind: "unnamed",
        key: "sq blue bottle coffee #",
        label: "SQ *BLUE BOTTLE COFFEE 1234",
        suggestedWords: "blue bottle coffee",
      }}
      detail={unnamedDetail}
    />
  ),
};

/** A text two payees match equally: each can be changed from here. */
export const MatchedByTwoPayees: Story = {
  render: () => (
    <Demo
      subject={{
        kind: "ambiguous",
        key: "amazon mktplace amzn",
        label: "AMAZON MKTPLACE AMZN",
        payees: amazon.payees,
      }}
      detail={ambiguousDetail}
    />
  ),
};

export const EnteredByHand: Story = {
  render: () => (
    <Demo
      subject={{ kind: "no_payee", why: "by_hand", label: "Entered by hand" }}
      detail={byHandDetail}
    />
  ),
};

export const Loading: Story = {
  render: () => (
    <Demo
      subject={{ kind: "payee", payeeId: "pay_stripe", label: "Stripe" }}
      detail={undefined}
      loading
    />
  ),
};

export const Failed: Story = {
  render: () => (
    <Demo
      subject={{ kind: "payee", payeeId: "pay_stripe", label: "Stripe" }}
      detail={undefined}
      failure="The service could not be reached."
    />
  ),
};

export const NoTransactions: Story = {
  render: () => (
    <Demo
      subject={{ kind: "payee", payeeId: "pay_stripe", label: "Stripe" }}
      detail={emptyDetail}
    />
  ),
};

/** Text with no spaces, a long account name and markup in a bank's text: shown as text, wrapped. */
export const LongText: Story = {
  render: () => (
    <Demo
      subject={{ kind: "unnamed", key: "long", label: LONG_WORD, suggestedWords: "" }}
      detail={longDetail}
    />
  ),
};
