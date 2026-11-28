import { createEffect, createMemo, createSignal, createUniqueId, on, Show } from "solid-js";
import { CheckField } from "../accounting-controls";
import { Button } from "../button";
import { ErrorSummary, type FormError } from "../error-summary";
import { Details } from "../kit";
import { Notice } from "../notice";
import { SelectField } from "../select-field";
import { TextField } from "../text-field";
import { cleanEntryText } from "./quick-entry";
import { businessWords as words } from "./words";

export type BusinessDateFormat = "medium" | "numeric" | "iso";
export type BusinessAcceptMode = "post" | "draft";
export type BusinessEntityType =
  | "sole_proprietorship"
  | "single_member_llc"
  | "multi_member_llc"
  | "s_corp"
  | "c_corp"
  | "partnership"
  | "nonprofit"
  | "other";

export interface BusinessEntityAddress {
  readonly line1?: string | undefined;
  readonly line2?: string | undefined;
  readonly city?: string | undefined;
  readonly state?: string | undefined;
  readonly postalCode?: string | undefined;
  readonly country?: string | undefined;
}

export interface BusinessEntityValues {
  readonly legalName?: string | null | undefined;
  readonly ein?: string | null | undefined;
  readonly entityType?: BusinessEntityType | null | undefined;
  readonly formationState?: string | null | undefined;
  readonly address?: BusinessEntityAddress | null | undefined;
  readonly contactEmail?: string | null | undefined;
}

/** What the form edits: the business name, display preferences, and optional legal entity metadata. */
export interface BusinessValues {
  readonly name: string;
  readonly dateFormat: BusinessDateFormat;
  readonly showAccountNumbers: boolean;
  readonly acceptMode: BusinessAcceptMode;
  readonly entity?: BusinessEntityValues | undefined;
}

const MAX_NAME = 120;
const EIN_PATTERN = /^\d{2}-?\d{7}$/;
const STATE_PATTERN = /^[A-Za-z]{2}$/;
const EMAIL_PATTERN = /^[^\s@]+@[^\s@]+$/;

const ENTITY_TYPE_ITEMS: readonly { value: string; label: string }[] = [
  { value: "none", label: words.entityTypeNone },
  { value: "sole_proprietorship", label: words.entityTypes.sole_proprietorship },
  { value: "single_member_llc", label: words.entityTypes.single_member_llc },
  { value: "multi_member_llc", label: words.entityTypes.multi_member_llc },
  { value: "s_corp", label: words.entityTypes.s_corp },
  { value: "c_corp", label: words.entityTypes.c_corp },
  { value: "partnership", label: words.entityTypes.partnership },
  { value: "nonprofit", label: words.entityTypes.nonprofit },
  { value: "other", label: words.entityTypes.other },
];

export interface BusinessEntityAddressPatch {
  readonly line1?: string;
  readonly line2?: string;
  readonly city?: string;
  readonly state?: string;
  readonly postalCode?: string;
  readonly country?: string;
}

export interface BusinessEntityPatch {
  readonly legalName?: string | null;
  readonly ein?: string | null;
  readonly entityType?: BusinessEntityType | null;
  readonly formationState?: string | null;
  readonly address?: BusinessEntityAddressPatch | null;
  readonly contactEmail?: string | null;
}

export interface BusinessPatch {
  readonly name?: string;
  readonly dateFormat?: BusinessDateFormat;
  readonly showAccountNumbers?: boolean;
  readonly acceptMode?: BusinessAcceptMode;
  readonly entity?: BusinessEntityPatch;
}

const trimOrNull = (value: string | null | undefined): string | null => {
  const cleaned = (value ?? "").trim();
  return cleaned === "" ? null : cleaned;
};

const normalizeEin = (value: string | null | undefined): string | null => {
  const cleaned = (value ?? "").trim();
  if (cleaned === "") return null;
  const digits = cleaned.replace(/-/g, "");
  return /^\d{9}$/.test(digits) ? `${digits.slice(0, 2)}-${digits.slice(2)}` : cleaned;
};

const normalizeState = (value: string | null | undefined): string | null => {
  const cleaned = (value ?? "").trim().toUpperCase();
  return cleaned === "" ? null : cleaned;
};

function normalizeAddress(
  address: BusinessEntityAddress | null | undefined,
): BusinessEntityAddressPatch | null {
  if (!address) return null;
  const line1 = (address.line1 ?? "").trim();
  const line2 = (address.line2 ?? "").trim();
  const city = (address.city ?? "").trim();
  const state = (address.state ?? "").trim().toUpperCase();
  const postalCode = (address.postalCode ?? "").trim();
  const country = (address.country ?? "").trim().toUpperCase();
  if (!line1 && !line2 && !city && !state && !postalCode && !country) return null;
  return {
    ...(line1 ? { line1 } : {}),
    ...(line2 ? { line2 } : {}),
    ...(city ? { city } : {}),
    ...(state ? { state } : {}),
    ...(postalCode ? { postalCode } : {}),
    ...(country ? { country } : {}),
  };
}

function sameAddress(
  left: BusinessEntityAddressPatch | null,
  right: BusinessEntityAddressPatch | null,
): boolean {
  if (!left && !right) return true;
  if (!left || !right) return false;
  return (
    (left.line1 ?? "") === (right.line1 ?? "") &&
    (left.line2 ?? "") === (right.line2 ?? "") &&
    (left.city ?? "") === (right.city ?? "") &&
    (left.state ?? "") === (right.state ?? "") &&
    (left.postalCode ?? "") === (right.postalCode ?? "") &&
    (left.country ?? "") === (right.country ?? "")
  );
}

function entityDiff(
  saved: BusinessEntityValues | undefined,
  wanted: BusinessEntityValues | undefined,
): BusinessEntityPatch | undefined {
  if (saved === undefined && wanted === undefined) return undefined;
  const patch: {
    legalName?: string | null;
    ein?: string | null;
    entityType?: BusinessEntityType | null;
    formationState?: string | null;
    address?: BusinessEntityAddressPatch | null;
    contactEmail?: string | null;
  } = {};
  const nextLegal = trimOrNull(wanted?.legalName);
  if (nextLegal !== trimOrNull(saved?.legalName)) patch.legalName = nextLegal;
  const nextEin = normalizeEin(wanted?.ein);
  if (nextEin !== normalizeEin(saved?.ein)) patch.ein = nextEin;
  const nextType = wanted?.entityType ?? null;
  if (nextType !== (saved?.entityType ?? null)) patch.entityType = nextType;
  const nextState = normalizeState(wanted?.formationState);
  if (nextState !== normalizeState(saved?.formationState)) patch.formationState = nextState;
  const nextAddr = normalizeAddress(wanted?.address);
  if (!sameAddress(nextAddr, normalizeAddress(saved?.address))) patch.address = nextAddr;
  const nextEmail = trimOrNull(wanted?.contactEmail);
  if (nextEmail !== trimOrNull(saved?.contactEmail)) patch.contactEmail = nextEmail;
  return Object.keys(patch).length > 0 ? patch : undefined;
}

const hasEntityData = (entity: BusinessEntityValues | undefined): boolean =>
  Boolean(
    trimOrNull(entity?.legalName) ||
      trimOrNull(entity?.ein) ||
      entity?.entityType ||
      trimOrNull(entity?.formationState) ||
      trimOrNull(entity?.contactEmail) ||
      normalizeAddress(entity?.address),
  );

/** What differs between what the book has and what the form holds, ready to send: only the names of
 * what changed. A name that differs only in spacing is not a change. */
export function changesIn(saved: BusinessValues, wanted: BusinessValues): BusinessPatch {
  const name = cleanEntryText(wanted.name, MAX_NAME);
  const entity = entityDiff(saved.entity, wanted.entity);
  return {
    ...(name !== cleanEntryText(saved.name, MAX_NAME) ? { name } : {}),
    ...(wanted.dateFormat !== saved.dateFormat ? { dateFormat: wanted.dateFormat } : {}),
    ...(wanted.showAccountNumbers !== saved.showAccountNumbers
      ? { showAccountNumbers: wanted.showAccountNumbers }
      : {}),
    ...(wanted.acceptMode !== saved.acceptMode ? { acceptMode: wanted.acceptMode } : {}),
    ...(entity !== undefined ? { entity } : {}),
  };
}

/** The business name, how dates read, whether lists show account numbers, what accepting a suggestion
 * does, and optional legal entity metadata. The parent saves and passes back what the book now holds
 * as `saved`; the form keeps what is being typed until then, and says plainly when there is nothing to save. */
export function BusinessSettingsForm(props: {
  saved: BusinessValues;
  pending?: boolean | undefined;
  /** What happened last, read out politely: "Saved." */
  message?: string | undefined;
  /** A refusal in words. */
  error?: string | undefined;
  /** An earlier save whose reply was lost: resume it, never save again. */
  uncertain?: boolean | undefined;
  onResume?: () => void;
  /** An example date for each format, rendered by the formatter. */
  dateExamples?: Partial<Record<BusinessDateFormat, string>> | undefined;
  onSave: (values: BusinessValues) => void;
}) {
  const uid = createUniqueId();
  const nameId = `${uid}-name`;
  const einId = `${uid}-ein`;
  const stateId = `${uid}-formation-state`;
  const emailId = `${uid}-contact-email`;
  const [name, setName] = createSignal(props.saved.name);
  const [dateFormat, setDateFormat] = createSignal<BusinessDateFormat>(props.saved.dateFormat);
  const [accountNumbers, setAccountNumbers] = createSignal(props.saved.showAccountNumbers);
  const [acceptMode, setAcceptMode] = createSignal<BusinessAcceptMode>(props.saved.acceptMode);
  const [legalName, setLegalName] = createSignal(props.saved.entity?.legalName ?? "");
  const [ein, setEin] = createSignal(props.saved.entity?.ein ?? "");
  const [entityType, setEntityType] = createSignal<BusinessEntityType | "">(
    props.saved.entity?.entityType ?? "",
  );
  const [formationState, setFormationState] = createSignal(
    props.saved.entity?.formationState ?? "",
  );
  const [contactEmail, setContactEmail] = createSignal(props.saved.entity?.contactEmail ?? "");
  const [addressLine1, setAddressLine1] = createSignal(props.saved.entity?.address?.line1 ?? "");
  const [addressLine2, setAddressLine2] = createSignal(props.saved.entity?.address?.line2 ?? "");
  const [addressCity, setAddressCity] = createSignal(props.saved.entity?.address?.city ?? "");
  const [addressState, setAddressState] = createSignal(props.saved.entity?.address?.state ?? "");
  const [addressPostal, setAddressPostal] = createSignal(
    props.saved.entity?.address?.postalCode ?? "",
  );
  const [attempt, setAttempt] = createSignal(0);
  const [problem, setProblem] = createSignal<string | undefined>(undefined);
  const [einError, setEinError] = createSignal<string | undefined>(undefined);
  const [stateError, setStateError] = createSignal<string | undefined>(undefined);
  const [emailError, setEmailError] = createSignal<string | undefined>(undefined);

  // What the book holds changed (it was saved, or read again): the form holds that now.
  createEffect(
    on(
      () => props.saved,
      (saved) => {
        setName(saved.name);
        setDateFormat(saved.dateFormat);
        setAccountNumbers(saved.showAccountNumbers);
        setAcceptMode(saved.acceptMode);
        setLegalName(saved.entity?.legalName ?? "");
        setEin(saved.entity?.ein ?? "");
        setEntityType(saved.entity?.entityType ?? "");
        setFormationState(saved.entity?.formationState ?? "");
        setContactEmail(saved.entity?.contactEmail ?? "");
        setAddressLine1(saved.entity?.address?.line1 ?? "");
        setAddressLine2(saved.entity?.address?.line2 ?? "");
        setAddressCity(saved.entity?.address?.city ?? "");
        setAddressState(saved.entity?.address?.state ?? "");
        setAddressPostal(saved.entity?.address?.postalCode ?? "");
        setProblem(undefined);
        setEinError(undefined);
        setStateError(undefined);
        setEmailError(undefined);
      },
      { defer: true },
    ),
  );

  const wantedEntity = (): BusinessEntityValues => ({
    legalName: trimOrNull(legalName()),
    ein: normalizeEin(ein()),
    entityType: entityType() === "" ? null : (entityType() as BusinessEntityType),
    formationState: normalizeState(formationState()),
    contactEmail: trimOrNull(contactEmail()),
    address: normalizeAddress({
      line1: addressLine1(),
      line2: addressLine2(),
      city: addressCity(),
      state: addressState(),
      postalCode: addressPostal(),
    }),
  });

  const wanted = (): BusinessValues => ({
    name: name(),
    dateFormat: dateFormat(),
    showAccountNumbers: accountNumbers(),
    acceptMode: acceptMode(),
    entity: wantedEntity(),
  });
  const changed = createMemo(() => Object.keys(changesIn(props.saved, wanted())).length > 0);

  const submit = (event: SubmitEvent) => {
    event.preventDefault();
    if (props.pending) return;
    const clean = cleanEntryText(name(), MAX_NAME);
    const nextNameProblem = clean.length < 2 ? words.nameRequired : undefined;
    const rawEin = ein().trim();
    const nextEinProblem =
      rawEin !== "" && !EIN_PATTERN.test(rawEin) ? words.entityEinBad : undefined;
    const rawState = formationState().trim();
    const nextStateProblem =
      rawState !== "" && !STATE_PATTERN.test(rawState) ? words.entityStateBad : undefined;
    const rawEmail = contactEmail().trim();
    const nextEmailProblem =
      rawEmail !== "" && !EMAIL_PATTERN.test(rawEmail) ? words.entityEmailBad : undefined;
    setProblem(nextNameProblem);
    setEinError(nextEinProblem);
    setStateError(nextStateProblem);
    setEmailError(nextEmailProblem);
    if (nextNameProblem || nextEinProblem || nextStateProblem || nextEmailProblem) {
      setAttempt((count) => count + 1);
      return;
    }
    if (!changed()) return;
    props.onSave({ ...wanted(), name: clean });
  };

  const items = (): { value: BusinessDateFormat; label: string }[] =>
    (["medium", "numeric", "iso"] as const).map((value) => {
      const example = props.dateExamples?.[value];
      return {
        value,
        label: example ? `${words.dateOptions[value]} (${example})` : words.dateOptions[value],
      };
    });
  const errors = (): FormError[] =>
    [
      problem() ? { id: nameId, message: problem() as string } : null,
      einError() ? { id: einId, message: einError() as string } : null,
      stateError() ? { id: stateId, message: stateError() as string } : null,
      emailError() ? { id: emailId, message: emailError() as string } : null,
    ].filter((item): item is FormError => item !== null);

  return (
    <form class="rt-business-form rt-stack" onSubmit={submit} novalidate aria-label={words.title}>
      <Show when={errors().length > 0}>
        <ErrorSummary errors={errors()} title="Fix this before you save" attempt={attempt()} />
      </Show>
      <Show when={props.error}>
        <Notice title={words.failed} tone="error" role="alert">
          {props.error}
        </Notice>
      </Show>
      <Show when={props.uncertain}>
        <Notice title={words.uncertain} tone="review" role="status">
          <Button
            type="button"
            label={words.resume}
            variant="secondary"
            size="sm"
            onClick={() => props.onResume?.()}
          />
        </Notice>
      </Show>
      <TextField
        id={nameId}
        label={words.nameLabel}
        autocomplete="organization"
        maxLength={MAX_NAME}
        required
        disabled={props.pending ?? false}
        value={name()}
        onInput={(event) => setName(event.currentTarget.value)}
        {...(problem() ? { error: problem() as string } : {})}
      />
      <SelectField
        label={words.dateLabel}
        items={items()}
        value={dateFormat()}
        onChange={(value) => setDateFormat(value as BusinessDateFormat)}
        disabled={props.pending ?? false}
      />
      <CheckField
        label={words.accountNumbersLabel}
        checked={accountNumbers()}
        onChange={setAccountNumbers}
        disabled={props.pending ?? false}
      />
      <SelectField
        label={words.acceptLabel}
        items={[
          { value: "post", label: words.acceptOptions.post },
          { value: "draft", label: words.acceptOptions.draft },
        ]}
        value={acceptMode()}
        onChange={(value) => setAcceptMode(value as BusinessAcceptMode)}
        disabled={props.pending ?? false}
      />
      <div class="rt-business-entity">
        <Details summary={words.entitySummary} defaultOpen={hasEntityData(props.saved.entity)}>
          <div class="rt-stack">
            <TextField
              label={words.entityLegalNameLabel}
              hint={words.entityLegalNameHint}
              maxLength={200}
              disabled={props.pending ?? false}
              value={legalName()}
              onInput={(event) => setLegalName(event.currentTarget.value)}
            />
            <div class="rt-business-entity-row">
              <TextField
                id={einId}
                label={words.entityEinLabel}
                hint={words.entityEinHint}
                maxLength={10}
                inputMode="numeric"
                disabled={props.pending ?? false}
                value={ein()}
                onInput={(event) => {
                  setEin(event.currentTarget.value);
                  setEinError(undefined);
                }}
                {...(einError() ? { error: einError() as string } : {})}
              />
              <TextField
                id={stateId}
                label={words.entityStateLabel}
                hint={words.entityStateHint}
                maxLength={2}
                disabled={props.pending ?? false}
                value={formationState()}
                onInput={(event) => {
                  setFormationState(event.currentTarget.value);
                  setStateError(undefined);
                }}
                {...(stateError() ? { error: stateError() as string } : {})}
              />
            </div>
            <SelectField
              label={words.entityTypeLabel}
              items={ENTITY_TYPE_ITEMS}
              value={entityType() === "" ? "none" : entityType()}
              onChange={(value) =>
                setEntityType(value === "none" ? "" : (value as BusinessEntityType))
              }
              disabled={props.pending ?? false}
            />
            <TextField
              id={emailId}
              type="email"
              label={words.entityEmailLabel}
              maxLength={254}
              disabled={props.pending ?? false}
              value={contactEmail()}
              onInput={(event) => {
                setContactEmail(event.currentTarget.value);
                setEmailError(undefined);
              }}
              {...(emailError() ? { error: emailError() as string } : {})}
            />
            <TextField
              label={words.entityAddressLine1Label}
              maxLength={200}
              disabled={props.pending ?? false}
              value={addressLine1()}
              onInput={(event) => setAddressLine1(event.currentTarget.value)}
            />
            <TextField
              label={words.entityAddressLine2Label}
              maxLength={200}
              disabled={props.pending ?? false}
              value={addressLine2()}
              onInput={(event) => setAddressLine2(event.currentTarget.value)}
            />
            <div class="rt-business-entity-addr">
              <TextField
                label={words.entityAddressCityLabel}
                maxLength={120}
                disabled={props.pending ?? false}
                value={addressCity()}
                onInput={(event) => setAddressCity(event.currentTarget.value)}
              />
              <TextField
                label={words.entityAddressStateLabel}
                maxLength={40}
                disabled={props.pending ?? false}
                value={addressState()}
                onInput={(event) => setAddressState(event.currentTarget.value)}
              />
              <TextField
                label={words.entityAddressPostalLabel}
                maxLength={20}
                disabled={props.pending ?? false}
                value={addressPostal()}
                onInput={(event) => setAddressPostal(event.currentTarget.value)}
              />
            </div>
          </div>
        </Details>
      </div>
      <div class="rt-row">
        <Button
          type="submit"
          label={words.save}
          pendingLabel={words.saving}
          pending={props.pending ?? false}
          disabled={!changed() && !props.pending}
        />
        <Show when={props.message}>
          <p class="rt-business-status" role="status">
            {props.message}
          </p>
        </Show>
      </div>
    </form>
  );
}
