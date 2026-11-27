import type { AccountRow } from "@rastrata/application/client-contracts";
import type { ChartAccount } from "@rastrata/application/rules-browser";
import { listAccountLabel } from "@rastrata/ui/entries/display";
import type { RuleOption } from "@rastrata/ui/rules-logic";

/** The chart as the Rules screens use it: names for the accounts a rule mentions, the accounts a
 * line can be booked to (open ones, grouped by kind), and the accounts bank lines are on. Closed
 * accounts are kept for naming and for validation (a rule that points at one is flagged) but are
 * not offered. */

const GROUP_NAMES: Readonly<Record<AccountRow["role"], string>> = {
  asset: "Assets",
  liability: "Liabilities",
  equity: "Equity",
  income: "Income",
  expense: "Expenses",
  gain: "Gains",
  unrealizedGain: "Unrealized gains",
};

/** Expenses first: most rules book a line to one. */
const GROUP_ORDER: readonly AccountRow["role"][] = [
  "expense",
  "income",
  "asset",
  "liability",
  "equity",
  "gain",
  "unrealizedGain",
];

export type ChartView = {
  /** The chart as the shared validation reads it. */
  validation: ReadonlyMap<string, ChartAccount>;
  /** Every open account, grouped, for booking a line to. */
  bookable: readonly RuleOption[];
  /** Your own asset and liability accounts: where a transfer goes, and where bank lines are. */
  own: readonly RuleOption[];
  /** "Software" (with its number first only when the owner asked for numbers), or a plain notice when the
   * account is not in the chart. */
  label: (id: string) => string;
  /** Options with any account the draft refers to that is not offered (closed, or gone) added, so
   * a stored rule is shown as it is and not as the first option in the list. */
  withCurrent: (options: readonly RuleOption[], ids: readonly string[]) => readonly RuleOption[];
};

const nameOf = (account: AccountRow) => `${account.code} · ${account.name}`;

export function chartView(accounts: readonly AccountRow[]): ChartView {
  const byId = new Map(accounts.map((account) => [account.id, account] as const));
  const open = accounts.filter((account) => account.closedOn === null);
  const sorted = (rows: readonly AccountRow[]) =>
    [...rows].sort((left, right) =>
      left.code < right.code ? -1 : left.code > right.code ? 1 : left.name < right.name ? -1 : 1,
    );
  const bookable = GROUP_ORDER.flatMap((role) =>
    sorted(open.filter((account) => account.role === role)).map((account) => ({
      value: account.id,
      label: nameOf(account),
      group: GROUP_NAMES[role],
    })),
  );
  const own = sorted(
    open.filter((account) => account.role === "asset" || account.role === "liability"),
  ).map((account) => ({ value: account.id, label: nameOf(account) }));
  const label = (id: string): string => {
    const account = byId.get(id);
    return account
      ? listAccountLabel(account.name, account.code)
      : "An account that is not in the chart";
  };
  return {
    validation: new Map(
      accounts.map((account) => [
        account.id,
        {
          id: account.id,
          code: account.code,
          name: account.name,
          role: account.role,
          closedOn: account.closedOn,
        },
      ]),
    ),
    bookable,
    own,
    label,
    withCurrent(options, ids) {
      const offered = new Set(options.map((option) => option.value));
      const extra = [...new Set(ids)]
        .filter((id) => id !== "" && !offered.has(id))
        .map((id) => {
          const account = byId.get(id);
          return {
            value: id,
            label: account ? `${nameOf(account)} (closed)` : label(id),
            group: "Not available",
          };
        });
      return extra.length > 0 ? [...options, ...extra] : options;
    },
  };
}
