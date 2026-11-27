import { expect, test } from "bun:test";
import {
  commandId,
  executeBookCommand,
  instant,
  rebuildAccountBalanceProjection,
  sealCommand,
  semanticVersion,
} from "../src/index.ts";
import { IDS, freshState } from "./fixtures.ts";

test("rejects a broken revision hash chain rather than rebuilding a plausible projection (I20)", () => {
  const fresh = freshState();
  const activated = executeBookCommand(
    fresh.state,
    fresh.protocol,
    sealCommand({
      id: commandId("projection-activation"),
      type: "activateBook",
      protocolVersion: semanticVersion("1.0.0"),
      bookId: IDS.book,
      expectedBookRevision: 0n,
      issuedAt: instant("2026-01-01T00:00:00Z"),
      completedAt: instant("2026-01-01T00:00:01Z"),
      committedAt: instant("2026-01-01T00:00:02Z"),
      actorId: IDS.actor,
      mode: "newZeroBalance",
      boundaryId: IDS.boundary,
      firstAccountingDate: fresh.state.periods[0]!.startsOn,
    }),
  );
  const revision = activated.state.revisions[0]!;
  const corrupted = Object.freeze({ ...revision, bookRevision: 2n });
  const result = rebuildAccountBalanceProjection([corrupted]);
  expect(result.disposition).toBe("rejected");
  if (result.disposition === "rejected") {
    expect(result.diagnostics[0]?.code).toBe("projection_rebuild_mismatch");
  }
});
