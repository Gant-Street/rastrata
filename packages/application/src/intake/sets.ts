/** The closed sets of the intake lane. Every code an intake operation returns is one of these, so
 * a client (and a model) never meets a string it has to interpret: text from a customer's file
 * appears only in the fields that are named for it (a file name, a column header), bounded and with
 * control and direction characters made visible. Portable: no dependencies. */

/** What a file is, decided from its bytes and never from its extension. */
export const FILE_KINDS = [
  "csv",
  "tsv",
  "ofx",
  "qfx",
  "json",
  "text",
  "pdf",
  "xlsx",
  "xls",
  "zip",
  "gzip",
  "image",
  "binary",
  "empty",
] as const;
export type FileKind = (typeof FILE_KINDS)[number];

/** What a file is for. */
export const ROLES = [
  "bank_statement",
  "card_statement",
  "trial_balance",
  "chart_of_accounts",
  "general_ledger",
  "payout_report",
  "invoices",
  "other",
] as const;
export type Role = (typeof ROLES)[number];

export const CONFIDENCES = ["high", "medium", "low"] as const;
export type Confidence = (typeof CONFIDENCES)[number];

/** Why a role was guessed. Codes, never text from the file. */
export const ROLE_REASONS = [
  "ofx_bank_account",
  "ofx_card_account",
  "header_statement_columns",
  "header_running_balance",
  "header_account_and_debit_credit",
  "header_account_and_type",
  "header_payout_columns",
  "header_invoice_columns",
  "header_ledger_columns",
  "title_trial_balance",
  "title_chart_of_accounts",
  "title_general_ledger",
  "title_statement",
  "title_invoices",
  "no_dates_in_rows",
  "total_row",
  "card_words",
  "balance_counts_owed",
  "dated_rows",
  "single_account",
  "many_accounts",
  "no_recognised_columns",
  "not_a_table",
  "binary_content",
] as const;
export type RoleReason = (typeof ROLE_REASONS)[number];

/** What a file needs next from someone other than the program. */
export const NEEDS = ["none", "recipe", "agent", "human"] as const;
export type Need = (typeof NEEDS)[number];

/** Why a file is not parsed. */
export const UNPARSED_REASONS = [
  "pdf_needs_agent",
  "workbook_needs_agent",
  "archive_not_opened",
  "image_needs_agent",
  "binary_unknown",
  "empty_file",
  "too_large",
] as const;
export type UnparsedReason = (typeof UNPARSED_REASONS)[number];

export const ENCODINGS = ["utf-8", "utf-16le", "utf-16be", "windows-1252"] as const;
export const DELIMITERS = [",", ";", "\t", "|"] as const;
export const LINE_ENDINGS = ["lf", "crlf", "cr", "mixed", "none"] as const;
export const DATE_ORDERS = ["mdy", "dmy", "ymd", "ambiguous", "mixed", "none"] as const;

/** Conditions seen in a file that the gates and the plan act on. */
export const FILE_FLAGS = [
  "bom",
  "multiline_cells",
  "pending_rows",
  "ambiguous_dates",
  "mixed_dates",
  "future_dates",
  "formula_cells",
  "instruction_text",
  "control_characters",
  "markup_text",
  "duplicate_rows",
  "unreadable_rows",
  "no_balance",
  "preamble",
  "total_row",
  "encrypted",
  "unsafe_names",
  "name_flagged",
] as const;
export type FileFlag = (typeof FILE_FLAGS)[number];

/** The verification gates. */
export const GATES = [
  "balance_chain",
  "ending_balance",
  "sign_convention",
  "date_order",
  "date_period",
  "encoding",
  "pending_rows",
  "multiline_memo",
  "rejected_rows",
  "hostile_text",
  "coverage",
  "continuity",
  "duplicate_file",
  "trial_balance_ties",
  "trial_balance_date",
  "trial_balance_statements",
] as const;
export type Gate = (typeof GATES)[number];

export const GATE_STATUSES = ["pass", "fail", "unverified", "not_applicable"] as const;
export type GateStatus = (typeof GATE_STATUSES)[number];

/** The checklist items of a plan. */
export const PLAN_CODES = [
  "cutover_date",
  "through_date",
  "source_account",
  "source_files",
  "statement_readable",
  "statement_coverage",
  "statement_ending_balance",
  "statement_continuity",
  "duplicate_file",
  "trial_balance_file",
  "trial_balance_date",
  "trial_balance_ties",
  "trial_balance_statements",
  "chart_file",
  "unassigned_file",
  "unparsed_file",
  "account_without_source",
  "payout_report",
] as const;
export type PlanCode = (typeof PLAN_CODES)[number];

export const PLAN_STATUSES = ["present", "missing", "uncertain"] as const;
export type PlanStatus = (typeof PLAN_STATUSES)[number];

/** Who has to act on a plan item. */
export const OWNERS = ["agent", "customer"] as const;
export type Owner = (typeof OWNERS)[number];

/** The friction log. `class` says what an event counts as in `intake status`. */
export const FRICTION_KINDS = [
  "scan",
  "plan",
  "file_not_parsed",
  "recipe_needed",
  "recipe_failed",
  "gate_failed",
  "date_order_unclear",
  "balance_needed",
  "cutover_needed",
  "account_needed",
  "trial_balance_problem",
  "coverage_gap",
  "duplicate_file",
  "import_blocked",
  "agent_retry",
  "human_input",
  "note",
] as const;
export type FrictionKind = (typeof FRICTION_KINDS)[number];

export const FRICTION_CLASSES = ["info", "agent", "retry", "human", "gap"] as const;
export type FrictionClass = (typeof FRICTION_CLASSES)[number];

/** What each kind counts as. `human`, `retry` and `agent` are interventions: a point where the
 * deterministic tooling could not go on by itself. `gap` is something missing that is still
 * missing until the same key is resolved. `info` marks that something happened. */
export const FRICTION_CLASS: Readonly<Record<FrictionKind, FrictionClass>> = {
  scan: "info",
  plan: "info",
  note: "info",
  file_not_parsed: "agent",
  recipe_needed: "agent",
  recipe_failed: "retry",
  gate_failed: "retry",
  import_blocked: "retry",
  agent_retry: "retry",
  date_order_unclear: "human",
  balance_needed: "human",
  cutover_needed: "human",
  account_needed: "human",
  trial_balance_problem: "human",
  human_input: "human",
  coverage_gap: "gap",
  duplicate_file: "gap",
};

/** The permission each operation of the lane needs, in one place so the tests and the docs agree. */
export const INTAKE_PERMISSIONS = {
  "intake.scan": "read",
  "intake.plan": "read",
  "intake.recipeTest": "read",
  "intake.recipeList": "read",
  "intake.trialBalance": "read",
  "intake.recipeSave": "draft",
  "intake.friction": "draft",
  "intake.frictionList": "read",
  "intake.status": "read",
} as const;

// ---- Text from outside ---------------------------------------------------------------------

/** True for the characters that can move a cursor, recolour a terminal or disguise what text says. */
export function isUnsafeCodePoint(code: number): boolean {
  return (
    code < 0x20 ||
    (code >= 0x7f && code <= 0x9f) ||
    (code >= 0x200b && code <= 0x200f) ||
    (code >= 0x202a && code <= 0x202e) ||
    (code >= 0x2060 && code <= 0x2064) ||
    (code >= 0x2066 && code <= 0x2069) ||
    code === 0x2028 ||
    code === 0x2029 ||
    code === 0x180e ||
    code === 0xfeff
  );
}

/** Text from a customer's file, made safe to put in an output: bounded, and with every control,
 * direction and invisible character written out as `\uXXXX`. The result contains no character
 * that a terminal, a screen or a person could mistake for something else. */
export function neutral(text: string, limit = 80): string {
  let shown = "";
  let count = 0;
  for (const symbol of text) {
    if (count >= limit) {
      shown += "…";
      break;
    }
    const code = symbol.codePointAt(0) ?? 0;
    shown += isUnsafeCodePoint(code) ? `\\u${code.toString(16).padStart(4, "0")}` : symbol;
    count++;
  }
  return shown;
}

/** Every string in an output made safe, whatever put it there: control, direction and invisible
 * characters are written out as `\uXXXX`, and nothing grows past `limit`. Applied to the whole of
 * an output on its way out, so a field nobody thought to check is still checked. */
export function scrub<T>(value: T, limit = 2000): T {
  if (typeof value === "string") {
    // A lone tab is the tab delimiter, a closed-set value, not text from a file.
    if (value === "\t") return value;
    for (let at = 0; at < value.length; at++)
      if (isUnsafeCodePoint(value.charCodeAt(at))) return neutral(value, limit) as T;
    return (value.length > limit ? `${value.slice(0, limit)}…` : value) as T;
  }
  if (Array.isArray(value)) return value.map((item) => scrub(item, limit)) as T;
  if (value !== null && typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const [key, item] of Object.entries(value)) out[key] = scrub(item, limit);
    return out as T;
  }
  return value;
}

// ---- Dates ---------------------------------------------------------------------------------

/** `YYYY-MM-DD` shifted by whole days, in the calendar and never through a time zone. */
export function addDays(date: string, days: number): string {
  const [year, month, day] = date.split("-").map(Number) as [number, number, number];
  const shifted = new Date(Date.UTC(year, month - 1, day + days));
  return shifted.toISOString().slice(0, 10);
}

/** `YYYY-MM` of a date. */
export const monthOf = (date: string): string => date.slice(0, 7);

/** The last day of a `YYYY-MM` month. */
export function monthEnd(month: string): string {
  const [year, number] = month.split("-").map(Number) as [number, number];
  return new Date(Date.UTC(year, number, 0)).toISOString().slice(0, 10);
}

/** The months from `from` to `to` inclusive, as `YYYY-MM`. */
export function monthsBetween(from: string, to: string, limit = 120): string[] {
  const months: string[] = [];
  let [year, month] = from.slice(0, 7).split("-").map(Number) as [number, number];
  const last = to.slice(0, 7);
  while (months.length < limit) {
    const label = `${year}-${String(month).padStart(2, "0")}`;
    if (label > last) break;
    months.push(label);
    month++;
    if (month > 12) {
      month = 1;
      year++;
    }
  }
  return months;
}
