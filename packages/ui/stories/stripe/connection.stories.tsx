import type { Meta, StoryObj } from "storybook-solidjs-vite";
import { StripeConnection } from "../../src";
import { keyBroken, keyMissing, keyUnrestricted } from "./fixtures";
import { Frame } from "./frame";

const meta = {
  title: "Lanes/Stripe/Key",
  parameters: { layout: "padded", a11y: { test: "error" } },
} satisfies Meta;
export default meta;
type Story = StoryObj<typeof meta>;

export const KeyMissing: Story = {
  render: () => (
    <Frame>
      <StripeConnection keyInfo={keyMissing} />
    </Frame>
  ),
};
export const KeyUnusable: Story = {
  render: () => (
    <Frame>
      <StripeConnection keyInfo={keyBroken} />
    </Frame>
  ),
};
export const KeyUnrestrictedWarning: Story = {
  render: () => (
    <Frame>
      <StripeConnection keyInfo={keyUnrestricted} />
    </Frame>
  ),
};
