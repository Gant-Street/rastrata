/** What the Changes components show. They are structurally the shapes the service returns for
 * `changes.list`; the UI package does not import the application, so they are written out here. Every
 * sentence in them was written by the service, and the text inside a sentence (a bank's description,
 * the name of a rule or of an agent) came from outside: it is shown as plain text and never read as
 * anything else. Pure types: nothing here loads a component library. */

/** What happened, as the service names it. */
export type ChangeKindId =
  | "entry.posted"
  | "entry.reversed"
  | "period.closed"
  | "period.reopened"
  | "calendar.extended"
  | "account.added"
  | "account.changed"
  | "account.closed"
  | "account.tagged"
  | "rule.created"
  | "rule.changed"
  | "reconciliation.completed"
  | "reconciliation.voided"
  | "access.granted"
  | "access.revoked"
  | "book.opened"
  | "book.changed";

/** Who made a change. `unknown` is a change whose maker the book did not record: it is never a guess. */
export type MakerKind = "owner" | "person" | "agent" | "service" | "unknown";

export type SubjectKind =
  | "journal"
  | "account"
  | "rule"
  | "period"
  | "calendar"
  | "reconciliation"
  | "token"
  | "member"
  | "book";

export interface MakerView {
  readonly kind: MakerKind;
  /** What the maker goes by: "owner", an agent's name, a person's role. */
  readonly label: string;
  /** The maker's identifier where it has one (an agent's key, a person). */
  readonly id?: string | undefined;
}

export interface SubjectView {
  readonly kind: SubjectKind;
  readonly id: string;
}

/** What a person reads first about an entry. */
export interface EntryView {
  readonly journalId: string;
  readonly number: number;
  /** "YYYY-MM-DD". */
  readonly date: string;
  readonly description: string;
  /** A wire amount. */
  readonly amount: string;
  /** The accounts it touches, by code and name, at most eight. */
  readonly accounts: readonly string[];
  readonly accountCount: number;
}

export interface ChangeView {
  readonly id: string;
  /** An instant in UTC, as the service writes one. */
  readonly at: string;
  readonly revision: string | null;
  readonly kind: ChangeKindId;
  /** One sentence the service built. */
  readonly summary: string;
  readonly subject: SubjectView;
  readonly by: MakerView;
  /** How it was done, in words. */
  readonly how: string;
  readonly entry?: EntryView | undefined;
}

/** A place changes are read from, and whether it could be read. */
export interface SourceView {
  readonly name: string;
  /** In plain words: "The books", "Rules". */
  readonly title: string;
  readonly read: boolean;
  /** Why it could not be read, in words; null when it was. */
  readonly reason: string | null;
  /** What this sign-in may not read of it, left out and said in one sentence; null or absent when nothing was. */
  readonly withheld?: string | null;
  /** How many changes it gave inside the window, before any choice narrowed them. */
  readonly changes: number;
}

export interface MakerCountView {
  readonly by: MakerView;
  readonly count: number;
}

export interface WindowView {
  /** Where the list starts, in words. */
  readonly since: string;
  readonly sinceRevision: string;
  readonly sinceAt: string | null;
  readonly until: string | null;
}

/** The last time a person said they had looked at the changes. */
export interface LookRecordView {
  readonly seq: number;
  readonly at: string;
  readonly by: MakerView;
  readonly upToRevision: string;
  readonly upToAt: string;
  readonly note: string;
}

export interface ChangeListView {
  readonly revision: string;
  /** The instant the sources that have no revision were read at. */
  readonly asOf: string;
  readonly window: WindowView;
  /** How many changes match, over all pages. */
  readonly count: number;
  readonly page: number;
  readonly pageSize: number;
  readonly changes: readonly ChangeView[];
  /** Who made the changes in the window, before the choice of maker narrowed them. */
  readonly actors: readonly MakerCountView[];
  readonly sources: readonly SourceView[];
  readonly notCovered: readonly string[];
  readonly attribution: { readonly fromRevision: string; readonly fromAt: string } | null;
  readonly lastReview: LookRecordView | null;
  /** Who is asking, named as a change they make would name them. */
  readonly caller?: MakerView | undefined;
}

/** Whether the list has been read. */
export type ChangesLoad = "loading" | "ready" | "failed";

/** Where saying "I have looked at these" stands. Only what the service confirmed is `saved`. */
export type LookState =
  | { readonly kind: "idle" }
  | { readonly kind: "saving" }
  | { readonly kind: "saved"; readonly at: string }
  /** The reply was lost: it is not known whether it was saved. */
  | { readonly kind: "uncertain" }
  /** Someone looked at newer changes while the page was open. */
  | { readonly kind: "stale" }
  /** A part of the list could not be read, so it cannot be marked. */
  | { readonly kind: "incomplete" }
  /** This sign-in may not say it. */
  | { readonly kind: "denied" }
  | { readonly kind: "failed" };
