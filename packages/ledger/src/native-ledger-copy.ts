import { decodeBookOutcome, encodeBookOutcome } from "@rastrata/kernel";
import { NativeLedger } from "./native-ledger.ts";
import { decodeAggregate, requireLedger } from "./records.ts";
import type {
  NativeLedgerHead,
  NativeFactPage,
  NativeLedgerRepository,
  NativeLedgerReader,
} from "./native-ledger-repository.ts";

const sameHead = (left: NativeLedgerHead, right: NativeLedgerHead) =>
  left.sequence === right.sequence &&
  left.bookRevision === right.bookRevision &&
  left.chainHash === right.chainHash;

function sameFact(
  left: NativeFactPage["facts"][number],
  right: NativeFactPage["facts"][number],
): boolean {
  return (
    left.collection === right.collection &&
    left.key === right.key &&
    left.encoded === right.encoded &&
    left.mutable === right.mutable &&
    left.sourceSequence === right.sourceSequence
  );
}

/** Pages are byte-bounded, not necessarily equal-sized across adapters. Keep
 * just one page per side and compare the ordered facts, not page boundaries. */
async function* factsAtHead(
  source: NativeLedgerReader,
  expected: NativeLedgerHead,
  changed: string,
): AsyncGenerator<NativeFactPage["facts"][number], void> {
  let cursor: string | null = null;
  for (;;) {
    const page = await source.factPage(cursor, 32);
    requireLedger(sameHead(page.observedTip, expected), changed);
    if (page.facts.length === 0) {
      requireLedger(page.nextIdentity === cursor, "native_copy_projection_mismatch");
      return;
    }
    const last = page.facts.at(-1);
    requireLedger(
      last !== undefined &&
        page.nextIdentity !== cursor &&
        page.nextIdentity === JSON.stringify([last.collection, last.key]),
      "native_copy_projection_mismatch",
    );
    yield* page.facts;
    cursor = page.nextIdentity;
  }
}

/** Reexecute every original command into an explicitly supplied empty STAGING
 * repository, then compare every persisted projection and origin sequence.
 * Source must remain at the supplied expected tip. Source writes cause an explicit
 * stale-copy failure, not a claim of corruption or successful restoration.
 * Never selects a production catalog generation or overwrites an existing ledger.
 * Restore authorization/fencing and archive delivery are separate release gates.
 * On failure the caller must keep the partial staging target unavailable. */
export async function verifyNativeLedgerCopy(
  source: NativeLedgerReader,
  target: NativeLedgerRepository & NativeLedgerReader,
  expectedSourceTip: NativeLedgerHead,
): Promise<{
  readonly sourceHead: NativeLedgerHead;
  readonly targetHead: NativeLedgerHead;
  readonly verifiedFacts: number;
}> {
  const expected = Object.freeze({ ...expectedSourceTip });
  requireLedger(
    source.scope.bookId === target.scope.bookId &&
      source.scope.tenantId === target.scope.tenantId &&
      JSON.stringify(source.scope) !== JSON.stringify(target.scope),
    "native_copy_scope_mismatch",
  );
  // Export pages already enforce the byte cap, including compressed outcomes.
  // Paging never holds a book transaction across an await or monopolizes its
  // queue for a full-history loop.
  let page = await source.outcomePage(null, 16);
  requireLedger(sameHead(page.observedTip, expected), "native_copy_source_changed");
  const initial = decodeAggregate(page.genesis);
  const first = page.outcomes[0];
  requireLedger(
    first &&
      first.payload.command.type === "activateBook" &&
      first.payload.originalResult.disposition === "committed",
    "native_copy_activation_missing",
  );
  const emptyHead = await target.provision(page.genesis);
  requireLedger(emptyHead.sequence === "0", "native_copy_target_not_empty");
  const ledger = new NativeLedger(target);
  await ledger.provision(initial, first.payload.command);
  let targetCursor: NativeLedgerHead | null = null;
  while (true) {
    requireLedger(sameHead(page.observedTip, expected), "native_copy_source_changed");
    for (const outcome of page.outcomes) {
      if (outcome.head.sequence !== "1") await ledger.execute(outcome.payload.command);
      const copy = await target.outcomePage(targetCursor, 1);
      const copied = copy.outcomes[0];
      requireLedger(
        copied &&
          copied.encoded === outcome.encoded &&
          copied.head.sequence === outcome.head.sequence &&
          copied.head.bookRevision === outcome.head.bookRevision,
        "native_copy_accounting_mismatch",
      );
      // Codec closure is checked independently of receipt equality. Projection
      // comparison below catches missing/extra state, not only retained receipts.
      const decoded = decodeBookOutcome(copied.encoded);
      requireLedger(
        decoded.disposition === "decoded" && encodeBookOutcome(decoded.payload) === outcome.encoded,
        "native_copy_accounting_mismatch",
      );
      targetCursor = copied.head;
    }
    if (sameHead(page.through, expected)) break;
    page = await source.outcomePage(page.through, 16);
  }
  requireLedger(targetCursor !== null, "native_copy_activation_missing");
  const targetHead = targetCursor;
  let verifiedFacts = 0;
  const originals = factsAtHead(source, expected, "native_copy_source_changed");
  const copies = factsAtHead(target, targetHead, "native_copy_target_changed");
  try {
    for (;;) {
      const [original, copy] = await Promise.all([originals.next(), copies.next()]);
      requireLedger(original.done === copy.done, "native_copy_projection_mismatch");
      if (original.done) break;
      requireLedger(
        !copy.done && sameFact(original.value, copy.value),
        "native_copy_projection_mismatch",
      );
      verifiedFacts++;
    }
  } finally {
    // Settle both readers even if one failed while its peer awaited a page.
    await Promise.all([originals.return(), copies.return()]);
  }
  const [final, finalTarget] = await Promise.all([
    source.outcomePage(expected, 1),
    target.outcomePage(targetHead, 1),
  ]);
  requireLedger(
    sameHead(final.observedTip, expected) && final.outcomes.length === 0,
    "native_copy_source_changed",
  );
  requireLedger(
    sameHead(finalTarget.observedTip, targetHead) && finalTarget.outcomes.length === 0,
    "native_copy_target_changed",
  );
  return Object.freeze({ sourceHead: expected, targetHead, verifiedFacts });
}
