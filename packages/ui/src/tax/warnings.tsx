import { For, Show } from "solid-js";
import { formatFiguresInText } from "../format";
import { Notice } from "../notice";
import type { TaxWarningView } from "./types";

/** A short heading for each kind of warning the tax operations attach, so a warning says what it is about
 * before its sentence does. A code this table does not know still shows, under a plain heading. */
const TITLES: Readonly<Record<string, string>> = {
  draft_form: "An early-release IRS form",
  unmapped_accounts: "Accounts with no form line",
  year_not_ended: "The year is not over",
  books_start_late: "The books start part-way through",
  range_not_calendar_year: "Not a calendar year",
  no_accounts_marked: "No account is marked",
  no_cash_tags: "No account is tagged as cash",
  accrual_basis: "Dates are booking dates",
  inbox_unreadable: "The transactions waiting for review could not be read",
  account_not_liability: "Not a liability account",
  several_accounts: "More than one account",
  negative_balance: "More paid than collected",
  stripe_differs: "Stripe and the account differ",
  stripe_not_read: "Stripe was not compared",
  stripe_tax_not_reported: "Charges with no tax figure",
};

/** The warnings where acting would change the figures: the books and Stripe disagree, or more tax was paid
 * than collected, and putting that right moves a figure. Every other warning is a fact about the figures
 * and is a plain note. */
const ATTENTION: ReadonlySet<string> = new Set(["stripe_differs", "negative_balance"]);

/** The warnings a tool on the Tax screen does not repeat. The screen's own checks and notes, above the
 * tools, say the first four (or leave them unsaid on purpose: that the year is not over is true of every
 * book). The last is said by the list it is about: with no account marked, the 1099 page shows its accounts
 * to mark and counts nothing. */
export const SAID_BY_THE_CHECKS: readonly string[] = [
  "draft_form",
  "unmapped_accounts",
  "year_not_ended",
  "books_start_late",
  "no_accounts_marked",
];

/** Warnings the service attached to a figure, each as a plain sentence under a heading that says what it
 * is about. They are observations about the books, not determinations about a return. Orange is for the
 * ones where acting would change the figures; the rest are notes. `omit` names the codes the screen has
 * already said elsewhere. */
export function TaxWarnings(props: {
  warnings: readonly TaxWarningView[];
  omit?: readonly string[] | undefined;
}) {
  const shown = () => props.warnings.filter((warning) => !props.omit?.includes(warning.code));
  return (
    <Show when={shown().length > 0}>
      <div class="rt-tax-warnings" data-facts="">
        <For each={shown()}>
          {(warning) => (
            <Notice
              title={TITLES[warning.code] ?? "Worth knowing"}
              tone={ATTENTION.has(warning.code) ? "attention" : "info"}
              role="status"
            >
              <p>{formatFiguresInText(warning.message)}</p>
            </Notice>
          )}
        </For>
      </div>
    </Show>
  );
}
