import { chartWords } from "../accounting/chart-words";
import { formatDate } from "../format";
import { type AccountKind, kindFacts } from "./account-kinds";
import { CODE_PATTERN, ROLE_KEY_PATTERN } from "./chart-logic";
import type { CashFlowClass, ChartRole } from "./chart-types";

/** The rules of the two account forms ("New account" and "Edit account"), with no UI in them: what is wrong
 * with what was typed, what the form says it will do, and the request it makes. Pure, so they behave the
 * same in the app, in a story and in a test. */

/** What the new-account form holds. The host owns it, so a request kept across a reload can put it back. */
export interface NewAccountValues {
  name: string;
  kind: AccountKind;
  code: string;
  parentId: string;
  effectiveOn: string;
  cashFlowClass: string;
  taxLine: string;
  roleKey: string;
}

export interface NewAccountProblems {
  name?: string;
  code?: string;
  roleKey?: string;
  effectiveOn?: string;
}

/** What is wrong with the typed fields, by field, in words. Nothing is said about a field that is right. */
export function newAccountProblems(
  values: NewAccountValues,
  accounts: readonly { readonly code: string; readonly name: string }[],
): NewAccountProblems {
  const w = chartWords.add;
  const found: NewAccountProblems = {};
  if (values.name.trim() === "") found.name = w.nameRequired;
  const code = values.code.trim();
  if (code === "") found.code = w.codeRequired;
  else if (!CODE_PATTERN.test(code)) found.code = w.codeShape;
  else {
    const used = accounts.find((account) => account.code.toLowerCase() === code.toLowerCase());
    if (used) found.code = w.codeUsed(used.code, used.name);
  }
  const key = values.roleKey.trim();
  if (key !== "" && !ROLE_KEY_PATTERN.test(key)) found.roleKey = w.roleKeyShape;
  if (values.effectiveOn.trim() === "") found.effectiveOn = w.effectiveRequired;
  return found;
}

export const hasAccountProblems = (problems: object): boolean => Object.keys(problems).length > 0;

/** What the form says it will do, in one sentence, or the words that ask for what is missing. The
 * date the account starts on is the field under Advanced, not part of the sentence: the one the form
 * suggests is the calendar's first day, which means nothing to the person. */
export function addSentence(values: NewAccountValues, problems: NewAccountProblems): string {
  const w = chartWords.add;
  if (problems.name || problems.code || problems.effectiveOn) return w.summaryEmpty;
  return w.summary(
    values.code.trim(),
    values.name.trim(),
    chartWords.kindAs[values.kind] ?? values.kind,
  );
}

const BALANCE_SHEET: readonly ChartRole[] = ["asset", "liability", "equity"];
export const isBalanceSheetKind = (kind: AccountKind): boolean =>
  BALANCE_SHEET.includes(kindFacts(kind).role);

/** The request the form makes: the type, the code, the name, the parent and the date. Tags are saved by a
 * second request once the account exists (the ledger adds an account and its tags separately). */
export function newAccountRequest(values: NewAccountValues): {
  code: string;
  name: string;
  role: ChartRole;
  parentId?: string;
  effectiveOn: string;
} {
  return {
    code: values.code.trim(),
    name: values.name.trim(),
    role: kindFacts(values.kind).role,
    ...(values.parentId ? { parentId: values.parentId } : {}),
    effectiveOn: values.effectiveOn,
  };
}

/** The tags the new account is given: what its kind decides for the cash flow (unless the person chose
 * another), a tax line for an income or expense account, and a role key. */
export function newAccountTags(values: NewAccountValues): {
  cashFlowClass?: CashFlowClass;
  taxLine?: string;
  roleKey?: string;
  kind?: "bank" | "card";
} {
  const facts = kindFacts(values.kind);
  const balanceSheet = isBalanceSheetKind(values.kind);
  const cashFlow = (values.cashFlowClass || facts.cashFlowClass || "") as CashFlowClass | "";
  return {
    ...(facts.kind ? { kind: facts.kind } : {}),
    ...(balanceSheet && cashFlow ? { cashFlowClass: cashFlow } : {}),
    ...(!balanceSheet && values.taxLine ? { taxLine: values.taxLine } : {}),
    ...(values.roleKey.trim() ? { roleKey: values.roleKey.trim() } : {}),
  };
}

/** What the edit form holds. */
export interface EditAccountValues {
  name: string;
  close: boolean;
  effectiveOn: string;
}

export interface EditAccountProblems {
  name?: string;
  effectiveOn?: string;
  nothing?: string;
}

/** What is wrong with an edit: a name left empty, no date, or nothing changed at all. */
export function editAccountProblems(
  values: EditAccountValues,
  current: { readonly name: string },
): EditAccountProblems {
  const w = chartWords.edit;
  const found: EditAccountProblems = {};
  if (values.name.trim() === "") found.name = w.nameRequired;
  if (values.effectiveOn.trim() === "") found.effectiveOn = w.effectiveRequired;
  if (!found.name && values.name.trim() === current.name && !values.close)
    found.nothing = w.summaryNothing;
  return found;
}

/** What the edit form says it will do. */
export function editSentence(
  values: EditAccountValues,
  current: { readonly name: string },
  problems: EditAccountProblems,
): string {
  const w = chartWords.edit;
  if (problems.name || problems.effectiveOn || problems.nothing) return w.summaryNothing;
  const renamed = values.name.trim() !== current.name;
  const date = formatDate(values.effectiveOn);
  if (renamed && values.close) return w.summaryRenameClose(current.name, values.name.trim(), date);
  if (renamed) return w.summaryRename(current.name, values.name.trim(), date);
  return w.summaryClose(current.name, date);
}
