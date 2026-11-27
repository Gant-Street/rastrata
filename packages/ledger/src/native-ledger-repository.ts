import type { BookOutcomePayload } from "@rastrata/kernel";
import type { CompleteBookScope } from "./records.ts";

/** Existing persisted protocol identifier, independent of adapter implementation. */
export const NATIVE_LEDGER_FORMAT = "rastrata-native-sql-ledger-v1";

export interface NativeLedgerHead {
  readonly sequence: string;
  readonly bookRevision: string;
  readonly chainHash: string;
}
export interface NativeLedgerFact {
  readonly collection: string;
  readonly key: string;
  readonly encoded: string;
  /** Only derived current state may be replaced. Financial identities and
   * immutable records are insert-only, including at the persistence boundary. */
  readonly mutable?: true;
}
export interface NativeLedgerOutcome {
  readonly head: NativeLedgerHead;
  readonly previousHash: string;
  readonly payload: BookOutcomePayload;
  readonly encoded: string;
}
export interface NativeLedgerDecision {
  readonly encodedOutcome: string;
  readonly facts: readonly NativeLedgerFact[];
  /** Compatibility with the original insert-only open-period projection. */
  readonly upgradeOpenPeriod?: string;
}
export interface NativeOutcomePage {
  readonly genesis: string;
  readonly from: NativeLedgerHead;
  readonly through: NativeLedgerHead;
  readonly observedTip: NativeLedgerHead;
  readonly outcomes: readonly NativeLedgerOutcome[];
}
export interface NativeFactPage {
  readonly observedTip: NativeLedgerHead;
  readonly facts: readonly (NativeLedgerFact & { readonly sourceSequence: string })[];
  readonly nextIdentity: string | null;
}

/** How a page of outcomes is decoded. "canonical" (the default) proves that every stored text is the
 * canonical encoding of the payload it decodes to (`decodeBookOutcome`). "stored" skips that proof
 * (`decodeStoredBookOutcome`) and checks everything else, for a reader that compares the text with a
 * canonical encoding itself, as a replay that executes the command does, or that has chosen to trust
 * the ledger's chain over the stored bytes, as a trusted replay does. */
export type OutcomeDecoding = "canonical" | "stored";

/** Bounded asynchronous export port. Every page authenticates its records and
 * reports the observed head; consumers pin that head across awaits. Outcomes
 * form a contiguous chain. Facts use UTF-8 encoded-identity order. Pages may be
 * shorter than the requested limit due to their one-MiB body budget; only an
 * empty fact page is EOF. Limits are at most 16 outcomes or 32 facts per call.
 * This port does not authorize writes or claim a consistent whole-book snapshot. */
export interface NativeLedgerReader {
  readonly scope: CompleteBookScope;
  outcomePage(
    after?: NativeLedgerHead | null,
    limit?: number,
    admit?: () => void,
    decoding?: OutcomeDecoding,
  ): Promise<NativeOutcomePage>;
  factPage(
    afterIdentity?: string | null,
    limit?: number,
    admit?: () => void,
  ): Promise<NativeFactPage>;
}

/** Consistent, lifetime-bounded read view used by the synchronous evaluator.
 * These methods still assume synchronous reads. Extracting this contract removes
 * the concrete SQLite dependency, but does NOT qualify an asynchronous database
 * adapter. That requires bounded asynchronous input preparation (including
 * maintenance scans), not blocking network I/O or preloading the entire book. */
export interface NativeLedgerTransaction {
  readonly head: NativeLedgerHead;
  firstDueCurrencyPosition(policyIds: readonly string[], before: string): NativeLedgerFact | null;
  activeCurrencyPositions(sourceKeys: readonly string[]): ReadonlyMap<string, NativeLedgerFact>;
  activeInventoryPositions(
    accountIds: readonly string[],
    commodityId: string,
  ): readonly NativeLedgerFact[];
  outcome(commandId: string): NativeLedgerOutcome | null;
  facts(
    keys: readonly { readonly collection: string; readonly key: string }[],
  ): readonly (NativeLedgerFact | null)[];
  /** Maintenance only, in publication/identity order, bounded per yielded row.
   * Neither the view nor its iterator may escape the evaluation lifetime. */
  scanFacts(
    collection: string,
    companionCollection?: string,
  ): Iterable<{
    readonly fact: NativeLedgerFact;
    readonly companion: NativeLedgerFact | null;
  }>;
}
export type NativeLedgerTransactionResult<T> =
  | { readonly write: false; readonly value: T }
  | { readonly write: true; readonly decision: NativeLedgerDecision; readonly value: T };

/** Persistence obligations, not an accounting API. Implementations must:
 * - serialize evaluation and publication against one consistent book head;
 * - atomically retain outcomes (including rejections) and their state effects;
 * - enforce command uniqueness, immutable identities and writer fencing;
 * - recheck admission after asynchronous preparation, before evaluation;
 * - acknowledge only durable results and reconcile uncertain commits on retry.
 * A thrown failure must never be fabricated into a retained accounting rejection.
 * External publication preparation must not run inside the atomic evaluator. */
export interface NativeLedgerRepository {
  readonly scope: CompleteBookScope;
  provision(
    genesis: string,
    admit?: () => void,
    preparePublication?: () => Promise<void>,
  ): Promise<NativeLedgerHead>;
  transact<T>(
    evaluate: (view: NativeLedgerTransaction) => NativeLedgerTransactionResult<T>,
    admit?: () => void,
    preparePublication?: () => Promise<void>,
  ): Promise<{ readonly value: T; readonly head: NativeLedgerHead }>;
}
