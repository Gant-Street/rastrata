// Destructive fault injection exists only in this local test entrypoint.
import { LedgerBook as ProductionBook } from "../src/book.ts";
import { createHash } from "node:crypto";
import {
  SqliteLedgerRepository,
  type CompleteBookScope,
  type NativeRecoveryEvidence,
} from "@rastrata/ledger";
export { default, LedgerCatalog } from "../src/index.ts";
export class LedgerBook extends ProductionBook {
  async captureRecoveryEvidence(
    scope: CompleteBookScope,
    expectedCatalogHash: string,
    requestId: string,
  ): Promise<NativeRecoveryEvidence> {
    const repository = new SqliteLedgerRepository(this.ctx.storage, scope, scope.objectId, () => ({
      fence: "0",
      pending: false,
    }));
    const source = await repository.outcomePage();
    const sha = (text: string) => createHash("sha256").update(text).digest("hex");
    let digest = sha(
      JSON.stringify(["rastrata-native-projection-audit-v1", scope, source.observedTip]),
    );
    let count = 0,
      after: string | null = null;
    for (let pageIndex = 0; pageIndex < 10; pageIndex++) {
      const page = await repository.factPage(after);
      if (JSON.stringify(page.observedTip) !== JSON.stringify(source.observedTip))
        throw new Error("Snapshot changed");
      for (const fact of page.facts) {
        digest = sha(JSON.stringify(["rastrata-native-projection-audit-v1", digest, fact]));
        count++;
      }
      if (page.facts.length === 0) {
        const access = this.ctx.storage.sql
          .exec<{ revision: string }>("SELECT revision FROM ledger_native_access WHERE singleton=1")
          .one();
        return {
          scope,
          requestId,
          expectedCatalogHash,
          evidenceId: `snapshot-${source.observedTip.chainHash}`,
          approvedBy: "actor",
          genesisHash: sha(source.genesis),
          head: source.observedTip,
          projection: { count: String(count), digest },
          authorizationRevision: access.revision,
        };
      }
      after = page.nextIdentity;
    }
    throw new Error("Snapshot fixture exceeds bounded capture budget");
  }
  async simulatePrimaryLoss() {
    await this.ctx.storage.deleteAll();
  }
  async deliverArchiveAlarm() {
    await super.alarm();
  }
}
