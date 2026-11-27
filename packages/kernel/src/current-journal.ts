import { contentHashEquals, type ContentHash } from "./canonical.ts";
import { immutableAccountingValue } from "./accounting.ts";
import {
  evaluateBookCommandProtocol,
  hashBookConfigurationSnapshot,
  prepareBookCommitRecords,
  prepareBookIntent,
  prepareOrdinaryBookJournal,
  prepareBookConfigurationChange,
  prepareBookCorrection,
  prepareBookClose,
  prepareBookReopen,
  prepareBookTaxTransaction,
  prepareBookAllocation,
  prepareBookOpenItem,
  prepareBookSettlement,
  prepareBookCurrencyRemeasurement,
  prepareBookConsolidation,
  prepareBookOwnedInventory,
  ownedInventoryChangeEffects,
  type BookOwnedInventoryReadContext,
  type PostOwnedInventoryTransactionCommand,
  type BookConsolidationContext,
  type CompileConsolidationCommand,
  type BookCurrencyContext,
  type PostCurrencyRemeasurementCommand,
  type BookSettlementContext,
  type ApplySettlementCommand,
  type BookOpenItemContext,
  type RecognizeOpenItemCommand,
  type BookAllocationContext,
  type BookAllocationCommand,
  rejectBookCommand,
  validateBookConfiguration,
  validateBookFinancialIdentity,
  validateBookGlobalAdmission,
  STRUCTURAL_SOURCE_IDENTITY_PROFILE,
  type BookCommand,
  type PostJournalCommand,
  type BookConfigurationSnapshot,
  type OpeningBoundary,
  type RevisionRecord,
  type RetainedCommandResult,
  type BookCommandResult,
  type BookJournalReadContext,
  type RemeasurementAdmissionCandidate,
  type BookedJournal,
  type ReplaceConfigurationCommand,
  type CorrectJournalCommand,
  type BookEffect,
  type BookCommitIntent,
  type BookCloseContext,
  type BookReopenContext,
  type ClosePeriodCommand,
  type ReopenPeriodCommand,
  type PostTaxedTransactionCommand,
  type BookTaxContext,
} from "./book.ts";
import { diagnostic, type LocalDate, type SemanticDiagnostic } from "./journal.ts";
import { decodeBookRow, type BookStateHeader } from "./codec.ts";
import type { InventoryMoneyScope } from "./owned-inventory-command.ts";

/** Only this strict decoder can register a configuration for reusable pure
 * checks. Its entire object graph is owned and frozen by the kernel. A caller's
 * hash, shallow freeze or copied object grants no memoization authority. Weak
 * keys let the bounded storage-owner cache control the lifetime of these facts. */
const preparedConfigurations = new WeakMap<BookConfigurationSnapshot, {
  hash?: ContentHash;
  validation?: { identityHash: ContentHash; diagnostics: readonly SemanticDiagnostic[] };
}>();

export function decodePreparedBookConfiguration(encoded: string) {
  const decoded = decodeBookRow("state.configurationSnapshots", encoded);
  if (decoded.disposition === "decoded") preparedConfigurations.set(decoded.row, {});
  return decoded;
}

/** Common current-state mathematical inputs; command-specific observations are
 * supplied separately. This is an execution boundary, not a sparse legacy BookState.
 * Storage must bind every input/absence to one transaction, admit configuration
 * lineage, preserve permanent identities, and publish outcome+facts atomically.
 * No caller-supplied integrity boolean or arbitrary contentHash bypass exists. */
export interface CurrentJournalContext {
  readonly header: BookStateHeader;
  readonly configuration: BookConfigurationSnapshot;
  readonly opening: OpeningBoundary | null;
  readonly activationIdentity: ContentHash | null;
  readonly previousRevision: RevisionRecord | null;
  retainedCommand(id: BookCommand["id"]): RetainedCommandResult | null;
  readonly journalIdentity: BookJournalReadContext["journalIdentity"];
  readonly postingIdentity: BookJournalReadContext["postingIdentity"];
  readonly readPostingIdentities?: BookJournalReadContext["readPostingIdentities"];
  readonly periodStatus: BookJournalReadContext["periodStatus"];
  overdueRemeasurement(): RemeasurementAdmissionCandidate | null;
  managedMoneyScope(scope: InventoryMoneyScope): "managed" | "unmanaged";
  /** Optional batched prefetch for storage-backed guards; it grants no admission. */
  readMoneyScopes?(scopes: readonly InventoryMoneyScope[]): void;
}
export interface CurrentJournalResult {
  readonly header: BookStateHeader;
  readonly result: BookCommandResult;
  readonly retained?: RetainedCommandResult;
  readonly revision?: RevisionRecord;
  readonly journal?: BookedJournal;
  readonly effects?: readonly BookEffect[];
}

/** Command-specific evidence augments the common current-state admission inputs.
 * All observations must come from one transaction. Missing evidence is not an
 * empty book or permission to bypass managed-inventory/source ownership rules. */
export interface CurrentBookContext extends CurrentJournalContext {
  readonly ownedInventoryFacts?: Pick<BookOwnedInventoryReadContext, "ownership" | "readPool" | "identityPresence" | "latestMovementDate" | "hasLiveUnownedStock" | "postedMoneyBalance">;
  readonly consolidationFacts?: Pick<BookConsolidationContext, "compilationIdentity">;
  readonly currencyFacts?: Pick<BookCurrencyContext, "currencyState" | "accountingIdentity" | "sourceJournals" | "allocatedSource" | "sourceRemeasurement" | "originalJournal">;
  readonly settlementFacts?: Pick<BookSettlementContext, "settlement" | "financialSourceOwner" | "sourceJournals" | "sourceRemeasurement">;
  readonly openItemFacts?: Pick<BookOpenItemContext, "openItemIdentity" | "financialSourceOwner" | "sourceJournals">;
  readonly allocationFacts?: Pick<BookAllocationContext, "accountingState" | "accountingIdentity" | "resolveSource">;
  readonly taxFacts?: Pick<BookTaxContext, "taxIdentity">;
  readonly closeFacts?: Pick<BookCloseContext, "previousCloseCount" | "closePackageIdentity" | "journals">;
  readonly reopenFacts?: Pick<BookReopenContext, "currentClosePackages" | "journal">;
  /** Required only for configuration evolution; null is an explicitly empty book. */
  readonly configurationFacts?: { readonly latestAccountingDate: LocalDate | null };
  readonly correctionFacts?: {
    readonly originalJournal: BookedJournal | null;
    readonly alreadyCorrected: boolean;
    readonly currencySource: boolean;
    readonly managedSource: boolean;
  };
}

/** Evaluate once and produce exact immutable records. Retained diagnostics and
 * canonical journal/revision/result bytes use the SAME kernel primitives as the
 * legacy evaluator. Legacy aggregate state hashes remain an audit/export format;
 * this API never invents a complete aggregate or hashes historical populations. */
export function evaluateCurrentJournal(
  context: CurrentJournalContext,
  input: BookCommand & PostJournalCommand,
): CurrentJournalResult {
  if (input.type !== "postJournal" || (input.lotOperations?.length ?? 0) > 0)
    throw new TypeError("Current journal execution requires a journal without lot operations");
  return evaluateCurrentBookCommand(context, input);
}

/** Exact native journal, correction, configuration and period evaluation. Reuses
 * shared preparation without reconstructing an aggregate; close streams its cutoff.
 * Other command families require their own complete read contexts; unsupported
 * commands fail as service errors rather than retained accounting rejections. */
export function evaluateCurrentBookCommand(
  context: CurrentBookContext,
  input: BookCommand & (PostJournalCommand | ReplaceConfigurationCommand | CorrectJournalCommand | ClosePeriodCommand | ReopenPeriodCommand | PostTaxedTransactionCommand | BookAllocationCommand | RecognizeOpenItemCommand | ApplySettlementCommand | PostCurrencyRemeasurementCommand | CompileConsolidationCommand | PostOwnedInventoryTransactionCommand),
): CurrentJournalResult {
  if (
    !["postJournal", "replaceConfiguration", "correctJournal", "closePeriod", "reopenPeriod", "postTaxedTransaction", "createAllocationSchedule", "recognizeScheduledAllocation", "reviseAllocationSchedule", "recognizeOpenItem", "applySettlement", "postCurrencyRemeasurement", "compileConsolidation", "postOwnedInventoryTransaction"].includes(input.type) ||
    (input.type === "postOwnedInventoryTransaction" && input.request.algorithmVersion !== "1.2.0") ||
    ("lotOperations" in input && (input.lotOperations?.length ?? 0) > 0)
  )
    throw new TypeError("Unsupported current-state command");
  const command = immutableAccountingValue(input);
  const header = immutableAccountingValue(context.header);
  const finished = (evaluation: ReturnType<typeof rejectBookCommand>): CurrentJournalResult =>
    Object.freeze({
      header,
      result: evaluation.result,
      ...(evaluation.retained === undefined ? {} : { retained: evaluation.retained }),
    });
  const protocol = evaluateBookCommandProtocol(
    {
      identity: header.identity,
      bookRevision: header.bookRevision,
      retainedCommand: (id) => context.retainedCommand(id),
      previousFinancialCommit: () => {
        const previous = context.previousRevision;
        if (
          header.bookRevision === 0n
            ? previous !== null
            : previous === null ||
              previous.bookId !== header.identity.bookId ||
              previous.bookRevision !== header.bookRevision
        )
          throw new TypeError("Current financial predecessor does not match the book header");
        return previous?.committedAt ?? null;
      },
    },
    command,
  );
  if (protocol.disposition === "finished") return finished(protocol);
  const configuration = context.configuration;
  const state = {
    ...header,
    periods: configuration.periods,
    admissionSnapshot: configuration.admissionSnapshot,
    policies: configuration.policies,
    quantizationPolicies: configuration.quantizationPolicies,
    accountingPolicySnapshot: configuration.accountingPolicySnapshot,
    ...(context.opening === null ? {} : { openingBoundary: context.opening }),
  };
  const reject = (diagnostics: Parameters<typeof rejectBookCommand>[2]) =>
    finished(rejectBookCommand(header, command, diagnostics, true));
  const commit = (intent: BookCommitIntent): CurrentJournalResult => {
    const records = prepareBookCommitRecords({ bookId: header.identity.bookId,
      bookRevision: header.bookRevision, previousRevision: context.previousRevision }, intent);
    const journal = intent.effects.find((effect) => effect.type === "journal");
    return Object.freeze({
      header: immutableAccountingValue({ ...header, bookRevision: records.revision.bookRevision,
        latestPostingSequence: intent.resultingPostingSequence,
        configurationRevision: intent.nextConfigurationRevision, configurationHash: intent.resultingConfigurationHash }),
      result: records.result, retained: records.retained, revision: records.revision,
      effects: intent.effects, ...(journal === undefined ? {} : { journal: journal.booked }),
    });
  };
  const managedInventoryDiagnostics = (journals: readonly BookedJournal[]) => {
    context.readMoneyScopes?.(journals.flatMap(journal => journal.journal.postings.map(posting => ({
      bookId: header.identity.bookId, accountId: posting.accountId, functionalCommodityId: header.identity.functionalCommodityId,
      dimensionMemberIds: posting.dimensionMemberIds,
    }))));
    for (const journal of journals) for (const posting of journal.journal.postings) {
      const managed = context.managedMoneyScope({ bookId: header.identity.bookId, accountId: posting.accountId,
        functionalCommodityId: header.identity.functionalCommodityId, dimensionMemberIds: posting.dimensionMemberIds });
      if (managed !== "managed" && managed !== "unmanaged") throw new TypeError("Incomplete managed inventory scope evidence");
      if (managed === "managed") return [diagnostic("inventory_cost_policy_incoherent", "command.inventoryOwnership",
        "Managed inventory postings, holdings and source corrections require an explicit ownership transition", ["ACC-039.7", "ACC-039.8", "ACC-039.9"])];
    }
    return [];
  };
  const identityDiagnostics = validateBookFinancialIdentity(
    state,
    () => context.activationIdentity,
  );
  if (identityDiagnostics.length) return reject(identityDiagnostics);
  const prepared = preparedConfigurations.get(configuration);
  const reproducedHash = prepared?.hash ?? hashBookConfigurationSnapshot(configuration);
  if (prepared !== undefined) prepared.hash = reproducedHash;
  // This context's lineage is established by the repository, not by traversing
  // historical configurations here. A broken internal binding is a service error.
  if (
    configuration.revision !== header.configurationRevision ||
    !contentHashEquals(configuration.contentHash, header.configurationHash) ||
    !contentHashEquals(reproducedHash, configuration.contentHash) ||
    (configuration.executionProfile !== undefined &&
      configuration.executionProfile !== STRUCTURAL_SOURCE_IDENTITY_PROFILE)
  )
    throw new TypeError("Current configuration does not match the admitted book header");
  if (command.expectedBookRevision !== header.bookRevision)
    return reject([
      diagnostic(
        "stale_book_revision",
        "command.expectedBookRevision",
        "Command was evaluated against a stale book revision",
        ["ACC-021", "ACC-031"],
      ),
    ]);
  const known = prepared?.validation;
  const configurationDiagnostics = known !== undefined && contentHashEquals(known.identityHash, header.financialIdentityHash)
    ? known.diagnostics : validateBookConfiguration(state);
  if (prepared !== undefined) prepared.validation = { identityHash: header.financialIdentityHash, diagnostics: configurationDiagnostics };
  if (configurationDiagnostics.length) return reject(configurationDiagnostics);
  const globalDiagnostics = validateBookGlobalAdmission(state, command, () =>
    context.overdueRemeasurement(),
  );
  if (globalDiagnostics.length) return reject(globalDiagnostics);
  if (command.type === "replaceConfiguration") {
    if (context.configurationFacts === undefined)
      throw new TypeError("Missing current configuration facts");
    const prepared = prepareBookConfigurationChange(
      {
        ...header,
        activeConfigurationSnapshot: configuration,
        latestAccountingDate: context.configurationFacts.latestAccountingDate,
      },
      command,
    );
    if (prepared.disposition === "finished") return finished(prepared);
    return commit(prepared.intent);
  }
  const journalContext: BookJournalReadContext & typeof state = {
    ...state,
    journalIdentity: (id) => context.journalIdentity(id),
    postingIdentity: (id) => context.postingIdentity(id),
    ...(context.readPostingIdentities === undefined ? {} : { readPostingIdentities: context.readPostingIdentities }),
    periodStatus: (id) => context.periodStatus(id),
  };
  if (command.type === "postOwnedInventoryTransaction") {
    if (context.ownedInventoryFacts === undefined) throw new TypeError("Missing current inventory ownership evidence");
    const prepared = prepareBookOwnedInventory({ ...journalContext, ...context.ownedInventoryFacts,
      executionProfile: configuration.executionProfile, managedMoneyScope: scope => context.managedMoneyScope(scope) }, command);
    if (!("journals" in prepared)) return reject(prepared);
    return commit(prepareBookIntent(header, command, ownedInventoryChangeEffects(prepared), prepared.sequence).intent);
  }
  if (command.type === "postCurrencyRemeasurement") {
    if (context.currencyFacts === undefined) throw new TypeError("Missing current currency evidence");
    const prepared = prepareBookCurrencyRemeasurement({ ...journalContext, ...context.currencyFacts, executionProfile: configuration.executionProfile }, command);
    if (!("effects" in prepared)) return reject(prepared);
    const diagnostics = managedInventoryDiagnostics(prepared.effects.flatMap((effect) => effect.type === "journal" ? [effect.booked] : []));
    if (diagnostics.length > 0) return reject(diagnostics);
    return commit(prepareBookIntent(header, command, prepared.effects, prepared.sequence).intent);
  }
  if (command.type === "applySettlement") {
    if (context.settlementFacts === undefined) throw new TypeError("Missing current settlement evidence");
    const prepared = prepareBookSettlement({ ...journalContext, ...context.settlementFacts, executionProfile: configuration.executionProfile }, command);
    if (!("effects" in prepared)) return reject(prepared);
    const diagnostics = managedInventoryDiagnostics(prepared.effects.flatMap((effect) => effect.type === "journal" ? [effect.booked] : []));
    if (diagnostics.length > 0) return reject(diagnostics);
    return commit(prepareBookIntent(header, command, prepared.effects, prepared.sequence).intent);
  }
  if (command.type === "recognizeOpenItem") {
    if (context.openItemFacts === undefined) throw new TypeError("Missing current open-item source evidence");
    const prepared = prepareBookOpenItem({ ...journalContext, ...context.openItemFacts, executionProfile: configuration.executionProfile }, command);
    if (!("effects" in prepared)) return reject(prepared);
    const diagnostics = managedInventoryDiagnostics(prepared.effects.flatMap((effect) => effect.type === "journal" ? [effect.booked] : []));
    if (diagnostics.length > 0) return reject(diagnostics);
    return commit(prepareBookIntent(header, command, prepared.effects, prepared.sequence).intent);
  }
  if (command.type === "createAllocationSchedule" || command.type === "recognizeScheduledAllocation" || command.type === "reviseAllocationSchedule") {
    const facts = context.allocationFacts;
    if (facts === undefined) throw new TypeError("Missing current allocation lifecycle evidence");
    const prepared = prepareBookAllocation({ ...journalContext, ...facts }, command);
    if (!("effects" in prepared)) return reject(prepared);
    const diagnostics = managedInventoryDiagnostics(prepared.effects.flatMap((effect) => effect.type === "journal" ? [effect.booked] : []));
    if (diagnostics.length > 0) return reject(diagnostics);
    return commit(prepareBookIntent(header, command, prepared.effects, prepared.sequence).intent);
  }
  if (command.type === "compileConsolidation") {
    if (context.consolidationFacts === undefined) throw new TypeError("Missing current compilation identity evidence");
    const prepared = prepareBookConsolidation({ ...journalContext, ...context.consolidationFacts }, command);
    if (!("effects" in prepared)) return reject(prepared);
    const diagnostics = managedInventoryDiagnostics(prepared.effects.flatMap(effect => effect.type === "journal" ? [effect.booked] : []));
    if (diagnostics.length > 0) return reject(diagnostics);
    return commit(prepareBookIntent(header, command, prepared.effects, prepared.sequence).intent);
  }
  if (command.type === "postTaxedTransaction") {
    if (context.taxFacts === undefined) throw new TypeError("Missing current tax identity evidence");
    const prepared = prepareBookTaxTransaction({ ...journalContext, ...context.taxFacts }, command);
    if (!("effects" in prepared)) return reject(prepared);
    const diagnostics = managedInventoryDiagnostics(prepared.effects.flatMap((effect) => effect.type === "journal" ? [effect.booked] : []));
    if (diagnostics.length > 0) return reject(diagnostics);
    return commit(prepareBookIntent(header, command, prepared.effects, prepared.sequence).intent);
  }
  if (command.type === "closePeriod" || command.type === "reopenPeriod") {
    let prepared: ReturnType<typeof prepareBookClose>;
    if (command.type === "closePeriod") {
      if (context.closeFacts === undefined || context.previousRevision === null)
        throw new TypeError("Missing current period close facts");
      prepared = prepareBookClose({ ...journalContext, ...context.closeFacts,
        activeConfigurationSnapshot: configuration, bookStateSnapshotHash: context.previousRevision.chainHash }, command);
    } else {
      if (context.reopenFacts === undefined) throw new TypeError("Missing current period reopen facts");
      prepared = prepareBookReopen({ ...journalContext, ...context.reopenFacts }, command);
    }
    if (prepared.disposition === "finished") return finished(prepared);
    const diagnostics = managedInventoryDiagnostics(prepared.intent.effects.flatMap((effect) => effect.type === "journal" ? [effect.booked] : []));
    if (diagnostics.length) return reject(diagnostics);
    return commit(prepared.intent);
  }
  let correction: Extract<BookEffect, { type: "correction" }> | undefined;
  let booked: ReturnType<typeof prepareOrdinaryBookJournal>;
  if (command.type === "correctJournal") {
    const facts = context.correctionFacts;
    if (facts === undefined || typeof facts.managedSource !== "boolean")
      throw new TypeError("Missing managed correction source evidence");
    const prepared = prepareBookCorrection({ ...journalContext, ...facts }, command);
    if (!("booked" in prepared)) return reject(prepared);
    booked = prepared.booked;
    correction = { type: "correction", link: prepared.link };
  } else booked = prepareOrdinaryBookJournal(journalContext, command);
  if (!("journal" in booked)) return reject(booked);
  const managedDiagnostics = managedInventoryDiagnostics([booked]);
  if (managedDiagnostics.length) return reject(managedDiagnostics);
  if (command.type === "correctJournal" && context.correctionFacts?.managedSource === true)
    return reject([
      diagnostic(
        "inventory_cost_policy_incoherent",
        "command.inventoryOwnership",
        "Managed inventory postings, holdings and source corrections require an explicit ownership transition",
        ["ACC-039.7", "ACC-039.8", "ACC-039.9"],
      ),
    ]);
  const evaluated = prepareBookIntent(
    header,
    command,
    [{ type: "journal", booked }, ...(correction === undefined ? [] : [correction])],
    booked.postingSequence,
  );
  return commit(evaluated.intent);
}
