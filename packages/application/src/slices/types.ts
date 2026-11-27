import type { BookCommand, BookState } from "@rastrata/kernel";
import type { ApplicationAccess } from "../agent/principal.ts";
import type { BusinessPermission, OperationDefinition, Schema } from "../schema-kit.ts";
import type { ApplicationService } from "../service.ts";

/** A note on a prepared plan: a consequence the plan has beyond its own journals, that the person
 * (or agent) should see before committing. A warning never blocks a commit and never changes
 * `valid`; the plan hash does not cover it. */
export interface PlanWarning {
  readonly code: string;
  readonly message: string;
}

export interface AdvisorContext {
  readonly service: ApplicationService;
  /** The kind of the prepared action: "reverseJournal", "closePeriod", "postDraft", ... */
  readonly kind: string;
  /** The sealed command being prepared. */
  readonly command: BookCommand;
  /** The book as it stands now, before the command. */
  readonly state: BookState;
}

/** Looks at one prepared plan and says what else it affects. Consulted every time a plan is
 * prepared, so it must be quick, read-only and deterministic. Return nothing when there is
 * nothing to say. */
export type Advisor = (
  context: AdvisorContext,
) => readonly PlanWarning[] | Promise<readonly PlanWarning[]>;

/** The contract half of a slice: pure data, importable by every surface (CLI, MCP, web types).
 * It must import from ../schema-kit.ts only, never from ../schema.ts, the service or the runtime. */
export interface SliceSchema {
  /** The lane's name; also its folder under slices/. */
  readonly name: string;
  /** Named JSON-schema definitions this slice adds. Names are global and must stay unique, so use
   * your slice's nouns (InboxItem, ReconciliationRecord). A duplicate fails at import time. */
  readonly definitions: Readonly<Record<string, Schema>>;
  readonly operations: readonly OperationDefinition[];
  /** Kinds of prepared actions this slice's prepare operations create, with the permission needed
   * to commit each. Kinds are global; prefix them with your slice's nouns. */
  readonly preparedPermissions?: Readonly<Record<string, BusinessPermission>>;
  /** Names of this slice's read operations that work before the book is configured: catalogs and
   * templates the setup flow needs. Every other operation answers `book_not_configured` until
   * `book.setup` has run. Only reads may be listed. */
  readonly readsBeforeSetup?: readonly string[];
  /** Names of this slice's operations that write and still work before the book is configured: only the member
   * table, which the control plane fills (the owner first) before the owner sets the book up. */
  readonly writesBeforeSetup?: readonly string[];
}

export interface SliceContext {
  readonly service: ApplicationService;
  /** What this request may do. `permissions` is already narrowed to the caller (an agent token
   * holds fewer than the owner). `principal` says who is calling: record "owner" or the token's id
   * (see `describePrincipal`) wherever a figure or a rule must say who made it. */
  readonly access: ApplicationAccess;
  /** The caller's durable operation identity; empty for reads, which carry none. */
  readonly operationId: string;
}

/** The behaviour half of a slice. `input` has already been validated against the operation's
 * schema, the caller's permission has been checked, and the book is configured. The result is
 * validated against the operation's output schema before it leaves the service. */
export type SliceHandler = (
  input: Record<string, unknown>,
  context: SliceContext,
) => unknown | Promise<unknown>;
export type SliceHandlers = Readonly<Record<string, SliceHandler>>;
