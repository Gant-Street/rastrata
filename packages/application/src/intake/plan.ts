import { formatMoney, parseMoney } from "../money.ts";
import type { FileFacts } from "./inspect.ts";
import {
  addDays,
  type Gate,
  monthEnd,
  monthOf,
  monthsBetween,
  type Owner,
  type PlanCode,
  type PlanStatus,
} from "./sets.ts";

/** A move-in plan: pure data in, pure data out.
 *
 * Given what the agent declares (which files belong to which account, the cutover date, how far the
 * statements should go), the facts of those files, and the book as it stands, the plan says what is
 * present, what is missing and what cannot be relied on, and for each gap what to do next. It reads
 * no file, calls no operation and keeps no state: the same input gives the same plan.
 *
 * Nothing a customer's file says is copied into the plan. A plan item is a code, an account, a
 * file named by its SHA-256, a month, and a sentence built here from fixed words and numbers; a
 * command is built from fixed templates and ids that passed the book's own checks. */

export interface PlanSourceInput {
  /** The chart account, by id, code or exact name. */
  readonly account: string;
  readonly kind?: "bank" | "card";
  readonly files: readonly string[];
}

export interface PlanBalanceInput {
  readonly file: string;
  /** The balance the statement prints at its start and at its end, read from the statement. */
  readonly opening?: string;
  readonly ending?: string;
}

export interface PlanInput {
  readonly cutoverDate?: string;
  /** The last day the statements should reach. Left out, the latest month any file reaches. */
  readonly through?: string;
  readonly sources: readonly PlanSourceInput[];
  /** Every file the scan found, so a file nobody assigned is noticed. */
  readonly files?: readonly string[];
  readonly trialBalance?: string;
  readonly chart?: string;
  readonly generalLedger?: string;
  readonly payoutReports?: readonly string[];
  readonly balances?: readonly PlanBalanceInput[];
  /** Files left out of the move on purpose (a statement of an account that is being closed, a
   * test file): they are not reported as unassigned. */
  readonly ignore?: readonly string[];
  /** Files whose unreadable rows the owner agreed to leave out (a totals row, a heading). */
  readonly skipInvalidRows?: readonly string[];
  /** There are no earlier books: no trial balance is expected. */
  readonly fresh?: boolean;
}

export interface PlanFileInfo {
  readonly sha256: string;
  readonly facts: FileFacts;
}

export interface PlanBookAccount {
  readonly id: string;
  readonly code: string;
  readonly name: string;
  readonly role: string;
  readonly closedOn: string | null;
}

export interface PlanBook {
  readonly configured: boolean;
  readonly accounts: readonly PlanBookAccount[];
  readonly recordedCutover: string | null;
}

/** One account of a trial balance, in the account's own sign: debits less credits. */
export interface PlanTrialBalanceRow {
  readonly code: string | null;
  readonly name: string;
  readonly balance: bigint;
}

export interface PlanNext {
  readonly command?: string;
  readonly file?: string;
  readonly note: string;
}

export interface PlanItem {
  readonly code: PlanCode;
  readonly status: PlanStatus;
  readonly required: boolean;
  readonly owner: Owner;
  readonly account?: string;
  readonly file?: string;
  readonly month?: string;
  readonly gate?: Gate;
  readonly detail: string;
  readonly next?: PlanNext;
}

export interface PlanMonth {
  readonly month: string;
  readonly state: "covered" | "missing";
  readonly files: number;
}

export interface PlanSourceView {
  readonly account: string;
  readonly accountId?: string;
  readonly kind: "bank" | "card";
  readonly files: number;
  readonly months: readonly PlanMonth[];
}

export interface Plan {
  readonly cutoverDate: string | null;
  readonly through: string | null;
  readonly sources: readonly PlanSourceView[];
  readonly items: readonly PlanItem[];
  readonly counts: {
    readonly present: number;
    readonly missing: number;
    readonly uncertain: number;
  };
  /** Nothing required is missing or uncertain. */
  readonly ready: boolean;
  /** More items than are listed: the first ones are the ones to deal with. */
  readonly truncated: boolean;
}

const MAX_ITEMS = 400;
const MAX_MONTH_ITEMS_PER_SOURCE = 12;
const SAFE_ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,39}$/;
const BANKLIKE =
  /bank|checking|savings|money market|credit union|card|visa|mastercard|amex|stripe|paypal|cash/i;

const normal = (text: string): string => text.trim().toLowerCase().replace(/\s+/g, " ");

export function resolveAccount(
  accounts: readonly PlanBookAccount[],
  want: string,
): { account?: PlanBookAccount; ambiguous: boolean } {
  for (const pick of [
    (a: PlanBookAccount) => a.id,
    (a: PlanBookAccount) => a.code,
    (a: PlanBookAccount) => a.name,
  ]) {
    const found = accounts.filter((account) => normal(pick(account)) === normal(want));
    if (found.length === 1) return { account: found[0] as PlanBookAccount, ambiguous: false };
    if (found.length > 1) return { ambiguous: true };
  }
  return { ambiguous: false };
}

/** An account written into a command: its id when the book has one, else only a plain token. */
const accountToken = (account: PlanBookAccount | undefined, declared: string): string =>
  account && SAFE_ID.test(account.id)
    ? account.id
    : SAFE_ID.test(declared)
      ? declared
      : "<ACCOUNT>";

function span(facts: FileFacts): { from: string; to: string } | null {
  return facts.range ? { from: facts.range.from, to: facts.range.to } : null;
}

const cents = (value: string | undefined): bigint | null => {
  if (value === undefined) return null;
  try {
    return parseMoney(value);
  } catch {
    return null;
  }
};

export function buildPlan(
  input: PlanInput,
  files: ReadonlyMap<string, PlanFileInfo>,
  book: PlanBook,
  trialBalanceRows: readonly PlanTrialBalanceRow[] | null,
): Plan {
  const items: PlanItem[] = [];
  const add = (item: PlanItem) => {
    items.push(item);
  };
  const balances = new Map<string, PlanBalanceInput>();
  for (const balance of input.balances ?? []) balances.set(balance.file, balance);

  // ---- The dates ---------------------------------------------------------------------------
  const declared = input.cutoverDate ?? null;
  const cutover = declared ?? book.recordedCutover;
  if (cutover === null) {
    add({
      code: "cutover_date",
      status: "missing",
      required: true,
      owner: "customer",
      detail: "No cutover date: the first day of the new books has not been chosen.",
      next: {
        command: "rastrata cutover set --date <DATE> --accounts <ACCOUNT_IDS>",
        note: "Ask the owner for the first day of the new books (usually the first of a month); never guess it.",
      },
    });
  } else if (
    declared !== null &&
    book.recordedCutover !== null &&
    declared !== book.recordedCutover
  ) {
    add({
      code: "cutover_date",
      status: "uncertain",
      required: true,
      owner: "customer",
      detail: `The plan says ${declared} but the book records ${book.recordedCutover}.`,
      next: {
        command: "rastrata cutover show",
        note: "Decide which is right with the owner. The recorded date cannot move once the opening entry is posted.",
      },
    });
  } else {
    add({
      code: "cutover_date",
      status: "present",
      required: true,
      owner: "agent",
      detail: `Cutover ${cutover}${declared !== null ? " (in the plan)" : " (recorded in the book)"}.`,
    });
  }

  const known = (info: PlanFileInfo | undefined): info is PlanFileInfo => info !== undefined;
  const everyRange: string[] = [];
  for (const source of input.sources)
    for (const sha of source.files) {
      const range = known(files.get(sha)) ? span((files.get(sha) as PlanFileInfo).facts) : null;
      if (range) everyRange.push(range.to);
    }
  const through =
    input.through ?? (everyRange.length > 0 ? (everyRange.sort().at(-1) ?? null) : null);
  if (input.through === undefined) {
    add({
      code: "through_date",
      status: through === null ? "missing" : "present",
      required: false,
      owner: "agent",
      detail:
        through === null
          ? "No statement has dates, so there is no last month to expect."
          : `No last day was given; the latest statement reaches ${through}.`,
    });
  }

  // ---- The sources -------------------------------------------------------------------------
  const referenced = new Set<string>();
  const sourceViews: PlanSourceView[] = [];
  const declaredAccounts = new Set<string>();
  const firstMonth = cutover === null ? null : monthOf(cutover);
  const lastMonth = through === null ? null : monthOf(through);
  const months =
    firstMonth !== null && lastMonth !== null ? monthsBetween(firstMonth, lastMonth) : [];

  for (const source of input.sources) {
    const { account, ambiguous } = resolveAccount(book.accounts, source.account);
    const kind = source.kind ?? (account?.role === "liability" ? "card" : "bank");
    const token = accountToken(account, source.account);
    const label = account
      ? account.code
      : SAFE_ID.test(source.account)
        ? source.account
        : "an account";
    if (account) declaredAccounts.add(account.id);

    if (!book.configured) {
      add({
        code: "source_account",
        status: "missing",
        required: true,
        owner: "agent",
        account: token,
        detail: "The book is not set up yet, so no account can be chosen.",
        next: {
          command: "rastrata book setup --input -",
          note: "Set up the book with the accounts these files belong to.",
        },
      });
    } else if (ambiguous) {
      add({
        code: "source_account",
        status: "uncertain",
        required: true,
        owner: "agent",
        account: token,
        detail: "More than one chart account matches; name it by its id.",
        next: { command: "rastrata accounts list", note: "Use the id of the one you mean." },
      });
    } else if (!account) {
      add({
        code: "source_account",
        status: "missing",
        required: true,
        owner: "agent",
        account: token,
        detail: "No chart account matches this source.",
        next: {
          command: "rastrata accounts prepare-create --input -",
          note: "Create the bank or card account in the chart (an asset for a bank, a liability for a card), or name the account that exists.",
        },
      });
    } else if (
      (account.role !== "asset" && account.role !== "liability") ||
      account.closedOn !== null
    ) {
      add({
        code: "source_account",
        status: "uncertain",
        required: true,
        owner: "agent",
        account: account.id,
        detail:
          account.closedOn !== null
            ? "The chart account is closed."
            : "The chart account is not an asset (a bank) or a liability (a card).",
        next: {
          note: "Choose an open asset account for a bank or a liability account for a card.",
        },
      });
    } else {
      add({
        code: "source_account",
        status: "present",
        required: true,
        owner: "agent",
        account: account.id,
        detail: `${account.role === "asset" ? "Bank" : "Card"} account ${account.code}.`,
      });
      if (kind === "card" && account.role === "asset")
        add({
          code: "source_account",
          status: "uncertain",
          required: true,
          owner: "agent",
          account: account.id,
          detail: "The plan calls this a card but the chart account is an asset.",
          next: {
            note: "A credit card is a liability account. Check which account these statements belong to.",
          },
        });
    }

    const unique = [...new Set(source.files)];
    for (const sha of unique) referenced.add(sha);
    if (unique.length < source.files.length)
      add({
        code: "duplicate_file",
        status: "uncertain",
        required: false,
        owner: "agent",
        account: token,
        gate: "duplicate_file",
        detail: `The same file is listed ${source.files.length - unique.length} more time(s) for this account. It is read once.`,
        next: { note: "List each statement once." },
      });

    if (unique.length === 0) {
      add({
        code: "source_files",
        status: "missing",
        required: true,
        owner: "customer",
        account: token,
        detail: `No file for account ${label}.`,
        next: {
          note: "Ask the owner for this account's statements (CSV, OFX or QFX) from the cutover month on, or say the account is to be left out.",
        },
      });
      sourceViews.push({
        account: label,
        ...(account ? { accountId: account.id } : {}),
        kind,
        files: 0,
        months: months.map((month) => ({ month, state: "missing" as const, files: 0 })),
      });
      for (const month of months.slice(0, MAX_MONTH_ITEMS_PER_SOURCE))
        add({
          code: "statement_coverage",
          status: "missing",
          required: true,
          owner: "customer",
          account: token,
          month,
          gate: "coverage",
          detail: `No statement for ${month}.`,
        });
      continue;
    }

    // The files of the source, oldest first.
    interface Entry {
      sha: string;
      facts: FileFacts;
      from: string | null;
      to: string | null;
    }
    const entries: Entry[] = [];
    for (const sha of unique) {
      const info = files.get(sha);
      if (!info) {
        add({
          code: "source_files",
          status: "uncertain",
          required: true,
          owner: "agent",
          account: token,
          file: sha,
          detail: "This file is not in the archive.",
          next: { note: "Upload it again (rastrata intake scan FOLDER), then run the plan again." },
        });
        continue;
      }
      const range = span(info.facts);
      entries.push({ sha, facts: info.facts, from: range?.from ?? null, to: range?.to ?? null });
    }
    entries.sort(
      (a, b) => (a.from ?? "9999").localeCompare(b.from ?? "9999") || a.sha.localeCompare(b.sha),
    );

    for (const entry of entries) {
      const { facts, sha } = entry;
      const common = { required: true, account: token, file: sha } as const;
      if (!facts.parsed) {
        add({
          code: "unparsed_file",
          status: "uncertain",
          ...common,
          owner: "agent",
          detail: `This ${facts.kind} file is not read by the program (${facts.why ?? "unreadable"}).`,
          next: {
            note: "Read it yourself, or ask for the bank's CSV, OFX or QFX download; the program imports only those.",
            file: sha,
          },
        });
        continue;
      }
      if (facts.role !== "bank_statement" && facts.role !== "card_statement") {
        add({
          code: "statement_readable",
          status: "uncertain",
          ...common,
          owner: "agent",
          detail: `This file reads as ${facts.role.replaceAll("_", " ")}, not as a statement.`,
          next: {
            note: "Check that the file belongs to this account, or assign it where it belongs.",
            file: sha,
          },
        });
        continue;
      }
      if (facts.need === "human" && (input.skipInvalidRows ?? []).includes(sha)) {
        add({
          code: "statement_readable",
          status: "present",
          ...common,
          owner: "agent",
          gate: "rejected_rows",
          detail: `Some rows are left out with the owner's agreement; the statement's balance still has to agree.`,
        });
      } else if (facts.need === "human") {
        add({
          code: "statement_readable",
          status: "uncertain",
          ...common,
          owner: "customer",
          gate: "rejected_rows",
          detail: `Some rows of this ${facts.kind} file cannot be read (${facts.flags.includes("total_row") ? "a totals row, perhaps" : "see the preview"}). They are left out only if the owner agrees.`,
          next: {
            command: `rastrata import <FILE> --account ${token} --dry-run=true`,
            file: sha,
            note: "Read the rows the preview lists. If they are not transactions, import the rest with --skip-invalid-rows=true; the statement's balance still has to agree.",
          },
        });
      } else if (facts.need === "recipe") {
        add({
          code: "statement_readable",
          status: "uncertain",
          ...common,
          owner: "agent",
          detail: `This ${facts.kind} file is not read correctly without a recipe${facts.flags.length > 0 ? ` (${facts.flags.join(", ")})` : ""}.`,
          next: {
            command: `rastrata intake recipe test <RECIPE.json> <FILE> --account ${token}`,
            file: sha,
            note: "Write a recipe for the layout, prove it on this file with the ending balance printed on the statement, then save it.",
          },
        });
      } else {
        add({
          code: "statement_readable",
          status: "present",
          ...common,
          owner: "agent",
          detail: `${facts.kind.toUpperCase()} read as ${facts.statement?.reading ?? "ofx"}${facts.rows !== undefined ? `, ${facts.rows} rows` : ""}.`,
        });
      }
      const guessedCard = facts.role === "card_statement";
      if (facts.confidence !== "low" && account && (account.role === "liability") !== guessedCard)
        add({
          code: "statement_readable",
          status: "uncertain",
          ...common,
          owner: "agent",
          detail: `The file reads as a ${guessedCard ? "card" : "bank"} statement but the chart account is a ${account.role === "liability" ? "card" : "bank"}.`,
          next: {
            note: "Check the signs in the preview before importing: a card charge is negative.",
          },
        });

      // An ending balance to prove the statement against.
      const declaredBalance = balances.get(sha);
      const hasBalance =
        (facts.statement !== undefined && facts.statement.balance !== "none") ||
        declaredBalance?.ending !== undefined;
      add({
        code: "statement_ending_balance",
        status: hasBalance ? "present" : "missing",
        ...common,
        owner: "customer",
        gate: "ending_balance",
        detail: hasBalance
          ? declaredBalance?.ending !== undefined
            ? "The ending balance was read from the statement."
            : `The file carries a ${facts.statement?.balance} balance.`
          : "The file has no balance, so nothing proves it complete.",
        ...(hasBalance
          ? {}
          : {
              next: {
                command: `rastrata intake recipe test <RECIPE.json> <FILE> --opening-balance <AMOUNT> --ending-balance <AMOUNT>`,
                file: sha,
                note: "Read the opening and ending balances from the statement itself, never from the books.",
              },
            }),
      });
      if (facts.flags.includes("ambiguous_dates") && facts.dateOrder === "ambiguous")
        add({
          code: "statement_readable",
          status: "uncertain",
          ...common,
          owner: "customer",
          gate: "date_order",
          detail: "Every date could be month/day or day/month. The program never guesses.",
          next: {
            command: `rastrata intake recipe test <RECIPE.json> <FILE> --period-from <DATE> --period-to <DATE>`,
            file: sha,
            note: "Give the statement period printed on the statement (a day above 12 settles the order) and write it into the recipe.",
          },
        });
    }

    // The months the files cover.
    const ranged = entries.filter((entry) => entry.from !== null && entry.to !== null);
    const monthStates: PlanMonth[] = months.map((month) => {
      const hits = ranged.filter(
        (entry) =>
          (entry.from as string) <= monthEnd(month) && (entry.to as string) >= `${month}-01`,
      ).length;
      return { month, state: hits > 0 ? ("covered" as const) : ("missing" as const), files: hits };
    });
    sourceViews.push({
      account: label,
      ...(account ? { accountId: account.id } : {}),
      kind,
      files: unique.length,
      months: monthStates,
    });
    if (ranged.length === 0 && entries.length > 0) {
      add({
        code: "statement_coverage",
        status: "uncertain",
        required: true,
        owner: "agent",
        account: token,
        gate: "coverage",
        detail: "No file of this account gives dates yet, so the months it covers are not known.",
      });
    } else {
      let listed = 0;
      let more = 0;
      for (const state of monthStates)
        if (state.state === "missing") {
          if (listed < MAX_MONTH_ITEMS_PER_SOURCE) {
            listed++;
            add({
              code: "statement_coverage",
              status: "missing",
              required: true,
              owner: "customer",
              account: token,
              month: state.month,
              gate: "coverage",
              detail: `No statement covers ${state.month}.`,
              next: {
                note: `Download the statement for ${state.month} (CSV, OFX or QFX) and add it to the folder, then scan it.`,
              },
            });
          } else more++;
        }
      if (more > 0)
        add({
          code: "statement_coverage",
          status: "missing",
          required: true,
          owner: "customer",
          account: token,
          gate: "coverage",
          detail: `${more} more month(s) have no statement.`,
        });
      if (monthStates.length > 0 && monthStates.every((state) => state.state === "covered"))
        add({
          code: "statement_coverage",
          status: "present",
          required: true,
          owner: "agent",
          account: token,
          gate: "coverage",
          detail: `Every month from ${monthStates[0]?.month} to ${monthStates.at(-1)?.month} has a statement.`,
        });
    }

    // Each file picks up where the one before it ended.
    const closing = (entry: Entry): bigint | null =>
      cents(balances.get(entry.sha)?.ending) ?? cents(entry.facts.statement?.closing?.amount);
    const opening = (entry: Entry): bigint | null =>
      cents(balances.get(entry.sha)?.opening) ?? cents(entry.facts.statement?.opening);
    for (let at = 1; at < ranged.length; at++) {
      const before = ranged[at - 1] as Entry;
      const entry = ranged[at] as Entry;
      if (before.sha === entry.sha) continue;
      const last = closing(before);
      const first = opening(entry);
      if (last === null || first === null) continue;
      // Only neighbours: a month with no statement between them is reported as missing already.
      const gap = monthsBetween(monthOf(before.to as string), monthOf(entry.from as string)).length;
      if (gap > 2) continue;
      if (last !== first)
        add({
          code: "statement_continuity",
          status: "uncertain",
          required: true,
          owner: "agent",
          account: token,
          file: entry.sha,
          gate: "continuity",
          detail: `This file opens at ${formatMoney(first)} but the one before it closed at ${formatMoney(last)} (difference ${formatMoney(first - last)}). A line or a file is missing between them, or one is read wrongly.`,
          next: {
            note: "Look for a missing file or a line the recipe left out. Do not adjust a balance.",
          },
        });
    }
    // Two files that cover the same days.
    for (let at = 1; at < ranged.length; at++) {
      const before = ranged[at - 1] as Entry;
      const entry = ranged[at] as Entry;
      if (
        (entry.from as string) <= (before.to as string) &&
        entry.from === before.from &&
        entry.to === before.to
      )
        add({
          code: "duplicate_file",
          status: "uncertain",
          required: false,
          owner: "agent",
          account: token,
          file: entry.sha,
          gate: "duplicate_file",
          detail:
            "Two different files cover exactly the same days. Importing both adds each line once, but one of them may be the wrong month.",
          next: {
            note: "Check that the two files are not the same statement exported twice under different names.",
          },
        });
    }

    // The first statement against the trial balance.
    if (!input.fresh && trialBalanceRows !== null && account && ranged.length > 0) {
      const first = ranged[0] as Entry;
      if (cutover !== null && monthOf(first.from as string) === monthOf(cutover)) {
        const row = trialBalanceRows.find(
          (candidate) =>
            (candidate.code !== null && normal(candidate.code) === normal(account.code)) ||
            normal(candidate.name) === normal(account.name),
        );
        if (row) {
          const start = opening(first);
          if (start === null)
            add({
              code: "trial_balance_statements",
              status: "uncertain",
              required: true,
              owner: "customer",
              account: token,
              file: first.sha,
              gate: "trial_balance_statements",
              detail: `The trial balance holds ${formatMoney(row.balance)} for this account, and the first statement does not say what it opened at.`,
              next: {
                note: "Read the opening balance from the first statement and compare it with the trial balance.",
              },
            });
          else
            add({
              code: "trial_balance_statements",
              status: start === row.balance ? "present" : "uncertain",
              required: true,
              owner: start === row.balance ? "agent" : "customer",
              account: token,
              file: first.sha,
              gate: "trial_balance_statements",
              detail:
                start === row.balance
                  ? `The first statement opens at ${formatMoney(start)}, the trial balance's figure.`
                  : `The first statement opens at ${formatMoney(start)} but the trial balance holds ${formatMoney(row.balance)} (difference ${formatMoney(start - row.balance)}). The old books and the bank disagree.`,
              ...(start === row.balance
                ? {}
                : {
                    next: {
                      note: "The statement is the proof: use its balance as the opening balance and record the difference as a gap to look at.",
                    },
                  }),
            });
        }
      }
    }
  }

  // ---- The trial balance -------------------------------------------------------------------
  const slot = (sha: string | undefined) => (sha === undefined ? undefined : files.get(sha));
  if (!input.fresh) {
    const tbSha = input.trialBalance;
    const tb = slot(tbSha);
    if (tbSha !== undefined) referenced.add(tbSha);
    if (tbSha === undefined) {
      add({
        code: "trial_balance_file",
        status: "missing",
        required: true,
        owner: "customer",
        detail: "No trial balance: the opening balances have no source.",
        next: {
          note: `Export the old system's trial balance as at ${cutover !== null ? addDays(cutover, -1) : "the day before the cutover"} (CSV), or say this is a new business with no earlier books (fresh).`,
        },
      });
    } else if (!tb) {
      add({
        code: "trial_balance_file",
        status: "uncertain",
        required: true,
        owner: "agent",
        file: tbSha,
        detail: "The trial balance file is not in the archive.",
        next: { note: "Upload it again, then run the plan again." },
      });
    } else if (tb.facts.role !== "trial_balance" || tb.facts.trialBalance === undefined) {
      add({
        code: "trial_balance_file",
        status: "uncertain",
        required: true,
        owner: "agent",
        file: tbSha,
        detail: `This file reads as ${tb.facts.role.replaceAll("_", " ")}, not as a trial balance.`,
        next: { note: "Check that this is the trial balance, or assign the right file." },
      });
    } else {
      const facts = tb.facts.trialBalance;
      add({
        code: "trial_balance_file",
        status: "present",
        required: true,
        owner: "agent",
        file: tbSha,
        detail: `A trial balance with ${facts.rows} accounts.`,
      });
      const day = cutover === null ? null : addDays(cutover, -1);
      add({
        code: "trial_balance_date",
        status:
          facts.asOf === null
            ? "uncertain"
            : day !== null && facts.asOf === day
              ? "present"
              : "uncertain",
        required: true,
        owner: facts.asOf === day ? "agent" : "customer",
        file: tbSha,
        gate: "trial_balance_date",
        detail:
          facts.asOf === null
            ? "The trial balance does not say what date it is as at."
            : day === null
              ? `The trial balance is as at ${facts.asOf}; there is no cutover date to compare it with.`
              : facts.asOf === day
                ? `As at ${facts.asOf}, the day before the cutover.`
                : `As at ${facts.asOf}, not the day before the cutover (${day}).`,
        ...(facts.asOf !== null && day !== null && facts.asOf === day
          ? {}
          : {
              next: {
                note: `Export the trial balance again as at ${day ?? "the day before the cutover"}; do not edit the file.`,
              },
            }),
      });
      add({
        code: "trial_balance_ties",
        status: facts.balanced && facts.problems === 0 ? "present" : "uncertain",
        required: true,
        owner: facts.balanced ? "agent" : "customer",
        file: tbSha,
        gate: "trial_balance_ties",
        detail: facts.balanced
          ? `Debits and credits agree at ${facts.debit}.`
          : `Debits ${facts.debit} and credits ${facts.credit} do not agree, or rows are missing (${facts.problems} problem(s)).`,
        ...(facts.balanced
          ? {}
          : {
              next: { note: "A trial balance always balances. Export it again; do not edit it." },
            }),
      });
    }
  }

  // ---- The chart, the ledger, the payouts ---------------------------------------------------
  if (input.chart !== undefined) {
    referenced.add(input.chart);
    const chart = slot(input.chart);
    add({
      code: "chart_file",
      status: chart && chart.facts.role === "chart_of_accounts" ? "present" : "uncertain",
      required: false,
      owner: "agent",
      file: input.chart,
      detail: chart
        ? chart.facts.role === "chart_of_accounts"
          ? `A chart of ${chart.facts.summary?.accounts ?? 0} accounts.`
          : `This file reads as ${chart.facts.role.replaceAll("_", " ")}, not as a chart of accounts.`
        : "The chart file is not in the archive.",
    });
  } else
    add({
      code: "chart_file",
      status: "missing",
      required: false,
      owner: "customer",
      detail:
        "No chart of accounts from the old system (optional): it helps name the accounts of the new books.",
    });
  if (input.generalLedger !== undefined) referenced.add(input.generalLedger);
  for (const sha of input.payoutReports ?? []) {
    referenced.add(sha);
    const report = slot(sha);
    add({
      code: "payout_report",
      status: report && report.facts.role === "payout_report" ? "present" : "uncertain",
      required: false,
      owner: "agent",
      file: sha,
      detail: report
        ? report.facts.role === "payout_report"
          ? `A payout report with ${report.facts.summary?.distinct ?? 0} payouts. The Stripe connection books payouts from Stripe's own ids; this file is a cross-check.`
          : `This file reads as ${report.facts.role.replaceAll("_", " ")}, not as a payout report.`
        : "The payout report is not in the archive.",
      next: {
        command: "rastrata stripe status",
        note: "Stripe is imported through its connection, not from this file.",
      },
    });
  }

  // ---- An account the trial balance has and no source covers --------------------------------
  if (!input.fresh && trialBalanceRows !== null) {
    for (const account of book.accounts) {
      if (declaredAccounts.has(account.id)) continue;
      if (account.closedOn !== null || (account.role !== "asset" && account.role !== "liability"))
        continue;
      if (!BANKLIKE.test(account.name)) continue;
      const row = trialBalanceRows.find(
        (candidate) =>
          (candidate.code !== null && normal(candidate.code) === normal(account.code)) ||
          normal(candidate.name) === normal(account.name),
      );
      if (row && row.balance !== 0n)
        add({
          code: "account_without_source",
          status: "missing",
          required: true,
          owner: "customer",
          account: accountToken(account, account.code),
          detail: `The trial balance holds ${formatMoney(row.balance)} for ${account.code} and no file is assigned to it.`,
          next: {
            note: "Ask the owner for this account's statements, or say it is to be left out and why.",
          },
        });
    }
  }

  // ---- Files nobody assigned -----------------------------------------------------------------
  const ignored = new Set(input.ignore ?? []);
  for (const sha of [...new Set(input.files ?? [])]) {
    if (referenced.has(sha) || ignored.has(sha)) continue;
    const info = files.get(sha);
    if (!info) continue;
    const statementLike = ["bank_statement", "card_statement", "trial_balance"].includes(
      info.facts.role,
    );
    add({
      code: "unassigned_file",
      status: "uncertain",
      required: statementLike,
      owner: "agent",
      file: sha,
      detail: `A ${info.facts.kind} file that reads as ${info.facts.role.replaceAll("_", " ")} (${info.facts.confidence} confidence) is not assigned to anything.`,
      next: {
        note: "Assign it to an account in the plan, or leave it out on purpose and say why.",
      },
    });
    if (!info.facts.parsed)
      add({
        code: "unparsed_file",
        status: "uncertain",
        required: false,
        owner: "agent",
        file: sha,
        detail: `This ${info.facts.kind} file is not read by the program (${info.facts.why ?? "unreadable"}).`,
        next: { note: "Read it yourself if it matters.", file: sha },
      });
  }

  const truncated = items.length > MAX_ITEMS;
  const listed = truncated ? items.slice(0, MAX_ITEMS) : items;
  const counts = { present: 0, missing: 0, uncertain: 0 };
  for (const item of items) counts[item.status]++;
  return {
    cutoverDate: cutover,
    through,
    sources: sourceViews,
    items: listed,
    counts,
    ready: items.every((item) => !item.required || item.status === "present"),
    truncated,
  };
}
