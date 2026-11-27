import type { Meta, StoryObj } from "storybook-solidjs-vite";
import { Button, Details, DetailsList, Notice, type DetailsItem } from "../../src";
import { FINGERPRINT, Frame, darkUnlessAsked } from "./frame";

const reportFacts: DetailsItem[] = [
  { label: "Book revision", value: "24" },
  { label: "Fingerprint", value: FINGERPRINT, mono: true, copy: true },
  { label: "Basis", value: "Cash" },
  { label: "Compiler version", value: "2026.10.1", mono: true },
];

const entryFacts: DetailsItem[] = [
  { label: "Revision", value: "7" },
  { label: "Sequence", value: "23" },
  {
    label: "Source event",
    value: "stripe:payout:po_1Qx7hVLk3d9Wm2Zt",
    mono: true,
    copy: true,
    copyLabel: "source event",
  },
  { label: "Fingerprint", value: FINGERPRINT, mono: true, copy: true },
];

const longFacts: DetailsItem[] = [
  {
    label: "Source identity for the duplicate protection of this imported statement line",
    value: `statement-line-${"0123456789abcdef".repeat(12)}`,
    mono: true,
    copy: true,
    copyLabel: "source identity",
  },
  { label: "Fingerprint", value: FINGERPRINT, mono: true, copy: true },
  {
    label: "Note",
    value:
      "Imported from a file whose name is longer than the column it is shown in, and which a person may need to find again later.",
  },
];

function DetailsDemo(props: {
  summary?: string;
  preview?: string;
  copy?: { value: string; label?: string };
  open?: boolean;
  items?: DetailsItem[];
  width?: string;
  label?: string;
  children?: import("solid-js").JSX.Element;
  /** A second, closed fold inside this one. */
  nested?: boolean;
}) {
  return (
    <Frame
      {...(props.width ? { width: props.width } : {})}
      {...(props.label ? { label: props.label } : {})}
    >
      <Details
        summary={props.summary ?? "Details"}
        {...(props.preview ? { preview: props.preview } : {})}
        {...(props.copy ? { copy: props.copy } : {})}
        defaultOpen={props.open ?? false}
      >
        {props.nested ? (
          <>
            <p>Learned from 10 transactions across 7 accounts.</p>
            <Details summary="By account" preview="7 accounts">
              <DetailsList items={reportFacts} />
            </Details>
          </>
        ) : (
          (props.children ?? <DetailsList items={props.items ?? entryFacts} />)
        )}
      </Details>
    </Frame>
  );
}

const meta = {
  title: "Lanes/UXKit/Details",
  component: DetailsDemo,
  parameters: { layout: "fullscreen", a11y: { test: "error" } },
} satisfies Meta<typeof DetailsDemo>;
export default meta;
type Story = StoryObj<typeof meta>;

/** Closed, as a page ships it: a hairline, the label, and the one fact people look for beside it with a
 * Copy button. The hash is not on the surface; one click opens the rest. */
export const Default: Story = {
  args: {
    summary: "Report details",
    preview: "Book revision 24 · fingerprint 61e985c0…",
    copy: { value: FINGERPRINT, label: "fingerprint" },
    items: reportFacts,
    label: "Reports: the proof stays, one click away.",
  },
};

/** Open: every fact with its label, set in the monospaced face when it is a key, with a Copy button for
 * the ones worth taking away. */
export const Open: Story = { args: { open: true, items: entryFacts } };

/** A fold inside an open fold: the inner one is closed and looks closed, its chevron pointing along. */
export const Nested: Story = {
  args: {
    open: true,
    summary: "Suggested accounts",
    nested: true,
  },
};

/** Nothing recorded: say so in a sentence, not an empty box. */
export const Empty: Story = {
  render: () => (
    <DetailsDemo open>
      <p class="rt-hint">Nothing more is recorded for this transaction.</p>
    </DetailsDemo>
  ),
};

/** While the facts are being read the disclosure is open and says so, politely. */
export const Loading: Story = {
  render: () => (
    <DetailsDemo open>
      <p class="rt-hint" role="status">
        Reading the details…
      </p>
    </DetailsDemo>
  ),
};

/** A read that failed is a problem, with a way to try again; it is not an empty list. */
export const ErrorState: Story = {
  render: () => (
    <DetailsDemo open>
      <Notice tone="problem" title="The details could not be read" role="alert">
        Nothing was changed.
        <div style={{ "margin-top": "0.5rem" }}>
          <Button label="Try again" variant="secondary" size="sm" />
        </div>
      </Notice>
    </DetailsDemo>
  ),
};

/** A key with no spaces and a label longer than its column wrap inside the page instead of widening it,
 * and a narrow column stacks the label over the value. */
export const LongContent: Story = {
  args: { open: true, items: longFacts, width: "22rem", summary: "Details" },
};

/** The dark theme. */
export const Dark: Story = {
  args: {
    open: true,
    items: entryFacts,
    summary: "Details",
    preview: "Revision 7",
    copy: { value: FINGERPRINT, label: "fingerprint" },
  },
  decorators: [darkUnlessAsked],
};
