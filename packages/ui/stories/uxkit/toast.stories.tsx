import { createSignal, onMount, Show } from "solid-js";
import type { Meta, StoryObj } from "storybook-solidjs-vite";
import {
  AccountPicker,
  accountOptions,
  Button,
  CheckField,
  SelectField,
  TextArea,
  TextField,
  ToastProvider,
  useToast,
} from "../../src";
import { Frame, darkUnlessAsked } from "./frame";

type Scenario = "default" | "empty" | "loading" | "error" | "long" | "queue" | "fields";

const chart = accountOptions([
  { id: "bank", code: "1000", name: "Business checking", role: "asset" },
  { id: "sales", code: "4000", name: "Sales", role: "income" },
  { id: "software", code: "6200", name: "Software and subscriptions", role: "expense" },
]);

/** The page a toast appears over. Stories that show a toast on load give it no timeout, so it stays for
 * review; the buttons use the real timings (five seconds, ten with an action, a problem stays). */
function Page(props: { scenario: Scenario }) {
  const toast = useToast();
  const [undone, setUndone] = createSignal(0);
  const undo = () => setUndone((count) => count + 1);

  const posted = (timeoutMs?: number) =>
    toast.show({
      message: "Posted 6 transactions.",
      action: { label: "Undo", onSelect: undo },
      ...(timeoutMs !== undefined ? { timeoutMs } : {}),
    });

  onMount(() => {
    if (props.scenario === "default") posted(0);
    if (props.scenario === "fields")
      toast.show({ message: "Imported 31 transactions.", timeoutMs: 0 });
    if (props.scenario === "loading")
      toast.show({ id: "post", message: "Posting 6 transactions…", tone: "info", timeoutMs: 0 });
    if (props.scenario === "error")
      toast.show({
        message: "2 of 6 transactions could not be posted. The other 4 are posted.",
        tone: "problem",
        action: { label: "See which", onSelect: undo },
      });
    if (props.scenario === "long")
      toast.show({
        message:
          "Posted 6 transactions dated in March, April and May 2026 to Business checking, Business savings and the Business credit card, including 2 that a rule matched.",
        action: { label: "Undo and return them to review", onSelect: undo },
        timeoutMs: 0,
      });
    if (props.scenario === "queue") {
      toast.show({
        message: "Posted 6 transactions.",
        action: { label: "Undo", onSelect: undo },
        timeoutMs: 0,
      });
      toast.show({ message: "Imported 31 transactions.", timeoutMs: 0 });
      toast.show({ message: "Backup verified.", tone: "info", timeoutMs: 0 });
      toast.show({ message: "Rule saved.", timeoutMs: 0 });
      toast.show({ message: "Excluded 1 transaction.", timeoutMs: 0 });
    }
  });

  return (
    <div class="rt-stack">
      <p>
        A toast says that something already happened and may offer to take it back. It sits at the
        bottom of the window, is read out politely and waits while you point at it or tab into it.
        Alt+T moves focus to it.
      </p>
      <div style={{ display: "flex", "flex-wrap": "wrap", gap: "0.75rem" }}>
        <Button label="Accept 6 suggestions" onClick={() => posted()} />
        <Button
          label="Import a file"
          variant="secondary"
          onClick={() => toast.show({ message: "Imported 31 transactions." })}
        />
        <Button
          label="Post one that fails"
          variant="secondary"
          onClick={() =>
            toast.show({ message: "This transaction could not be posted.", tone: "problem" })
          }
        />
        <Button
          label="Finish posting"
          variant="secondary"
          onClick={() =>
            toast.show({
              id: "post",
              message: "Posted 6 transactions.",
              action: { label: "Undo", onSelect: undo },
            })
          }
        />
        <Button label="Dismiss all" variant="quiet" onClick={() => toast.dismiss()} />
      </div>
      <output class="rt-hint" aria-label="Undo count">
        {undone() === 0 ? "Nothing undone." : `Undo pressed ${undone()} times.`}
      </output>
      <Show when={props.scenario === "fields"}>
        <div class="rt-stack" style={{ "max-width": "28rem" }}>
          <TextField label="Reference" />
          <TextArea label="Description" rows={2} />
          <SelectField
            label="Type"
            defaultValue="all"
            items={[
              { value: "all", label: "All types" },
              { value: "bank", label: "Bank" },
              { value: "stripe", label: "Stripe" },
            ]}
          />
          <div class="rt-stack" style={{ gap: "0.375rem" }}>
            <span style={{ "font-weight": 600 }} id="note-label">
              Note
            </span>
            {/* biome-ignore lint/a11y/useSemanticElements: an editable region is one of the cases under test */}
            <div
              class="rt-input"
              contenteditable="true"
              tabIndex={0}
              role="textbox"
              aria-labelledby="note-label"
              aria-multiline="true"
              style={{ "min-height": "3rem" }}
            />
          </div>
          <AccountPicker accounts={chart} label="Paid from" />
          <CheckField label="Select this row" />
        </div>
      </Show>
    </div>
  );
}

function ToastDemo(props: { scenario: Scenario; width?: string }) {
  return (
    <Frame {...(props.width ? { width: props.width } : {})}>
      <ToastProvider>
        <Page scenario={props.scenario} />
      </ToastProvider>
    </Frame>
  );
}

const meta = {
  title: "Lanes/UXKit/Toast",
  component: ToastDemo,
  parameters: { layout: "fullscreen", a11y: { test: "error" } },
} satisfies Meta<typeof ToastDemo>;
export default meta;
type Story = StoryObj<typeof meta>;

/** After Accept: one sentence and an Undo. It stays ten seconds because it has an action, and it waits
 * while the pointer or focus is on it. */
export const Default: Story = { args: { scenario: "default" } };

/** Nothing showing. The region is on the page from the start, so the first toast is announced. */
export const Empty: Story = { args: { scenario: "empty" } };

/** Work in progress is a toast with an id, replaced by the result: press "Finish posting". */
export const Loading: Story = { args: { scenario: "loading" } };

/** A failure stays until it is dismissed, in the problem tone, and may offer to show what failed. */
export const ErrorState: Story = { args: { scenario: "error" } };

/** A long sentence and a long action wrap inside the toast and never push it off a phone. */
export const LongContent: Story = { args: { scenario: "long", width: "22rem" } };

/** Three at a time; the rest wait their turn and appear as room is made. */
export const Queue: Story = { args: { scenario: "queue" } };

/** Typing is never interrupted. A toast is showing and focus is in a text box, a text area, a list, an
 * editable region or an account picker's box: Alt+T (Option+T on a Mac, which types "†") does nothing there,
 * so the character arrives where the person is typing. From the checkbox, or a button, it reaches the toast. */
export const TypingInAField: Story = { args: { scenario: "fields" } };

/** The dark theme. */
export const Dark: Story = { args: { scenario: "default" }, decorators: [darkUnlessAsked] };
