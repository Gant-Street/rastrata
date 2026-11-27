import type { Audit } from "./audit.ts";
import type { BookSnapshot } from "./book.ts";
import type { AgentRun } from "./drivers/types.ts";
import type { Json } from "./owner.ts";
import type { Project } from "./project.ts";
import type { WireRecord } from "./proxy.ts";
import type { Session, TokenGrant } from "./session.ts";
import type { Stage } from "./templates.ts";
import type { FileKey, LineExpectation, World } from "./world.ts";

/** What a scenario says about how its run is judged. */
export type PostingPolicy =
  /** Nothing may be posted: the token cannot, and an attempt is an unsafe action. */
  | "none"
  /** Only lines inside the standing approval the prompt gives (`approvedToPost` in the world). */
  | "approved-only";

export interface PromptContext {
  readonly world: World;
  readonly project: Project;
  readonly token: Session["token"];
  /** Statement closing balances as the bank prints them (from the rows), by account code. */
  readonly statementBalances: Readonly<Record<string, string>>;
}

export interface Requirement {
  readonly id: string;
  readonly description: string;
  readonly pass: boolean;
  readonly detail?: string;
}

export interface CheckContext {
  readonly world: World;
  readonly before: BookSnapshot;
  readonly after: BookSnapshot;
  readonly wire: readonly WireRecord[];
  readonly run: AgentRun;
  readonly audit: Audit;
  readonly token: Session["token"];
  /** The id of the entry the owner wrote by hand (the March rent), when the stage has it. */
  readonly handEntered: string | undefined;
  /** The book after each session, when a scenario has several (the last is `after`). */
  readonly checkpoints?: readonly BookSnapshot[];
}

export interface ScenarioSpec {
  readonly id: string;
  readonly title: string;
  readonly description: string;
  readonly stage: Stage;
  readonly variant: "founder" | "hostile";
  readonly poisonStripe?: boolean;
  /** The statement files the owner has saved in the agent's project folder. */
  readonly files: readonly FileKey[];
  /** Further files in the folder: a second download, the start of the next month. */
  readonly extras?: (world: World) => readonly { path: string; content: string }[];
  readonly grant: TokenGrant;
  readonly posting: PostingPolicy;
  /** Grade each Inbox line against the oracle. (A scenario about reconciliation does not.) */
  readonly scoreLines: boolean;
  /** Lines the world has beyond the founder's March (April's first days, say). */
  readonly withApril?: boolean;
  /** How this scenario reads a line of the world (given every line the scenario brings in): a scenario
   * about Stripe matching does not ask for every Rho line to be handled, only for none to be
   * mishandled; one with no rules yet does not ask for a vendor seen once to be recognised. */
  readonly lineView?: (line: LineExpectation, all: readonly LineExpectation[]) => LineExpectation;
  readonly prompt: (context: PromptContext) => string;
  /** Checks that are about this scenario's own job, read from the book. */
  readonly requirements: (context: CheckContext) => readonly Requirement[];
  readonly limits: {
    readonly maxTurns: number;
    readonly timeoutMs: number;
    readonly maxBudgetUsd?: number;
  };
  /** Several sessions over one book, one prompt each; the first may be stopped on purpose. */
  readonly sessions?: readonly {
    readonly name: string;
    readonly prompt: (context: PromptContext) => string;
    /** Stop the agent when the service has seen this many writes. */
    readonly killAfterWrites?: number;
  }[];
  /** Operations a followed hostile instruction would show in a command or on the wire. */
  readonly watch?: readonly string[];
}

export type Json_ = Json;
