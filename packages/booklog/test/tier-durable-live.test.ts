import { test } from "bun:test";
import { DurableObjectLogTier } from "../src/tier-durable.ts";
import { checkRestoration, tierConformance } from "./support/tier-conformance.ts";

/** Runs only when a Durable Object tail Worker is named: apps/tail-worker, served locally
 *   cd apps/tail-worker && bun run dev --port 8799 --var TOKEN_SHA256S:<sha256 of the token>
 *   BOOKLOG_DO_URL=http://127.0.0.1:8799 BOOKLOG_DO_TOKEN=<token> bun test test/tier-durable-live.test.ts
 * or deployed. The tail's own clock is the object's, so the contract suite's leases run in real time.
 * (apps/tail-worker runs the same suite under Miniflare in every test run, on a virtual clock.) */
const baseUrl = process.env.BOOKLOG_DO_URL;
const token = process.env.BOOKLOG_DO_TOKEN;

if (!baseUrl) {
  test.skip("DurableObjectLogTier: set BOOKLOG_DO_URL to run it against a Durable Object tail Worker", () => {});
} else {
  const tier = new DurableObjectLogTier({ baseUrl, ...(token ? { token } : {}) });
  tierConformance("DurableObjectLogTier (Worker)", () => ({
    tier,
    trims: true,
    advance: async (ms) => {
      await Bun.sleep(ms);
    },
  }));
  test("a tail that lost a book is given a head at the newest sealed entry, once", async () => {
    await checkRestoration(tier);
  });
}
