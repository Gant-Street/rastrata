import type { ApplicationOutputs } from "@rastrata/application/client-contracts";
import {
  Button,
  emptyVendorValues,
  TaxVendorForm,
  TaxVendorsView,
  taxWords,
  type TaxVendorFormValues,
  type TaxVendorView,
  vendorFields,
  vendorValues,
  PageSkeleton,
} from "@rastrata/ui";
import { type Accessor, createMemo, createSignal, Show } from "solid-js";
import { ApplicationRequestError, type BrowserApplicationClient } from "../../application-client";
import { createKeyedLoader } from "../../loader";
import { payeeHref } from "../payees/controller";
import { saveCsv } from "./download";
import { failureText, TaxFailure } from "./failure";

type Vendor = ApplicationOutputs["taxVendors.save"]["vendor"];

interface Editing {
  /** The vendor being changed, or null for a new one. */
  readonly vendor: TaxVendorView | null;
  readonly initial: TaxVendorFormValues;
}

/** The 1099 vendor list for the year: mark the accounts that hold payments, record who is a vendor, whether
 * they need a 1099 and whether a W-9 is on file. Every change is a new version with who and when, and a write
 * whose reply was lost is shown as uncertain, never repeated silently. Nothing is filed and no taxpayer
 * identification number is ever asked for. */
export function VendorsTab(props: {
  client: BrowserApplicationClient;
  year: Accessor<number | undefined>;
  /** Something that changes the readiness checks was saved: read them again. */
  onChanged: () => void;
}) {
  const key = createMemo(
    () => {
      const taxYear = props.year();
      return taxYear === undefined ? undefined : { taxYear };
    },
    undefined,
    { equals: (left, right) => left?.taxYear === right?.taxYear },
  );
  const vendors = createKeyedLoader(key, (input) => props.client.read("taxVendors.list", input));
  const [editing, setEditing] = createSignal<Editing | null>(null);
  const [history, setHistory] = createSignal<readonly TaxVendorView[]>([]);
  const [saving, setSaving] = createSignal(false);
  const [failure, setFailure] = createSignal<string | undefined>();
  const [pendingAccount, setPendingAccount] = createSignal<string | null>(null);
  const [accountsError, setAccountsError] = createSignal<string | undefined>();
  const [message, setMessage] = createSignal("");
  const [exporting, setExporting] = createSignal<string | null>(null);

  const changed = async () => {
    await vendors.reload();
    props.onChanged();
  };

  function openNew(payee?: string) {
    setFailure(undefined);
    setHistory([]);
    setEditing({ vendor: null, initial: emptyVendorValues(payee) });
  }

  async function openEdit(vendorId: string) {
    const row = vendors.value()?.vendors.find((entry) => entry.vendor.id === vendorId);
    const taxYear = props.year();
    if (!row || taxYear === undefined) return;
    setFailure(undefined);
    setHistory([]);
    setEditing({ vendor: row.vendor, initial: vendorValues(row.vendor) });
    try {
      const detail = await props.client.read("taxVendors.get", { vendorId, taxYear });
      setHistory(detail.history.slice(0, -1));
    } catch {
      // The form works without the history; it is only shown when it could be read.
    }
  }

  async function save(values: TaxVendorFormValues) {
    const current = editing();
    if (!current) return;
    setFailure(undefined);
    setSaving(true);
    try {
      const saved = await props.client.write(
        "taxVendors.save",
        {
          ...vendorFields(values),
          ...(current.vendor
            ? { vendorId: current.vendor.id, expectedVersion: current.vendor.version }
            : {}),
        },
        `tax:vendor:${current.vendor?.id ?? "new"}`,
      );
      const vendor: Vendor = saved.vendor;
      setEditing(null);
      setMessage(taxWords.formSaved(vendor.name));
      await changed();
    } catch (cause) {
      setFailure(
        cause instanceof ApplicationRequestError && cause.uncertain
          ? taxWords.formUncertain
          : failureText(cause, taxWords.formFailed),
      );
    } finally {
      setSaving(false);
    }
  }

  async function mark(accountId: string, marked: boolean) {
    setAccountsError(undefined);
    setPendingAccount(accountId);
    try {
      await props.client.write(
        "taxVendors.setAccounts",
        marked ? { add: [accountId] } : { remove: [accountId] },
        "tax:accounts",
      );
      await changed();
    } catch (cause) {
      setAccountsError(
        cause instanceof ApplicationRequestError && cause.uncertain
          ? taxWords.formUncertain
          : failureText(cause, taxWords.accountsMarkError),
      );
    } finally {
      setPendingAccount(null);
    }
  }

  async function download(file: "vendors" | "payments") {
    const input = key();
    if (!input) return;
    setExporting(file);
    setMessage("");
    try {
      const done = await props.client.read("taxVendors.export", { ...input, file });
      setMessage(taxWords.exported(saveCsv(done.filename, done.mediaType, done.content)));
    } catch (cause) {
      setMessage(failureText(cause, taxWords.exportFailed));
    } finally {
      setExporting(null);
    }
  }

  return (
    <section class="rt-tax-section" aria-labelledby="tax-vendors-title">
      <h2 id="tax-vendors-title" class="rt-sr-only">
        {taxWords.vendorsTitle}
      </h2>
      <Show
        when={vendors.error() === undefined}
        fallback={<TaxFailure error={vendors.error()} retry={() => void vendors.reload()} />}
      >
        <Show
          when={vendors.value()}
          fallback={<PageSkeleton shape="table" label={taxWords.loading} />}
        >
          {(data) => (
            <TaxVendorsView
              data={data()}
              busy={vendors.loading()}
              pendingAccountId={pendingAccount()}
              accountsError={accountsError()}
              onMarkAccount={(accountId, marked) => void mark(accountId, marked)}
              onAddVendor={() => openNew()}
              onEditVendor={(id) => void openEdit(id)}
              onMakeVendor={(payee) => openNew(payee)}
              payeeHref={(vendorId) => payeeHref(vendorId, data().from, data().to)}
              exportControls={
                <>
                  <Button
                    variant="secondary"
                    label={taxWords.exportVendors}
                    pending={exporting() === "vendors"}
                    pendingLabel={taxWords.exporting}
                    onClick={() => void download("vendors")}
                  />
                  <Button
                    variant="secondary"
                    label={taxWords.exportPayments}
                    pending={exporting() === "payments"}
                    pendingLabel={taxWords.exporting}
                    onClick={() => void download("payments")}
                  />
                </>
              }
            />
          )}
        </Show>
      </Show>
      <p class="rt-hint" role="status" aria-live="polite">
        {message()}
      </p>
      <Show when={editing()} keyed>
        {(current) => (
          <TaxVendorForm
            open
            vendor={current.vendor}
            initial={current.initial}
            history={history()}
            saving={saving()}
            failure={failure()}
            onSave={(values) => void save(values)}
            onClose={() => setEditing(null)}
          />
        )}
      </Show>
    </section>
  );
}
