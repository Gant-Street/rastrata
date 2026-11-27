import { createSignal, createUniqueId, For, Show } from "solid-js";
import { ComboField } from "../combo-field";
import { DateField } from "../date-field";
import { RadioField } from "../radio-field";
import { SelectField } from "../select-field";
import { Button } from "../button";
import { ErrorSummary, type FormError } from "../error-summary";
import { FieldError } from "../field";
import { Notice } from "../notice";
import {
  STRIPE_ROLE_ORDER,
  type StripeAccountOption,
  type StripeRoleKey,
  type StripeRoleView,
  type StripeSettingsErrors,
  type StripeSettingsValues,
} from "./types";
import { roleLabels, words } from "./words";
import { Details } from "../kit/details";

const KINDS: Readonly<Record<StripeRoleKey, readonly string[]>> = {
  "payouts.in-transit": ["asset"],
  "revenue.sales": ["income"],
  "tax.sales": ["liability"],
  refunds: ["income", "expense"],
  chargebacks: ["expense", "income"],
  "stripe.fees": ["expense"],
  "stripe.adjustments": ["expense", "income"],
  "stripe.balance": ["asset"],
};

const ZONES = [
  "UTC",
  "America/New_York",
  "America/Chicago",
  "America/Denver",
  "America/Phoenix",
  "America/Los_Angeles",
  "America/Anchorage",
  "Pacific/Honolulu",
];

const WHOLE = /^\d{1,2}$/;

/** The first day, the time zone and how sales tax is handled; and, under Advanced, the chart account for
 * each Stripe role. A role left unchosen uses the one account the chart tags with that role's key, which is
 * right for nearly every book, so the eight choices are out of the way: Advanced opens by itself only when
 * a role that is needed has no account, or the service refused a choice. Each row says which account the
 * role uses now, or why there is none. The parent owns the save; this
 * validates what it can before sending and shows the server's refusals in an error summary that
 * links to the field. */
export function StripeSettingsForm(props: {
  accounts: readonly StripeAccountOption[];
  initial: StripeSettingsValues;
  /** The account each role uses today and why, as the service resolved it. */
  roles?: readonly StripeRoleView[];
  errors?: StripeSettingsErrors;
  pending?: boolean;
  saved?: boolean;
  /** The first day cannot change once Stripe lines are imported, and is then not shown: nothing can be done about it. */
  startLocked?: boolean;
  onSubmit: (values: StripeSettingsValues) => void;
}) {
  const uid = createUniqueId();
  const id = (name: string): string => `${uid}-${name}`;
  const [mapping, setMapping] = createSignal<Partial<Record<StripeRoleKey, string>>>({
    ...props.initial.mapping,
  });
  const [syncFrom, setSyncFrom] = createSignal(props.initial.syncFrom);
  const [timeZone, setTimeZone] = createSignal(props.initial.timeZone);
  const [salesTax, setSalesTax] = createSignal(props.initial.salesTax);
  const [overlap, setOverlap] = createSignal(props.initial.overlapDays);
  const [window, setWindow] = createSignal(props.initial.matchWindowDays);
  const [attempt, setAttempt] = createSignal(0);
  const [local, setLocal] = createSignal<StripeSettingsErrors>({});
  const shown = (): StripeSettingsErrors => ({
    ...local(),
    ...(props.errors ?? {}),
    mapping: { ...(local().mapping ?? {}), ...(props.errors?.mapping ?? {}) },
  });
  const view = (role: StripeRoleKey): StripeRoleView | undefined =>
    props.roles?.find((r) => r.role === role);
  const labelOf = (accountId: string | null): string | null =>
    accountId === null ? null : (props.accounts.find((a) => a.value === accountId)?.label ?? null);
  // Whether a role's account is needed: the optional one never is, and sales tax only when split.
  const needed = (role: StripeRoleKey): boolean =>
    (view(role)?.required ?? role !== "stripe.adjustments") &&
    (role !== "tax.sales" || salesTax() === "stripe");

  const list = (): FormError[] => {
    const errors = shown();
    return [
      ...STRIPE_ROLE_ORDER.flatMap((role) =>
        errors.mapping?.[role] ? [{ id: id(role), message: errors.mapping[role] as string }] : [],
      ),
      ...(errors.syncFrom ? [{ id: id("from"), message: errors.syncFrom }] : []),
      ...(errors.timeZone ? [{ id: id("zone"), message: errors.timeZone }] : []),
      ...(errors.overlapDays ? [{ id: id("overlap"), message: errors.overlapDays }] : []),
      ...(errors.matchWindowDays ? [{ id: id("window"), message: errors.matchWindowDays }] : []),
    ];
  };

  const optionsFor = (role: StripeRoleKey) =>
    props.accounts.filter(
      (account) =>
        KINDS[role].includes(account.kind) &&
        (!account.closed || mapping()[role] === account.value),
    );

  /** Something under Advanced needs the person: a role that is needed has no account, or a choice or a
   * number there was refused. Advanced is then open, so what the error summary links to can be reached. */
  const rolesNeedYou = (): boolean =>
    shown().overlapDays !== undefined ||
    shown().matchWindowDays !== undefined ||
    STRIPE_ROLE_ORDER.some(
      (role) => problemOf(role) !== null || shown().mapping?.[role] !== undefined,
    );

  const submit = (event: SubmitEvent) => {
    event.preventDefault();
    if (props.pending) return;
    const problems: StripeSettingsErrors = {
      ...(/^\d{4}-\d{2}-\d{2}$/.test(syncFrom().trim()) ? {} : { syncFrom: words.needDate }),
      ...(timeZone().trim() ? {} : { timeZone: words.needZone }),
      ...(WHOLE.test(overlap().trim()) && Number(overlap()) <= 30
        ? {}
        : { overlapDays: words.needWhole(0, 30) }),
      ...(WHOLE.test(window().trim()) && Number(window()) <= 14
        ? {}
        : { matchWindowDays: words.needWhole(0, 14) }),
    };
    const hasProblems =
      problems.syncFrom !== undefined ||
      problems.timeZone !== undefined ||
      problems.overlapDays !== undefined ||
      problems.matchWindowDays !== undefined;
    setLocal(problems);
    if (hasProblems) {
      setAttempt((value) => value + 1);
      return;
    }
    const chosen = Object.fromEntries(
      STRIPE_ROLE_ORDER.flatMap((role) => (mapping()[role] ? [[role, mapping()[role]]] : [])),
    ) as Partial<Record<StripeRoleKey, string>>;
    props.onSubmit({
      mapping: chosen,
      syncFrom: syncFrom().trim(),
      timeZone: timeZone().trim(),
      salesTax: salesTax(),
      overlapDays: overlap().trim(),
      matchWindowDays: window().trim(),
    });
  };

  /** Why a role that is needed has no account, in the service's words; null when it has one, or needs none. The account a role uses is the choice in its field, so nothing more is said of
   * a role that is settled. */
  const problemOf = (role: StripeRoleKey): string | null => {
    if (mapping()[role]) return null;
    const current = view(role);
    if (!current || current.state === "chosen" || current.state === "tagged" || !needed(role))
      return null;
    return current.problem ?? words.roleState(current.state, "");
  };
  /** The first choice of a role's field: the account the chart names for it, by name, or that there is none. */
  const chartChoice = (role: StripeRoleKey): string => {
    const current = view(role);
    return current?.state === "tagged"
      ? words.fromChart(labelOf(current.accountId) ?? current.code ?? "")
      : words.noAccount;
  };

  return (
    <form class="rt-stripe-settings" onSubmit={submit} noValidate aria-label={words.settingsTitle}>
      <Show when={list().length > 0}>
        <ErrorSummary errors={list()} title={words.errorsTitle} attempt={attempt()} />
      </Show>
      <Show when={shown().form}>
        <Notice title={words.saveFailed} tone="error" role="alert">
          {shown().form}
        </Notice>
      </Show>
      <div class="rt-stripe-options">
        <Show when={!props.startLocked}>
          <DateField
            id={id("from")}
            label={words.syncFrom}
            hint={words.syncFromHint}
            error={shown().syncFrom || undefined}
            value={syncFrom()}
            onChange={setSyncFrom}
          />
        </Show>
        <ComboField
          id={id("zone")}
          label={words.timeZone}
          hint={words.timeZoneHint}
          error={shown().timeZone || undefined}
          showLabel={words.timeZoneShow}
          items={ZONES}
          value={timeZone()}
          onChange={setTimeZone}
        />
        <RadioField
          class="rt-stripe-tax"
          label={words.salesTax}
          value={salesTax()}
          items={[
            { value: "stripe", label: words.salesTaxStripe, hint: words.salesTaxStripeHint },
            { value: "none", label: words.salesTaxNone, hint: words.salesTaxNoneHint },
          ]}
          onChange={(value) => setSalesTax(value as ReturnType<typeof salesTax>)}
        />
        <Details
          class="rt-stripe-advanced"
          flush
          defaultOpen={rolesNeedYou()}
          summary={words.advanced}
        >
          <h3 class="rt-stripe-roles-title">{words.rolesTitle}</h3>
          <div class="rt-stripe-roles">
            <For each={STRIPE_ROLE_ORDER}>
              {(role) => (
                <div class="rt-stripe-role" data-role={role}>
                  <SelectField
                    id={id(role)}
                    label={roleLabels[role]}
                    aside={
                      <Show when={!needed(role)}>
                        <span class="rt-stripe-tag">{words.optional}</span>
                      </Show>
                    }
                    error={shown().mapping?.[role]}
                    describedBy={`${id(role)}-status`}
                    value={mapping()[role] ?? ""}
                    items={[{ value: "", label: chartChoice(role) }, ...optionsFor(role)]}
                    onChange={(value) =>
                      setMapping((current) => ({ ...current, [role]: value || undefined }))
                    }
                  />
                  <p class="rt-stripe-role-status" id={`${id(role)}-status`}>
                    <Show when={problemOf(role)}>
                      {(problem) => (
                        <>
                          <span class="rt-cell" data-tone="attention" aria-hidden="true" />
                          <bdi>{problem()}</bdi>
                        </>
                      )}
                    </Show>
                  </p>
                </div>
              )}
            </For>
          </div>
          <div class="rt-stripe-options">
            <div class="rt-field">
              <div class="rt-label-row">
                <label for={id("overlap")}>{words.overlapDays}</label>
              </div>
              <input
                id={id("overlap")}
                class="rt-input"
                inputmode="numeric"
                value={overlap()}
                aria-invalid={shown().overlapDays ? true : undefined}
                aria-describedby={`${id("overlap")}-hint${shown().overlapDays ? ` ${id("overlap")}-error` : ""}`}
                onInput={(event) => setOverlap(event.currentTarget.value)}
              />
              <p class="rt-hint" id={`${id("overlap")}-hint`}>
                {words.overlapDaysHint}
              </p>
              <Show when={shown().overlapDays}>
                <FieldError id={`${id("overlap")}-error`}>{shown().overlapDays}</FieldError>
              </Show>
            </div>
            <div class="rt-field">
              <div class="rt-label-row">
                <label for={id("window")}>{words.matchWindowDays}</label>
              </div>
              <input
                id={id("window")}
                class="rt-input"
                inputmode="numeric"
                value={window()}
                aria-invalid={shown().matchWindowDays ? true : undefined}
                aria-describedby={`${id("window")}-hint${shown().matchWindowDays ? ` ${id("window")}-error` : ""}`}
                onInput={(event) => setWindow(event.currentTarget.value)}
              />
              <p class="rt-hint" id={`${id("window")}-hint`}>
                {words.matchWindowDaysHint}
              </p>
              <Show when={shown().matchWindowDays}>
                <FieldError id={`${id("window")}-error`}>{shown().matchWindowDays}</FieldError>
              </Show>
            </div>
          </div>
        </Details>
      </div>

      <div class="rt-stripe-actions">
        <Button
          type="submit"
          label={words.save}
          pendingLabel={words.saving}
          pending={props.pending ?? false}
        />
        <Show when={props.saved}>
          <p role="status" class="rt-stripe-saved">
            {words.saved}
          </p>
        </Show>
      </div>
    </form>
  );
}
