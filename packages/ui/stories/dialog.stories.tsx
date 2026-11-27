import type { Meta, StoryObj } from "storybook-solidjs-vite";
import { buttonAttrs, Dialog, DialogClose, TextField } from "../src";

function DialogExample() {
  return (
    <Dialog
      triggerLabel="Edit reference"
      title="Edit reference"
      description="Preview only. No changes will be saved."
      footer={<DialogClose {...buttonAttrs({ variant: "secondary" })}>Close</DialogClose>}
    >
      <TextField label="Reference" placeholder="September adjustments" />
    </Dialog>
  );
}
const meta = {
  title: "Patterns/Dialog",
  component: DialogExample,
  parameters: {
    docs: {
      description: {
        component:
          "The shared Dialog: Ark keeps focus, dismissal and stacking; Rastrata owns the look and the copy.",
      },
    },
  },
} satisfies Meta<typeof DialogExample>;
export default meta;
type Story = StoryObj<typeof meta>;
export const KeyboardReview: Story = {};
