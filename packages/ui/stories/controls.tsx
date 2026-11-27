import type { ComponentProps } from "solid-js";
import { AccountPicker as SharedAccountPicker, SelectField } from "../src";
import { accounts } from "./accounts";
export { accounts } from "./accounts";
export { CheckField, CalendarField, InlineHelp } from "../src";
export function AccountPicker(props: Omit<ComponentProps<typeof SharedAccountPicker>, "accounts">) {
  return <SharedAccountPicker {...props} accounts={accounts} />;
}

export const currencies = [
  { label: "USD · US dollar", value: "USD" },
  { label: "EUR · Euro", value: "EUR" },
  { label: "JPY · Japanese yen", value: "JPY" },
];
export function CurrencySelect() {
  return (
    <SelectField
      label="Currency"
      items={currencies}
      defaultValue="USD"
      placeholder="Select currency"
    />
  );
}
