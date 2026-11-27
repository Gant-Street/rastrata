import { expect, test } from "bun:test";
import { inventoryCostLayersMatch, accountId, instant, ExactRational, type InventoryLayerInput } from "../src/index.ts";

test("inventory population comparison is exact, complete and non-mutating", () => {
  const first: InventoryLayerInput = Object.freeze({ id: "z", accountId: accountId("stock"), acquiredAt: instant("2026-01-01T00:00:00Z"), quantity: ExactRational.of(2n, 1n), totalBasis: ExactRational.of(7n, 1n) });
  const second = Object.freeze({ ...first, id: "a" });
  const canonical = Object.freeze([first, second]);
  const supplied = Object.freeze([second, first]);
  expect(inventoryCostLayersMatch(canonical, supplied)).toBeTrue();
  expect(canonical.map((l) => l.id)).toEqual(["z", "a"]);
  expect(supplied.map((l) => l.id)).toEqual(["a", "z"]);
  expect(inventoryCostLayersMatch([], [])).toBeTrue();
  expect(inventoryCostLayersMatch(canonical, [])).toBeFalse();
  expect(inventoryCostLayersMatch(canonical, [first])).toBeFalse();
  expect(inventoryCostLayersMatch([first], canonical)).toBeFalse();
  for (const changed of [
    { ...first, id: "other" }, { ...first, accountId: accountId("other") },
    { ...first, acquiredAt: instant("2026-01-02T00:00:00Z") },
    { ...first, quantity: ExactRational.of(1n, 1n) }, { ...first, totalBasis: ExactRational.of(8n, 1n) },
  ]) expect(inventoryCostLayersMatch(canonical, [second, changed])).toBeFalse();
});
