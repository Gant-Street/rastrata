import {
  decodePreparedBookConfiguration,
  decodeBookRow,
  decodeBookStateHeader,
  encodeBookOutcome,
  encodeBookRow,
  encodeBookStateHeader,
  encodeDurableBook,
  evaluateCurrentBookCommand,
  localDate,
  type BookCommand,
  type BookCommandResult,
  type BookState,
  type BookStateHeader,
  type DurableBookAggregate,
  type RetainedCommandResult,
  type BookedJournal,
  type CurrentBookContext,
  type ClosePackage,
  type AccountingPolicy,
  type PostingId,
} from "@rastrata/kernel";
import { evaluateOutcomePayload } from "./outcome-payload.ts";
import { decodeAggregate, LedgerError, requireLedger, snapshotCommand } from "./records.ts";
import { currentStateCache } from "./current-state-cache.ts";
import type {
  NativeLedgerRepository,
  NativeLedgerFact,
  NativeLedgerOutcome,
  NativeLedgerTransaction,
} from "./native-ledger-repository.ts";

import { readNativeAllocation, readNativeSourceJournals } from "./native-allocation.ts";
import { journalMoneyScopes, moneyScopeKeys, nativeMoney } from "./native-money.ts";
import {
  readNativeInventory,
  postingReferenceIdentityKeys,
  projectPostingReferenceIdentities,
} from "./native-inventory.ts";
import {
  readActiveSourceRemeasurements,
  readNativeCurrency,
  readOverdueCurrency,
} from "./native-currency.ts";
import {
  financialSourceFact,
  readFinancialSourceOwner,
  initialOpenItemTotals,
  readNativeSettlement,
} from "./native-settlement.ts";

const CURRENT = "current";
// Earlier experimental books lack complete money-scope/reference indexes. Do
// not silently treat missing history as zero/absence; require verified replay.
const PROFILE = "native-book-commands-owned-inventory-v1";
function supportedPolicies(policies: readonly AccountingPolicy[]): boolean {
  return policies.every(
    (policy) =>
      policy.kind === "taxDetermination" ||
      policy.kind === "allocationSchedule" ||
      policy.kind === "currencyRemeasurement" ||
      policy.kind === "monetaryClassification" ||
      policy.kind === "inventoryCost" ||
      policy.kind === "consolidation",
  );
}
const currentKeys = [
  "profile",
  "header",
  "configuration",
  "opening",
  "revision",
  "activation",
  "latestAccountingDate",
];
function headerOf(state: BookState): BookStateHeader {
  return {
    identity: state.identity,
    financialIdentityHash: state.financialIdentityHash,
    status: state.status,
    bookRevision: state.bookRevision,
    latestPostingSequence: state.latestPostingSequence,
    configurationRevision: state.configurationRevision,
    configurationHash: state.configurationHash,
  };
}
function required(fact: NativeLedgerFact | null | undefined): string {
  requireLedger(fact, "native_ledger_required_fact_missing");
  return fact.encoded;
}
function periodState(fact: NativeLedgerFact | null | undefined) {
  const encoded = required(fact);
  if (encoded === "open" && fact?.mutable !== true)
    return { status: "open" as const, closeCount: 0n };
  const value = JSON.parse(encoded);
  requireLedger(
    fact?.mutable === true &&
      value &&
      (value.status === "open" || value.status === "closed") &&
      typeof value.closeCount === "string" &&
      /^[1-9][0-9]{0,18}$/.test(value.closeCount) &&
      JSON.stringify({ status: value.status, closeCount: value.closeCount }) === encoded,
    "native_ledger_current_state_corrupt",
  );
  return { status: value.status as "open" | "closed", closeCount: BigInt(value.closeCount) };
}
function currentFact(key: string, encoded: string): NativeLedgerFact {
  return {
    collection: CURRENT,
    key,
    encoded,
    ...(["header", "revision", "configuration", "latestAccountingDate"].includes(key)
      ? { mutable: true as const }
      : {}),
  };
}
function retained(outcome: NativeLedgerOutcome | null): RetainedCommandResult | null {
  if (outcome === null) return null;
  const { command, originalResult: result } = outcome.payload;
  return {
    command,
    commandId: command.id,
    inputHash: command.inputHash,
    outcome: result.disposition,
    observedBookRevision: result.observedBookRevision,
    resultHash: result.resultHash,
    completedAt: result.completedAt,
    diagnostics: result.diagnostics,
  };
}
/** One entry per stable current field, never per outcome/history row. Bytes are
 * still fetched and authenticated on every transaction. Cache only deeply frozen
 * decoder results, and replace on any exact-byte change (including rollback). */
function currentDecoders() {
  // Shared, not 1 MiB per field. There are only three slots and no history cache.
  const cache = currentStateCache(1_048_576);
  return {
    configuration: cache.memoize(decodePreparedBookConfiguration),
    opening: cache.memoize((encoded) => decodeBookRow("state.openingBoundary", encoded)),
    activation: cache.memoize(decodeBookStateHeader),
  };
}
function decodeCurrent(view: NativeLedgerTransaction, decode: ReturnType<typeof currentDecoders>) {
  const keys = currentKeys.map((key) => ({ collection: CURRENT, key }));
  let facts: ReturnType<NativeLedgerTransaction["facts"]>;
  try {
    facts = view.facts(keys);
  } catch (error) {
    if (!(error instanceof LedgerError) || error.code !== "native_ledger_read_limit") throw error;
    // Exactly seven fixed current coordinates, still within this transaction.
    // A large activation revision plus its configuration/opening can exceed the
    // 1 MiB batch bound even though every individual admitted row fits. Do not
    // raise that general bound or split arbitrary caller-controlled populations.
    facts = keys.map((key) => view.facts([key])[0] ?? null);
  }
  requireLedger(required(facts[0]) === PROFILE, "native_ledger_profile_unsupported");
  const header = decodeBookStateHeader(required(facts[1]));
  const configuration = decode.configuration(required(facts[2]));
  const opening = decode.opening(required(facts[3]));
  const revision = decodeBookRow("state.revisions", required(facts[4]));
  const activation = decode.activation(required(facts[5]));
  requireLedger(
    header.disposition === "decoded" &&
      configuration.disposition === "decoded" &&
      opening.disposition === "decoded" &&
      revision.disposition === "decoded" &&
      activation.disposition === "decoded",
    "native_ledger_current_state_corrupt",
  );
  requireLedger(
    header.header.bookRevision.toString() === view.head.bookRevision &&
      revision.row.bookRevision === header.header.bookRevision &&
      revision.row.bookId === header.header.identity.bookId &&
      supportedPolicies(configuration.row.accountingPolicySnapshot.policies) &&
      configuration.row.revision === header.header.configurationRevision,
    "native_ledger_current_state_corrupt",
  );
  const dateText = required(facts[6]);
  const parsedDate: unknown = JSON.parse(dateText);
  requireLedger(
    parsedDate === null || typeof parsedDate === "string",
    "native_ledger_current_state_corrupt",
  );
  const latestAccountingDate = parsedDate === null ? null : localDate(parsedDate);
  requireLedger(
    JSON.stringify(latestAccountingDate) === dateText &&
      (header.header.latestPostingSequence === 0n || latestAccountingDate !== null),
    "native_ledger_current_state_corrupt",
  );
  return {
    header: header.header,
    configuration: configuration.row,
    opening: opening.row,
    previousRevision: revision.row,
    activationIdentity: activation.header.financialIdentityHash,
    latestAccountingDate,
  };
}

/** Internal native execution slice. Supports new-zero-balance books, journals,
 * corrections, period close/reopen, tax, open items/payments, allocation lifecycle and prospective
 * configuration and explicit 1.2 owned acquisition/issue/transfer. Legacy lots,
 * adoption and other unsupported commands
 * fail as service errors; no slow fallback or fabricated accounting rejection.
 * This is NOT yet the complete production ledger or an enabled public profile.
 * Every successful write uses the native repository and current-state kernel API,
 * including after process replacement. Ordinary saves do not scan history;
 * period maintenance streams its required retained populations. */
export class NativeLedger {
  private readonly decode = currentDecoders();
  constructor(
    private readonly repository: NativeLedgerRepository,
    private readonly preparePublication?: () => Promise<void>,
  ) {}

  provision(
    initial: DurableBookAggregate,
    input: BookCommand,
    admit?: () => void,
  ): Promise<{ readonly result: BookCommandResult; readonly outcomeSequence: string }> {
    const genesis = encodeDurableBook(initial);
    const verified = decodeAggregate(genesis);
    const command = snapshotCommand(input);
    requireLedger(
      command.type === "activateBook" &&
        command.mode === "newZeroBalance" &&
        command.opening === undefined &&
        (command.lotOperations?.length ?? 0) === 0 &&
        verified.state.bookRevision === 0n &&
        verified.protocol.retainedResults.length === 0 &&
        verified.state.lots.length === 0 &&
        verified.state.lotHoldings.length === 0 &&
        verified.state.lotAllocations.length === 0 &&
        (verified.state.inventoryOwnershipEffects?.length ?? 0) === 0 &&
        supportedPolicies(verified.state.accountingPolicySnapshot.policies) &&
        verified.state.identity.bookId === this.repository.scope.bookId,
      "native_ledger_profile_unsupported",
    );
    const next = evaluateOutcomePayload(verified, command);
    const encodedOutcome = next.encoded;
    const state = next.transition.state;
    const opening = state.openingBoundary;
    requireLedger(
      encodedOutcome !== null &&
        next.transition.result.disposition === "committed" &&
        opening !== undefined,
      "native_ledger_activation_rejected",
    );
    const revision = state.revisions[0];
    requireLedger(revision, "native_ledger_activation_rejected");
    const facts = [
      currentFact("profile", PROFILE),
      currentFact("header", encodeBookStateHeader(headerOf(state))),
      currentFact(
        "configuration",
        encodeBookRow("state.configurationSnapshots", state.activeConfigurationSnapshot),
      ),
      currentFact("opening", encodeBookRow("state.openingBoundary", opening)),
      currentFact("revision", encodeBookRow("state.revisions", revision)),
      currentFact("activation", encodeBookStateHeader(headerOf(state))),
      currentFact("latestAccountingDate", "null"),
      ...state.periods.map((period) => ({
        collection: "periods",
        key: period.id,
        encoded: "open",
      })),
    ];
    return this.repository
      .provision(genesis, admit, this.preparePublication)
      .then(() =>
        this.repository.transact(
          (view) => {
            const original = view.outcome(command.id);
            if (original !== null) {
              requireLedger(original.encoded === encodedOutcome, "native_ledger_genesis_conflict");
              return {
                write: false,
                value: {
                  result: original.payload.originalResult,
                  outcomeSequence: original.head.sequence,
                },
              };
            }
            requireLedger(view.head.sequence === "0", "native_ledger_activation_conflict");
            return {
              write: true,
              decision: { encodedOutcome, facts },
              value: { result: next.transition.result, outcomeSequence: "1" },
            };
          },
          admit,
          this.preparePublication,
        ),
      )
      .then((result) => result.value);
  }

  execute(input: BookCommand, admit?: () => void) {
    const command = snapshotCommand(input);
    requireLedger(command.bookId === this.repository.scope.bookId, "ledger_identity_mismatch");
    requireLedger(
      ((command.type === "postJournal" || command.type === "correctJournal") &&
        (command.lotOperations?.length ?? 0) === 0) ||
        (command.type === "replaceConfiguration" &&
          supportedPolicies(command.accountingPolicies)) ||
        command.type === "postTaxedTransaction" ||
        (command.type === "postOwnedInventoryTransaction" &&
          command.request.algorithmVersion === "1.2.0") ||
        command.type === "compileConsolidation" ||
        command.type === "postCurrencyRemeasurement" ||
        command.type === "recognizeOpenItem" ||
        command.type === "applySettlement" ||
        command.type === "createAllocationSchedule" ||
        command.type === "recognizeScheduledAllocation" ||
        command.type === "reviseAllocationSchedule" ||
        command.type === "closePeriod" ||
        command.type === "reopenPeriod",
      "native_ledger_profile_unsupported",
    );
    return this.repository.transact(
      (view) => {
        const original = view.outcome(command.id);
        const current = decodeCurrent(view, this.decode);
        const allocationCommand =
          command.type === "createAllocationSchedule" ||
          command.type === "recognizeScheduledAllocation" ||
          command.type === "reviseAllocationSchedule";
        let allocation: ReturnType<typeof readNativeAllocation> | undefined;
        let settlement: ReturnType<typeof readNativeSettlement> | undefined;
        let currency: ReturnType<typeof readNativeCurrency> | undefined;
        let inventory: ReturnType<typeof readNativeInventory> | undefined;
        const suppliedJournals =
          command.type === "postOwnedInventoryTransaction"
            ? command.request.resolvedJournals
            : command.type === "applySettlement"
              ? command.resolved
              : [];
        const journalInput =
          command.type === "postJournal" ||
          command.type === "correctJournal" ||
          command.type === "recognizeOpenItem"
            ? command.resolved
            : command.type === "closePeriod"
              ? command.closing
              : command.type === "reopenPeriod"
                ? command.reversal
                : undefined;
        const identities =
          journalInput !== undefined
            ? [
                { collection: "journals", key: journalInput.journal.id },
                ...journalInput.journal.postings.map((posting) => ({
                  collection: "postings",
                  key: posting.id,
                })),
              ]
            : [];
        const keys = [
          ...(original === null
            ? moneyScopeKeys(
                journalMoneyScopes([
                  ...(journalInput === undefined ? [] : [journalInput.journal]),
                  ...suppliedJournals.map((item) => item.journal),
                ]),
              )
            : []),
          ...identities,
          ...postingReferenceIdentityKeys(command),
          ...suppliedJournals.flatMap((resolved) => [
            { collection: "journals", key: resolved.journal.id },
            ...resolved.journal.postings.map((posting) => ({
              collection: "postings",
              key: posting.id,
            })),
          ]),
          ...(command.type === "recognizeOpenItem"
            ? [{ collection: "openItems", key: command.request.value.id }]
            : []),
          ...(command.type === "postTaxedTransaction"
            ? [
                { collection: "journals", key: command.request.sourceTransactionId },
                { collection: "taxDeterminations", key: command.request.id },
              ]
            : []),
          ...(command.type === "compileConsolidation"
            ? [
                { collection: "journals", key: `${command.request.id}-journal` },
                { collection: "consolidationCompilations", key: command.request.id },
              ]
            : []),
          ...current.configuration.periods.map((period) => ({
            collection: "periods",
            key: period.id,
          })),
          ...(command.type === "replaceConfiguration"
            ? command.periods.map((period) => ({ collection: "periods", key: period.id }))
            : []),
          ...(command.type === "closePeriod"
            ? [{ collection: "closePackages", key: command.closePackageId }]
            : []),
          ...(command.type === "correctJournal"
            ? [
                { collection: "journals", key: command.originalJournalId },
                { collection: "corrections", key: command.originalJournalId },
              ]
            : []),
        ];
        const selected = view.facts(keys);
        const presence = new Map(
          keys.map((key, index) => [
            JSON.stringify([key.collection, key.key]),
            selected[index] ?? null,
          ]),
        );
        const identityPresence = (collection: string, id: string) => {
          const key = JSON.stringify([collection, id]);
          requireLedger(presence.has(key), "native_ledger_identity_not_read");
          return presence.get(key) === null ? ("absent" as const) : ("present" as const);
        };
        const money = nativeMoney(view, presence);
        const journalIdentity = (id: string) => {
          const key = JSON.stringify(["journals", id]);
          if (
            (allocationCommand ||
              command.type === "applySettlement" ||
              command.type === "postCurrencyRemeasurement") &&
            !presence.has(key)
          ) {
            const fact = view.facts([{ collection: "journals", key: id }])[0];
            requireLedger(fact !== undefined, "native_ledger_required_fact_missing");
            presence.set(key, fact);
          }
          return identityPresence("journals", id);
        };
        const readJournal = (id: string): BookedJournal | null => {
          const fact = view.facts([{ collection: "journals", key: id }])[0];
          if (!fact) return null;
          const decoded = decodeBookRow("state.journals", fact.encoded);
          requireLedger(
            decoded.disposition === "decoded" &&
              decoded.row.journal.id === id &&
              decoded.row.journal.bookId === current.header.identity.bookId,
            "native_ledger_current_state_corrupt",
          );
          return decoded.row;
        };
        let closeFacts: CurrentBookContext["closeFacts"];
        let reopenFacts: CurrentBookContext["reopenFacts"];
        if (
          (command.type === "closePeriod" || command.type === "reopenPeriod") &&
          original === null
        ) {
          let previousCloseCount = 0n;
          const closeCounts = new Map<string, bigint>();
          const currentClosePackages: ClosePackage[] = [];
          const target = current.configuration.periods.find(
            (period) => period.id === command.periodId,
          );
          const relevant = new Set(
            current.configuration.periods
              .filter((period) => target !== undefined && period.endsOn >= target.endsOn)
              .map((period) => period.id),
          );
          for (const { fact, companion } of view.scanFacts("closePackages", "closeStatuses")) {
            const decoded = decodeBookRow("state.closePackages", fact.encoded);
            requireLedger(
              decoded.disposition === "decoded" &&
                decoded.row.id === fact.key &&
                decoded.row.configurationSnapshot.admissionSnapshot.bookId ===
                  current.header.identity.bookId &&
                decoded.row.throughBookRevision <= current.header.bookRevision &&
                decoded.row.throughPostingSequence <= current.header.latestPostingSequence &&
                companion !== null &&
                (companion.encoded === "current" || companion.encoded === "superseded"),
              "native_ledger_current_state_corrupt",
            );
            if (decoded.row.periodId === command.periodId) previousCloseCount++;
            closeCounts.set(
              decoded.row.periodId,
              (closeCounts.get(decoded.row.periodId) ?? 0n) + 1n,
            );
            if (
              command.type === "reopenPeriod" &&
              companion.encoded === "current" &&
              relevant.has(decoded.row.periodId)
            ) {
              currentClosePackages.push(decoded.row);
            }
          }
          for (const period of current.configuration.periods) {
            const stored = periodState(presence.get(JSON.stringify(["periods", period.id])));
            requireLedger(
              stored.closeCount === (closeCounts.get(period.id) ?? 0n),
              "native_ledger_period_history_incomplete",
            );
          }
          if (command.type === "closePeriod")
            closeFacts = {
              previousCloseCount,
              closePackageIdentity: (id) => identityPresence("closePackages", id),
              journals: function* () {
                // Rows are in outcome order; one command can publish several journals
                // in one outcome. Sort only that bounded transaction-sized group,
                // never the whole retained population.
                let group: BookedJournal[] = [];
                let groupBytes = 0;
                const ordered = () =>
                  group.sort((left, right) =>
                    left.postingSequence < right.postingSequence ? -1 : 1,
                  );
                for (const { fact } of view.scanFacts("journals")) {
                  const decoded = decodeBookRow("state.journals", fact.encoded);
                  requireLedger(
                    decoded.disposition === "decoded" &&
                      decoded.row.journal.id === fact.key &&
                      decoded.row.journal.bookId === current.header.identity.bookId &&
                      decoded.row.bookRevision <= current.header.bookRevision,
                    "native_ledger_current_state_corrupt",
                  );
                  const previous = group[0];
                  if (
                    previous !== undefined &&
                    previous.bookRevision !== decoded.row.bookRevision
                  ) {
                    requireLedger(
                      previous.bookRevision < decoded.row.bookRevision,
                      "native_ledger_current_state_corrupt",
                    );
                    yield* ordered();
                    group = [];
                    groupBytes = 0;
                  }
                  group.push(decoded.row);
                  groupBytes += new TextEncoder().encode(fact.encoded).byteLength;
                  // No outcome can publish more than the repository's 1,000 facts
                  // or 4 MiB total fact bytes. Close retains only this bounded group.
                  requireLedger(
                    group.length <= 1000 && groupBytes <= 4_194_304,
                    "native_ledger_current_state_corrupt",
                  );
                }
                yield* ordered();
              },
            };
          else
            reopenFacts = {
              currentClosePackages,
              journal: (id) => {
                const journal = readJournal(id);
                requireLedger(journal !== null, "native_ledger_required_fact_missing");
                return journal;
              },
            };
        }
        let correctionFacts:
          | {
              originalJournal: BookedJournal | null;
              alreadyCorrected: boolean;
              currencySource: boolean;
              managedSource: boolean;
            }
          | undefined;
        if (command.type === "correctJournal") {
          const source = presence.get(JSON.stringify(["journals", command.originalJournalId]));
          let originalJournal: BookedJournal | null = null;
          if (source) {
            const decoded = decodeBookRow("state.journals", source.encoded);
            requireLedger(
              decoded.disposition === "decoded" &&
                decoded.row.journal.id === command.originalJournalId &&
                decoded.row.journal.bookId === this.repository.scope.bookId,
              "native_ledger_current_state_corrupt",
            );
            originalJournal = decoded.row;
            const periodKey = JSON.stringify(["periods", originalJournal.fiscalPeriodId]);
            if (!presence.has(periodKey)) {
              const status = view.facts([
                { collection: "periods", key: originalJournal.fiscalPeriodId },
              ])[0];
              requireLedger(status, "native_ledger_required_fact_missing");
              presence.set(periodKey, status);
            }
          }
          const origin = originalJournal === null ? null : view.outcome(originalJournal.commandId);
          requireLedger(
            originalJournal === null ||
              (origin !== null &&
                origin.payload.revision?.bookRevision === originalJournal.bookRevision &&
                origin.payload.revision.effects.some(
                  (effect) =>
                    effect.type === "journal" &&
                    encodeBookRow("state.journals", effect.booked) ===
                      encodeBookRow("state.journals", originalJournal),
                )),
            "native_ledger_required_fact_missing",
          );
          correctionFacts = {
            originalJournal,
            currencySource: origin?.payload.command.type === "postCurrencyRemeasurement",
            alreadyCorrected:
              identityPresence("corrections", command.originalJournalId) === "present",
            managedSource: origin?.payload.command.type === "postOwnedInventoryTransaction",
          };
        }
        const result = evaluateCurrentBookCommand(
          {
            ...current,
            configurationFacts: { latestAccountingDate: current.latestAccountingDate },
            ...(closeFacts === undefined ? {} : { closeFacts }),
            ...(reopenFacts === undefined ? {} : { reopenFacts }),
            ...(correctionFacts === undefined ? {} : { correctionFacts }),
            retainedCommand: () => retained(original),
            journalIdentity,
            get openItemFacts(): NonNullable<CurrentBookContext["openItemFacts"]> {
              requireLedger(
                command.type === "recognizeOpenItem",
                "native_ledger_profile_unsupported",
              );
              return {
                openItemIdentity: (id) => identityPresence("openItems", id),
                sourceJournals: (source) =>
                  readNativeSourceJournals(
                    view,
                    current.header.identity.bookId,
                    current.configuration.executionProfile,
                    source,
                  ),
                financialSourceOwner: (source) => readFinancialSourceOwner(view, source),
              };
            },
            get allocationFacts() {
              requireLedger(allocationCommand, "native_ledger_profile_unsupported");
              allocation ??= readNativeAllocation(view, command, current.configuration);
              return allocation.context;
            },
            get settlementFacts() {
              requireLedger(
                command.type === "applySettlement",
                "native_ledger_profile_unsupported",
              );
              settlement ??= readNativeSettlement(view, command, current.configuration, (sources) =>
                readActiveSourceRemeasurements(view, sources),
              );
              return settlement.context;
            },
            get currencyFacts() {
              requireLedger(
                command.type === "postCurrencyRemeasurement",
                "native_ledger_profile_unsupported",
              );
              currency ??= readNativeCurrency(view, command, current.configuration);
              return currency.context;
            },
            get ownedInventoryFacts() {
              requireLedger(
                command.type === "postOwnedInventoryTransaction",
                "native_ledger_profile_unsupported",
              );
              inventory ??= readNativeInventory(view, command, current.header, money, presence);
              return inventory.context;
            },
            postingIdentity: (id) => identityPresence("postings", id),
            ...(command.type === "compileConsolidation"
              ? {
                  consolidationFacts: {
                    compilationIdentity: (id: string) =>
                      identityPresence("consolidationCompilations", id),
                  },
                }
              : {}),
            ...(command.type === "postTaxedTransaction"
              ? {
                  taxFacts: {
                    taxIdentity: (id: string) => identityPresence("taxDeterminations", id),
                  },
                }
              : {}),
            ...(command.type === "postTaxedTransaction" ||
            command.type === "compileConsolidation" ||
            command.type === "postCurrencyRemeasurement" ||
            allocationCommand ||
            command.type === "applySettlement"
              ? {
                  readPostingIdentities: (
                    ids: readonly PostingId[],
                    journal?: BookedJournal["journal"],
                  ) => {
                    if (
                      command.type === "applySettlement" &&
                      ids.every((id) => presence.has(JSON.stringify(["postings", id])))
                    )
                      return new Map(ids.map((id) => [id, identityPresence("postings", id)]));
                    const keys = [
                      ...ids.map((key) => ({ collection: "postings", key })),
                      ...moneyScopeKeys(journalMoneyScopes(journal === undefined ? [] : [journal])),
                    ];
                    const observed = view.facts(keys);
                    for (const [index, key] of keys.entries()) {
                      const value = observed[index];
                      requireLedger(value !== undefined, "native_ledger_required_fact_missing");
                      presence.set(JSON.stringify([key.collection, key.key]), value);
                    }
                    return new Map(
                      ids.map((id, index) => {
                        const fact = observed[index];
                        requireLedger(fact !== undefined, "native_ledger_required_fact_missing");
                        return [id, fact === null ? ("absent" as const) : ("present" as const)];
                      }),
                    );
                  },
                }
              : {}),
            periodStatus: (id) => {
              return periodState(presence.get(JSON.stringify(["periods", id]))).status;
            },
            overdueRemeasurement: () => readOverdueCurrency(view, command, current.configuration),
            readMoneyScopes: (scopes) => money.read(scopes),
            managedMoneyScope: (scope) => money.managed(scope),
          },
          command,
        );
        const value = {
          result: result.result,
          originalResult:
            result.retained !== undefined
              ? result.result
              : result.result.disposition === "replayed"
                ? (original?.payload.originalResult ?? null)
                : null,
          outcomeSequence:
            result.retained === undefined
              ? result.result.disposition === "replayed"
                ? (original?.head.sequence ?? null)
                : null
              : (BigInt(view.head.sequence) + 1n).toString(),
        };
        if (result.retained === undefined) return { write: false, value };
        requireLedger(
          (result.effects?.filter((effect) => effect.type === "journal").length ?? 0) <= 1000,
          "native_ledger_profile_unsupported",
        );
        const facts: NativeLedgerFact[] = [];
        let upgradeOpenPeriod: string | undefined;
        const { revision } = result;
        const journals =
          result.effects?.flatMap((effect) => (effect.type === "journal" ? [effect.booked] : [])) ??
          [];
        if (revision !== undefined) facts.push(...money.project(result.effects ?? []));
        if (revision !== undefined)
          facts.push(...projectPostingReferenceIdentities(view, result.effects ?? [], presence));
        if (revision !== undefined) {
          facts.push(
            currentFact("header", encodeBookStateHeader(result.header)),
            currentFact("revision", encodeBookRow("state.revisions", revision)),
          );
        }
        const accountingDates = [
          ...journals.map((journal) => journal.journal.accountingDate),
          ...(result.effects ?? []).flatMap((effect) =>
            effect.type === "settlementAllocation" && effect.value.appliedAt !== undefined
              ? [localDate(effect.value.appliedAt.slice(0, 10))]
              : effect.type === "inventoryOwnership"
                ? [
                    ...effect.value.journalLinkedMovements,
                    ...effect.value.quantityOnlyMovements,
                  ].map((movement) => movement.accountingDate)
                : [],
          ),
        ];
        if (revision !== undefined && accountingDates.length > 0) {
          const latestDate = accountingDates.reduce(
            (latest, date) => (latest === null || date > latest ? date : latest),
            current.latestAccountingDate,
          );
          facts.push(currentFact("latestAccountingDate", JSON.stringify(latestDate)));
        }
        if (revision !== undefined && journals.length > 0) {
          for (const journal of journals)
            facts.push(
              {
                collection: "journals",
                key: journal.journal.id,
                encoded: encodeBookRow("state.journals", journal),
              },
              ...journal.journal.postings.map((posting) => ({
                collection: "postings",
                key: posting.id,
                encoded: JSON.stringify([journal.journal.id, revision.bookRevision.toString()]),
              })),
            );
        }
        if (allocation !== undefined) facts.push(...allocation.project(result.effects ?? []));
        if (settlement !== undefined) facts.push(...settlement.project(result.effects ?? []));
        if (currency !== undefined) facts.push(...currency.project(result.effects ?? []));
        if (inventory !== undefined) facts.push(...inventory.project(result.effects ?? []));
        for (const effect of result.effects ?? [])
          if (effect.type === "configuration") {
            facts.push(
              currentFact(
                "configuration",
                encodeBookRow(
                  "state.configurationSnapshots",
                  effect.resultingConfigurationSnapshot,
                ),
              ),
              {
                collection: "configurations",
                key: effect.nextConfigurationRevision.toString(),
                encoded: encodeBookRow(
                  "state.configurationSnapshots",
                  effect.resultingConfigurationSnapshot,
                ),
              },
            );
            for (const period of effect.periods) {
              if (identityPresence("periods", period.id) === "absent")
                facts.push({ collection: "periods", key: period.id, encoded: "open" });
            }
          } else if (effect.type === "openItem") {
            facts.push(
              {
                collection: "openItems",
                key: effect.value.id,
                encoded: encodeBookRow("state.accountingState.openItems", effect.value),
              },
              financialSourceFact(effect),
              initialOpenItemTotals(effect.value.id),
            );
          } else if (effect.type === "settlement") {
            facts.push(
              {
                collection: "settlements",
                key: effect.value.id,
                encoded: encodeBookRow("state.accountingState.settlements", effect.value),
              },
              financialSourceFact(effect),
            );
          } else if (effect.type === "correction") {
            facts.push({
              collection: "corrections",
              key: effect.link.originalJournalId,
              encoded: encodeBookRow("state.corrections", effect.link),
            });
          } else if (effect.type === "closePackage") {
            facts.push(
              {
                collection: "closePackages",
                key: effect.closePackage.id,
                encoded: encodeBookRow("state.closePackages", effect.closePackage),
              },
              {
                collection: "closeStatuses",
                key: effect.closePackage.id,
                encoded: "current",
                mutable: true,
              },
            );
          } else if (effect.type === "consolidationCompilation") {
            facts.push({
              collection: "consolidationCompilations",
              key: effect.value.id,
              encoded: encodeBookRow(
                "state.accountingState.consolidationCompilations",
                effect.value,
              ),
            });
          } else if (effect.type === "taxDetermination") {
            facts.push({
              collection: "taxDeterminations",
              key: effect.value.id,
              encoded: encodeBookRow("state.accountingState.taxDeterminations", effect.value),
            });
          } else if (effect.type === "periodTransition") {
            const { transition } = effect;
            const previous = presence.get(JSON.stringify(["periods", transition.periodId]));
            requireLedger(previous, "native_ledger_required_fact_missing");
            const before = periodState(previous);
            if (previous.mutable !== true) {
              requireLedger(
                before.status === "open" && transition.kind === "close",
                "native_ledger_current_state_corrupt",
              );
              upgradeOpenPeriod = transition.periodId;
            }
            facts.push(
              {
                collection: "periods",
                key: transition.periodId,
                encoded: JSON.stringify({
                  status: transition.kind === "close" ? "closed" : "open",
                  closeCount: (
                    before.closeCount + (transition.kind === "close" ? 1n : 0n)
                  ).toString(),
                }),
                mutable: true,
              },
              {
                collection: "periodTransitions",
                key: transition.bookRevision.toString(),
                encoded: encodeBookRow("state.periodTransitions", transition),
              },
              ...transition.supersededCloseIds.map((id) => ({
                collection: "closeStatuses",
                key: id,
                encoded: "superseded",
                mutable: true as const,
              })),
            );
          }
        requireLedger(result.result.disposition !== "replayed", "native_ledger_outcome_invalid");
        const encodedOutcome = encodeBookOutcome({
          command: result.retained.command,
          originalResult: { ...result.result, disposition: result.result.disposition },
          revision: result.revision ?? null,
        });
        return {
          write: true,
          decision: {
            encodedOutcome,
            facts,
            ...(upgradeOpenPeriod === undefined ? {} : { upgradeOpenPeriod }),
          },
          value,
        };
      },
      admit,
      this.preparePublication,
    );
  }
}
