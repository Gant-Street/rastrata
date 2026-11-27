/** Opening balances: the arithmetic that turns what a person knows about each account on the day
 * they leave another system into the one balanced journal that starts the book.
 *
 * Pure and portable (no `bun:` or `node:`; the browser imports it for the live totals on the
 * screen, so the figure a person sees while typing is computed by the same code the service uses
 * to review and to post). Money is exact: integer cents in a `bigint`, never a float, never a
 * tolerance. A balance is entered the way a person reads it: the amount in the account's normal
 * orientation, so a bank account holding 1,200.00 and a card that owes 300.00 are both entered as
 * positive numbers, and a negative number means the unusual side (an overdrawn bank account). The
 * review states every line as a debit or a credit, so a misread sign shows before anything posts.
 *
 * The journal balances against an equity offset account. The offset is calculated, never typed,
 * and is shown as a line of its own with what it is: whatever the entered balances do not explain. */
import { formatMoney, isMoney, parseMoney } from "../money.ts";

export type OpeningRole =
  | "asset"
  | "liability"
  | "equity"
  | "income"
  | "expense"
  | "gain"
  | "unrealizedGain";
export type OpeningSide = "debit" | "credit";

/** Assets and expenses are debit-normal; everything else is credit-normal. */
export const sideOf = (role: OpeningRole): OpeningSide =>
  role === "asset" || role === "expense" ? "debit" : "credit";

export const isProfitLoss = (role: OpeningRole): boolean =>
  role === "income" || role === "expense" || role === "gain" || role === "unrealizedGain";

/** A posting is one journal line; the application accepts at most this many in one entry (the
 * offset line included). */
export const MAX_JOURNAL_LINES = 100;
/** The largest amount one journal line carries: sixteen digits and two decimals. */
export const MAX_LINE_CENTS = 999_999_999_999_999_999n;

export interface OpeningAccount {
  readonly id: string;
  readonly code: string;
  readonly name: string;
  readonly role: OpeningRole;
  readonly openedOn: string;
  readonly closedOn: string | null;
}

/** One balance as it was given: the account and its amount in the normal orientation. */
export interface OpeningEntry {
  readonly accountId: string;
  /** Signed, two places. Positive is the account's normal side. */
  readonly balance: string;
  /** The row of the file it came from, when it came from one. */
  readonly row?: number;
}

export type IssueSeverity = "error" | "warning" | "info";

export interface OpeningIssue {
  readonly severity: IssueSeverity;
  readonly code: string;
  readonly message: string;
  readonly accountId?: string;
  readonly row?: number;
}

export interface OpeningLine {
  readonly accountId: string;
  readonly code: string;
  readonly name: string;
  readonly role: OpeningRole;
  /** The account's normal side. */
  readonly side: OpeningSide;
  /** As entered: positive is the normal side. */
  readonly balance: string;
  readonly debit: string;
  readonly credit: string;
  readonly row?: number;
}

export interface OpeningOffset {
  readonly accountId: string;
  readonly code: string;
  readonly name: string;
  readonly debit: string;
  readonly credit: string;
  /** True when the person named the account; false when it was found by its name. */
  readonly chosen: boolean;
}

export interface OpeningTotals {
  /** What the entered balances come to on each side, before the offset. */
  readonly enteredDebit: string;
  readonly enteredCredit: string;
  /** What the journal comes to on each side, offset included. */
  readonly debit: string;
  readonly credit: string;
  readonly balanced: boolean;
}

/** One line of the journal that will be posted, in the shape a draft takes. */
export interface JournalLine {
  readonly accountId: string;
  readonly debit: string;
  readonly credit: string;
}

export interface OpeningBuild {
  readonly valid: boolean;
  readonly lines: readonly OpeningLine[];
  readonly offset: OpeningOffset | null;
  readonly totals: OpeningTotals;
  /** Entries at 0.00: not part of the journal. */
  readonly zeroBalances: number;
  readonly issues: readonly OpeningIssue[];
  /** The exact journal, accounts in code order and the offset last. Empty when there is nothing
   * to post. */
  readonly journal: readonly JournalLine[];
}

export interface OpeningCalendarFacts {
  /** The cutover date is the first day of a fiscal year. */
  readonly fiscalYearStart: boolean;
}

export interface OpeningBuildInput {
  readonly cutoverDate: string;
  /** The date the entry is posted on: the day before the cutover when the book's calendar allows
   * it, the cutover date itself otherwise (the default). The accounts must be open on it. */
  readonly entryDate?: string | undefined;
  readonly accounts: readonly OpeningAccount[];
  readonly entries: readonly OpeningEntry[];
  /** The account that balances the entry. Omitted: the one equity account named for opening
   * balances, when the entered balances need an offset. */
  readonly offsetAccountId?: string | undefined;
  readonly calendar?: OpeningCalendarFacts | undefined;
  /** For tests that pin the limit. */
  readonly maxLines?: number | undefined;
}

const error = (
  code: string,
  message: string,
  extra: { accountId?: string; row?: number } = {},
): OpeningIssue => ({ severity: "error", code, message, ...extra });
const warning = (
  code: string,
  message: string,
  extra: { accountId?: string; row?: number } = {},
): OpeningIssue => ({ severity: "warning", code, message, ...extra });
const info = (
  code: string,
  message: string,
  extra: { accountId?: string; row?: number } = {},
): OpeningIssue => ({ severity: "info", code, message, ...extra });

const compareCodes = (a: string, b: string): number => (a < b ? -1 : a > b ? 1 : 0);
const DATE = /^\d{4}-\d{2}-\d{2}$/;

/** A real calendar date written YYYY-MM-DD. */
export function isCalendarDate(value: string): boolean {
  if (!DATE.test(value)) return false;
  const [year, month, day] = value.split("-").map(Number) as [number, number, number];
  if (month < 1 || month > 12 || day < 1) return false;
  const leap = (year % 4 === 0 && year % 100 !== 0) || year % 400 === 0;
  const length = [31, leap ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31][month - 1] as number;
  return day <= length;
}

/** The debit-positive effect of a balance on the books: a debit-normal account's balance as it
 * stands, a credit-normal account's negated. */
export const debitCents = (role: OpeningRole, balanceCents: bigint): bigint =>
  sideOf(role) === "debit" ? balanceCents : -balanceCents;

/** A named account for opening balances: "Opening balance equity", however it is cased or spaced. */
const OFFSET_NAME = /\bopening\s+balances?\b/i;

/** Whether an account is the equity account named for opening balances: where a hand-made opening
 * entry puts what the balances do not explain. */
export const isOpeningBalanceAccount = (account: {
  readonly role: string;
  readonly name: string;
}): boolean => account.role === "equity" && OFFSET_NAME.test(account.name);

export type OffsetChoice =
  | { readonly account: OpeningAccount; readonly chosen: boolean }
  | { readonly problem: OpeningIssue };

/** The equity account that balances the entry. A named account must exist and be equity; with none
 * named, exactly one equity account whose name says opening balances is used. */
export function resolveOffset(
  accounts: readonly OpeningAccount[],
  offsetAccountId: string | undefined,
): OffsetChoice {
  const equity = accounts.filter((account) => account.role === "equity");
  if (offsetAccountId !== undefined) {
    const named = accounts.find((account) => account.id === offsetAccountId);
    if (!named)
      return {
        problem: error(
          "offset_not_found",
          "The offset account is not in your chart. Choose an equity account.",
          { accountId: offsetAccountId },
        ),
      };
    if (named.role !== "equity")
      return {
        problem: error(
          "offset_not_equity",
          `The offset must be an equity account; ${named.code} is a ${named.role} account.`,
          { accountId: named.id },
        ),
      };
    return { account: named, chosen: true };
  }
  const named = equity.filter((account) => OFFSET_NAME.test(account.name));
  if (named.length === 1) return { account: named[0] as OpeningAccount, chosen: false };
  if (named.length > 1)
    return {
      problem: error(
        "offset_ambiguous",
        `More than one equity account is named for opening balances (${named.map((a) => a.code).join(", ")}). Choose which one is the offset.`,
      ),
    };
  return {
    problem: error(
      "offset_required",
      equity.length === 0
        ? "Your chart has no equity account to carry the difference. Add one (for example Opening balance equity), then try again."
        : "Choose the equity account that carries the difference, for example Opening balance equity.",
    ),
  };
}

/** Add up what the balances come to, before any offset: the debits, the credits and what is left to
 * balance. The browser uses it for the totals under the table. */
export function openingTotals(rows: readonly { role: OpeningRole; balance: string }[]): {
  readonly debit: string;
  readonly credit: string;
  /** Debits less credits: what the offset must carry, as a debit when positive. */
  readonly net: string;
} {
  let debit = 0n;
  let credit = 0n;
  for (const row of rows) {
    if (!isMoney(row.balance)) continue;
    const signed = debitCents(row.role, parseMoney(row.balance));
    if (signed > 0n) debit += signed;
    else credit -= signed;
  }
  return {
    debit: formatMoney(debit),
    credit: formatMoney(credit),
    net: formatMoney(debit - credit),
  };
}

const NO_TOTALS: OpeningTotals = {
  enteredDebit: "0.00",
  enteredCredit: "0.00",
  debit: "0.00",
  credit: "0.00",
  balanced: true,
};

/** Build the journal for these balances, or say exactly why it cannot be built. Never throws for a
 * problem with the data: every problem is an issue naming the account or row. */
export function buildOpening(input: OpeningBuildInput): OpeningBuild {
  const issues: OpeningIssue[] = [];
  const byId = new Map(input.accounts.map((account) => [account.id, account]));
  const maxLines = input.maxLines ?? MAX_JOURNAL_LINES;
  const entryDate = input.entryDate ?? input.cutoverDate;
  if (!isCalendarDate(input.cutoverDate))
    issues.push(
      error("date_invalid", `${JSON.stringify(input.cutoverDate)} is not a calendar date.`),
    );

  const seen = new Map<string, number>();
  let zeroBalances = 0;
  const lines: OpeningLine[] = [];
  const cents = new Map<string, bigint>();
  for (const entry of input.entries) {
    const at = entry.row !== undefined ? { row: entry.row } : {};
    const account = byId.get(entry.accountId);
    if (!account) {
      issues.push(
        error("account_not_found", "That account is not in your chart.", {
          accountId: entry.accountId,
          ...at,
        }),
      );
      continue;
    }
    const label = `${account.code} ${account.name}`;
    if (seen.has(account.id)) {
      issues.push(
        error("duplicate_account", `${label} is listed twice. Give each account one balance.`, {
          accountId: account.id,
          ...at,
        }),
      );
      continue;
    }
    seen.set(account.id, entry.row ?? 0);
    if (!isMoney(entry.balance)) {
      issues.push(
        error("amount_invalid", `The balance for ${label} is not an amount with two decimals.`, {
          accountId: account.id,
          ...at,
        }),
      );
      continue;
    }
    const balance = parseMoney(entry.balance);
    if (balance === 0n) {
      zeroBalances++;
      continue;
    }
    const magnitude = balance < 0n ? -balance : balance;
    if (magnitude > MAX_LINE_CENTS) {
      issues.push(
        error("amount_too_large", `The balance for ${label} is too large to post.`, {
          accountId: account.id,
          ...at,
        }),
      );
      continue;
    }
    if (isCalendarDate(entryDate)) {
      if (account.closedOn !== null && account.closedOn <= entryDate)
        issues.push(
          error(
            "account_closed",
            `${label} was closed on ${account.closedOn}, so it cannot start with a balance${entryDate === input.cutoverDate ? ` on ${input.cutoverDate}` : ` (the opening entry is dated ${entryDate})`}.`,
            { accountId: account.id, ...at },
          ),
        );
      else if (account.openedOn > entryDate)
        issues.push(
          error(
            "account_not_open",
            entryDate === input.cutoverDate
              ? `${label} opens on ${account.openedOn}, after the cutover date ${input.cutoverDate}.`
              : `${label} opens on ${account.openedOn}, after ${entryDate}, the date of the opening entry.`,
            { accountId: account.id, ...at },
          ),
        );
    }
    const side = sideOf(account.role);
    const signed = debitCents(account.role, balance);
    cents.set(account.id, signed);
    lines.push({
      accountId: account.id,
      code: account.code,
      name: account.name,
      role: account.role,
      side,
      balance: formatMoney(balance),
      debit: formatMoney(signed > 0n ? signed : 0n),
      credit: formatMoney(signed < 0n ? -signed : 0n),
      ...(entry.row !== undefined ? { row: entry.row } : {}),
    });
  }
  lines.sort((a, b) => compareCodes(a.code, b.code));
  if (zeroBalances > 0)
    issues.push(
      info(
        "zero_balances",
        `${zeroBalances} ${zeroBalances === 1 ? "account is" : "accounts are"} at 0.00 and left out of the entry.`,
      ),
    );

  let debit = 0n;
  let credit = 0n;
  for (const signed of cents.values()) {
    if (signed > 0n) debit += signed;
    else credit -= signed;
  }
  const net = debit - credit;

  let offset: OpeningOffset | null = null;
  const entered = { enteredDebit: formatMoney(debit), enteredCredit: formatMoney(credit) };
  if (net !== 0n) {
    const choice = resolveOffset(input.accounts, input.offsetAccountId);
    if ("problem" in choice) issues.push(choice.problem);
    else {
      const account = choice.account;
      if (seen.has(account.id))
        issues.push(
          error(
            "offset_entered",
            `${account.code} ${account.name} is the offset: its amount is calculated so the entry balances. Remove it from the list, or choose another equity account as the offset.`,
            { accountId: account.id },
          ),
        );
      const amount = net < 0n ? -net : net;
      if (amount > MAX_LINE_CENTS)
        issues.push(
          error("amount_too_large", "The difference is too large for one line of an entry."),
        );
      // A net debit is offset by a credit to equity, and the other way round.
      offset = {
        accountId: account.id,
        code: account.code,
        name: account.name,
        debit: formatMoney(net < 0n ? amount : 0n),
        credit: formatMoney(net > 0n ? amount : 0n),
        chosen: choice.chosen,
      };
      if (isCalendarDate(entryDate)) {
        if (account.closedOn !== null && account.closedOn <= entryDate)
          issues.push(
            error("account_closed", `The offset account was closed on ${account.closedOn}.`, {
              accountId: account.id,
            }),
          );
        else if (account.openedOn > entryDate)
          issues.push(
            error(
              "account_not_open",
              entryDate === input.cutoverDate
                ? `The offset account opens on ${account.openedOn}, after the cutover date.`
                : `The offset account opens on ${account.openedOn}, after ${entryDate}, the date of the opening entry.`,
              { accountId: account.id },
            ),
          );
      }
      issues.push(
        info(
          "offset_carries_difference",
          `${account.code} ${account.name} carries ${formatMoney(amount)} as a ${net > 0n ? "credit" : "debit"}: everything the balances you entered do not explain. It is the owner's equity at the start; reclassify it later if you want it split.`,
          { accountId: account.id },
        ),
      );
    }
  }

  if (lines.length + (offset ? 1 : 0) > maxLines)
    issues.push(
      error(
        "too_many_lines",
        `One entry holds at most ${maxLines} lines, offset included, and this one needs ${lines.length + (offset ? 1 : 0)}. Leave out accounts that are not needed, such as year-to-date profit and loss accounts.`,
      ),
    );
  if (lines.length === 0 && !issues.some((issue) => issue.severity === "error"))
    issues.push(error("nothing_to_post", "Enter at least one balance that is not zero."));

  const profitLoss = lines.filter((line) => isProfitLoss(line.role));
  if (profitLoss.length > 0 && input.calendar) {
    if (input.calendar.fiscalYearStart)
      issues.push(
        warning(
          "profit_loss_at_year_start",
          `${profitLoss.length} income or expense ${profitLoss.length === 1 ? "account has" : "accounts have"} a balance, but a fiscal year starts on the cutover date, when profit and loss accounts start at zero. Last year's result belongs in equity.`,
        ),
      );
    else
      issues.push(
        warning(
          "profit_loss_mid_year",
          `${profitLoss.length} income or expense ${profitLoss.length === 1 ? "account has" : "accounts have"} a balance. These are year-to-date amounts, and the entry is dated ${entryDate}, so the profit and loss for the period that date falls in shows them. Leave them out if you want monthly figures from the start; the difference then lands in the offset.`,
        ),
      );
  }

  const valid = !issues.some((issue) => issue.severity === "error");
  const journal: JournalLine[] = valid
    ? [
        ...lines.map((line) => ({
          accountId: line.accountId,
          debit: line.debit === "0.00" ? "" : line.debit,
          credit: line.credit === "0.00" ? "" : line.credit,
        })),
        ...(offset
          ? [
              {
                accountId: offset.accountId,
                debit: offset.debit === "0.00" ? "" : offset.debit,
                credit: offset.credit === "0.00" ? "" : offset.credit,
              },
            ]
          : []),
      ]
    : [];
  const offsetDebit = offset ? parseMoney(offset.debit) : 0n;
  const offsetCredit = offset ? parseMoney(offset.credit) : 0n;
  const totals: OpeningTotals =
    lines.length === 0
      ? { ...NO_TOTALS, ...entered }
      : {
          ...entered,
          debit: formatMoney(debit + offsetDebit),
          credit: formatMoney(credit + offsetCredit),
          balanced: debit + offsetDebit === credit + offsetCredit,
        };
  return { valid, lines, offset, totals, zeroBalances, issues, journal };
}
