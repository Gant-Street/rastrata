import type { Meta, StoryObj } from "storybook-solidjs-vite";
import { StripeSettingsForm } from "../../src";
import {
  accounts,
  arabicAccounts,
  chosenValues,
  emptyValues,
  rolesChosen,
  rolesFromChart,
  rolesTrouble,
  rolesUntagged,
  savedValues,
} from "./fixtures";
import { Frame } from "./frame";

const meta = {
  title: "Lanes/Stripe/Settings form",
  parameters: { layout: "padded", a11y: { test: "error" } },
} satisfies Meta;
export default meta;
type Story = StoryObj<typeof meta>;

export const SettingsFromChartKeys: Story = {
  name: "Settings: first time, every account found from the chart's role keys",
  render: () => (
    <Frame>
      <StripeSettingsForm
        accounts={accounts}
        initial={emptyValues}
        roles={rolesFromChart}
        onSubmit={() => undefined}
      />
    </Frame>
  ),
};
export const SettingsUntagged: Story = {
  name: "Settings: a chart with no role keys, nothing found",
  render: () => (
    <Frame>
      <StripeSettingsForm
        accounts={accounts}
        initial={emptyValues}
        roles={rolesUntagged}
        onSubmit={() => undefined}
      />
    </Frame>
  ),
};
export const SettingsAmbiguousAndUnusable: Story = {
  name: "Settings: two accounts carry one key, and one key is on the wrong kind of account",
  render: () => (
    <Frame>
      <StripeSettingsForm
        accounts={accounts}
        initial={savedValues}
        roles={rolesTrouble}
        onSubmit={() => undefined}
      />
    </Frame>
  ),
};
export const SettingsSaved: Story = {
  name: "Settings: saved, with the service's notes",
  render: () => (
    <Frame>
      <StripeSettingsForm
        accounts={accounts}
        initial={chosenValues}
        roles={rolesChosen}
        saved
        onSubmit={() => undefined}
      />
    </Frame>
  ),
};
export const SettingsWithErrors: Story = {
  name: "Settings: errors in a summary that links to each field",
  render: () => (
    <Frame>
      <StripeSettingsForm
        accounts={accounts}
        initial={{ ...savedValues, syncFrom: "", mapping: { "stripe.fees": "2500" } }}
        roles={rolesFromChart}
        errors={{
          mapping: { "stripe.fees": "Stripe fees must be an expense account; 2500 is liability." },
          syncFrom: "Enter the first day as a date.",
          form: "The settings could not be saved. Your books have not been changed.",
        }}
        onSubmit={() => undefined}
      />
    </Frame>
  ),
};
export const SettingsFirstDayLocked: Story = {
  name: "Settings: first day fixed once lines are imported",
  render: () => (
    <Frame>
      <StripeSettingsForm
        accounts={accounts}
        initial={savedValues}
        roles={rolesFromChart}
        startLocked
        onSubmit={() => undefined}
      />
    </Frame>
  ),
};
export const SettingsSaving: Story = {
  name: "Settings: saving",
  render: () => (
    <Frame>
      <StripeSettingsForm
        accounts={accounts}
        initial={chosenValues}
        roles={rolesChosen}
        pending
        onSubmit={() => undefined}
      />
    </Frame>
  ),
};
export const SettingsSalesTaxOff: Story = {
  name: "Settings: sales tax not split, so no tax account is needed",
  render: () => (
    <Frame>
      <StripeSettingsForm
        accounts={accounts}
        initial={{ ...savedValues, salesTax: "none" }}
        roles={rolesUntagged.map((r) => (r.role === "tax.sales" ? { ...r, required: false } : r))}
        onSubmit={() => undefined}
      />
    </Frame>
  ),
};
export const SettingsRightToLeft: Story = {
  name: "Settings: right to left, account names isolated",
  render: () => (
    <Frame dir="rtl">
      <StripeSettingsForm
        accounts={arabicAccounts}
        initial={savedValues}
        roles={rolesFromChart}
        onSubmit={() => undefined}
      />
    </Frame>
  ),
};
