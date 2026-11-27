import {
  createBookState,
  decodeDurableBook,
  sealCommand,
  semanticVersion,
  type BookCommand,
  type DurableBookAggregate,
  ExactRational,
  commandId,
  identifier,
  lotId,
  lotHoldingId,
  lotAllocationId,
} from "@rastrata/kernel";

/** Pinned pre-native paid acquisition/issue history; only the explicitly new
 * effect/pool version changes. Tests reexecute, never copy its final balances. */
export async function nativeInventoryWorkflow(encoded?: string) {
  const decoded = decodeDurableBook(
    encoded ??
      (await Bun.file(
        new URL("./data/owned-inventory-preparation-baseline.json", import.meta.url),
      ).text()),
  );
  if (decoded.disposition !== "decoded") throw new Error("Invalid pinned inventory fixture");
  const state = decoded.aggregate.state,
    configuration = state.configurationSnapshots[0];
  if (!configuration) throw new Error("Missing initial configuration");
  const initial: DurableBookAggregate = {
    state: createBookState(
      state.identity,
      configuration.periods,
      configuration.admissionSnapshot,
      configuration.policies,
      configuration.quantizationPolicies,
      configuration.accountingPolicySnapshot.policies,
      configuration.effectiveAt,
      configuration.executionProfile,
    ),
    protocol: { retainedResults: [] },
  };
  const commands: BookCommand[] = state.revisions.map((revision) =>
    revision.command.type === "postOwnedInventoryTransaction"
      ? sealCommand({
          ...revision.command,
          request: { ...revision.command.request, algorithmVersion: semanticVersion("1.2.0") },
        })
      : revision.command,
  );
  return { initial, commands };
}

export function freeInventoryCycle(
  commands: readonly BookCommand[],
  prefix: string,
  revision: bigint,
) {
  const acquire = commands[1],
    issue = commands[2];
  if (
    acquire?.type !== "postOwnedInventoryTransaction" ||
    issue?.type !== "postOwnedInventoryTransaction"
  )
    throw new Error("Missing owned fixture");
  const acquisition = acquire.request.operations[0],
    disposal = issue.request.operations[0];
  if (acquisition?.kind !== "acquisition" || disposal?.kind !== "issue")
    throw new Error("Invalid owned operations");
  const { postingLink: acquisitionLink, ...acquisitionBase } = acquisition;
  const { postingLink: disposalLink, ...disposalBase } = disposal;
  void acquisitionLink;
  void disposalLink;
  const entries = acquisition.entries.map((entry, index) => ({
    ...entry,
    anchorId: identifier<"InventoryPostedAnchor">(`${prefix}-anchor-${index}`),
    movementId: identifier<"InventoryPostedMovement">(`${prefix}-acquire-${index}`),
    lot: {
      ...entry.lot,
      id: lotId(`${prefix}-lot-${index}`),
      acquisitionTotalBasis: ExactRational.zero(),
    },
    holding: {
      ...entry.holding,
      id: lotHoldingId(`${prefix}-holding-${index}`),
      lotId: lotId(`${prefix}-lot-${index}`),
      remainingTotalBasis: ExactRational.zero(),
      remainingValuationAllowance: ExactRational.zero(),
      remainingCarryingAmount: ExactRational.zero(),
    },
  }));
  return [
    sealCommand({
      ...acquire,
      id: commandId(`${prefix}-acquisition`),
      expectedBookRevision: revision,
      request: {
        ...acquire.request,
        resolvedJournals: [],
        operations: [
          {
            ...acquisitionBase,
            id: identifier<"InventoryOperation">(`${prefix}-acquisition`),
            entries,
          },
        ],
      },
    }),
    sealCommand({
      ...issue,
      id: commandId(`${prefix}-issue`),
      expectedBookRevision: revision + 1n,
      request: {
        ...issue.request,
        resolvedJournals: [],
        operations: [
          {
            ...disposalBase,
            id: identifier<"InventoryOperation">(`${prefix}-issue`),
            identities: entries.map((entry, index) => ({
              holdingId: entry.holding.id,
              allocationId: lotAllocationId(`${prefix}-allocation-${index}`),
              movementId: identifier<"InventoryPostedMovement">(`${prefix}-issue-${index}`),
            })),
          },
        ],
      },
    }),
  ] as const;
}
