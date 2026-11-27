import { starterWords } from "./text.ts";

/** From a kind of category ("software", "utilities", "postage") to the one account of this book that
 * holds it. The starter list knows merchants, not charts: every book has its own accounts, made from
 * one of the templates and then renamed, closed and added to by its owner.
 *
 * What is read, in this order, and why:
 *
 * 1. A role key, for the one kind another part of Rastrata books by key (a payout from Stripe goes to
 *    the account that carries `payouts.in-transit`). A key names one account whatever it is called.
 * 2. The tax line, where a line of the form means the kind and nothing else: Schedule C line 25 is
 *    utilities, line 15 is insurance, line 24b is meals. The chart records the line on the account, a
 *    rename does not change it, and it was verified against the form (chart/tax-lines.ts). One open
 *    account on such a line is the account.
 * 3. The account's name, where the chart records nothing better: a generic chart has no tax lines, and
 *    on every form "Other expenses" (Schedule C line 27b, Form 1120-S line 20, Form 1065 line 21) is
 *    one line shared by software, bank fees, and on the two entity returns by insurance, utilities,
 *    travel and meals as well, so the line cannot tell them apart. Names are compared as whole words,
 *    and a word that says the account is something else (health insurance, payroll taxes) rules it out.
 *
 * An account's code is not read. The templates give "Software and subscriptions" a different code on
 * each form, and a book does not record which template it came from, so a code says nothing a name
 * does not.
 *
 * It answers with one account or with none. None when the account is missing, when it cannot take the
 * line (closed, or not open on its date: the caller leaves those out), and when two accounts could be
 * meant: a wrong suggestion costs trust, a missing one costs a click. An S corporation's payroll is the
 * standing example of two: wages go to "Salaries and wages" and an officer's to "Officer compensation",
 * a debit from a payroll provider does not say which, so nothing is suggested. */

export type StarterKind =
  | "software"
  | "hosting"
  | "advertising"
  | "utilities"
  | "telecom"
  | "insurance"
  | "payroll"
  | "payrollTaxes"
  | "postage"
  | "shipping"
  | "bankFees"
  | "interest"
  | "rent"
  | "officeSupplies"
  | "supplies"
  | "meals"
  | "travel"
  | "fuel"
  | "professional"
  | "contractLabor"
  | "licenses"
  | "stripePayout";

/** One place a kind may live in a chart. */
export interface Home {
  /** Tax lines that mean this and nothing else. */
  readonly lines?: readonly string[];
  /** Names that say so: an account matches when every word of one of these is in its name. */
  readonly names?: readonly string[];
  /** Words in a name that say the account is something else. */
  readonly except?: readonly string[];
}

export interface KindSpec {
  /** How a reason names it: "USPS is usually postage." */
  readonly noun: string;
  /** The side of the line it may be suggested for. Money in is never an expense. */
  readonly direction: "in" | "out";
  readonly role: "expense" | "asset";
  /** The account that carries this role key, before anything else. */
  readonly roleKey?: string;
  /** Where it may live, the most particular first. */
  readonly homes: readonly Home[];
}

const SOFTWARE: readonly Home[] = [
  { names: ["software", "saas", "apps"] },
  { names: ["subscriptions", "subscription"] },
];
const UTILITIES: Home = { lines: ["scheduleC.line25"], names: ["utilities", "utility"] };
const OFFICE: Home = {
  lines: ["scheduleC.line18"],
  names: ["office"],
  except: ["home", "rent", "lease", "space"],
};
const POSTAGE: Home = {
  names: ["postage", "shipping", "freight", "delivery"],
  except: ["cost", "goods"],
};
const TAXES: Home = {
  lines: ["scheduleC.line23", "form1120S.line12", "form1065.line14"],
  names: ["licenses", "license", "licences", "permits"],
  except: ["software", "payroll", "sales", "income"],
};
const TRAVEL: Home = { lines: ["scheduleC.line24a"], names: ["travel"] };

const out = (noun: string, homes: readonly Home[]): KindSpec => ({
  noun,
  direction: "out",
  role: "expense",
  homes,
});

export const KINDS: Readonly<Record<StarterKind, KindSpec>> = {
  software: out("software", SOFTWARE),
  hosting: out("web hosting", [{ names: ["website", "hosting"] }, ...SOFTWARE]),
  advertising: out("advertising", [
    { lines: ["scheduleC.line8", "form1120S.line16"], names: ["advertising", "marketing"] },
  ]),
  utilities: out("utilities", [UTILITIES]),
  telecom: out("phone and internet", [
    { names: ["telephone", "phone", "internet", "telecom", "telecommunications"] },
    UTILITIES,
  ]),
  insurance: out("insurance", [
    {
      lines: ["scheduleC.line15"],
      names: ["insurance"],
      except: ["health", "medical", "life", "dental", "vision", "disability", "workers"],
    },
  ]),
  // Form 1120-S has two lines a payroll debit could be (7, officers; 8, everyone else): with both in
  // the chart the answer is none. Form 1065's guaranteed payments are not payroll and are not listed.
  payroll: out("payroll", [
    {
      lines: ["scheduleC.line26", "form1120S.line7", "form1120S.line8", "form1065.line9"],
      names: ["wages", "salaries", "payroll", "officer", "officers"],
      except: ["taxes", "tax", "liabilities", "fees"],
    },
  ]),
  payrollTaxes: out("payroll taxes", [
    { names: ["payroll taxes", "payroll tax", "employer taxes"] },
    TAXES,
  ]),
  postage: out("postage", [POSTAGE, OFFICE]),
  shipping: out("shipping", [POSTAGE, OFFICE]),
  bankFees: out("a bank fee", [
    { names: ["bank fees", "bank fee", "bank charges", "bank charge", "bank service"] },
  ]),
  // Schedule C moved "Other" interest from line 16b (2025) to 16c (2026); a chart keeps the line of
  // the year it was made in, so both are read. A mortgage's or a vehicle loan's interest is not this.
  interest: out("interest", [
    {
      lines: ["scheduleC.line16b", "scheduleC.line16c", "form1120S.line13", "form1065.line15"],
      names: ["interest"],
      except: ["mortgage", "vehicle", "income", "earned"],
    },
  ]),
  rent: out("rent", [
    {
      lines: ["scheduleC.line20b", "form1120S.line11", "form1065.line13"],
      names: ["rent"],
      except: ["equipment", "vehicle", "vehicles", "machinery"],
    },
  ]),
  officeSupplies: out("office supplies", [{ names: ["office supplies"] }, OFFICE]),
  supplies: out("supplies", [
    {
      lines: ["scheduleC.line22"],
      names: ["supplies"],
      except: ["office", "cost", "goods", "materials"],
    },
  ]),
  meals: out("meals", [{ lines: ["scheduleC.line24b"], names: ["meals", "meal"] }]),
  travel: out("travel", [TRAVEL]),
  // Only Schedule C has a line for a vehicle's costs. Elsewhere fuel goes where travel goes.
  fuel: out("fuel", [
    {
      lines: ["scheduleC.line9"],
      names: ["car truck", "auto", "automobile", "vehicle", "vehicles", "fuel", "gas", "gasoline"],
      except: ["insurance", "loan", "interest", "lease", "rent"],
    },
    TRAVEL,
  ]),
  professional: out("professional services", [
    { lines: ["scheduleC.line17"], names: ["legal", "professional", "accounting"] },
  ]),
  contractLabor: out("contract labor", [
    {
      lines: ["scheduleC.line11"],
      names: ["contract labor", "contractors", "contractor", "subcontractors", "freelancers"],
    },
  ]),
  licenses: out("taxes and licenses", [TAXES]),
  // The deposit of a payout: money in, from the account Stripe's payouts wait in. Only a book that
  // has that account (the Stripe add-on's, found by its role key) is suggested it.
  stripePayout: {
    noun: "a payout from Stripe",
    direction: "in",
    role: "asset",
    roleKey: "payouts.in-transit",
    homes: [],
  },
};

/** An account as the mapping reads it: what the chart records about it on the line's date. */
export interface StarterAccount {
  readonly id: string;
  readonly name: string;
  readonly role: string;
  readonly taxLine?: string | undefined;
  readonly roleKey?: string | undefined;
}

/** What decided the account: said so that a test, and a reader of the code, can tell. */
export type AccountBasis = "roleKey" | "taxLine" | "name";

export interface AccountChoice {
  readonly accountId: string;
  readonly basis: AccountBasis;
}

const nameCache = new Map<string, ReadonlySet<string>>();
function wordsOf(name: string): ReadonlySet<string> {
  let words = nameCache.get(name);
  if (!words) {
    words = new Set(starterWords(name));
    if (nameCache.size > 5000) nameCache.clear();
    nameCache.set(name, words);
  }
  return words;
}

function named(account: StarterAccount, home: Home): boolean {
  const words = wordsOf(account.name);
  if (home.except?.some((word) => words.has(word))) return false;
  return (home.names ?? []).some((name) => name.split(" ").every((word) => words.has(word)));
}

/** The one account of `accounts` that a kind goes to, or null. `accounts` are the ones that can take
 * the line: open on its date and not the line's own. */
export function accountFor(
  kind: StarterKind,
  accounts: readonly StarterAccount[],
): AccountChoice | null {
  const spec = KINDS[kind];
  const pool = accounts.filter((account) => account.role === spec.role);
  if (spec.roleKey !== undefined) {
    const holders = pool.filter((account) => account.roleKey === spec.roleKey);
    if (holders.length === 1)
      return { accountId: (holders[0] as StarterAccount).id, basis: "roleKey" };
    if (holders.length > 1) return null;
  }
  for (const home of spec.homes) {
    const lines = home.lines ?? [];
    const onLine = pool.filter(
      (account) => account.taxLine !== undefined && lines.includes(account.taxLine),
    );
    if (onLine.length === 1)
      return { accountId: (onLine[0] as StarterAccount).id, basis: "taxLine" };
    if (onLine.length > 1) {
      // Several accounts on the line (an owner split Utilities in two): the name chooses, or nothing.
      const both = onLine.filter((account) => named(account, home));
      return both.length === 1
        ? { accountId: (both[0] as StarterAccount).id, basis: "taxLine" }
        : null;
    }
    const byName = pool.filter((account) => named(account, home));
    if (byName.length === 1) return { accountId: (byName[0] as StarterAccount).id, basis: "name" };
    if (byName.length > 1) return null;
  }
  return null;
}
