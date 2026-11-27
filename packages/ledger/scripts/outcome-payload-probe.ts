import assert from "node:assert/strict";
import { Database } from "bun:sqlite";
import { arch, platform } from "node:os";
import { encodeDurableBook, ExactRational, type DurableBookAggregate } from "@rastrata/kernel";
import { evaluateOutcomePayload, replayOutcomePayload } from "../src/outcome-payload.ts";
import { activation, genesis, posting, CASH } from "../test/fixtures.ts";

/** Isolated representation comparison, not the deployed ledger or a durable
 * storage benchmark. Both byte populations are stored in one in-memory SQLite DB. */
export function probeOutcomePayloads(sales = 100) {
  assert.ok(Number.isInteger(sales) && sales >= 1 && sales <= 500, "probe sales budget");
  const db = new Database(":memory:");
  const started = performance.now();
  const checkpoints: {
    sales: number;
    snapshotBytes: number;
    outcomeBytes: number;
    totalSnapshotBytes: number;
    totalOutcomeBytes: number;
  }[] = [];
  let completedSales = 0,
    outcomes = 0,
    totalSnapshotBytes = 0,
    totalOutcomeBytes = 0;
  try {
    db.exec(
      "CREATE TABLE probe_outcomes (sequence INTEGER PRIMARY KEY, snapshot TEXT NOT NULL, outcome TEXT NOT NULL)",
    );
    let current: DurableBookAggregate = genesis();
    let finalSnapshot = "";
    for (let sale = 0; sale <= sales; sale++) {
      assert.ok(performance.now() - started <= 60_000, "probe time budget");
      const command =
        sale === 0 ? activation() : posting(`payload-sale-${sale}`, current.state.bookRevision);
      const evaluated = evaluateOutcomePayload(current, command);
      assert.equal(evaluated.transition.result.disposition, "committed");
      assert.ok(evaluated.encoded !== null);
      current = { state: evaluated.transition.state, protocol: evaluated.transition.protocol };
      finalSnapshot = encodeDurableBook(current);
      const snapshotBytes = new TextEncoder().encode(finalSnapshot).length;
      const outcomeBytes = new TextEncoder().encode(evaluated.encoded).length;
      db.query("INSERT INTO probe_outcomes VALUES (?, ?, ?)").run(
        sale + 1,
        finalSnapshot,
        evaluated.encoded,
      );
      outcomes++;
      completedSales = sale;
      totalSnapshotBytes += snapshotBytes;
      totalOutcomeBytes += outcomeBytes;
      if (sale === 0 || sale === 10 || sale === 50 || sale === sales)
        checkpoints.push({
          sales: sale,
          snapshotBytes,
          outcomeBytes,
          totalSnapshotBytes,
          totalOutcomeBytes,
        });
    }
    const replayStarted = performance.now();
    let restored: DurableBookAggregate = genesis(),
      replayed = 0;
    for (const row of db
      .query("SELECT sequence, outcome FROM probe_outcomes ORDER BY sequence")
      .iterate() as Iterable<{ sequence: number; outcome: string }>) {
      assert.ok(performance.now() - started <= 60_000, "probe time budget");
      assert.equal(row.sequence, replayed + 1);
      const next = replayOutcomePayload(restored, row.outcome);
      restored = { state: next.state, protocol: next.protocol };
      replayed++;
    }
    assert.equal(replayed, outcomes);
    assert.equal(encodeDurableBook(restored), finalSnapshot);
    const cash = restored.state.journals
      .flatMap((journal) => journal.journal.postings)
      .filter((item) => item.accountId === CASH)
      .reduce((sum, item) => sum.add(item.bookValue.amount.toRational()), ExactRational.zero());
    assert.equal(cash.toString(), `${sales * 100}/1`);
    assert.equal(restored.state.journals.length, sales);
    return {
      status: "complete" as const,
      sales: completedSales,
      outcomes,
      checkpoints,
      totalSnapshotBytes,
      totalOutcomeBytes,
      byteReductionRatio: totalSnapshotBytes / totalOutcomeBytes,
      finalSnapshotBytes: new TextEncoder().encode(finalSnapshot).length,
      exactFinalSnapshotReplay: true,
      cashBalance: cash.toString(),
      replayMs: performance.now() - replayStarted,
      elapsedMs: performance.now() - started,
      bun: Bun.version,
      sqlite: db.query("SELECT sqlite_version() AS version").get(),
      platform: platform(),
      arch: arch(),
      limitations:
        "in-memory SQLite representation comparison; no production adapter, outer head/chunk framing, indexes, archive durability, indexed kernel, or inventory scaling",
    };
  } catch (error) {
    return {
      status: "failed" as const,
      sales: completedSales,
      outcomes,
      checkpoints,
      totalSnapshotBytes,
      totalOutcomeBytes,
      error: error instanceof Error ? error.message : String(error),
    };
  } finally {
    db.close();
  }
}

if (import.meta.main) {
  const result = probeOutcomePayloads();
  process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
  if (result.status !== "complete") process.exitCode = 1;
}
