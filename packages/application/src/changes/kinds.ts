/** The words of the changes lane that more than one part of it needs: what kinds of change there
 * are, who can have made one, what one can be about, and where the changes are read from.
 * Pure and portable. */

/** What happened. The first fifteen are the lane's charter; `calendar.extended` (the fiscal calendar
 * was lengthened) and `book.changed` (a command the lane has no sentence for, so that no change the
 * ledger holds is ever left out) complete it. */
export const CHANGE_KINDS = [
  "entry.posted",
  "entry.reversed",
  "period.closed",
  "period.reopened",
  "calendar.extended",
  "account.added",
  "account.changed",
  "account.closed",
  "account.tagged",
  "rule.created",
  "rule.changed",
  "reconciliation.completed",
  "reconciliation.voided",
  "access.granted",
  "access.revoked",
  "book.opened",
  "book.changed",
] as const;
export type ChangeKind = (typeof CHANGE_KINDS)[number];

/** Who made a change. `unknown` is a change whose maker the book did not record; it is never a guess. */
export const ACTOR_KINDS = ["owner", "person", "agent", "service", "unknown"] as const;
export type ActorKind = (typeof ACTOR_KINDS)[number];

/** What a change is about, so that a screen can open it. */
export const SUBJECT_KINDS = [
  "journal",
  "account",
  "rule",
  "period",
  "calendar",
  "reconciliation",
  "token",
  "member",
  "book",
] as const;
export type SubjectKind = (typeof SUBJECT_KINDS)[number];

/** Where the changes come from. `ledger` is the book itself; the others are product state that other
 * parts of Rastrata keep, read only through their own operations. */
export const SOURCE_NAMES = [
  "ledger",
  "review",
  "rules",
  "tags",
  "reconciliation",
  "access",
] as const;
export type SourceName = (typeof SOURCE_NAMES)[number];

/** What the list does not cover yet, in the words a person reads under it. Each joins the list when
 * the part of Rastrata that keeps it can say what changed since a point in time. */
export const NOT_COVERED: readonly string[] = [
  "Changes to 1099 vendors",
  "Changes to the book's settings",
  "Changes to bank and Stripe connections",
];

export interface ActorRef {
  readonly kind: ActorKind;
  readonly label: string;
  readonly id?: string;
}

/** The words for "the book did not record who". */
export const NOT_RECORDED = "not recorded";

export const UNKNOWN_ACTOR: ActorRef = { kind: "unknown", label: NOT_RECORDED };

/** The key two changes by the same maker share. */
export const actorKey = (actor: ActorRef): string =>
  actor.kind === "unknown" ? "unknown" : `${actor.kind}:${actor.id ?? actor.label}`;
