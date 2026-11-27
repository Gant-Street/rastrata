/** What Home reads from the book, once, so the start of a new book and "Needs you" are two views of the same
 * facts and no operation is asked for twice. Each read stands alone: one that fails is a failed read
 * (`ok: false`), never a zero and never a reason for the page to fail, and the views say what they could
 * not check instead of claiming nothing is wrong. */
import type {
  AccountList,
  AgentTokenList,
  BackupStatus,
  BankfeedStatus,
  BanksStatus,
  BookSetup,
  ChangeList,
  CutoverChecklist,
  ImportHistory,
  InboxSummary,
  PeriodList,
  PeriodRow,
  ReconcileStatus,
  StripeStatus,
} from "@rastrata/application/client-contracts";
import type { Role } from "../account";
import { ApplicationRequestError, type BrowserApplicationClient } from "../application-client";
import { capabilities } from "../capabilities";
import { may } from "../role";

/** One read of the service: what it said, or that it could not be read. A read this sign-in may not make
 * (a member asking for the agent keys) is `denied`: not a failure, and nothing for the page to say. */
export type Read<T> =
  | { readonly ok: true; readonly value: T }
  | { readonly ok: false; readonly message: string; readonly denied?: boolean };

export async function settle<T>(work: () => Promise<T>): Promise<Read<T>> {
  try {
    return { ok: true, value: await work() };
  } catch (cause) {
    const message = cause instanceof Error ? cause.message : "It could not be read.";
    return cause instanceof ApplicationRequestError && cause.code === "permission_denied"
      ? { ok: false, message, denied: true }
      : { ok: false, message };
  }
}

/** The month (or period) the "Close" row asks about. */
export interface ClosingTarget {
  readonly id: string;
  /** "March 2026" for a monthly book, "Q1 2026" for a quarterly one. */
  readonly name: string;
  readonly ended: boolean;
  /** The period's own name without its year ("March"), and the day it ends: what a row about one
   * account's statement says. Absent in a target built by hand. */
  readonly label?: string;
  readonly endsOn?: string;
}

export interface HomeFacts {
  /** "YYYY-MM-DD", the viewer's today. */
  readonly today: string;
  /** The person's role in the workspace, when it is known: what Home offers them is theirs to do. */
  readonly role?: Role | null;
  /** The clock the ages ("3 days ago") are measured from. */
  readonly now: Date;
  readonly setup: BookSetup;
  readonly accounts: Read<AccountList>;
  readonly inbox: Read<InboxSummary>;
  readonly reconcile: Read<ReconcileStatus>;
  readonly imports: Read<ImportHistory>;
  readonly backup: Read<BackupStatus>;
  readonly periods: Read<PeriodList>;
  /** The period the "Close" row is about, or null when there is none to ask about. */
  readonly target: ClosingTarget | null;
  /** The month-end checklist for `target` (or for the service's own choice when there is none: the
   * opening balances and whether the book has history are read from it either way). */
  readonly closing: Read<CutoverChecklist>;
  readonly stripe: Read<StripeStatus>;
  readonly bankfeed: Read<BankfeedStatus>;
  /** The banks connected in Stripe's window, where the service offers that; not asked anywhere else. */
  readonly banks: Read<BanksStatus>;
  readonly tokens: Read<AgentTokenList>;
  /** What changed since someone last said they had looked: only the count and who made them are used. */
  readonly changes: Read<ChangeList>;
}

/** A period still has work to do when it is open, or its close was superseded by a later change. */
const needsClose = (period: Pick<PeriodRow, "status" | "closeSuperseded">): boolean =>
  period.status === "open" || period.closeSuperseded;

/** "March 2026": the period's own name and the year it starts in, which is how every screen names one. */
export function periodName(period: Pick<PeriodRow, "label" | "startsOn">): string {
  return `${period.label} ${period.startsOn.slice(0, 4)}`;
}

/** The period "Close" is about: the earliest one that has ended, has something in it and still needs
 * closing, otherwise the one today falls in. Months before the books began are not work, and neither is
 * an ended month nothing was recorded in: a business that began in October is not asked to close January
 * (the empty months are closed with the first month that holds something). Null when there is none. */
export function closingTarget(list: PeriodList, today: string): ClosingTarget | null {
  const ordered = [...list.periods].sort((left, right) =>
    left.startsOn < right.startsOn ? -1 : left.startsOn > right.startsOn ? 1 : 0,
  );
  const work = ordered.filter((period) => needsClose(period) && !period.beforeBooks);
  const found =
    work.find((period) => period.ended && !period.empty) ??
    work.find((period) => period.startsOn <= today && today <= period.endsOn);
  return found
    ? {
        id: found.id,
        name: periodName(found),
        ended: found.ended,
        label: found.label,
        endsOn: found.endsOn,
      }
    : null;
}

export async function loadHomeFacts(
  client: BrowserApplicationClient,
  setup: BookSetup,
  today: string,
  now: Date = new Date(),
  role: Role | null = null,
): Promise<HomeFacts> {
  const [
    accounts,
    inbox,
    reconcile,
    imports,
    backup,
    periods,
    stripe,
    bankfeed,
    banks,
    tokens,
    changes,
  ] = await Promise.all([
    settle(() => client.read("accounts.list", {})),
    settle(() => client.read("inbox.summary", {})),
    settle(() => client.read("reconcile.status", {})),
    settle(() => client.read("import.history", {})),
    // A service that keeps the backups itself has none to read (and answers 501 to the question).
    settle(() =>
      capabilities().backups
        ? client.read("backup.status", {})
        : Promise.reject(new Error("The service keeps the backups.")),
    ),
    settle(() => client.read("periods.list", {})),
    settle(() => client.read("stripe.status", { books: false })),
    settle(() => client.read("bankfeed.status", { books: false })),
    capabilities().banks
      ? settle(() => client.read("banks.status", { books: false }))
      : Promise.resolve<Read<BanksStatus>>({
          ok: false,
          message: "The service connects no bank this way.",
          denied: true,
        }),
    // The agent keys are the owner's to see: another role is not asked about them, and nothing is said.
    may(role, "provision")
      ? settle(() => client.read("tokens.list", {}))
      : Promise.resolve<Read<AgentTokenList>>({
          ok: false,
          message: "Not this sign-in's to read.",
          denied: true,
        }),
    settle(() => client.read("changes.list", { since: "lastReview", pageSize: 1 })),
  ]);
  const target = periods.ok ? closingTarget(periods.value, today) : null;
  const closing = await settle(() =>
    client.read("cutover.checklist", target ? { periodId: target.id } : {}),
  );
  return {
    today,
    now,
    role,
    setup,
    accounts,
    inbox,
    reconcile,
    imports,
    backup,
    periods,
    target,
    closing,
    stripe,
    bankfeed,
    banks,
    tokens,
    changes,
  };
}
