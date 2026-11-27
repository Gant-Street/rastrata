import { RadioGroup } from "@ark-ui/solid/radio-group";
import { createSignal, For } from "solid-js";
import type { Meta, StoryObj } from "storybook-solidjs-vite";
import {
  AccountPicker as SharedAccountPicker,
  Button,
  PasswordField,
  SelectField,
  TextArea,
  TextField,
  UiProvider,
} from "../src";
import { Catalog, Specimen } from "./catalog";
import { AccountPicker, CalendarField, CheckField, CurrencySelect, currencies } from "./controls";

function Forms() {
  const [exact, setExact] = createSignal("9007199254740993.123456789");
  const [accountId, setAccountId] = createSignal("");
  return (
    <Catalog
      section="02 / Forms"
      title="Ask clearly. Preserve the answer."
      description="Native text entry and Ark's interaction primitives. No financial rounding, hidden conversion, or custom keyboard machinery."
    >
      <Specimen
        title="Text & descriptions"
        note="Persistent labels, useful hints, and errors next to the answer. Placeholders are not labels."
      >
        <div class="catalog-split">
          <TextField
            label="Reference"
            placeholder="September adjustments"
            hint="A name you can find later."
            help="Shown in the register and on reports. Use something a colleague would recognize, such as a supplier and month."
          />
          <TextArea
            label="Description"
            placeholder="What is this entry for?"
            hint="Add context for the person reviewing the books."
          />
        </div>
      </Specimen>
      <Specimen
        title="Choices"
        note="Checkboxes select independent options. Radio buttons select one of a small set."
      >
        <div class="catalog-split">
          <fieldset>
            <legend>Include in review</legend>
            <div class="rt-stack">
              <CheckField label="Draft entries" />
              <CheckField label="Posted entries" />
              <CheckField label="Archived entries (unavailable)" disabled />
            </div>
          </fieldset>
          <RadioGroup.Root class="rt-stack" defaultValue="accrual">
            <RadioGroup.Label class="rt-label">Report basis</RadioGroup.Label>
            <For each={["Accrual", "Cash"]}>
              {(label) => (
                <RadioGroup.Item class="rt-choice" value={label.toLowerCase()}>
                  <RadioGroup.ItemHiddenInput />
                  <RadioGroup.ItemControl />
                  <RadioGroup.ItemText>{label}</RadioGroup.ItemText>
                </RadioGroup.Item>
              )}
            </For>
          </RadioGroup.Root>
        </div>
      </Specimen>
      <Specimen
        title="Select & search"
        note="Choose from known values. Accounts retain their canonical ID; an archived account cannot be selected."
      >
        <div class="catalog-split">
          <CurrencySelect />
          <div class="rt-stack">
            <AccountPicker onChange={setAccountId} />
            <output class="rt-hint" aria-label="Selected account ID">
              {accountId() ? `Selected ID: ${accountId()}` : "No account selected"}
            </output>
          </div>
        </div>
      </Specimen>
      <Specimen
        title="Date & period"
        note="Type a date or use the calendar. Date-only values are not timestamps."
      >
        <div class="catalog-split">
          <CalendarField defaultDateValues={["2026-09-23"]} />
          <CalendarField range defaultDateValues={["2026-09-01", "2026-09-30"]} />
        </div>
      </Specimen>
      <Specimen
        title="Exact amount"
        note="This specimen preserves the entered string. Currency rules and arithmetic belong outside the control."
      >
        <div class="rt-stack">
          <TextField
            label="Amount (USD)"
            inputMode="decimal"
            value={exact()}
            onInput={(event) => setExact(event.currentTarget.value)}
            hint="No rounding is applied in this preview."
          />
          <output
            aria-label="Exact input"
            style={{ "overflow-wrap": "anywhere", "font-variant-numeric": "tabular-nums" }}
          >
            {exact() || "No amount entered"}
          </output>
        </div>
      </Specimen>
      <Specimen
        title="Password"
        note="A familiar control, with an explicit reveal action and password-manager support."
      >
        <PasswordField label="Password" autocomplete="current-password" />
      </Specimen>
    </Catalog>
  );
}

function AccountStates(props: { state: "ready" | "loading" | "error"; disabled: boolean }) {
  const [state, setState] = createSignal(props.state);
  return (
    <Catalog
      section="02 / Selector states"
      title="Keep the choice understandable."
      description="Search by code or name. Loading, no matches and unavailable choices are distinct states."
    >
      <Specimen
        title="Account selector"
        note="Open the selector to review the current fixture state. Recovery is local, with no network request."
      >
        <div class="rt-stack">
          <AccountPicker state={state()} disabled={props.disabled} />
          <Button
            variant="secondary"
            label="Load fixture accounts"
            onClick={() => setState("ready")}
          />
        </div>
      </Specimen>
    </Catalog>
  );
}
export default {
  title: "Components/Forms",
  component: Forms,
  parameters: {
    layout: "fullscreen",
    options: { showPanel: false },
    controls: { disable: true },
  },
} satisfies Meta<typeof Forms>;
type Story = StoryObj<typeof Forms>;
export const Review: Story = {};
export const RightToLeft: Story = {
  render: () => (
    <UiProvider locale="ar-EG">
      <Forms />
    </UiProvider>
  ),
};
function ControlledFieldsExample() {
  const [accountId, setAccountId] = createSignal("");
  const [items, setItems] = createSignal(currencies.slice(0, 1));
  const [currency, setCurrency] = createSignal("USD");
  return (
    <Catalog
      section="02 / Controlled fields"
      title="Say it once, and the field listens."
      description="Fields follow the value you give them. Reset a form, load options late, and the controls keep up."
    >
      <div class="catalog-split">
        <div class="rt-stack">
          <AccountPicker value={accountId()} onChange={setAccountId} />
          <div class="catalog-row">
            <Button
              variant="secondary"
              label="Select the cash account"
              onClick={() => setAccountId("cash")}
            />
            <Button variant="quiet" label="Clear account" onClick={() => setAccountId("")} />
          </div>
          <output class="rt-hint" aria-label="Account in the form">
            {accountId() ? `Account in the form: ${accountId()}` : "No account in the form"}
          </output>
        </div>
        <div class="rt-stack">
          <SelectField label="Currency" items={items()} value={currency()} onChange={setCurrency} />
          <div class="catalog-row">
            <Button
              variant="secondary"
              label="Load more currencies"
              onClick={() => setItems(currencies)}
            />
          </div>
          <output class="rt-hint" aria-label="Currency in the form">
            Currency in the form: {currency()}
          </output>
        </div>
        <CalendarField
          label="Posting date"
          min="2026-09-01"
          max="2026-09-30"
          focusedDate="2026-09-15"
        />
        <SharedAccountPicker
          label="Account with an awkward ID"
          accounts={[
            {
              label: "1000 · Cash drawer",
              value: 'cash drawer #1 "main"',
              path: "Assets / Current assets",
              group: "Assets",
            },
          ]}
        />
      </div>
    </Catalog>
  );
}
export const LoadingAccounts: Story = {
  render: () => <AccountStates state="loading" disabled={false} />,
};
export const FailedAccounts: Story = {
  render: () => <AccountStates state="error" disabled={false} />,
};
export const ControlledFields: Story = { render: () => <ControlledFieldsExample /> };
export const DisabledAccount: Story = { render: () => <AccountStates state="ready" disabled /> };
export const AccountHierarchy: Story = {
  render: () => (
    <Catalog
      section="02 / Account context"
      title="The right account, not just the right name."
      description="Search “Professional services” to compare domestic and international accounts, or search a parent path. Group and archived accounts explain why they are unavailable."
    >
      <AccountPicker />
    </Catalog>
  ),
};
export const UnavailableAccount: Story = {
  render: () => (
    <Catalog
      section="02 / Account context"
      title="Never silently replace an account."
      description="This draft references an account that is absent from the available choices. No replacement is assumed."
    >
      <AccountPicker value="removed-account-7100" />
    </Catalog>
  ),
};
export const LongContent: Story = {
  render: () => (
    <Catalog
      section="02 / Content resilience"
      title="Real text is rarely short."
      description="Long references, required fields, readonly and disabled states."
    >
      <div class="rt-stack">
        <TextField
          label="Reference for the intercompany adjustment at the end of the financial year"
          value="Northern workshops / International operations / September reconciliation / 2026"
          readOnly
        />
        <TextField label="Posting reference" required error="Enter a reference." />
        <TextField
          label="Account managed by your administrator"
          disabled
          value="Retained earnings"
        />
      </div>
    </Catalog>
  ),
};
