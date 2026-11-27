/** Spend money, Receive money and Transfer: the pure part.
 *
 * Each of the three is an ordinary two-line entry. Money moves from one account to another, so the
 * entry debits the account it goes to and credits the account it comes from, for one positive amount.
 * Everything here is plain functions of what the person typed and the chart: which accounts a picker
 * offers, what an amount typed as "25" or "1,250.5" means, what is wrong with a form, the plain-words
 * line that says what the entry will do, and the draft the entry is saved as. The dialog and the web
 * controller are thin around it, so it is tested without a browser.
 *
 * Amounts are decimal strings and arithmetic is on whole cents; nothing here is a floating point
 * number. */
import { centsToMoney, formatMoney, moneyToCents } from "../format";
import { quickWords as words } from "./words";

export type QuickKind = "spend" | "receive" | "transfer";
export type QuickPreset = "owner-in" | "owner-out";
export type QuickRole =
  | "asset"
  | "liability"
  | "equity"
  | "income"
  | "expense"
  | "gain"
  | "unrealizedGain";

/** An account as the entry dialogs see it. */
export interface QuickAccount {
  readonly id: string;
  readonly code: string;
  readonly name: string;
  readonly role: QuickRole;
  /** The account holds other accounts, so nothing is posted to it. */
  readonly group?: boolean;
  /** A bank, card or cash account: the accounts money is paid from, received into and moved between. */
  readonly bank?: boolean;
  /** Closed on a date: it takes no new entries. */
  readonly closed?: boolean;
}

/** What the person types. Money moves `from` one account `to` another: for Spend money the person's
 * bank or card is `from` and the category is `to`; for Receive money the category is `from` and the
 * bank is `to`; a Transfer is between two accounts of their own. */
export interface QuickValues {
  /** `YYYY-MM-DD`, as a date field holds it. */
  readonly date: string;
  readonly from: string;
  readonly to: string;
  /** Who was paid, or who paid. Not used by a transfer. */
  readonly party: string;
  /** As typed. */
  readonly amount: string;
  readonly description: string;
}

export const emptyQuickValues = (date: string): QuickValues => ({
  date,
  from: "",
  to: "",
  party: "",
  amount: "",
  description: "",
});

export interface QuickChoice {
  readonly id: string;
  readonly name: string;
  readonly code: string;
  readonly role: QuickRole;
  readonly group: string;
}

/** The side of the entry an account picker is for. */
export type QuickSide = "from" | "to";

/** Whether the picker for this side is the person's own bank, card or cash accounts. */
export function quickBankSide(kind: QuickKind, side: QuickSide): boolean {
  if (kind === "transfer") return true;
  return kind === "spend" ? side === "from" : side === "to";
}

/** The kinds in the order the form offers them (Xero's order: money out, money in, between accounts). */
export const QUICK_KINDS: readonly QuickKind[] = ["spend", "receive", "transfer"];

/** The side that holds the account the money moved through: paid from, deposit to, or a transfer's from. */
const moneySide = (kind: QuickKind): QuickSide => (kind === "receive" ? "to" : "from");

/** What the form holds after its kind is changed. The date, the amount, the description and who it was
 * with stay (a transfer has nobody). The account the money moved through stays, on the side the new kind
 * keeps it, when the new kind offers it there. The other account is asked again: an expense is not an
 * income, and a transfer's other side is one of the person's own accounts. */
export function quickSwitchKind(
  values: QuickValues,
  from: QuickKind,
  to: QuickKind,
  accounts: readonly QuickAccount[],
): QuickValues {
  if (from === to) return values;
  const bank = values[moneySide(from)];
  const side = moneySide(to);
  const kept =
    bank !== "" && quickChoices(to, side, accounts).some((choice) => choice.id === bank)
      ? bank
      : "";
  return {
    ...values,
    from: side === "from" ? kept : "",
    to: side === "to" ? kept : "",
    party: to === "transfer" ? "" : values.party,
  };
}

const byName = (left: QuickChoice, right: QuickChoice) =>
  left.name.localeCompare(right.name, "en", { sensitivity: "base", numeric: true }) ||
  left.code.localeCompare(right.code, "en", { numeric: true });

const postable = (account: QuickAccount): boolean =>
  account.group !== true && account.closed !== true;
const holdsMoney = (account: QuickAccount): boolean =>
  account.role === "asset" || account.role === "liability";

/** The accounts a picker offers, in the groups a person looks in. The bank side lists bank, card and
 * cash accounts first, and the other assets and liabilities after them (money can be paid from or
 * moved between those too). The category side leaves the bank accounts out, because moving money
 * between two of your own accounts is a Transfer, and lists the accounts that usually hold the
 * answer first: expenses when money is spent, income when it is received. Accounts that hold other
 * accounts and closed accounts are never offered, and neither is the account on the other side. */
export function quickChoices(
  kind: QuickKind,
  side: QuickSide,
  accounts: readonly QuickAccount[],
  otherSide?: string,
): readonly QuickChoice[] {
  const open = accounts.filter((account) => postable(account) && account.id !== otherSide);
  const choice = (account: QuickAccount, group: string): QuickChoice => ({
    id: account.id,
    name: account.name,
    code: account.code,
    role: account.role,
    group,
  });
  if (quickBankSide(kind, side)) {
    const money = open.filter(holdsMoney);
    // Until any account is marked as a bank, card or cash account, every asset and liability is one.
    const anyBank = money.some((account) => account.bank === true);
    return [
      ...money
        .filter((account) => !anyBank || account.bank === true)
        .map((account) => choice(account, words.bankGroup))
        .sort(byName),
      ...(anyBank
        ? money
            .filter((account) => account.bank !== true)
            .map((account) => choice(account, words.otherBalanceGroup))
            .sort(byName)
        : []),
    ];
  }
  const usual = kind === "spend" ? "expense" : "income";
  const rest = open.filter((account) => account.bank !== true || !holdsMoney(account));
  const first = rest.filter((account) => account.role === usual);
  const other = rest.filter((account) => account.role !== usual);
  return [
    ...first
      .map((account) => choice(account, kind === "spend" ? words.expenseGroup : words.incomeGroup))
      .sort(byName),
    ...other.map((account) => choice(account, words.otherGroup)).sort(byName),
  ];
}

const OWNER_OUT = /\b(draws?|distributions?|withdrawals?)\b/i;
const OWNER_IN = /(invest|contribut|capital|equity|paid.in)/i;

/** The account a preset points at: for "Owner took money out" an equity account named for draws,
 * distributions or withdrawals; for "Owner put money in" one named for investment, contributions,
 * capital or equity. The lowest code wins, so the answer does not move when an account is added.
 * `undefined` when the chart has none, and the person chooses. */
export function quickPresetAccount(
  preset: QuickPreset,
  accounts: readonly QuickAccount[],
): string | undefined {
  const equity = accounts
    .filter((account) => account.role === "equity" && postable(account))
    .sort((left, right) => left.code.localeCompare(right.code, "en", { numeric: true }));
  const found =
    preset === "owner-out"
      ? equity.find((account) => OWNER_OUT.test(account.name))
      : equity.find((account) => OWNER_IN.test(account.name) && !OWNER_OUT.test(account.name));
  return found?.id;
}

/** The kind a preset belongs to, and the side of the entry it fills in. */
export const QUICK_PRESETS: Readonly<
  Record<
    QuickPreset,
    {
      readonly kind: QuickKind;
      readonly side: QuickSide;
      readonly label: string;
      readonly hint: string;
    }
  >
> = {
  "owner-out": {
    kind: "spend",
    side: "to",
    label: words.ownerOut,
    hint: words.ownerOutHint,
  },
  "owner-in": {
    kind: "receive",
    side: "from",
    label: words.ownerIn,
    hint: words.ownerInHint,
  },
};

export type QuickAmountResult =
  | { readonly ok: true; readonly value: string }
  | { readonly ok: false; readonly message: string };

/** The most digits before the point that the books take (see the amount pattern of the contract). */
const MAX_DIGITS = 16;

/** What a person typed as an amount, as the exact wire amount: "25" is 25.00, "1,250.5" is 1250.50,
 * "$7" is 7.00. A minus sign, a third decimal place, letters, zero and an absurd size are refused
 * with what to do about it. Never goes through a number. */
export function parseEntryAmount(text: string): QuickAmountResult {
  const typed = text.trim();
  if (typed === "") return { ok: false, message: words.errors.amountMissing };
  const plain = typed.replace(/^\$\s*/, "").replace(/[,\s]/g, "");
  const match = /^(\d*)(?:\.(\d*))?$/.exec(plain);
  if (!match || (match[1] === "" && (match[2] ?? "") === ""))
    return { ok: false, message: words.errors.amountFormat };
  const whole = (match[1] ?? "").replace(/^0+(?=\d)/, "") || "0";
  const fraction = match[2] ?? "";
  if (fraction.length > 2) return { ok: false, message: words.errors.amountDecimals };
  if (whole.length > MAX_DIGITS) return { ok: false, message: words.errors.amountLarge };
  const value = `${whole}.${fraction.padEnd(2, "0")}`;
  if (value === "0.00") return { ok: false, message: words.errors.amountZero };
  return { ok: true, value };
}

export type QuickField = "date" | "from" | "to" | "amount";
export interface QuickProblem {
  readonly field: QuickField;
  readonly message: string;
}

const ISO = /^\d{4}-\d{2}-\d{2}$/;

/** What is wrong with the form, in the order a person fills it in. Empty means it can be saved. */
export function quickProblems(kind: QuickKind, values: QuickValues): readonly QuickProblem[] {
  const found: QuickProblem[] = [];
  if (!ISO.test(values.date)) found.push({ field: "date", message: words.errors.date });
  if (values.from === "") found.push({ field: "from", message: words.errors.from[kind] });
  if (values.to === "") found.push({ field: "to", message: words.errors.to[kind] });
  if (values.from !== "" && values.from === values.to)
    found.push({ field: "to", message: words.errors.same });
  const amount = parseEntryAmount(values.amount);
  if (!amount.ok) found.push({ field: "amount", message: amount.message });
  return found;
}

/** The labels of the two account fields for a kind of entry. */
export function quickLabels(kind: QuickKind): { readonly from: string; readonly to: string } {
  const copy = words[kind];
  return {
    from: copy.fromLabel,
    to: copy.toLabel,
  };
}

/** Whether a debit raises the account's balance. Assets and expenses are debit-normal; the rest
 * (liabilities, equity, income) are credit-normal. */
const debitNormal = (role: QuickRole): boolean => role === "asset" || role === "expense";

export interface QuickPreviewLine {
  readonly accountId: string;
  readonly name: string;
  /** The account's balance moves by this much, as the books write an amount: "25.00" or "-25.00". */
  readonly change: string;
  /** The change as it reads, "+25.00" or "−25.00". */
  readonly shown: string;
}

const signed = (cents: bigint): string =>
  cents < 0n ? formatMoney(centsToMoney(cents)) : `+${formatMoney(centsToMoney(cents))}`;

/** What the entry will do, in the accounts' own terms: how much each balance goes up or down. For
 * "Software +25.00, Business checking −25.00" the expense goes up and the bank goes down. A line the
 * person has not filled in yet is left out, and `null` means there is nothing to say yet. */
export function quickPreview(
  values: QuickValues,
  accounts: readonly QuickAccount[],
): readonly QuickPreviewLine[] | null {
  const amount = parseEntryAmount(values.amount);
  const to = accounts.find((account) => account.id === values.to);
  const from = accounts.find((account) => account.id === values.from);
  if (!amount.ok || (!to && !from)) return null;
  const cents = moneyToCents(amount.value);
  const lines: QuickPreviewLine[] = [];
  // The account money goes to is debited; the one it comes from is credited.
  if (to) {
    const change = debitNormal(to.role) ? cents : -cents;
    lines.push({
      accountId: to.id,
      name: to.name,
      change: centsToMoney(change),
      shown: signed(change),
    });
  }
  if (from) {
    const change = debitNormal(from.role) ? -cents : cents;
    lines.push({
      accountId: from.id,
      name: from.name,
      change: centsToMoney(change),
      shown: signed(change),
    });
  }
  return lines;
}

/** The preview as one sentence for a screen reader and for tests: "This will record Software +25.00
 * and Business checking −25.00". */
export function quickPreviewSentence(lines: readonly QuickPreviewLine[]): string {
  return `${words.previewTitle} ${lines.map((line) => `${line.name} ${line.shown}`).join(" and ")}`;
}

/** What the toast says after a post: the amount as a screen shows it, and the accounts it moved between
 * ("Posted: 25.00 spent on Software and subscriptions."). Account ids that are not in the chart are said
 * as they are, never as a blank. */
export function quickPostedSentence(
  kind: QuickKind,
  values: QuickValues,
  accounts: readonly QuickAccount[],
): string {
  const amount = parseEntryAmount(values.amount);
  const shown = formatMoney(amount.ok ? amount.value : "0.00");
  const name = (id: string) => accounts.find((account) => account.id === id)?.name ?? id;
  if (kind === "spend") return words.posted.spend(shown, name(values.to));
  if (kind === "receive") return words.posted.receive(shown, name(values.to));
  return words.posted.transfer(shown, name(values.from), name(values.to));
}

type Range = readonly [from: number, to?: number];

/** A character class from code point ranges, written as escapes so this file stays plain text a
 * reviewer can read (the characters it matches are invisible). */
const classOf = (ranges: readonly Range[]): RegExp =>
  new RegExp(
    `[${ranges
      .map(([from, to]) => {
        const start = `\\u{${from.toString(16)}}`;
        return to === undefined ? start : `${start}-\\u{${to.toString(16)}}`;
      })
      .join("")}]`,
    "gu",
  );
/** Control characters (tab, line feed and carriage return are only whitespace and are kept for the
 * collapse below). */
const CONTROLS = classOf([
  [0x00, 0x08],
  [0x0b, 0x0c],
  [0x0e, 0x1f],
  [0x7f, 0x9f],
]);
/** Characters that hide text or change how it is laid out: the soft hyphen, bidirectional marks,
 * overrides and isolates, zero-width characters and the byte order mark. */
const INVISIBLE = classOf([
  [0xad],
  [0x61c],
  [0x200b, 0x200f],
  [0x202a, 0x202e],
  [0x2060, 0x2064],
  [0x2066, 0x206f],
  [0xfeff],
]);

/** Text a person typed, made safe to keep in an entry: control and direction-changing characters
 * go, runs of space collapse, and it is cut to `max`. */
export function cleanEntryText(value: string, max: number): string {
  const text = value.replace(CONTROLS, "").replace(INVISIBLE, "").replace(/\s+/g, " ").trim();
  return text.length <= max ? text : text.slice(0, max).trimEnd();
}

/** The draft an entry is saved as: two lines, the account money goes to debited and the account it
 * comes from credited, a reference that reads well in the Transactions list, and a narration that says
 * what happened. Call it only for a form `quickProblems` accepts. */
export function quickDraft(
  kind: QuickKind,
  values: QuickValues,
  accounts: readonly QuickAccount[],
): {
  readonly date: string;
  readonly reference: string;
  readonly narration: string;
  readonly lines: readonly { accountId: string; debit: string; credit: string }[];
} {
  const amount = parseEntryAmount(values.amount);
  if (!amount.ok) throw new TypeError(amount.message);
  const party = cleanEntryText(values.party, 80);
  const description = cleanEntryText(values.description, 1000);
  const name = (id: string) => accounts.find((account) => account.id === id)?.name ?? id;
  const generated =
    kind === "transfer"
      ? words.entry.transfer(name(values.from), name(values.to))
      : words.entry[kind](party);
  return {
    date: values.date,
    reference: cleanEntryText(party || description || words.entry.reference[kind], 80),
    narration: description || generated,
    lines: [
      { accountId: values.to, debit: amount.value, credit: "" },
      { accountId: values.from, debit: "", credit: amount.value },
    ],
  };
}
