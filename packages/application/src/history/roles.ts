/** The accounts a history adds to the book: which kind an account of a file probably is, and the code it is
 * given. Only the five kinds a person chooses between; the book's other kinds (gains) are for the kernel. */

export type NewRole = "asset" | "liability" | "equity" | "income" | "expense";

export const NEW_ROLES: readonly NewRole[] = ["asset", "liability", "equity", "income", "expense"];

/** What the usual four-digit numbering says: 1000s are assets, 2000s liabilities, 3000s equity, 4000s income and
 * 5000s to 7000s expenses. 8000s and 9000s are other income in one chart and other expense in the next, so they say
 * nothing. A three-digit code says nothing either: Xero's chart puts sales at 200 and rent at 469, so for a Xero file
 * the kinds come from its chart of accounts, imported first. */
const FROM_DIGIT: Readonly<Record<string, NewRole>> = {
  "1": "asset",
  "2": "liability",
  "3": "equity",
  "4": "income",
  "5": "expense",
  "6": "expense",
  "7": "expense",
};

const tidy = (text: string): string => text.toLowerCase().replace(/\s+/g, " ").trim();

/** Strong words only, in the order that settles the doubtful ones ("sales tax payable" is owed, not earned). A
 * name with none of them says nothing, and then the person chooses. */
const BY_NAME: readonly (readonly [NewRole, RegExp])[] = [
  [
    "liability",
    /\b(payable|credit card|line of credit|loans?|sales tax|accrued|unearned|deferred revenue|mortgage)\b/,
  ],
  [
    "equity",
    /\b(retained earnings|opening balance equity|owner'?s? (equity|investment|draws?|contributions?)|members?'? (equity|draws?|contributions?)|paid-in capital|common stock|distributions?|draws?)\b/,
  ],
  [
    "expense",
    /\b(expenses?|cost of (goods|sales|revenue)|cogs|depreciation|amortization|interest paid)\b/,
  ],
  [
    "asset",
    /\b(checking|savings|petty cash|undeposited funds|accounts receivable|a\/r|inventory|prepaid|money market)\b/,
  ],
  ["income", /\b(revenue|sales|income)\b/],
];

/** The kind an account of a file probably is, or null when nothing in it says. */
export function suggestRole(code: string, name: string): NewRole | null {
  if (/^[0-9]{4,}$/.test(code)) {
    const fromNumber = FROM_DIGIT[code.slice(0, 1)];
    if (fromNumber) return fromNumber;
  }
  const text = tidy(name === "" ? code : name);
  for (const [role, pattern] of BY_NAME) if (pattern.test(text)) return role;
  return null;
}

const BASE: Readonly<Record<NewRole, number>> = {
  asset: 1000,
  liability: 2000,
  equity: 3000,
  income: 4000,
  expense: 6000,
};

/** A code the book accepts for an account (letters, digits, "_" and "-", two to twenty characters). */
export const usableCode = (code: string): boolean => /^[A-Za-z0-9][A-Za-z0-9_-]{1,19}$/.test(code);

/** The code a new account is given: the file's own when it is usable and free, otherwise the next free
 * multiple of ten in the kind's thousand (1010, 1020, ...). `used` holds lower-case codes and is added to. */
export function codeFor(role: NewRole, fileCode: string, used: Set<string>): string {
  if (usableCode(fileCode) && !used.has(fileCode.toLowerCase())) {
    used.add(fileCode.toLowerCase());
    return fileCode;
  }
  for (let number = BASE[role] + 10; ; number += 10) {
    const code = String(number);
    if (!used.has(code)) {
      used.add(code);
      return code;
    }
  }
}
