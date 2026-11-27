import { expect, test } from "bun:test";
import { ownedAnchorCase, ownedCommandCase } from "./owned-inventory-case-executors.ts";

const valid = { quantity: "3/1", algorithm_version: "1.2.0" };

test("inventory design executors distinguish valid command controls from hostile inputs", () => {
  const admitted = ownedCommandCase(valid);
  expect(admitted.outcome).toBe("admit");
  expect(admitted.facts).toEqual({ revision_delta: 1, posting_sequence_delta: 0, journal_count: 0,
    quantity_only_movements: 1, remaining_quantity: "3/1", durable_retry_identical: true });
  expect(ownedCommandCase({ ...valid, quantity: "7/2" }).facts.remaining_quantity).toBe("7/2");
  for (const [input, path] of [
    [{ ...valid, fake_posting_id: "invented-posting" }, "ownedInventory.postingLink"],
    [{ ...valid, algorithm_version: "9.0.0" }, "ownedInventory.request"],
  ] as const) {
    const rejected = ownedCommandCase(input);
    expect(rejected.outcome).toBe("reject");
    expect(rejected.facts).toMatchObject({ diagnostic: "inventory_cost_policy_incoherent", diagnostic_path: path,
      revision_delta: 0, posting_sequence_delta: 0, journal_count: 0, quantity_only_movements: 0,
      remaining_quantity: null, durable_retry_identical: true });
  }
});

test("rehashing a proposed posted budget cannot replace a committed source anchor", () => {
  expect(ownedAnchorCase({ ...valid, proposed_posted_budget: "0.00" }).outcome).toBe("admit");
  expect(ownedAnchorCase({ ...valid, proposed_posted_budget: "1.00" })).toEqual({ outcome: "reject", facts: {
    diagnostic: "lot_overallocation", diagnostic_path: "inventoryOwnership.anchorSource",
    revision_delta: 0, posting_sequence_delta: 0, original_posted_budget: "0.00", proposed_posted_budget: "1.00",
  } });
});
