import { createMemo, createSignal, For, Show } from "solid-js";
import { Button } from "../button";
import { Dialog } from "../dialog";
import { ErrorSummary, type FormError } from "../error-summary";
import { formatDate, formatInstant } from "../format";
import { Details } from "../kit";
import { Notice } from "../notice";
import { SelectField } from "../select-field";
import { TextArea, TextField } from "../text-field";
import { hasVendorErrors, vendorErrors } from "./logic";
import type {
  TaxVendorClassification,
  TaxVendorFormErrors,
  TaxVendorFormValues,
  TaxVendorPaidBy,
  TaxVendorReason,
  TaxVendorReporting,
  TaxVendorTinStatus,
  TaxVendorView,
  TaxVendorW9,
} from "./types";
import { words } from "./words";

/** `error` only when there is one: the fields take it as an optional string, not as undefined. */
const maybeError = (message: string | undefined): { error?: string } =>
  message ? { error: message } : {};

const REPORTING_ITEMS = [
  { value: "undecided", label: words.reportingUndecided },
  { value: "yes", label: words.reportingYes },
  { value: "no", label: words.reportingNo },
] as const;
const REASON_ITEMS = [
  { value: "corporation", label: words.reasonCorporation },
  { value: "employee", label: words.reasonEmployee },
  { value: "personal", label: words.reasonPersonal },
  { value: "merchandise", label: words.reasonMerchandise },
  { value: "exempt_organization", label: words.reasonExempt },
  { value: "card_or_network", label: words.reasonCard },
  { value: "other", label: words.reasonOther },
] as const;
const W9_ITEMS = [
  { value: "not_requested", label: words.w9NotRequested },
  { value: "requested", label: words.w9Requested },
  { value: "received", label: words.w9Received },
] as const;
const CLASSIFICATION_ITEMS = [
  { value: "none", label: words.formClassificationNone },
  { value: "individual", label: words.classificationIndividual },
  { value: "c_corporation", label: words.classificationC },
  { value: "s_corporation", label: words.classificationS },
  { value: "partnership", label: words.classificationPartnership },
  { value: "trust_estate", label: words.classificationTrust },
  { value: "llc_c", label: words.classificationLlcC },
  { value: "llc_s", label: words.classificationLlcS },
  { value: "llc_p", label: words.classificationLlcP },
  { value: "other", label: words.classificationOther },
] as const;
const PAID_BY_ITEMS = [
  { value: "unknown", label: words.paidByUnknown },
  { value: "bank", label: words.paidByBank },
  { value: "card_or_network", label: words.paidByCard },
] as const;
const TIN_STATUS_ITEMS = [
  { value: "not_collected", label: words.tinNotCollected },
  { value: "on_file", label: words.tinOnFile },
  { value: "verified", label: words.tinVerified },
] as const;

/** Add or change a vendor: its name, the payee texts that match it to bank lines, whether it needs a 1099
 * (and why not), the W-9, the classification, how it is paid and notes. There is no field for a taxpayer
 * identification number and the form says never to type one. A problem is said beside its field and in a
 * summary that moves focus there; a refusal from the service is shown above the form and every answer
 * stays. Closing leaves nothing changed. */
export function TaxVendorForm(props: {
  open: boolean;
  /** The vendor being changed, or null for a new one. */
  vendor: TaxVendorView | null;
  initial: TaxVendorFormValues;
  /** Earlier versions of the vendor, oldest first, with who recorded each and when. */
  history?: readonly TaxVendorView[] | undefined;
  saving?: boolean | undefined;
  /** What the service said when it refused or could not be reached. */
  failure?: string | undefined;
  onSave: (values: TaxVendorFormValues) => void;
  onClose: () => void;
}) {
  const [values, setValues] = createSignal<TaxVendorFormValues>(props.initial);
  const [attempt, setAttempt] = createSignal(0);
  const [shown, setShown] = createSignal<TaxVendorFormErrors>({});
  /** A problem is said until the person changes what it is about: then it goes, and what is still wrong
   * stays said. */
  const set = <K extends keyof TaxVendorFormValues>(key: K, value: TaxVendorFormValues[K]) => {
    setValues((current) => ({ ...current, [key]: value }));
    const about: Partial<Record<keyof TaxVendorFormValues, keyof TaxVendorFormErrors>> = {
      name: "name",
      payees: "payees",
      reporting: "reason",
      reason: "reason",
      w9On: "w9On",
      email: "email",
    };
    const field = about[key];
    if (field) setShown((current) => ({ ...current, [field]: undefined }));
  };
  const summary = createMemo<FormError[]>(() => {
    const errors = shown();
    return (
      [
        ["name", errors.name],
        ["payees", errors.payees],
        ["reason", errors.reason],
        ["w9On", errors.w9On],
        ["email", errors.email],
      ] as const
    ).flatMap(([id, message]) => (message ? [{ id: `tax-vendor-${id}`, message }] : []));
  });
  const hasFilingDetails = () =>
    Boolean(
      props.initial.legalName ||
        props.initial.email ||
        (props.initial.tinStatus && props.initial.tinStatus !== "not_collected") ||
        props.initial.addressLine1 ||
        props.initial.addressCity ||
        props.initial.addressPostalCode,
    );
  const submit = () => {
    const errors = vendorErrors(values());
    setShown(errors);
    if (hasVendorErrors(errors)) {
      setAttempt((count) => count + 1);
      return;
    }
    props.onSave(values());
  };
  return (
    <Dialog
      open={props.open}
      onOpenChange={(open) => {
        if (!open) props.onClose();
      }}
      title={props.vendor ? words.formVendorEdit : words.formVendorNew}
      closeLabel={words.formDialogClose}
      footer={
        <>
          <Button variant="quiet" label={words.formCancel} onClick={props.onClose} />
          <Button
            variant="primary"
            label={words.formSave}
            pending={props.saving ?? false}
            pendingLabel={words.formSaving}
            onClick={submit}
          />
        </>
      }
    >
      <form
        class="rt-tax-vendorform rt-stack"
        onSubmit={(event) => {
          event.preventDefault();
          submit();
        }}
        noValidate
      >
        <Show when={props.failure}>
          <Notice title={props.failure ?? ""} tone="error" role="alert" />
        </Show>
        <Show when={summary().length > 0}>
          <ErrorSummary errors={summary()} attempt={attempt()} />
        </Show>
        <TextField
          id="tax-vendor-name"
          label={words.formName}
          value={values().name}
          maxLength={120}
          required
          {...maybeError(shown().name)}
          onInput={(event) => set("name", event.currentTarget.value)}
        />
        <TextArea
          id="tax-vendor-payees"
          label={words.formPayees}
          hint={words.formPayeesHint}
          rows={3}
          value={values().payees}
          {...maybeError(shown().payees)}
          onInput={(event) => set("payees", event.currentTarget.value)}
        />
        <SelectField
          label={words.formReporting}
          items={REPORTING_ITEMS}
          value={values().reporting}
          onChange={(value) => set("reporting", value as TaxVendorReporting)}
        />
        <Show when={values().reporting === "no"}>
          <SelectField
            label={words.formReason}
            items={REASON_ITEMS}
            value={values().reason}
            placeholder=" "
            {...maybeError(shown().reason)}
            onChange={(value) => set("reason", value as TaxVendorReason)}
          />
        </Show>
        <div class="rt-tax-formrow">
          <SelectField
            label={words.formW9}
            items={W9_ITEMS}
            value={values().w9}
            onChange={(value) => set("w9", value as TaxVendorW9)}
          />
          <TextField
            id="tax-vendor-w9On"
            label={words.formW9On}
            hint={words.formW9OnHint}
            inputMode="numeric"
            value={values().w9On}
            {...maybeError(shown().w9On)}
            onInput={(event) => set("w9On", event.currentTarget.value)}
          />
        </div>
        <SelectField
          label={words.formClassification}
          items={CLASSIFICATION_ITEMS}
          value={values().classification === "" ? "none" : values().classification}
          onChange={(value) =>
            set("classification", value === "none" ? "" : (value as TaxVendorClassification))
          }
        />
        <SelectField
          label={words.formPaidBy}
          items={PAID_BY_ITEMS}
          value={values().paidBy}
          onChange={(value) => set("paidBy", value as TaxVendorPaidBy)}
        />
        <TextArea
          id="tax-vendor-notes"
          label={words.formNotes}
          hint={words.formNotesHint}
          rows={2}
          maxLength={500}
          value={values().notes}
          onInput={(event) => set("notes", event.currentTarget.value)}
        />
        <Details summary={words.formFilingDetails} defaultOpen={hasFilingDetails()}>
          <div class="rt-stack">
            <TextField
              id="tax-vendor-legalName"
              label={words.formLegalName}
              hint={words.formLegalNameHint}
              maxLength={200}
              value={values().legalName ?? ""}
              onInput={(event) => set("legalName", event.currentTarget.value)}
            />
            <div class="rt-tax-formrow">
              <TextField
                id="tax-vendor-email"
                type="email"
                label={words.formEmail}
                maxLength={254}
                value={values().email ?? ""}
                {...maybeError(shown().email)}
                onInput={(event) => set("email", event.currentTarget.value)}
              />
              <SelectField
                label={words.formTinStatus}
                hint={words.formTinStatusHint}
                items={TIN_STATUS_ITEMS}
                value={values().tinStatus ?? "not_collected"}
                onChange={(value) => set("tinStatus", value as TaxVendorTinStatus)}
              />
            </div>
            <TextField
              id="tax-vendor-addressLine1"
              label={words.formAddressLine1}
              maxLength={200}
              value={values().addressLine1 ?? ""}
              onInput={(event) => set("addressLine1", event.currentTarget.value)}
            />
            <TextField
              id="tax-vendor-addressLine2"
              label={words.formAddressLine2}
              maxLength={200}
              value={values().addressLine2 ?? ""}
              onInput={(event) => set("addressLine2", event.currentTarget.value)}
            />
            <div class="rt-tax-formrow">
              <TextField
                id="tax-vendor-addressCity"
                label={words.formAddressCity}
                maxLength={120}
                value={values().addressCity ?? ""}
                onInput={(event) => set("addressCity", event.currentTarget.value)}
              />
              <TextField
                id="tax-vendor-addressState"
                label={words.formAddressState}
                maxLength={40}
                value={values().addressState ?? ""}
                onInput={(event) => set("addressState", event.currentTarget.value)}
              />
              <TextField
                id="tax-vendor-addressPostalCode"
                label={words.formAddressPostal}
                maxLength={20}
                value={values().addressPostalCode ?? ""}
                onInput={(event) => set("addressPostalCode", event.currentTarget.value)}
              />
            </div>
          </div>
        </Details>
      </form>
      <Show when={props.vendor}>
        <section class="rt-tax-history" aria-label={words.formHistory}>
          <h3>{words.formHistory}</h3>
          <Show
            when={(props.history?.length ?? 0) > 0}
            fallback={<p class="rt-hint">{words.formHistoryNone}</p>}
          >
            <ol>
              <For each={props.history}>
                {(version) => (
                  <li>
                    Version {version.version}, {formatInstant(version.recordedAt)}, by{" "}
                    {version.principal}: {version.name}
                    <Show when={version.w9On}>, W-9 {formatDate(version.w9On as string)}</Show>
                  </li>
                )}
              </For>
            </ol>
          </Show>
        </section>
      </Show>
    </Dialog>
  );
}
