import { createSignal } from "solid-js";
import type { Meta, StoryObj } from "storybook-solidjs-vite";
import {
  Button,
  emptyVendorValues,
  TaxVendorForm,
  TaxVendorsView,
  vendorValues,
  type TaxVendorFormValues,
} from "../../src";
import { vendorHistory, vendorJane, vendors, vendorsEmpty } from "./fixtures";
import { Frame } from "./frame";

const meta = {
  title: "Lanes/Tax/1099 vendors",
  parameters: { layout: "padded", a11y: { test: "error" } },
} satisfies Meta;
export default meta;
type Story = StoryObj<typeof meta>;

const noop = () => undefined;
const handlers = {
  onMarkAccount: noop,
  onAddVendor: noop,
  onEditVendor: noop,
  onMakeVendor: noop,
};

export const VendorsList: Story = {
  name: "Vendors: marked accounts, vendors that need a look, payees that are not vendors yet",
  render: () => (
    <Frame>
      <TaxVendorsView
        data={vendors}
        {...handlers}
        payeeHref={(vendorId) => `/reports/payees?payee=${vendorId}`}
        exportControls={
          <>
            <Button variant="secondary" label="Download the vendor list (CSV)" onClick={noop} />
            <Button variant="secondary" label="Download every payment (CSV)" onClick={noop} />
          </>
        }
      />
    </Frame>
  ),
};

export const VendorsNoneMarked: Story = {
  name: "Vendors: no account marked yet",
  render: () => (
    <Frame>
      <TaxVendorsView data={vendorsEmpty} {...handlers} />
    </Frame>
  ),
};

export const VendorsMarking: Story = {
  name: "Vendors: an account is being marked",
  render: () => (
    <Frame>
      <TaxVendorsView data={vendors} {...handlers} pendingAccountId="6020" busy />
    </Frame>
  ),
};

export const VendorsMarkFailed: Story = {
  name: "Vendors: marking an account failed",
  render: () => (
    <Frame>
      <TaxVendorsView
        data={vendors}
        {...handlers}
        accountsError="The accounts could not be changed. Nothing was changed."
      />
    </Frame>
  ),
};

function FormDemo(props: {
  vendor: typeof vendorJane | null;
  initial: TaxVendorFormValues;
  failure?: string;
  saving?: boolean;
}) {
  const [open, setOpen] = createSignal(true);
  return (
    <Frame>
      <Button label="Open the form" onClick={() => setOpen(true)} />
      <TaxVendorForm
        open={open()}
        vendor={props.vendor}
        initial={props.initial}
        history={props.vendor ? vendorHistory : []}
        saving={props.saving ?? false}
        failure={props.failure}
        onSave={noop}
        onClose={() => setOpen(false)}
      />
    </Frame>
  );
}

export const FormNew: Story = {
  name: "Vendor form: a new vendor from a payee",
  render: () => <FormDemo vendor={null} initial={emptyVendorValues("SOMEONE NEW LLC 0042")} />,
};

export const FormEdit: Story = {
  name: "Vendor form: changing a vendor, with its history",
  render: () => <FormDemo vendor={vendorJane} initial={vendorValues(vendorJane)} />,
};

export const FormRefused: Story = {
  name: "Vendor form: the service refused the change",
  render: () => (
    <FormDemo
      vendor={vendorJane}
      initial={vendorValues(vendorJane)}
      failure="This vendor was changed since you opened it (it is now version 4). Close this and open it again."
    />
  ),
};

export const FormSaving: Story = {
  name: "Vendor form: saving",
  render: () => <FormDemo vendor={null} initial={emptyVendorValues("Acme Law")} saving />,
};
