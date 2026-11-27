import { createSignal, Show } from "solid-js";
import type { Meta, StoryObj } from "storybook-solidjs-vite";
import {
  Button,
  PayeeDrawer,
  type PayeeFormValues,
  type PayeeTestData,
  payeeFormValues,
  payeeNameFormValues,
} from "../../src";
import {
  bottlePayee,
  HASH,
  LONG_WORD,
  testFinds,
  testNothing,
  testRefused,
  testTied,
  vendorPayee,
} from "./fixtures";
import { Frame } from "./frame";

const noop = () => undefined;

function Demo(props: {
  mode: "name" | "edit";
  from?: string;
  initial: PayeeFormValues;
  test?: PayeeTestData | undefined;
  checking?: boolean;
  checkFailed?: boolean;
  saving?: boolean;
  failure?: string;
  uncertain?: boolean;
  hasTaxDetails?: boolean;
  /** Work out what the typed words find, as the service would, so the story can be tried by hand. */
  live?: boolean;
}) {
  const [open, setOpen] = createSignal(true);
  const [typed, setTyped] = createSignal<PayeeTestData | undefined>(props.test);
  const answer = (value: string): PayeeTestData | undefined => {
    const text = value.trim().toLowerCase();
    if (text === "") return undefined;
    if (text.length < 3) return testRefused;
    if (text.includes("amazon")) return testTied;
    return text.includes("blue") ? testFinds : testNothing;
  };
  return (
    <Frame>
      <Button label="Open the sheet" onClick={() => setOpen(true)} />
      <Show when={open()}>
        <PayeeDrawer
          mode={props.mode}
          from={props.from}
          initial={props.initial}
          hasTaxDetails={props.hasTaxDetails}
          test={props.live ? typed() : props.test}
          checking={props.checking}
          checkFailed={props.checkFailed}
          onWords={(value) => props.live && setTyped(answer(value))}
          saving={props.saving}
          failure={props.failure}
          uncertain={props.uncertain}
          onSave={noop}
          onClose={() => setOpen(false)}
        />
      </Show>
    </Frame>
  );
}

const meta = {
  title: "Lanes/Payees/Name and change a payee",
  parameters: { layout: "padded", controls: { disable: true } },
} satisfies Meta;
export default meta;
type Story = StoryObj<typeof meta>;

/** Naming a payee out of what the bank wrote: the name and words are offered, and under the words is what
 * they would find, including the transactions that would move from another payee. Try other words. */
export const NameFromText: Story = {
  render: () => (
    <Demo
      mode="name"
      from="SQ *BLUE BOTTLE COFFEE 1234"
      initial={payeeNameFormValues("blue bottle coffee")}
      test={testFinds}
      live
    />
  ),
};

/** A text that names nobody offers nothing: the person writes the words from what the bank wrote. */
export const NameFromBareText: Story = {
  render: () => (
    <Demo mode="name" from="CHECK 1041" initial={payeeNameFormValues("")} test={undefined} live />
  ),
};

/** The words find nothing in these dates. */
export const WordsFindNothing: Story = {
  render: () => (
    <Demo
      mode="name"
      from="CHIPOTLE 2188"
      initial={{ name: "Chipotle", words: "chipotle grill", note: "", retired: false }}
      test={testNothing}
    />
  ),
};

/** The words tie with another payee's, and a longer one would keep some transactions. */
export const WordsTie: Story = {
  render: () => <Demo mode="edit" initial={payeeFormValues(bottlePayee)} test={testTied} />,
};

/** The service would refuse these words, so Save is not offered and the reasons are said. */
export const WordsRefused: Story = {
  render: () => (
    <Demo
      mode="name"
      from="AB 99"
      initial={{ name: "Ab", words: "ab\nstripe", note: "", retired: false }}
      test={testRefused}
    />
  ),
};

/** Changing a payee that is also a 1099 vendor: its name and words are kept the same there. */
export const ChangeA1099Vendor: Story = {
  render: () => (
    <Demo mode="edit" initial={payeeFormValues(vendorPayee)} test={testFinds} hasTaxDetails />
  ),
};

export const Checking: Story = {
  render: () => (
    <Demo
      mode="name"
      from="SQ *BLUE BOTTLE COFFEE 1234"
      initial={payeeNameFormValues("blue bottle coffee")}
      test={undefined}
      checking
    />
  ),
};

export const CheckFailed: Story = {
  render: () => (
    <Demo
      mode="name"
      from="SQ *BLUE BOTTLE COFFEE 1234"
      initial={payeeNameFormValues("blue bottle coffee")}
      test={undefined}
      checkFailed
    />
  ),
};

/** The service refused the save: what it said is above the form, and every answer stays. */
export const SaveRefused: Story = {
  render: () => (
    <Demo
      mode="name"
      from="SQ *BLUE BOTTLE COFFEE 1234"
      initial={payeeNameFormValues("blue bottle coffee")}
      test={testFinds}
      failure="A payee named Blue Bottle Coffee already exists."
    />
  ),
};

/** The reply to a save was lost: it is not known whether it was saved, so the same request is sent again. */
export const SaveUncertain: Story = {
  render: () => (
    <Demo
      mode="name"
      from="SQ *BLUE BOTTLE COFFEE 1234"
      initial={payeeNameFormValues("blue bottle coffee")}
      test={testFinds}
      uncertain
    />
  ),
};

export const Saving: Story = {
  render: () => (
    <Demo
      mode="name"
      from="SQ *BLUE BOTTLE COFFEE 1234"
      initial={payeeNameFormValues("blue bottle coffee")}
      test={testFinds}
      saving
    />
  ),
};

/** A text with no spaces and a long name: both wrap inside the sheet. */
export const LongText: Story = {
  render: () => (
    <Demo
      mode="name"
      from={LONG_WORD}
      initial={{
        name: `${"Extraordinarily Long Business Name ".repeat(3)}Ltd`,
        words: `${"abcdefghij ".repeat(10)}`,
        note: `A note that goes on. ${HASH}`,
        retired: false,
      }}
      test={testFinds}
    />
  ),
};
