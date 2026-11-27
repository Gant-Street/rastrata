import type { Meta, StoryObj } from "storybook-solidjs-vite";
import { TextField } from "../src";

const meta = {
  title: "Components/Text field",
  component: TextField,
  tags: ["autodocs"],
  args: {
    label: "Reference",
    hint: "Use a reference that helps you find this entry.",
    placeholder: "September adjustments",
    disabled: false,
    required: false,
  },
  parameters: {
    layout: "centered",
    docs: {
      description: {
        component:
          "A labeled text input with associated help and error text. Precision 2px corner radius and accessible state bindings.",
      },
    },
  },
} satisfies Meta<typeof TextField>;

export default meta;
type Story = StoryObj<typeof meta>;

export const Default: Story = {};
export const Invalid: Story = { args: { required: true, error: "Enter a reference." } };
export const Disabled: Story = { args: { disabled: true } };
export const ReadOnly: Story = {
  args: { readOnly: true, value: "JRN-2026-0042", hint: "This reference cannot be edited." },
};
