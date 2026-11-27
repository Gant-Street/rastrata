import type { Meta, StoryObj } from "storybook-solidjs-vite";
import { HomeStart, type HomeStartView, UiProvider } from "../../src";
import { startConnect, startStatement } from "./fixtures";

function Start(props: { start: HomeStartView; width?: string }) {
  return (
    <UiProvider locale="en-US">
      <div class="rt-theme" style={{ "max-width": props.width ?? "76rem", padding: "1rem" }}>
        <div class="rt-today">
          <HomeStart start={props.start} />
        </div>
      </div>
    </UiProvider>
  );
}

const meta = {
  title: "Lanes/UXHome/Start of a new book",
  component: Start,
  parameters: {
    layout: "fullscreen",
    a11y: { test: "error" },
    docs: {
      description: {
        component:
          "What Home shows for a book with nothing in it and no bank account yet: one thing to do, as a title, a sentence and one button, with the second way to do it as a quiet link beside the button. Under a hairline, one quiet line for each person it might be for.",
      },
    },
  },
} satisfies Meta<typeof Start>;
export default meta;
type Story = StoryObj<typeof meta>;

/** Where a bank can be connected: connecting is the way in, and a statement file is the other. */
export const ConnectABank: Story = { args: { start: startConnect } };

/** Where none can: the statement file is the one way in. */
export const ImportAStatement: Story = { args: { start: startStatement } };

/** A member, who neither brings in books from before nor makes agent keys: no quiet lines, and no rule. */
export const NoQuietLines: Story = { args: { start: { ...startConnect, lines: [] } } };

export const AtPhoneWidth: Story = { args: { start: startConnect, width: "22.5rem" } };
