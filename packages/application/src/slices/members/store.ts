/** Product state for who is in this book and as what: the member table. It is the truth about who may do what in the
 * book; the control plane's own table of memberships is only the way to a signed token (docs/reference/program/hosting/
 * auth-design.md). A person is never deleted: a removed member keeps their row, with their identifier, their last role and the
 * times, so the book still says who did what and when they left. It no longer says who they were: the address goes when they
 * do, so that a book holds a person's address only while they are in it (docs/reference/program/hosting/deletion-and-export.md). */
import { ApplicationError } from "../../errors.ts";
import { isWorkspaceRole, type WorkspaceRole } from "../../agent/member.ts";
import type { ApplicationService } from "../../service.ts";
import type { ApplicationStore } from "../../storage.ts";
import { migrate, sliceState } from "../state.ts";

const MIGRATIONS = [
  `CREATE TABLE members (
     user_id TEXT PRIMARY KEY,
     email TEXT NOT NULL,
     role TEXT NOT NULL CHECK (role IN ('owner', 'admin', 'accountant', 'member')),
     added_by TEXT NOT NULL,
     added_at TEXT NOT NULL,
     changed_by TEXT NOT NULL,
     changed_at TEXT NOT NULL,
     removed_at TEXT
   )`,
  // The book is being deleted (`retire`): one row, present for as long as it is. No member is let in while it is.
  `CREATE TABLE book_retirement (
     id INTEGER PRIMARY KEY CHECK (id = 1),
     retired_at TEXT NOT NULL,
     retired_by TEXT NOT NULL
   )`,
  // The book is read-only (`setReadOnly`): one row, present for as long as it is. A workspace that has not subscribed is read-only: its people may read it and export it, and nothing more.
  `CREATE TABLE book_access (
     id INTEGER PRIMARY KEY CHECK (id = 1),
     read_only_since TEXT NOT NULL,
     set_by TEXT NOT NULL
   )`,
];

/** A person who was taken out: what the row keeps of them. */
export interface RemovedRecord {
  readonly userId: string;
  readonly role: WorkspaceRole;
  readonly addedAt: string;
  readonly addedBy: string;
  readonly removedAt: string;
  readonly removedBy: string;
}

export interface MemberRecord {
  readonly userId: string;
  readonly email: string;
  readonly role: WorkspaceRole;
  readonly addedBy: string;
  readonly addedAt: string;
  readonly changedBy: string;
  readonly changedAt: string;
}

type Row = {
  user_id: string;
  email: string;
  role: string;
  added_by: string;
  added_at: string;
  changed_by: string;
  changed_at: string;
  removed_at: string | null;
};

const record = (row: Row): MemberRecord => {
  if (!isWorkspaceRole(row.role)) throw new Error("A member row holds a role that is not one");
  return {
    userId: row.user_id,
    email: row.email,
    role: row.role,
    addedBy: row.added_by,
    addedAt: row.added_at,
    changedBy: row.changed_by,
    changedAt: row.changed_at,
  };
};

const lastOwner = () =>
  new ApplicationError(
    "last_owner",
    "A workspace needs an owner: hand it to someone else first, or delete the workspace",
    409,
  );

/** Per-service state for the members slice. `clock` is the one place it reads time; tests replace it. */
export class MemberState {
  clock: () => Date = () => new Date();

  constructor(private readonly store: ApplicationStore) {
    migrate(store, "members", MIGRATIONS);
  }

  now(): Date {
    return this.clock();
  }

  /** Everyone who is in now, in the order they came. */
  list(): MemberRecord[] {
    return (
      this.store
        .query("SELECT * FROM members WHERE removed_at IS NULL ORDER BY added_at, user_id")
        .all() as Row[]
    ).map(record);
  }

  /** The people who were taken out, in the order they went. Their address was erased when they went. */
  listRemoved(): RemovedRecord[] {
    return (
      this.store
        .query(
          "SELECT user_id, role, added_at, added_by, removed_at, changed_by FROM members WHERE removed_at IS NOT NULL ORDER BY removed_at, user_id",
        )
        .all() as {
        user_id: string;
        role: string;
        added_at: string;
        added_by: string;
        removed_at: string;
        changed_by: string;
      }[]
    ).flatMap((row) =>
      isWorkspaceRole(row.role)
        ? [
            {
              userId: row.user_id,
              role: row.role,
              addedAt: row.added_at,
              addedBy: row.added_by,
              removedAt: row.removed_at,
              removedBy: row.changed_by,
            },
          ]
        : [],
    );
  }

  /** One person who is in now, or null (never been, or removed). */
  get(userId: string): MemberRecord | null {
    const row = this.store
      .query("SELECT * FROM members WHERE user_id = ? AND removed_at IS NULL")
      .get(userId) as Row | null;
    return row ? record(row) : null;
  }

  private owners(): number {
    return (
      this.store
        .query("SELECT COUNT(*) AS n FROM members WHERE role = 'owner' AND removed_at IS NULL")
        .get() as { n: number }
    ).n;
  }

  /** Put a person in, as that role: new, back after leaving, or changed. Asking again with the same words changes nothing
   * a second time. Taking the owner's role from the only owner is refused. */
  add(userId: string, email: string, role: WorkspaceRole, by: string): MemberRecord {
    const now = this.now().toISOString();
    const present = this.get(userId);
    if (present?.role === "owner" && role !== "owner" && this.owners() === 1) throw lastOwner();
    const existing = this.store
      .query("SELECT user_id FROM members WHERE user_id = ?")
      .get(userId) as { user_id: string } | null;
    if (!existing)
      this.store
        .query(
          "INSERT INTO members (user_id, email, role, added_by, added_at, changed_by, changed_at) VALUES (?, ?, ?, ?, ?, ?, ?)",
        )
        .run(userId, email, role, by, now, by, now);
    else if (!present || present.email !== email || present.role !== role)
      this.store
        .query(
          `UPDATE members SET email = ?, role = ?, changed_by = ?, changed_at = ?${
            present ? "" : ", added_by = ?, added_at = ?, removed_at = NULL"
          } WHERE user_id = ?`,
        )
        .run(
          ...(present ? [email, role, by, now, userId] : [email, role, by, now, by, now, userId]),
        );
    return this.require(userId);
  }

  require(userId: string): MemberRecord {
    const member = this.get(userId);
    if (!member)
      throw new ApplicationError("member_not_found", "That person is not in this book", 404);
    return member;
  }

  setRole(userId: string, role: WorkspaceRole, by: string): MemberRecord {
    const member = this.require(userId);
    if (member.role === role) return member;
    if (member.role === "owner" && this.owners() === 1) throw lastOwner();
    this.store
      .query("UPDATE members SET role = ?, changed_by = ?, changed_at = ? WHERE user_id = ?")
      .run(role, by, this.now().toISOString(), userId);
    return this.require(userId);
  }

  /** When the book was retired, or null. */
  retiredAt(): string | null {
    const row = this.store.query("SELECT retired_at FROM book_retirement WHERE id = 1").get() as {
      retired_at: string;
    } | null;
    return row ? row.retired_at : null;
  }

  /** The book is being deleted: no member is let in until it is restored. Asking again changes nothing (the time is the first's). Nobody is taken out of the table: the people
   * and their roles are what restoring brings back, and the only owner stays one. */
  retire(by: string): string {
    const present = this.retiredAt();
    if (present) return present;
    const now = this.now().toISOString();
    this.store
      .query("INSERT INTO book_retirement (id, retired_at, retired_by) VALUES (1, ?, ?)")
      .run(now, by);
    return now;
  }

  /** The book is let in again. Restoring a book that is not retired changes nothing. */
  unretire(): void {
    this.store.query("DELETE FROM book_retirement WHERE id = 1").run();
  }

  /** When the book became read-only, or null. */
  readOnlySince(): string | null {
    const row = this.store.query("SELECT read_only_since FROM book_access WHERE id = 1").get() as {
      read_only_since: string;
    } | null;
    return row ? row.read_only_since : null;
  }

  /** Make the book read-only, or not. Asking for what is already so changes nothing (the time is the first's). Nobody is taken out and nothing is erased. */
  setReadOnly(on: boolean, by: string): string | null {
    const present = this.readOnlySince();
    if (!on) {
      if (present !== null) this.store.query("DELETE FROM book_access WHERE id = 1").run();
      return null;
    }
    if (present !== null) return present;
    const now = this.now().toISOString();
    this.store
      .query("INSERT INTO book_access (id, read_only_since, set_by) VALUES (1, ?, ?)")
      .run(now, by);
    return now;
  }

  /** Take a person out, and erase their address from the book: the row keeps the identifier, the last role and the times. Taking out someone who is not in changes nothing.
   * The only owner cannot go, unless the book is being deleted: nobody is let in then, and a person who has deleted their account is taken out of it like anyone. */
  remove(userId: string, by: string): void {
    const member = this.get(userId);
    if (!member) return;
    if (member.role === "owner" && this.owners() === 1 && this.retiredAt() === null)
      throw lastOwner();
    const now = this.now().toISOString();
    this.store
      .query(
        "UPDATE members SET removed_at = ?, changed_by = ?, changed_at = ?, email = '' WHERE user_id = ?",
      )
      .run(now, by, now, userId);
  }
}

export const memberState = (service: ApplicationService): MemberState =>
  sliceState(service, "members", (store) => new MemberState(store));
