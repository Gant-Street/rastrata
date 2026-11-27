import { createSignal, type JSX } from "solid-js";
import type { Meta, StoryObj } from "storybook-solidjs-vite";
import { Button, ReverseDialog, type ReverseDialogProps, UiProvider } from "../../src";

/** The page the application puts the dialog on. */
function Frame(props: { children: JSX.Element }): JSX.Element {
  return (
    <UiProvider locale="en-US">
      <div class="rt-theme" style={{ padding: "1.5rem" }}>
        {props.children}
      </div>
    </UiProvider>
  );
}

type Preview = Partial<
  Pick<
    ReverseDialogProps,
    | "stage"
    | "warnings"
    | "problems"
    | "error"
    | "uncertain"
    | "description"
    | "dateError"
    | "reasonError"
  >
> & { startDate?: string; startReason?: string };

/** The dialog with a button that opens it again, so Escape and Cancel can be tried. Nothing is sent. */
function Reversing(props: Preview) {
  const [open, setOpen] = createSignal(true);
  const [date, setDate] = createSignal(props.startDate ?? "2026-03-20");
  const [reason, setReason] = createSignal(props.startReason ?? "");
  const [done, setDone] = createSignal("");
  return (
    <Frame>
      {/* Out of the tab order: while the dialog is open the page behind it is hidden from assistive
          technology, and a hidden page may hold nothing a keyboard can reach. Focus still returns to it. */}
      <Button
        label="Reverse No. 22"
        variant="secondary"
        tabIndex={-1}
        onClick={() => setOpen(true)}
      />
      <p role="status" class="rt-hint">
        {done()}
      </p>
      <ReverseDialog
        open={open()}
        label="No. 22"
        description={props.description ?? "LINEAR ORBIT"}
        entryDate="2026-03-20"
        amount="19.00"
        date={date()}
        onDate={setDate}
        reason={reason()}
        onReason={setReason}
        dateError={props.dateError}
        reasonError={props.reasonError}
        stage={props.stage ?? "compose"}
        warnings={props.warnings ?? []}
        problems={props.problems ?? []}
        error={props.error}
        uncertain={props.uncertain}
        onResume={() => {
          setDone("Resumed in this preview.");
          setOpen(false);
        }}
        onSubmit={() => {
          setDone(`Reversal of No. 22 dated ${date()} for “${reason()}” sent in this preview.`);
          setOpen(false);
        }}
        onConfirm={() => {
          setDone("Reversed anyway in this preview.");
          setOpen(false);
        }}
        onCancel={() => setOpen(false)}
        returnFocus={() => document.querySelector<HTMLElement>("button.rt-button")}
      />
    </Frame>
  );
}

const meta = {
  title: "Lanes/UXAccounting/Reverse dialog",
  component: Reversing,
  parameters: {
    layout: "fullscreen",
    docs: {
      description: {
        component:
          "Reversing a transaction: say when and why, and it is posted. The original is never changed; a linked transaction cancels it. When the service has something to say first (an account already reconciled, a date it cannot post to) the dialog shows it and waits for a decision.",
      },
    },
  },
} satisfies Meta<typeof Reversing>;

export default meta;
type Story = StoryObj<typeof meta>;

export const Default: Story = {};
export const MissingReason: Story = {
  args: { reasonError: "Enter a reason.", startReason: "" },
};
export const Working: Story = { args: { stage: "working", startReason: "Entered twice" } };
export const WarningsToRead: Story = {
  args: {
    stage: "review",
    startReason: "Entered twice",
    warnings: [
      "This entry is already reconciled: 1000 Business checking, statement ending 2026-03-31. Reversing it changes what was checked.",
    ],
  },
};
export const CannotBePosted: Story = {
  args: {
    stage: "review",
    startReason: "Entered twice",
    startDate: "2026-02-10",
    problems: [
      "February 2026 is closed (Feb 1 to Feb 28, 2026). Reopen it on Close the books, post the reversal, then close it again.",
    ],
  },
};
export const ReplyLost: Story = {
  args: {
    startReason: "Entered twice",
    uncertain: true,
    error: "The result is uncertain. Resume the original request; do not create a replacement.",
  },
};
export const LongDescription: Story = {
  args: {
    description:
      "Annual renewal of the design software licenses and the support plan for the whole studio, paid by card after the vendor sent a corrected invoice, https://example.invalid/receipts/2026/03/30/7f1c9a0e5d3b4c8f9e2a1b6d4c7e8f90a1b2c3d4e5f6",
    startReason: "The renewal was booked twice, once from the card statement and once by hand",
  },
};
