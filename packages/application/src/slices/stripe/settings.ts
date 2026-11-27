import { ApplicationError } from "../../errors.ts";
import { addDays, isDate, isTimeZone } from "../../stripe/dates.ts";
import {
  ROLE_KINDS,
  ROLE_LABELS,
  STRIPE_ROLES,
  type StripeRole,
  isStripeRole,
} from "../../stripe/roles.ts";

/** What the owner decides about the Stripe connection, kept as one record that is replaced whole.
 * A retried or repeated `stripe.configure` therefore gives the same result, and a screen always
 * shows the complete truth instead of a patch history. */

export interface RoleAccount {
  readonly role: StripeRole;
  readonly accountId: string;
}

export interface StripeSettings {
  readonly mapping: readonly RoleAccount[];
  /** The first day to import, YYYY-MM-DD. */
  readonly syncFrom: string;
  /** The IANA zone that decides which day a Stripe instant falls on. */
  readonly timeZone: string;
  /** `stripe`: take sales tax from the Checkout Session or invoice Stripe reports it on. */
  readonly salesTax: "stripe" | "none";
  /** How far before the last applied point each sync reads again, to catch late arrivals. */
  readonly overlapDays: number;
  /** How many days from its arrival date a bank deposit may be and still match a payout. */
  readonly matchWindowDays: number;
  /** "stripe:acct_...", learned from Stripe on the first sync and never changed afterwards. */
  readonly accountKey: string | null;
}

export interface ChartAccount {
  readonly id: string;
  readonly code: string;
  readonly role: string;
  readonly closedOn: string | null;
}

export const DEFAULT_OVERLAP_DAYS = 3;
export const DEFAULT_MATCH_WINDOW_DAYS = 2;

export function defaultSettings(syncFrom: string): StripeSettings {
  return {
    mapping: [],
    syncFrom,
    timeZone: "UTC",
    salesTax: "stripe",
    overlapDays: DEFAULT_OVERLAP_DAYS,
    matchWindowDays: DEFAULT_MATCH_WINDOW_DAYS,
    accountKey: null,
  };
}

export function parseSettings(body: string | null): StripeSettings | null {
  if (!body) return null;
  try {
    const value = JSON.parse(body) as StripeSettings;
    return {
      mapping: value.mapping.filter((m) => isStripeRole(m.role)),
      syncFrom: value.syncFrom,
      timeZone: value.timeZone,
      salesTax: value.salesTax,
      overlapDays: value.overlapDays,
      matchWindowDays: value.matchWindowDays,
      accountKey: value.accountKey ?? null,
    };
  } catch {
    return null;
  }
}

export function serialiseSettings(settings: StripeSettings): string {
  return JSON.stringify({
    mapping: [...settings.mapping].sort((a, b) => a.role.localeCompare(b.role)),
    syncFrom: settings.syncFrom,
    timeZone: settings.timeZone,
    salesTax: settings.salesTax,
    overlapDays: settings.overlapDays,
    matchWindowDays: settings.matchWindowDays,
    accountKey: settings.accountKey,
  });
}

/** The roles an import cannot run without. The sales tax account is needed only when tax is split;
 * the adjustments account is optional (without it, a payout that contains adjustments is shown but
 * not proposed). */
export function requiredRoles(settings: Pick<StripeSettings, "salesTax">): readonly StripeRole[] {
  return STRIPE_ROLES.filter((role) => {
    if (role === "stripe.adjustments") return false;
    if (role === "tax.sales") return settings.salesTax === "stripe";
    return true;
  });
}

/** How a role came to have an account, or why it has none:
 *  - `chosen`: the owner picked the account in Settings.
 *  - `tagged`: the owner picked none, and exactly one open account carries the role key.
 *  - `missing`: none picked and no open account carries the key.
 *  - `ambiguous`: none picked and more than one open account carries the key.
 *  - `unusable`: an account is named (picked, or the only one tagged) but cannot be used: it is
 *    closed, no longer in the chart, or the wrong kind of account. */
export type RoleState = "chosen" | "tagged" | "missing" | "ambiguous" | "unusable";

export interface RoleResolution {
  readonly role: StripeRole;
  readonly required: boolean;
  readonly state: RoleState;
  readonly accountId: string | null;
  readonly code: string | null;
  /** What is wrong and what to do about it; null when the role has its account. */
  readonly problem: string | null;
}

/** The role key an account carries on a date (the chart's tag, versioned by effective date). */
export type RoleKeyOf = (accountId: string, asOf: string) => string | undefined;

/** Closing on a date takes the account out of use from that date, so the day it closes is already
 * too late: the answer is deliberately the cautious one. */
const openOn = (account: ChartAccount, asOf: string): boolean =>
  account.closedOn === null || account.closedOn > asOf;

const codes = (accounts: readonly ChartAccount[]): string => accounts.map((a) => a.code).join(", ");

const kindsOf = (role: StripeRole): string => {
  const kinds = ROLE_KINDS[role] as readonly string[];
  return `${/^[aeiou]/.test(kinds[0] ?? "") ? "an" : "a"} ${kinds.join(" or ")} account`;
};

/** Which chart account each Stripe role uses on `asOf`: the one the owner chose, else the one open
 * account that carries the role key on that date, never one guessed from a name or a code. A
 * journal is dated, so the date it is booked on decides which tag applies. */
export function resolveRoles(
  settings: Pick<StripeSettings, "mapping" | "salesTax">,
  chart: readonly ChartAccount[],
  roleKeyOf: RoleKeyOf,
  asOf: string,
): RoleResolution[] {
  const byId = new Map(chart.map((a) => [a.id, a]));
  const required = new Set(requiredRoles(settings));
  const holders = new Map<string, ChartAccount[]>();
  for (const account of chart) {
    if (!openOn(account, asOf)) continue;
    const key = roleKeyOf(account.id, asOf);
    if (key !== undefined && isStripeRole(key))
      holders.set(key, [...(holders.get(key) ?? []), account]);
  }
  const first = STRIPE_ROLES.map((role): RoleResolution => {
    const label = ROLE_LABELS[role];
    const base = { role, required: required.has(role) };
    const unusable = (account: ChartAccount | null, problem: string): RoleResolution => ({
      ...base,
      state: "unusable",
      accountId: null,
      code: account?.code ?? null,
      problem,
    });
    const wrongKind = (account: ChartAccount): string | null =>
      (ROLE_KINDS[role] as readonly string[]).includes(account.role)
        ? null
        : `${label} must be ${kindsOf(role)}; ${account.code} is ${account.role}.`;

    const chosen = settings.mapping.find((m) => m.role === role);
    if (chosen) {
      const account = byId.get(chosen.accountId);
      if (!account)
        return unusable(
          null,
          `The account chosen for ${label} is no longer in the chart. Choose another account.`,
        );
      if (!openOn(account, asOf))
        return unusable(
          account,
          `Account ${account.code}, chosen for ${label}, is closed. Choose another account.`,
        );
      const wrong = wrongKind(account);
      if (wrong) return unusable(account, `${wrong} Choose another account.`);
      return { ...base, state: "chosen", accountId: account.id, code: account.code, problem: null };
    }
    const tagged = holders.get(role) ?? [];
    const [only] = tagged;
    if (!only)
      return {
        ...base,
        state: "missing",
        accountId: null,
        code: null,
        problem: `No account is chosen for ${label}, and no open account carries the role key ${role}. Choose one here, or give an account that role key in your chart of accounts.`,
      };
    if (tagged.length > 1)
      return {
        ...base,
        state: "ambiguous",
        accountId: null,
        code: null,
        problem: `Accounts ${codes(tagged)} all carry the role key ${role}, so Rastrata cannot tell which is ${label}. Choose one here, or leave the key on one account.`,
      };
    const wrong = wrongKind(only);
    if (wrong)
      return unusable(
        only,
        `${wrong} It carries the role key ${role}: choose another account here, or move the key.`,
      );
    return { ...base, state: "tagged", accountId: only.id, code: only.code, problem: null };
  });
  // The Stripe balance is its own account: nothing else Stripe books to may be the same one.
  const balance = first.find((r) => r.role === "stripe.balance" && isResolved(r));
  if (!balance) return first;
  return first.map((r) =>
    r.role !== "stripe.balance" && isResolved(r) && r.accountId === balance.accountId
      ? {
          ...r,
          state: "unusable" as const,
          accountId: null,
          problem: `${ROLE_LABELS[r.role]} cannot use account ${r.code}: it is the Stripe balance. Choose another account here, or move the role key.`,
        }
      : r,
  );
}

/** What the owner chose must work. A choice that cannot is refused when it is made; what the chart's
 * role keys give is only reported, because the owner can fix it in the chart. */
export function rejectUnusableChoices(
  settings: Pick<StripeSettings, "mapping">,
  roles: readonly RoleResolution[],
): void {
  for (const role of roles) {
    if (role.state !== "unusable" || !role.problem) continue;
    if (settings.mapping.some((m) => m.role === role.role)) invalid(role.problem, "input.mapping");
  }
}

export const isResolved = (r: RoleResolution): boolean =>
  r.state === "chosen" || r.state === "tagged";

/** Every role an import cannot run without has its account. */
export const isReady = (roles: readonly RoleResolution[]): boolean =>
  roles.every((r) => !r.required || isResolved(r));

/** The required roles that still lack an account. */
export const unresolvedRoles = (roles: readonly RoleResolution[]): RoleResolution[] =>
  roles.filter((r) => r.required && !isResolved(r));

export function accountOf(roles: readonly RoleResolution[], role: StripeRole): string | null {
  const found = roles.find((r) => r.role === role);
  return found && isResolved(found) ? found.accountId : null;
}

function invalid(message: string, path?: string): never {
  throw new ApplicationError(
    "stripe_settings_invalid",
    message,
    400,
    path ? [{ path, message }] : [],
  );
}

/** Check a mapping against the chart: each account exists and is open, is of a kind the role can
 * use, and the accounts that must differ do. Messages name accounts by code, never by name. */
export function validateMapping(
  mapping: readonly RoleAccount[],
  chart: readonly ChartAccount[],
): void {
  const byId = new Map(chart.map((a) => [a.id, a]));
  const seen = new Set<string>();
  for (const entry of mapping) {
    if (!isStripeRole(entry.role))
      invalid(`${String(entry.role)} is not a Stripe role.`, "input.mapping");
    if (seen.has(entry.role)) invalid(`${entry.role} is mapped twice.`, "input.mapping");
    seen.add(entry.role);
    const account = byId.get(entry.accountId);
    if (!account)
      invalid(
        `The account for ${ROLE_LABELS[entry.role]} is not in the chart. Use an account id from the chart.`,
        "input.mapping",
      );
    if (account.closedOn !== null)
      invalid(
        `Account ${account.code} is closed and cannot be used for ${ROLE_LABELS[entry.role]}.`,
      );
    if (!(ROLE_KINDS[entry.role] as readonly string[]).includes(account.role))
      invalid(
        `${ROLE_LABELS[entry.role]} must be ${kindsOf(entry.role)}; ${account.code} is ${account.role}.`,
      );
  }
}

export interface ConfigureInput {
  readonly mapping?: readonly RoleAccount[];
  readonly syncFrom?: string;
  readonly timeZone?: string;
  readonly salesTax?: "stripe" | "none";
  readonly overlapDays?: number;
  readonly matchWindowDays?: number;
}

/** The settings after applying `input` to `current`, checked. `today` is the book's current date. */
export function applyConfigure(
  current: StripeSettings,
  input: ConfigureInput,
  chart: readonly ChartAccount[],
  today: string,
): StripeSettings {
  const next: StripeSettings = {
    mapping: input.mapping ?? current.mapping,
    syncFrom: input.syncFrom ?? current.syncFrom,
    timeZone: input.timeZone ?? current.timeZone,
    salesTax: input.salesTax ?? current.salesTax,
    overlapDays: input.overlapDays ?? current.overlapDays,
    matchWindowDays: input.matchWindowDays ?? current.matchWindowDays,
    accountKey: current.accountKey,
  };
  if (!isDate(next.syncFrom) || next.syncFrom < "2000-01-01" || next.syncFrom > addDays(today, 1))
    invalid("syncFrom must be a real date no later than today.", "input.syncFrom");
  if (!isTimeZone(next.timeZone))
    invalid("timeZone must be an IANA time zone such as America/Denver or UTC.", "input.timeZone");
  validateMapping(next.mapping, chart);
  return next;
}
