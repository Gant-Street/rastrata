import { PluginError } from "./errors.ts";
import { fromCents, isMoney, toCents } from "./money.ts";
import type { BalanceCheck, BankLine, IngestLine, LedgerEvent, PluginManifest } from "./types.ts";

/** Validation rules shared by `definePlugin()`, `emit`, and `testPlugin()`.
 * Every diagnostic carries a field path and an actionable fix hint. */

export interface ValidationIssue {
  readonly code:
    | "invalid_manifest"
    | "invalid_date"
    | "invalid_money"
    | "invalid_line"
    | "unbalanced_event"
    | "undeclared_role";
  readonly field: string;
  readonly message: string;
  readonly hint: string;
}

const SLUG = /^[a-z][a-z0-9-]{1,30}[a-z0-9]$/;
const SEMVER = /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/;
const DATE_PATTERN = /^(\d{4})-(\d{2})-(\d{2})$/;
const CURRENCY_PATTERN = /^[A-Z]{3}$/;
const HOSTNAME_PATTERN = /^(?=.{1,253}$)(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$/;
const IPV4_PATTERN = /^\d{1,3}(?:\.\d{1,3}){3}$/;
const ENV_VAR_PATTERN = /^[A-Z][A-Z0-9_]{2,63}$/;
const ROLE_KEY_PATTERN = /^[a-z][a-z0-9.-]{1,62}[a-z0-9]$/;

/** True when `value` is a real calendar date `YYYY-MM-DD` (rejects 2026-02-30, etc.). */
export function isCalendarDate(value: unknown): value is string {
  if (typeof value !== "string") return false;
  const match = DATE_PATTERN.exec(value);
  if (!match) return false;
  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  if (month < 1 || month > 12 || day < 1 || day > 31) return false;
  const check = new Date(Date.UTC(year, month - 1, day));
  return (
    check.getUTCFullYear() === year &&
    check.getUTCMonth() === month - 1 &&
    check.getUTCDate() === day
  );
}

/** True when `host` is a valid public HTTPS hostname (no wildcards, no IPs, no localhost). */
export function isAllowedDomainEntry(host: string): boolean {
  const lower = host.toLowerCase();
  if (lower !== host) return false;
  if (host.includes("*") || host.includes("/") || host.includes(":") || host.includes(" "))
    return false;
  if (IPV4_PATTERN.test(host) || host === "localhost" || host.endsWith(".local")) return false;
  return HOSTNAME_PATTERN.test(host);
}

/** Validate a `PluginManifest`, returning all actionable issues (empty array = valid). */
export function validateManifest(manifest: PluginManifest): ValidationIssue[] {
  const issues: ValidationIssue[] = [];

  if (!SLUG.test(manifest.id)) {
    issues.push({
      code: "invalid_manifest",
      field: "manifest.id",
      message: `Invalid plugin id "${manifest.id}".`,
      hint: 'Use 3-32 lowercase letters, digits, or hyphens (e.g. "mercury", "shopify", "acme-billing").',
    });
  }

  if (!SEMVER.test(manifest.version)) {
    issues.push({
      code: "invalid_manifest",
      field: "manifest.version",
      message: `Invalid version "${manifest.version}".`,
      hint: 'Use semantic versioning such as "0.1.0" or "1.0.0".',
    });
  }

  if (!manifest.name.trim() || manifest.name.length > 60) {
    issues.push({
      code: "invalid_manifest",
      field: "manifest.name",
      message: "Plugin name must be 1-60 characters.",
      hint: 'Use a short product name such as "Mercury" or "Shopify".',
    });
  }

  if (!manifest.description.trim() || manifest.description.length > 160) {
    issues.push({
      code: "invalid_manifest",
      field: "manifest.description",
      message: "Plugin description must be 1-160 characters.",
      hint: "Describe what the plugin imports in one plain sentence.",
    });
  }

  if (manifest.capabilities.length === 0 || !manifest.capabilities.every((c) => c === "ingest")) {
    issues.push({
      code: "invalid_manifest",
      field: "manifest.capabilities",
      message: `Unsupported capabilities: ${JSON.stringify(manifest.capabilities)}.`,
      hint: 'Set capabilities: ["ingest"] for v1 ingestion plugins.',
    });
  }

  const seenDomains = new Set<string>();
  if (
    manifest.auth.kind !== "file" &&
    manifest.auth.kind !== "none" &&
    manifest.domains.length === 0
  ) {
    issues.push({
      code: "invalid_manifest",
      field: "manifest.domains",
      message: "API/OAuth plugins must declare at least one outbound HTTPS domain.",
      hint: 'Add the exact API hostname(s) this plugin calls, e.g. domains: ["api.mercury.com"].',
    });
  }
  for (const domain of manifest.domains) {
    if (!isAllowedDomainEntry(domain)) {
      issues.push({
        code: "invalid_manifest",
        field: "manifest.domains",
        message: `Invalid domain "${domain}".`,
        hint: 'Use exact lowercase HTTPS hostnames only (no wildcards, protocols, paths, ports, or IP addresses), e.g. "api.stripe.com".',
      });
    } else if (seenDomains.has(domain)) {
      issues.push({
        code: "invalid_manifest",
        field: "manifest.domains",
        message: `Duplicate domain "${domain}".`,
        hint: "List each hostname once.",
      });
    }
    seenDomains.add(domain);
  }

  if (manifest.auth.kind === "api_key" && !ENV_VAR_PATTERN.test(manifest.auth.envVar)) {
    issues.push({
      code: "invalid_manifest",
      field: "manifest.auth.envVar",
      message: `Invalid environment variable name "${manifest.auth.envVar}".`,
      hint: 'Use uppercase letters, digits, and underscores, e.g. "RASTRATA_MERCURY_KEY".',
    });
  }

  const roleKeys = new Set<string>();
  for (const role of manifest.roles ?? []) {
    if (!ROLE_KEY_PATTERN.test(role.key)) {
      issues.push({
        code: "invalid_manifest",
        field: `manifest.roles.${role.key}`,
        message: `Invalid role key "${role.key}".`,
        hint: 'Use lowercase dotted keys such as "revenue.sales" or "shopify.fees".',
      });
    }
    if (roleKeys.has(role.key)) {
      issues.push({
        code: "invalid_manifest",
        field: `manifest.roles.${role.key}`,
        message: `Duplicate role key "${role.key}".`,
        hint: "Each declared account role key must be unique.",
      });
    }
    roleKeys.add(role.key);
  }

  if (manifest.clearing) {
    if (!roleKeys.has(manifest.clearing.role)) {
      issues.push({
        code: "invalid_manifest",
        field: "manifest.clearing.role",
        message: `Clearing role "${manifest.clearing.role}" is not declared in manifest.roles.`,
        hint: `Add "${manifest.clearing.role}" to manifest.roles as an asset or liability role.`,
      });
    }
    const windowDays = manifest.clearing.windowDays ?? 7;
    if (!Number.isInteger(windowDays) || windowDays < 1 || windowDays > 30) {
      issues.push({
        code: "invalid_manifest",
        field: "manifest.clearing.windowDays",
        message: `Invalid clearing windowDays (${String(windowDays)}).`,
        hint: "Use an integer between 1 and 30 days (default 7).",
      });
    }
  }

  const fieldKeys = new Set<string>();
  for (const field of manifest.fields ?? []) {
    if (!/^[a-zA-Z][a-zA-Z0-9_]{0,49}$/.test(field.key)) {
      issues.push({
        code: "invalid_manifest",
        field: `manifest.fields.${field.key}`,
        message: `Invalid config field key "${field.key}".`,
        hint: 'Use camelCase or snake_case identifiers such as "shopDomain" or "syncFrom".',
      });
    }
    if (fieldKeys.has(field.key)) {
      issues.push({
        code: "invalid_manifest",
        field: `manifest.fields.${field.key}`,
        message: `Duplicate config field key "${field.key}".`,
        hint: "Each config field key must be unique.",
      });
    }
    fieldKeys.add(field.key);
    if (field.kind === "select" && field.options.length === 0) {
      issues.push({
        code: "invalid_manifest",
        field: `manifest.fields.${field.key}`,
        message: `Select field "${field.key}" has no options.`,
        hint: "Provide at least one { value, label } option.",
      });
    }
  }

  return issues;
}

/** Validate a single `BankLine` or `LedgerEvent` against Rastrata invariants and `manifest`. */
export function validateLine(
  line: IngestLine,
  manifest: PluginManifest,
  pathPrefix = "line",
): ValidationIssue[] {
  const issues: ValidationIssue[] = [];

  if (line.provider !== manifest.id) {
    issues.push({
      code: "invalid_line",
      field: `${pathPrefix}.provider`,
      message: `Line provider "${line.provider}" does not match manifest.id "${manifest.id}".`,
      hint: `Use emit.bankLine() or emit.event() so provider is always set to "${manifest.id}".`,
    });
  }

  if (!line.accountKey.trim()) {
    issues.push({
      code: "invalid_line",
      field: `${pathPrefix}.accountKey`,
      message: "accountKey cannot be empty.",
      hint: `Use a stable account identifier such as "${manifest.id}:checking-1234".`,
    });
  }

  if (!Number.isInteger(line.rawIndex) || line.rawIndex < 0) {
    issues.push({
      code: "invalid_line",
      field: `${pathPrefix}.rawIndex`,
      message: `Invalid rawIndex (${String(line.rawIndex)}).`,
      hint: "Use a zero-based integer index pointing to the element or row inside raw.bytes.",
    });
  }

  if (line.excerpt !== undefined && new TextEncoder().encode(line.excerpt).byteLength > 4096) {
    issues.push({
      code: "invalid_line",
      field: `${pathPrefix}.excerpt`,
      message: "Excerpt exceeds 4 KiB limit.",
      hint: "Truncate excerpts to at most 4,096 UTF-8 bytes.",
    });
  }

  if (!CURRENCY_PATTERN.test(line.currency)) {
    issues.push({
      code: "invalid_line",
      field: `${pathPrefix}.currency`,
      message: `Invalid ISO 4217 currency "${line.currency}".`,
      hint: 'Use a 3-letter uppercase code such as "USD".',
    });
  }

  if (line.kind === "bankLine") {
    validateBankLine(line, pathPrefix, issues);
  } else {
    validateLedgerEvent(line, manifest, pathPrefix, issues);
  }

  return issues;
}

function validateBankLine(line: BankLine, prefix: string, issues: ValidationIssue[]): void {
  if (!isCalendarDate(line.postedOn)) {
    issues.push({
      code: "invalid_date",
      field: `${prefix}.postedOn`,
      message: `Invalid postedOn date "${line.postedOn}".`,
      hint: 'Format dates as real calendar YYYY-MM-DD strings (e.g. "2026-09-09").',
    });
  }
  if (!isMoney(line.amount)) {
    issues.push({
      code: "invalid_money",
      field: `${prefix}.amount`,
      message: `Invalid amount "${line.amount}".`,
      hint: 'Use a signed two-decimal string (e.g. "-42.50") via money.fromCents().',
    });
  }
  if (line.runningBalance !== undefined && !isMoney(line.runningBalance)) {
    issues.push({
      code: "invalid_money",
      field: `${prefix}.runningBalance`,
      message: `Invalid runningBalance "${line.runningBalance}".`,
      hint: "Format runningBalance as a signed two-decimal string via money.fromCents().",
    });
  }
  if (!line.description.trim()) {
    issues.push({
      code: "invalid_line",
      field: `${prefix}.description`,
      message: "BankLine description cannot be empty.",
      hint: "Pass the provider's memo/payee text or a fallback identifier.",
    });
  }
}

function validateLedgerEvent(
  event: LedgerEvent,
  manifest: PluginManifest,
  prefix: string,
  issues: ValidationIssue[],
): void {
  if (!event.providerId.trim()) {
    issues.push({
      code: "invalid_line",
      field: `${prefix}.providerId`,
      message: "LedgerEvent requires a non-empty providerId.",
      hint: 'Pass the provider\'s immutable unique ID (e.g. "po_123", "bt_456") for hard deduplication.',
    });
  }
  if (!isCalendarDate(event.eventOn)) {
    issues.push({
      code: "invalid_date",
      field: `${prefix}.eventOn`,
      message: `Invalid eventOn date "${event.eventOn}".`,
      hint: 'Format dates as real calendar YYYY-MM-DD strings (e.g. "2026-09-09").',
    });
  }
  if (!event.summary.trim()) {
    issues.push({
      code: "invalid_line",
      field: `${prefix}.summary`,
      message: "LedgerEvent summary cannot be empty.",
      hint: 'Build summary from fixed words and identifiers (e.g. "Shopify payout po_123"), never customer free text.',
    });
  }
  if (event.amount !== undefined && !isMoney(event.amount)) {
    issues.push({
      code: "invalid_money",
      field: `${prefix}.amount`,
      message: `Invalid event amount "${event.amount}".`,
      hint: "Format amount as a signed two-decimal string via money.fromCents().",
    });
  }
  if (event.evidence !== undefined && event.evidence.length > 300) {
    issues.push({
      code: "invalid_line",
      field: `${prefix}.evidence`,
      message: `Evidence string is ${event.evidence.length} chars (max 300).`,
      hint: "Keep evidence concise (identifiers, counts, SHA-256 digest).",
    });
  }
  if (event.sourceId?.startsWith("ingest-")) {
    issues.push({
      code: "invalid_line",
      field: `${prefix}.sourceId`,
      message: `sourceId "${event.sourceId}" cannot start with reserved prefix "ingest-".`,
      hint: `Prefix sourceId with "${manifest.id}-" instead (e.g. "${manifest.id}-payout-123").`,
    });
  }

  if (event.legs.length < 2 || event.legs.length > 100) {
    issues.push({
      code: "invalid_line",
      field: `${prefix}.legs`,
      message: `LedgerEvent "${event.providerId}" has ${event.legs.length} leg(s); expected 2-100.`,
      hint: "Every double-entry event needs at least one debit leg and one credit leg.",
    });
    return;
  }

  const declaredRoles = new Set((manifest.roles ?? []).map((r) => r.key));
  let debits = 0n;
  let credits = 0n;
  let allMoneyValid = true;

  for (let i = 0; i < event.legs.length; i += 1) {
    const leg = event.legs[i];
    if (!leg) continue;
    if (!declaredRoles.has(leg.role)) {
      const available = [...declaredRoles].join(", ") || "(none declared)";
      issues.push({
        code: "undeclared_role",
        field: `${prefix}.legs[${i}].role`,
        message: `Role "${leg.role}" on LedgerEvent "${event.providerId}" is not declared in manifest.roles.`,
        hint: `Use one of [${available}] or add "${leg.role}" to manifest.roles.`,
      });
    }
    if (!isMoney(leg.amount)) {
      allMoneyValid = false;
      issues.push({
        code: "invalid_money",
        field: `${prefix}.legs[${i}].amount`,
        message: `Invalid leg amount "${leg.amount}" on role "${leg.role}".`,
        hint: "Use signed two-decimal strings (positive = debit, negative = credit).",
      });
    } else {
      const cents = toCents(leg.amount);
      if (cents > 0n) debits += cents;
      else credits += -cents;
    }
  }

  if (allMoneyValid && debits !== credits) {
    const diff = debits - credits;
    const sign = diff > 0n ? "+" : "";
    issues.push({
      code: "unbalanced_event",
      field: `${prefix}.legs`,
      message: `LedgerEvent "${event.providerId}" (${event.eventOn}) does not balance by ${sign}${fromCents(diff)} (debits ${fromCents(debits)}, credits ${fromCents(credits)}).`,
      hint: "Ensure all legs sum to 0.00 (positive = debit, negative = credit). Check fee, tax, or refund legs before emitting.",
    });
  }
}

export function validateBalanceCheck(check: BalanceCheck, prefix = "balance"): ValidationIssue[] {
  const issues: ValidationIssue[] = [];
  if (!check.accountKey.trim()) {
    issues.push({
      code: "invalid_line",
      field: `${prefix}.accountKey`,
      message: "BalanceCheck accountKey cannot be empty.",
      hint: "Match the accountKey used on emitted BankLine/LedgerEvent items.",
    });
  }
  if (!isCalendarDate(check.asOf)) {
    issues.push({
      code: "invalid_date",
      field: `${prefix}.asOf`,
      message: `Invalid BalanceCheck asOf date "${check.asOf}".`,
      hint: 'Use a calendar date YYYY-MM-DD (e.g. "2026-09-30").',
    });
  }
  if (!isMoney(check.balance)) {
    issues.push({
      code: "invalid_money",
      field: `${prefix}.balance`,
      message: `Invalid BalanceCheck balance "${check.balance}".`,
      hint: "Format balance as a signed two-decimal string (positive for a debit balance).",
    });
  }
  return issues;
}

/** Throw a structured `PluginError` on the first issue when strict fail-fast validation is desired. */
export function assertValidIssues(issues: readonly ValidationIssue[]): void {
  const first = issues[0];
  if (!first) return;
  throw new PluginError({
    code: first.code,
    field: first.field,
    message: first.message,
    hint: first.hint,
  });
}
