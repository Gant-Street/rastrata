import { createSignal, type JSX } from "solid-js";
import type { Meta, StoryObj } from "storybook-solidjs-vite";
import { Button, UiProvider, WatchAccountDialog, type WatchAccountDialogProps } from "../../src";

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
  Pick<WatchAccountDialogProps, "mode" | "replaces" | "busy" | "error" | "uncertain">
> & { name?: string; role?: "expense" | "income" };

function Watching(props: Preview) {
  const [open, setOpen] = createSignal(true);
  const [said, setSaid] = createSignal("");
  return (
    <Frame>
      <Button
        label="Watch this account"
        variant="secondary"
        tabIndex={-1}
        onClick={() => setOpen(true)}
      />
      <p role="status" class="rt-hint">
        {said()}
      </p>
      <WatchAccountDialog
        open={open()}
        mode={props.mode ?? "watch"}
        account={{ name: props.name ?? "Other expenses", role: props.role ?? "expense" }}
        replaces={props.replaces}
        busy={props.busy}
        error={props.error}
        uncertain={props.uncertain}
        onResume={() => setSaid("Resumed in this preview.")}
        onConfirm={() => {
          setSaid("Saved in this preview.");
          setOpen(false);
        }}
        onCancel={() => setOpen(false)}
        returnFocus={() => document.querySelector<HTMLElement>("button.rt-button")}
      />
    </Frame>
  );
}

const meta = {
  title: "Lanes/Catchall/Watch an account",
  component: Watching,
  parameters: {
    layout: "fullscreen",
    docs: {
      description: {
        component:
          "Marking an account to be watched at month end: Close the books then says what it took in the month. It is a mark on the account; no entry changes. The dialog says what the mark does before it is put on, and what it replaces.",
      },
    },
  },
} satisfies Meta<typeof Watching>;

export default meta;
type Story = StoryObj<typeof meta>;

export const WatchExpenses: Story = {};
export const WatchIncome: Story = { args: { name: "Other income", role: "income" } };
export const ReplacesAnotherAccount: Story = { args: { replaces: "Miscellaneous expenses" } };
export const StopWatching: Story = { args: { mode: "stop" } };
export const LongName: Story = {
  args: {
    name: "Other expenses and miscellaneous items that fit nowhere else in this book, with a very long name",
    replaces: "Another account with a name that is also very long indeed, to see how it wraps",
  },
};
export const Saving: Story = { args: { busy: true } };
export const Failed: Story = {
  args: { error: "Role key catchall.expense is on another account. Clear it there first." },
};
export const WaitingForAnAnswer: Story = {
  args: { uncertain: true, error: "The result is uncertain. Resume the original request." },
};
