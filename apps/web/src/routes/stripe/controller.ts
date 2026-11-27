import type {
  AccountRow,
  StripePayoutRow,
  StripeRoleStatus,
  StripeStatus,
  StripeSyncRun,
} from "@rastrata/application/client-contracts";
import type {
  StripeAccountOption,
  StripeBalanceView,
  StripeCardSummary,
  StripePayoutView,
  StripeRoleKey,
  StripeRoleView,
  StripeRun,
  StripeSettingsErrors,
  StripeSettingsValues,
} from "@rastrata/ui/stripe/types";

/** Pure translation between what the Stripe operations return and what the screen shows. No
 * fetching, no state: so every rule here (which message belongs to which field, what "ago" says) is
 * tested without a browser. */

export const SETTINGS = "stripe:configure";
export const SYNC = "stripe:sync";

/** The role a refusal is about. The service's messages name the role they refuse by its label
 * ("Stripe fees must be an expense account; ...", "The account chosen for Refunds is no longer in
 * the chart", "Account 4010, chosen for Chargebacks and disputes, is closed"), and the labels come
 * from the service's own list of roles. They are tried longest first, so "Sales tax payable" is
 * never taken for "Sales". */
function roleOfMessage(
  message: string,
  roles: readonly { readonly role: StripeRoleKey; readonly label: string }[],
): StripeRoleKey | null {
  const byLength = [...roles].sort((a, b) => b.label.length - a.label.length);
  for (const { role, label } of byLength)
    if (message.startsWith(label) || message.includes(`for ${label}`)) return role;
  return null;
}

/** Rastrata's own reading of a refusal, attached to the field it is about. Anything else stays a
 * message about the whole form. */
export function settingsErrors(
  message: string,
  roles: readonly { readonly role: StripeRoleKey; readonly label: string }[],
): StripeSettingsErrors {
  const role = roleOfMessage(message, roles);
  if (role) return { mapping: { [role]: message } };
  if (/^syncFrom/i.test(message)) return { syncFrom: message };
  if (/^timeZone/i.test(message)) return { timeZone: message };
  if (/overlapDays/i.test(message)) return { overlapDays: message };
  if (/matchWindowDays/i.test(message)) return { matchWindowDays: message };
  return { form: message };
}

export function accountOptions(accounts: readonly AccountRow[]): StripeAccountOption[] {
  return accounts.map((account) => ({
    value: account.id,
    label: `${account.code} · ${account.name}`,
    kind: account.role,
    closed: account.closedOn !== null,
  }));
}

export function roleView(role: StripeRoleStatus): StripeRoleView {
  return {
    role: role.role,
    required: role.required,
    state: role.state,
    accountId: role.accountId,
    code: role.code,
    problem: role.problem,
  };
}

/** The form's starting values: what is saved, else sensible defaults. The mapping holds only what
 * the owner chose; a role left out uses the account the chart's role key names, and the form shows
 * which. */
export function settingsValues(
  status: StripeStatus,
  fiscalYearStart: string,
): { values: StripeSettingsValues; saved: boolean } {
  const saved = status.settings;
  if (saved)
    return {
      saved: true,
      values: {
        mapping: Object.fromEntries(saved.mapping.map((m) => [m.role, m.accountId])),
        syncFrom: saved.syncFrom,
        timeZone: saved.timeZone,
        salesTax: saved.salesTax,
        overlapDays: String(saved.overlapDays),
        matchWindowDays: String(saved.matchWindowDays),
      },
    };
  return {
    saved: false,
    values: {
      mapping: {},
      syncFrom: fiscalYearStart,
      timeZone: status.account?.timeZone ?? "UTC",
      salesTax: "stripe",
      overlapDays: "3",
      matchWindowDays: "2",
    },
  };
}

export function runView(run: StripeSyncRun): StripeRun {
  return {
    id: run.id,
    startedAt: run.startedAt,
    finishedAt: run.finishedAt,
    disposition: run.disposition,
    requests: run.requests,
    transactions: run.transactions,
    newLines: run.newLines,
    duplicateLines: run.duplicateLines,
    heldLines: run.heldLines,
    payouts: run.payouts,
    through: run.through,
    errorCode: run.errorCode,
    errorMessage: run.errorMessage,
    notes: run.notes,
  };
}

export function balanceView(status: StripeStatus): StripeBalanceView {
  const b = status.balance;
  const snapshot = b.snapshot;
  return {
    readAt: snapshot?.readAt ?? null,
    currency: snapshot?.currency ?? status.bookCurrency,
    stripeTotal: snapshot?.total ?? null,
    available: snapshot?.available ?? null,
    pending: snapshot?.pending ?? null,
    unpaid: b.unpaid,
    unpaidCount: b.unpaidCount,
    difference: b.difference,
    inTransit: b.inTransit,
    ties: b.ties,
    stale: b.stale,
    explanation: b.explanation,
  };
}

export function payoutView(row: StripePayoutRow): StripePayoutView {
  return {
    id: row.id,
    arrivalOn: row.arrivalOn,
    amount: row.amount,
    currency: row.currency,
    status: row.status,
    automatic: row.automatic,
    booking: row.booking,
    memberCount: row.memberCount,
    memberNet: row.memberNet,
    difference: row.difference,
    deposit: row.deposit,
    reason: row.reason,
  };
}

/** The accounts Stripe needs and has none for, by name: what stands between a book and a reading, and the one thing the options ask of a person. Empty when every one is settled (the
 * chart of a book made from a template names them all, so this is the usual case and nothing is asked). */
export function openRoles(status: StripeStatus): string[] {
  return status.roles
    .filter(
      (r) =>
        r.required && (r.state === "missing" || r.state === "ambiguous" || r.state === "unusable"),
    )
    .map((r) => r.label);
}

export function cardSummary(status: StripeStatus): StripeCardSummary {
  const last = status.lastSync;
  return {
    stage: !status.configured
      ? "unconfigured"
      : !status.key.present && !status.link
        ? "no-key"
        : "ready",
    lastSync: last
      ? {
          at: last.finishedAt ?? last.startedAt,
          ok: last.disposition !== "failed",
          payouts: last.payouts,
        }
      : null,
    held: status.payouts.held,
    mismatched: status.payouts.mismatched,
    waiting: status.payouts.waiting,
    unmatched: status.payouts.unmatched,
  };
}

/** The first day of the fiscal year the book began in, "YYYY-MM-DD". */
export function fiscalYearStart(setup: {
  readonly fiscalYear: number;
  readonly fiscalYearStartMonth?: number | undefined;
}): string {
  return `${setup.fiscalYear}-${String(setup.fiscalYearStartMonth ?? 1).padStart(2, "0")}-01`;
}
