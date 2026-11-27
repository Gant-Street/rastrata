import type { Meta, StoryObj } from "storybook-solidjs-vite";
import { expect, fn, userEvent, within } from "storybook/test";
import { Button } from "../src";
import { Plus, Trash } from "../src/icons";

const meta = {
  title: "Components/Button",
  component: Button,
  tags: ["autodocs"],
  args: { label: "Save draft", variant: "primary", size: "md", disabled: false, onClick: fn() },
  argTypes: {
    variant: { control: "inline-radio", options: ["primary", "secondary", "quiet", "danger"] },
    size: { control: "inline-radio", options: ["sm", "md", "lg"] },
  },
  parameters: {
    layout: "centered",
    docs: {
      description: {
        component:
          "Native button styled with Rastrata design tokens. Supports primary, secondary, quiet, and danger variants across 3 sizes.",
      },
    },
  },
} satisfies Meta<typeof Button>;

export default meta;
type Story = StoryObj<typeof meta>;

export const Primary: Story = {
  async play({ canvasElement, args }) {
    const button = within(canvasElement).getByRole("button", { name: args.label });
    button.focus();
    await userEvent.keyboard("{Enter}");
    await expect(args.onClick).toHaveBeenCalled();
  },
};

export const Secondary: Story = { args: { label: "Cancel", variant: "secondary" } };
export const Disabled: Story = { args: { disabled: true } };
export const Quiet: Story = { args: { label: "Clear filters", variant: "quiet" } };
export const Destructive: Story = { args: { label: "Discard draft", variant: "danger" } };
export const Pending: Story = {
  args: { label: "Save draft", pendingLabel: "Saving…", pending: true },
  async play({ canvasElement, args }) {
    const button = within(canvasElement).getByRole("button", { name: "Saving…" });
    await userEvent.click(button);
    // Pending buttons stay focusable and announce busy, but ignore clicks: no double submit.
    await expect(args.onClick).not.toHaveBeenCalled();
    await expect(button).toHaveAttribute("aria-busy", "true");
  },
};
export const WithIcon: Story = {
  args: { label: "Add line", variant: "secondary", icon: <Plus /> },
};
export const IconOnly: Story = {
  args: { label: "Remove line 2", variant: "quiet", iconOnly: true, icon: <Trash /> },
};
