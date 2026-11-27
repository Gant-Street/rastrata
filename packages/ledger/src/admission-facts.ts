import {
  commandInputHash,
  requiresRemeasurementReversal,
  type BookCommand,
  type FiscalPeriodId,
} from "@rastrata/kernel";
import type { PinnedBookBasis } from "./book-basis.ts";
import type { GroupMember, PinnedGroupCursor } from "./group-reader.ts";
import type { SemanticGroupKind } from "./semantic-groups.ts";
import { requireLedger } from "./records.ts";

export interface PinnedAdmissionFacts {
  readonly commandId: BookCommand["id"];
  readonly commandInputHash: BookCommand["inputHash"];
  readonly basis: PinnedBookBasis;
  readonly periods: readonly {
    readonly periodId: FiscalPeriodId;
    readonly closed: boolean;
    readonly transitionCount: bigint;
    readonly lastTransition: {
      readonly ordinal: bigint;
      readonly rowHash: string;
      readonly kind: "close" | "reopen";
    } | null;
  }[];
  readonly overdueRemeasurement: GroupMember<"unrealizedByPolicy"> | null;
}
interface Ports {
  readonly basis: () => Promise<PinnedBookBasis>;
  readonly openGroup: <K extends SemanticGroupKind>(
    kind: K,
    values: readonly string[],
  ) => Promise<PinnedGroupCursor<K>>;
  readonly confirm: () => Promise<void>;
}
/** Owner-serialized factual reads, NOT command admission. Retry/input/timeline,
 * policy validity and command-specific checks retain their kernel ordering. */
export async function readPinnedAdmissionFacts(
  command: BookCommand,
  ports: Ports,
): Promise<PinnedAdmissionFacts> {
  const basis = await ports.basis();
  requireLedger(command.bookId === basis.header.identity.bookId, "ledger_identity_mismatch");
  const periods: PinnedAdmissionFacts["periods"][number][] = [];
  async function fold<K extends SemanticGroupKind>(
    kind: K,
    values: readonly string[],
    consume: (row: GroupMember<K>) => Promise<void>,
  ): Promise<bigint> {
    const cursor = await ports.openGroup(kind, values);
    try {
      while (true) {
        const page = await cursor.next();
        requireLedger(
          page.headHash === basis.headHash && page.catalogDigest === basis.catalogDigest,
          "admission_facts_view_mismatch",
        );
        for (const row of page.rows) await consume(row);
        if (page.complete) return page.consumed;
      }
    } finally {
      await cursor.close();
    }
  }
  for (const period of basis.configuration.row.periods) {
    let last: PinnedAdmissionFacts["periods"][number]["lastTransition"] = null;
    const transitionCount = await fold("transitionsByPeriod", [period.id], async (row) => {
      last = Object.freeze({ ordinal: row.ordinal, rowHash: row.rowHash, kind: row.row.kind });
    });
    const lastTransition = last as PinnedAdmissionFacts["periods"][number]["lastTransition"];
    periods.push(
      Object.freeze({
        periodId: period.id,
        closed: lastTransition?.kind === "close",
        transitionCount,
        lastTransition,
      }),
    );
  }
  // The legacy kernel selects the FIRST current currency policy with this ID,
  // not the policy embedded in an old result and not the latest version by sort.
  const seen = new Set<string>();
  let overdue: GroupMember<"unrealizedByPolicy"> | null = null;
  for (const policy of basis.configuration.row.accountingPolicySnapshot.policies) {
    if (policy.kind !== "currencyRemeasurement" || seen.has(policy.id)) continue;
    seen.add(policy.id);
    if (!policy.reversalRequired) continue;
    await fold("unrealizedByPolicy", [policy.id], async (result) => {
      if (!requiresRemeasurementReversal(command, result.row, policy)) return;
      const reversals = await fold("reversalsByOriginalResult", [result.row.id], async () => {});
      if (reversals === 0n && (overdue === null || result.ordinal < overdue.ordinal))
        overdue = result;
    });
  }
  await ports.confirm();
  return Object.freeze({
    commandId: command.id,
    commandInputHash: commandInputHash(command),
    basis,
    periods: Object.freeze(periods),
    overdueRemeasurement: overdue,
  });
}
