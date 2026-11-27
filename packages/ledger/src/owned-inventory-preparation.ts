import {
  ACCOUNTING_LIMITS,
  canonicalAccountingValue,
  canonicalEncode,
  contentHashEquals,
  hashAccountingPolicy,
  hashCanonical,
  prepareBookOwnedInventory,
  type BookCommand,
  type BookOwnedInventoryReadContext,
  type LocalDate,
} from "@rastrata/kernel";
import type { PinnedBookRowReader, PinnedInventoryPositionRead } from "./book-row-reader.ts";
import { moneyScopeValues } from "./semantic-groups.ts";
import { requireLedger, snapshotCommand } from "./records.ts";

/** Run the complete common admission bridge before composing authenticated
 * sources for command-specific preparation. Admission still reads the owner's
 * full recovered state/protocol, NOT a sparse header. Neither result is a commit
 * intent, durable receipt, or publication authority. The reader remains pinned; it is retired on
 * any failure. No callback/context escapes this function. Current startup still
 * performs full recovery and the legacy wrapper still emits whole lotState.
 * The bounded eager read set includes all original pool rows; it is not a claim
 * that selected-row-only I/O or enterprise capacity has been achieved. */
export async function preparePinnedOwnedInventory(
  reader: PinnedBookRowReader<unknown>,
  input: BookCommand,
) {
  try {
    const command = snapshotCommand(input);
    requireLedger(
      command.type === "postOwnedInventoryTransaction",
      "owned_preparation_command_invalid",
    );
    const common = await reader.evaluateAdmission(command);
    requireLedger(
      common.commandId === command.id &&
        contentHashEquals(common.commandInputHash, command.inputHash),
      "owned_preparation_command_mismatch",
    );
    // The reader confirms the live head after admission, including replay and
    // rejection. Never resolve inventory pools for a finished common outcome.
    if (common.evaluation.disposition === "finished")
      return Object.freeze({
        disposition: "finished" as const,
        ...common,
      });
    requireLedger(
      common.evaluation.disposition === "continue",
      "owned_preparation_admission_invalid",
    );
    const admission = await reader.readAdmissionFacts(command);
    const basis = admission.basis;
    const sameHead = (value: { headHash: string; catalogDigest: string }) =>
      requireLedger(
        value.headHash === basis.headHash && value.catalogDigest === basis.catalogDigest,
        "owned_preparation_head_mismatch",
      );
    sameHead(common);
    requireLedger(command.bookId === basis.header.identity.bookId, "ledger_identity_mismatch");
    requireLedger(
      admission.commandId === command.id &&
        contentHashEquals(admission.commandInputHash, command.inputHash),
      "owned_preparation_command_mismatch",
    );
    const config = basis.configuration.row;
    const pools = await reader.readOwnedInventoryPools(command);
    sameHead(pools.basis);
    requireLedger(
      pools.commandId === command.id &&
        contentHashEquals(pools.commandInputHash, command.inputHash),
      "owned_preparation_command_mismatch",
    );
    let reads = 0;
    let retainedSourceBytes = pools.sourceRowBytes;
    const retain = (bytes: number) => {
      retainedSourceBytes += bytes;
      requireLedger(
        retainedSourceBytes <= 32 * 1024 * 1024,
        "owned_preparation_source_bytes_limit",
      );
    };
    for (const source of [
      basis.configuration,
      basis.openingBoundary,
      basis.financialRevision,
      pools.basis.configuration,
      pools.basis.openingBoundary,
      pools.basis.financialRevision,
      admission.overdueRemeasurement,
    ])
      if (source !== null) retain(new TextEncoder().encode(source.encoded).length);
    const charge = () =>
      requireLedger(
        ++reads <= ACCOUNTING_LIMITS.maxInventoryLayers * 8,
        "owned_preparation_read_limit",
      );
    const identities = new Map<string, "present" | "absent">();
    type IdentityKind = Parameters<BookOwnedInventoryReadContext["identityPresence"]>[0];
    const identityKey = (kind: string, id: string) => JSON.stringify([kind, id]);
    const claim = async (kind: IdentityKind, id: string) => {
      const key = identityKey(kind, id);
      if (identities.has(key)) return;
      charge();
      if (kind === "postingReference") {
        const result = await reader.readPostingReferenceUsage(id);
        sameHead(result);
        requireLedger(
          result.referenceId === id &&
            (result.disposition === "used" || result.disposition === "unused"),
          "owned_preparation_identity_mismatch",
        );
        identities.set(key, result.disposition === "used" ? "present" : "absent");
      } else {
        const result =
          kind === "allocation"
            ? await reader.readAllocationIdentityPresence(id)
            : kind === "lot" || kind === "holding"
              ? await reader.readLotIdentity(kind === "lot" ? "lot" : "lotHolding", id)
              : await reader.readInventoryIdentity(kind, id);
        sameHead(result);
        requireLedger(
          result.id === id && (result.disposition === "present" || result.disposition === "absent"),
          "owned_preparation_identity_mismatch",
        );
        identities.set(key, result.disposition);
      }
    };
    const positions = new Map<string, PinnedInventoryPositionRead>();
    const movementDates = new Map<string, LocalDate>();
    const position = async (id: string) => {
      const previous = positions.get(id);
      if (previous) return previous;
      charge();
      const result = await reader.readInventoryPosition(id);
      sameHead(result);
      requireLedger(result.id === id, "owned_preparation_position_mismatch");
      if (result.current.disposition === "present") {
        requireLedger(
          result.current.current.encoded !== null,
          "owned_preparation_position_mismatch",
        );
        retain(new TextEncoder().encode(result.current.current.encoded).length);
      }
      if (result.disposition === "owned") {
        retain(
          canonicalEncode(canonicalAccountingValue(result.anchor)).byteLength +
            canonicalEncode(canonicalAccountingValue(result.position)).byteLength,
        );
        charge();
        const source = await reader.readInventoryIdentity(
          "movement",
          result.position.originMovementId,
        );
        sameHead(source);
        requireLedger(
          source.disposition === "present" &&
            contentHashEquals(
              hashCanonical(canonicalAccountingValue(source.row.afterPosition)),
              hashCanonical(canonicalAccountingValue(result.position)),
            ),
          "owned_preparation_position_mismatch",
        );
        movementDates.set(id, source.row.accountingDate);
      }
      positions.set(id, result);
      return result;
    };
    for (const pool of pools.pools)
      if (pool.disposition === "resolved")
        for (const entry of pool.entries) {
          const source = await position(entry.holding.id);
          requireLedger(
            source.current.disposition === "present" &&
              source.current.current.rowHash === entry.holdingRowHash,
            "owned_preparation_pool_mismatch",
          );
        }
    const money = new Map<string, Awaited<ReturnType<typeof reader.readInventoryMoneyScope>>>();
    const readMoney = async (
      accountId: Parameters<typeof reader.readInventoryMoneyScope>[0]["accountId"],
      dimensions: Parameters<typeof reader.readInventoryMoneyScope>[0]["dimensionMemberIds"],
    ) => {
      const scope = {
        bookId: command.bookId,
        accountId,
        dimensionMemberIds: dimensions,
        functionalCommodityId: basis.header.identity.functionalCommodityId,
      };
      const key = JSON.stringify(moneyScopeValues(scope));
      if (money.has(key)) return;
      charge();
      const result = await reader.readInventoryMoneyScope(scope);
      sameHead(result);
      requireLedger(
        JSON.stringify(moneyScopeValues(result.scope)) === key,
        "owned_preparation_scope_mismatch",
      );
      money.set(key, result);
    };
    const acquisitionAccounts = new Set<string>();
    for (const operation of command.request.operations) {
      await claim("operation", operation.id);
      await readMoney(operation.coordinate.accountId, operation.coordinate.dimensionMemberIds);
      if (operation.postingLink) await claim("postingReference", operation.postingLink.referenceId);
      if (operation.kind === "acquisition") {
        acquisitionAccounts.add(operation.coordinate.accountId);
        for (const entry of operation.entries) {
          await claim("lot", entry.lot.id);
          await claim("holding", entry.holding.id);
          await claim("anchor", entry.anchorId);
          await claim("movement", entry.movementId);
        }
      } else if (operation.kind === "issue") {
        for (const identity of operation.identities) {
          await claim("allocation", identity.allocationId);
          await claim("movement", identity.movementId);
        }
      } else if (operation.kind === "transfer") {
        acquisitionAccounts.add(operation.destinationCoordinate.accountId);
        if (operation.destinationPostingLink) {
          await claim("postingReference", operation.destinationPostingLink.referenceId);
        }
        await readMoney(
          operation.destinationCoordinate.accountId,
          operation.destinationCoordinate.dimensionMemberIds,
        );
        for (const entry of operation.entries) {
          await claim("allocation", entry.allocationId);
          await claim("movement", entry.transferOutMovementId);
          await claim("anchor", entry.destinationAnchorId);
          await claim("movement", entry.destinationMovementId);
          await claim("lot", entry.destinationLotId);
          await claim("holding", entry.destinationHoldingId);
        }
      } else if (operation.kind === "adopt") {
        acquisitionAccounts.add(operation.coordinate.accountId);
        for (const entry of operation.entries) {
          await claim("anchor", entry.anchorId);
          await claim("movement", entry.movementId);
          for (const post of entry.historicalPostings) {
            await claim("postingReference", post.id);
          }
        }
      }
    }
    const unownedAccounts = new Set<string>();
    let scannedAcquisitionHoldings = 0;
    for (const account of acquisitionAccounts) {
      const cursor = await reader.openGroup("holdingsByAccount", [account]);
      let consumed = 0n,
        population: bigint | undefined,
        memberHash: string | null | undefined;
      try {
        while (true) {
          const page = await cursor.next();
          sameHead(page);
          requireLedger(
            page.key.kind === "holdingsByAccount" &&
              page.key.values.length === 1 &&
              page.key.values[0] === account &&
              (population === undefined || population === page.population) &&
              (memberHash === undefined || memberHash === page.memberHash),
            "owned_preparation_account_mismatch",
          );
          population = page.population;
          memberHash = page.memberHash;
          for (const member of page.rows) {
            requireLedger(
              ++scannedAcquisitionHoldings <= ACCOUNTING_LIMITS.maxInventoryLayers &&
                member.row.accountId === account,
              "owned_preparation_account_limit",
            );
            if (!member.row.remainingQuantity.isZero()) {
              const source = await position(member.row.id);
              requireLedger(
                source.current.disposition === "present" &&
                  source.current.current.rowHash === member.rowHash,
                "owned_preparation_pool_mismatch",
              );
              if (source.disposition === "unowned") unownedAccounts.add(account);
            }
            consumed++;
          }
          requireLedger(
            consumed === page.consumed &&
              consumed <= page.population &&
              (page.complete
                ? consumed === page.population
                : page.rows.length > 0 && consumed < page.population),
            "owned_preparation_account_mismatch",
          );
          if (page.complete) break;
        }
      } finally {
        await cursor.close();
      }
    }
    const journalIds = new Map<string, "present" | "absent">();
    const postingIds = new Map<string, "present" | "absent">();
    for (const resolved of command.request.resolvedJournals) {
      for (const [family, id, target] of [
        ["journal", resolved.journal.id, journalIds] as const,
        ...resolved.journal.postings.map((posting) => ["posting", posting.id, postingIds] as const),
      ])
        if (!target.has(id)) {
          charge();
          const result = await reader.readJournalIdentity(family, id);
          sameHead(result);
          requireLedger(
            result.family === family &&
              result.id === id &&
              (result.disposition === "present" || result.disposition === "absent"),
            "owned_preparation_identity_mismatch",
          );
          target.set(id, result.disposition);
        }
      for (const posting of resolved.journal.postings)
        await readMoney(posting.accountId, posting.dimensionMemberIds);
    }
    const required = <T>(value: T | undefined): T => {
      requireLedger(value !== undefined, "owned_preparation_dependency_missing");
      return value;
    };
    const scopes = (scope: Parameters<BookOwnedInventoryReadContext["managedMoneyScope"]>[0]) =>
      required(money.get(JSON.stringify(moneyScopeValues(scope))));
    let active = true;
    const context: BookOwnedInventoryReadContext = {
      ...basis.header,
      ...config,
      executionProfile: config.executionProfile,
      ...(basis.openingBoundary === null ? {} : { openingBoundary: basis.openingBoundary.row }),
      periodStatus: (id) =>
        required(admission.periods.find((period) => period.periodId === id)).closed
          ? "closed"
          : "open",
      journalIdentity: (id) => required(journalIds.get(id)),
      postingIdentity: (id) => required(postingIds.get(id)),
      hasLiveUnownedStock: (accounts) => [...accounts].some((id) => unownedAccounts.has(id)),
      postedMoneyBalance: (scope) => scopes(scope).postedBalance,
      managedMoneyScope: (scope) => scopes(scope).ownership,
      identityPresence: (kind, id) => required(identities.get(identityKey(kind, id))),
      latestMovementDate: (id) => required(movementDates.get(id)),
      readPool: (policy, commodity) => {
        const pool = pools.pools.find(
          (value) =>
            value.inventoryCommodityId === commodity &&
            value.policyReference.policyId === policy.id &&
            value.policyReference.policyVersion === policy.version &&
            contentHashEquals(
              value.policyReference.policyContentHash,
              hashAccountingPolicy(policy),
            ),
        );
        requireLedger(pool?.disposition === "resolved", "owned_preparation_dependency_missing");
        return pool.entries;
      },
      ownership: {
        bookId: command.bookId,
        bookRevision: basis.header.bookRevision,
        assertCurrent: () => requireLedger(active, "owned_preparation_context_retired"),
        readCurrentHolding: (id) => {
          const source = required(positions.get(id));
          return source.current.disposition === "present" ? source.current.current.row : undefined;
        },
        readCurrentPosition: (id) => required(positions.get(id)).position ?? undefined,
        readAnchor: (reference) =>
          [...positions.values()].find(
            (source) =>
              source.anchor !== null &&
              source.anchor.id === reference.id &&
              source.anchor.effectKey === reference.effectKey &&
              source.anchor.artifactOrdinal === reference.artifactOrdinal &&
              source.anchor.bookRevision === reference.bookRevision &&
              contentHashEquals(source.anchor.contentHash, reference.contentHash),
          )?.anchor ?? undefined,
        readPositionAfterImage: (origin) =>
          [...positions.values()].find(
            ({ position: value }) =>
              value !== null &&
              origin.bookId === command.bookId &&
              value.originMovementId === origin.movementId &&
              value.originEffectKey === origin.effectKey &&
              value.originArtifactOrdinal === origin.artifactOrdinal &&
              value.originBookRevision === origin.bookRevision,
          )?.position ?? undefined,
      },
    };
    sameHead(await reader.readBookBasis());
    let preparation: ReturnType<typeof prepareBookOwnedInventory>;
    try {
      preparation = prepareBookOwnedInventory(context, command);
    } finally {
      active = false;
    }
    sameHead(await reader.readBookBasis());
    return Object.freeze({
      disposition: "prepared" as const,
      commandId: command.id,
      commandInputHash: command.inputHash,
      basis,
      preparation,
      reads,
      scannedAcquisitionHoldings,
      retainedSourceBytes,
    });
  } catch (error) {
    await reader.close();
    throw error;
  }
}
