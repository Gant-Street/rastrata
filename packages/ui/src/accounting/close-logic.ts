import type { PeriodView } from "../calendar/types";
import { formatDate } from "../format";
import type { ChecklistView } from "../shadow/types";
import { closeWords } from "./close-words";

/** Close the books, as pure decisions: how far the books are closed, which months one press can close,
 * and what is left before it can, each with the one place that deals with it. Nothing here reads the book
 * or the clock: the periods, the checklist and today are passed in. */

/** How far the books are closed: the last day of the newest month that is closed, every month before it
 * closed too (the months before the books began hold nothing and are not counted). */
export interface ClosedThrough {
  /** The last day of the newest month in an unbroken run of closed months; null when none is closed. */
  readonly through: string | null;
  /** The month that run ends on. */
  readonly label: string | null;
}

export function closedThrough(periods: readonly PeriodView[]): ClosedThrough {
  let through: PeriodView | null = null;
  for (const period of periods) {
    if (period.beforeBooks) continue;
    if (period.status === "closed" && !period.closeSuperseded) through = period;
    else break;
  }
  return through
    ? { through: through.endsOn, label: through.label }
    : { through: null, label: null };
}

/** The months a person can act on now: not closed, not before the books began, and begun (the months
 * still to come are not listed: they open as they start). In date order, so the first is the one to close
 * next, because months close in order. */
export function monthsToClose(periods: readonly PeriodView[], today: string): PeriodView[] {
  return periods.filter(
    (period) => !period.beforeBooks && period.status === "open" && period.startsOn <= today,
  );
}

/** The months that are closed (newest first, for Reopen) and the months a close no longer describes. */
export function closedMonths(periods: readonly PeriodView[]): PeriodView[] {
  return periods.filter((period) => period.status === "closed").reverse();
}

/** The months the card can be about: the open months that have ended and hold something. `first` is the
 * one Home names (months close in order, so it is the one to deal with); `last` is as far as one press can
 * close when nothing stands in its way. A month nothing was recorded in is never either: it closes with the
 * next month that holds something, so a business that began in October is not asked to close January. Both
 * are null when there is nothing to close. */
export interface CloseTargets {
  readonly first: PeriodView | null;
  readonly last: PeriodView | null;
}

export function closeTargets(periods: readonly PeriodView[], today: string): CloseTargets {
  const work = monthsToClose(periods, today).filter((period) => period.ended && !period.empty);
  return { first: work[0] ?? null, last: work[work.length - 1] ?? null };
}

/** What "Close through October 2026" closes: every open month up to and including that one, oldest first,
 * the months that hold nothing among them. Empty when the month is not one that can be closed. */
export function closeThrough(
  periods: readonly PeriodView[],
  today: string,
  targetId: string,
): PeriodView[] {
  const open = monthsToClose(periods, today);
  const at = open.findIndex((period) => period.id === targetId);
  return at < 0 ? [] : open.slice(0, at + 1);
}

/** A run of months as one phrase, from the names of its first and last ("February 2026", "November
 * 2026"): "February to November 2026", or "November 2026 to January 2027" when the run crosses a year. One
 * month is its own name. */
export function monthRange(first: string, last: string): string {
  if (first === last) return first;
  const year = /\s(\d{4})$/.exec(first)?.[1];
  return year !== undefined && last.endsWith(` ${year}`)
    ? `${first.slice(0, -year.length - 1)} to ${last}`
    : `${first} to ${last}`;
}

/** One thing left before the books can be closed through a month: a sentence, and the one place that
 * deals with it, named for what it does ("Reconcile Business savings"), never a bare "Fix this". */
export interface CloseLine {
  readonly id: string;
  readonly text: string;
  readonly action?:
    | { readonly label: string; readonly href: string; readonly name: string }
    | undefined;
}

/** Where each thing is done. `reconcile` and the others are addresses the app knows; a line whose screen
 * is not in this version has no link, and says so rather than linking nowhere. */
export interface CloseLinks {
  readonly reconcile: (accountId: string) => string;
  readonly inbox: string | undefined;
  readonly opening: string | undefined;
  readonly stripe: string | undefined;
  readonly backups: string | undefined;
}

/** The order the lines are said in: what to decide first (transactions), then what follows from it. */
const RANK = { review: 0, reconcile: 1, stripe: 2, opening: 3, backup: 4, other: 5 } as const;

/** What is left for a month, from its checklist's own verdict: one line for each reason the service gives
 * for "not yet", in the page's words where the page has a place that deals with it, and in the service's
 * own sentence otherwise. Nothing the service says stands in the way is left out and nothing is added: the
 * list is empty exactly when the verdict has no reason, so the page, Home, the command line and an agent
 * agree on whether a month can close. */
export function closeLeft(view: ChecklistView, links: CloseLinks): CloseLine[] {
  const w = closeWords.left;
  const end = view.period ? formatDate(view.period.endsOn) : "";
  const found = new Map<string, { readonly line: CloseLine; readonly rank: number }>();
  const add = (kind: keyof typeof RANK, line: CloseLine) => {
    if (!found.has(line.id)) found.set(line.id, { line, rank: RANK[kind] });
  };
  const link = (href: string | undefined, label: string, name: string): CloseLine["action"] =>
    href ? { label, href, name } : undefined;
  view.verdict.blocking.forEach((reason, index) => {
    const asSaid = () => add("other", { id: `${reason.code}-${index}`, text: reason.message });
    switch (reason.code) {
      case "inbox_waiting":
        add("review", {
          id: "review",
          text: w.review(view.inbox.waiting),
          action: link(links.inbox, w.reviewAction, w.reviewName),
        });
        break;
      case "never_reconciled":
      case "not_through_period": {
        const account = view.accounts.find((item) => item.id === reason.accountId);
        if (!account) {
          asSaid();
          break;
        }
        add("reconcile", {
          id: `reconcile-${account.id}`,
          text: w.reconcile(account.name, end),
          action: link(
            account.draft?.href ?? links.reconcile(account.id),
            w.reconcileAction,
            w.reconcileName(account.name),
          ),
        });
        break;
      }
      case "opening_not_posted":
        add("opening", {
          id: "opening",
          text: w.opening,
          action: link(links.opening, w.openingAction, w.openingAction),
        });
        break;
      case "stripe_not_compared":
      case "stripe_differs":
        add("stripe", {
          id: "stripe",
          text: reason.code === "stripe_differs" ? w.stripeDiffers : w.stripeNotCompared,
          action: link(links.stripe, w.stripeAction, w.stripeAction),
        });
        break;
      case "stripe_payouts_mismatched":
        add("stripe", {
          id: "stripe-payouts",
          text: w.payouts(view.stripe?.payouts.mismatched ?? 0),
          action: link(links.stripe, w.payoutsAction, w.payoutsAction),
        });
        break;
      case "no_verified_backup":
      case "backup_too_old":
        add("backup", {
          id: "backup",
          text:
            reason.code === "backup_too_old" && view.backups.verifiedAt
              ? w.backupOld(formatDate(view.backups.verifiedAt))
              : w.backupNever,
          action: link(links.backups, w.backupAction, w.backupAction),
        });
        break;
      case "drill_failed":
        add("backup", {
          id: "backup-drill",
          text: w.backupDrill,
          action: link(links.backups, w.backupsAction, w.backupsAction),
        });
        break;
      default:
        asSaid();
    }
  });
  return [...found.values()].sort((left, right) => left.rank - right.rank).map((item) => item.line);
}

/** Whether the books can be closed through the month: the service's own verdict, and nothing else. */
export function closeReady(view: ChecklistView): boolean {
  return view.verdict.state === "ready";
}

/** What does not stand in the way and is worth a look before closing, in the service's own sentences. */
export function closeLook(view: ChecklistView): string[] {
  return view.verdict.attention.map((reason) => reason.message);
}
