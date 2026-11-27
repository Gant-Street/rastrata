import { expect, test } from "bun:test";
import {
  ExactDecimal as D, ExactRational as R, quantizeCumulativePostedShare,
  quantizationPolicyId, semanticVersion, localDate,
  decodeDurableBook, encodeDurableBook, executeBookCommand,
  type QuantizationPolicy, type RoundingMode, type DurableBookAggregate,
  MAX_DECIMAL_SCALE,
} from "../src/index.ts";
import { IDS } from "./fixtures.ts";
import legacy from "./data/inventory-rounding-legacy.json";

const policy: QuantizationPolicy = {
  id: quantizationPolicyId("posted-share-policy"), version: semanticVersion("1.0.0"),
  bookId: IDS.book, functionalCommodityId: IDS.usd, validFrom: localDate("2020-01-01"),
  targetScale: 2n, roundingMode: "halfEven", roundingAccountId: IDS.cash,
};
const zero = R.zero();
const one = R.of(1n, 1n);
function share(total: string, before: R, after: R, selected = policy) {
  const result = quantizeCumulativePostedShare(D.parse(total), before, after, selected);
  if (result.disposition !== "quantized") throw new Error(JSON.stringify(result.diagnostics));
  return result.share;
}

test("cumulative posted shares allocate the actual eight posted units exactly across thirds", () => {
  const shares = [0n, 1n, 2n].map((n) => share("8.00", R.of(n, 3n), R.of(n + 1n, 3n)));
  expect(shares.map((s) => s.postedAmount.toString())).toEqual(["2.67", "2.66", "2.67"]);
  expect(shares.map((s) => s.afterQuantization.amount.toString())).toEqual(["2.67", "5.33", "8.00"]);
  expect(shares.map((s) => s.afterQuantization.residual.toString())).toEqual(["-1/300", "1/300", "0/1"]);
  expect(shares.reduce((sum, s) => sum.add(s.postedAmount.toRational()), zero).toString()).toBe("8/1");
  expect(share("0.00", zero, one).postedAmount.toString()).toBe("0.00");
  expect(share("8.00", R.of(1n, 3n), R.of(1n, 3n)).postedAmount.toString()).toBe("0.00");
  // Positive physical consumption can have zero posted value, even at final
  // depletion. Integration needs a quantity-only effect, not a zero GL posting.
  const pennies = [0n, 1n, 2n].map((n) => share("0.01", R.of(n, 3n), R.of(n + 1n, 3n)));
  expect(pennies.map((s) => s.postedAmount.toString())).toEqual(["0.00", "0.01", "0.00"]);
  expect(pennies.map((s) => s.afterQuantization.amount.toString())).toEqual(["0.00", "0.01", "0.01"]);
  // Two posted acquisitions of 0.02 each may have total economic basis 0.03.
  // Full disposal must consume their actual 0.04, not a rerounded exact basis.
  expect(share("0.04", zero, one).postedAmount.toString()).toBe("0.04");
  const moved = share("0.04", zero, R.of(1n, 2n)).postedAmount;
  expect(moved.toString()).toBe("0.02");
  expect(share(moved.toString(), zero, one).postedAmount.toString()).toBe("0.02");
  const selected = { ...policy };
  const immutable = share("0.010", zero, one, selected);
  selected.targetScale = 0n;
  expect(immutable.postedTotal.toString()).toBe("0.01");
  expect(immutable.policy.targetScale).toBe(2n);
  expect(Object.isFrozen(immutable)).toBe(true);
  expect(Object.isFrozen(immutable.policy)).toBe(true);
  expect(Object.isFrozen(immutable.beforeQuantization)).toBe(true);
  expect(Object.isFrozen(immutable.afterQuantization)).toBe(true);
});

// Independent nonnegative integer oracle; never calls the production quantizer.
function roundedUnits(n: bigint, d: bigint, mode: RoundingMode): bigint {
  const q = n / d, r = n % d;
  if (mode === "floor" || mode === "towardZero" || r === 0n) return q;
  if (mode === "ceiling") return q + 1n;
  if (2n * r < d) return q;
  if (2n * r > d) return q + 1n;
  return mode === "halfAwayFromZero" || q % 2n === 1n ? q + 1n : q;
}

test("all rounding modes telescope, preserve subdivision and match an independent integer oracle", () => {
  const modes: RoundingMode[] = ["halfEven", "halfAwayFromZero", "towardZero", "floor", "ceiling"];
  for (const mode of modes) for (const scale of [0n, 2n, 3n]) {
    const selected = { ...policy, roundingMode: mode, targetScale: scale };
    for (const units of [0n, 1n, 2n, 3n, 8n, 101n, 800n]) for (const d of [2n, 3n, 5n, 7n, 11n, 17n]) {
      const total = D.of(units, scale);
      let sum = 0n;
      for (let n = 0n; n < d; n++) {
        const result = quantizeCumulativePostedShare(total, R.of(n, d), R.of(n + 1n, d), selected);
        if (result.disposition !== "quantized") throw new Error("Valid partition rejected");
        const value = result.share;
        const expectedBefore = roundedUnits(units * n, d, mode);
        const expectedAfter = roundedUnits(units * (n + 1n), d, mode);
        expect(value.beforeQuantization.amount.coefficient).toBe(expectedBefore);
        expect(value.afterQuantization.amount.coefficient).toBe(expectedAfter);
        expect(value.postedAmount.coefficient).toBe(expectedAfter - expectedBefore);
        expect(value.postedAmount.scale).toBe(scale);
        expect(value.postedAmount.coefficient >= 0n).toBe(true);
        expect(value.afterTarget.subtract(value.afterQuantization.amount.toRational()).equals(value.afterQuantization.residual)).toBe(true);
        sum += value.postedAmount.coefficient;
        // Any prefix of the fine partition equals its unsplit cumulative share.
        expect(share(total.toString(), zero, R.of(n + 1n, d), selected).postedAmount.coefficient).toBe(sum);
      }
      expect(sum).toBe(units);
    }
  }
});

test("posted shares reject invalid fractions, policy domains and silent rerounding of prior postings", () => {
  for (const [total, before, after, selected] of [
    ["-0.01", zero, one, policy],
    ["1.00", R.of(-1n, 3n), one, policy],
    ["1.00", one, zero, policy],
    ["1.00", zero, R.of(4n, 3n), policy],
    ["1.00", R.of(4n, 3n), R.of(5n, 3n), policy],
    ["1.00", zero, one, { ...policy, targetScale: -1n }],
    ["1.00", zero, one, { ...policy, targetScale: MAX_DECIMAL_SCALE + 1n }],
    ["1.00", zero, one, { ...policy, roundingMode: "unknown" as RoundingMode }],
    ["0.001", zero, one, policy],
    ["1.01", zero, one, { ...policy, targetScale: 0n }],
  ] as const) {
    const result = quantizeCumulativePostedShare(D.parse(total), before, after, selected);
    expect(result.disposition).toBe("rejected");
    if (result.disposition !== "rejected") throw new Error("Invalid share admitted");
    expect(result.diagnostics[0]?.code).toBe("invalid_exact_number");
  }
  const maxScaleResult = quantizeCumulativePostedShare(D.of(100n, MAX_DECIMAL_SCALE), zero, one, { ...policy, targetScale: MAX_DECIMAL_SCALE });
  expect(maxScaleResult.disposition).toBe("quantized");
});

function unpack(record: { aggregateGzipBase64: string; sha256: string }) {
  const bytes = new TextDecoder().decode(Bun.gunzipSync(Buffer.from(record.aggregateGzipBase64, "base64")));
  expect(new Bun.CryptoHasher("sha256").update(bytes).digest("hex")).toBe(record.sha256);
  const result = decodeDurableBook(bytes);
  if (result.disposition !== "decoded") throw new Error(result.message);
  return { bytes, aggregate: result.aggregate };
}

test("legacy characterization: the recorded one-cent inventory defect is unchanged, not claimed fixed", () => {
  const { bytes, aggregate } = unpack(legacy.aggregate);
  let replayed: DurableBookAggregate = unpack(legacy.initial).aggregate;
  for (const retained of aggregate.protocol.retainedResults.slice(replayed.protocol.retainedResults.length)) {
    const result = executeBookCommand(replayed.state, replayed.protocol, retained.command);
    expect(result.result.resultHash).toEqual(retained.resultHash);
    replayed = { state: result.state, protocol: result.protocol };
  }
  expect(encodeDurableBook(replayed)).toBe(bytes);
  const balance = replayed.state.journals.flatMap((j) => j.journal.postings).filter((p) => p.accountId === "account-inventory").reduce((sum, p) => sum.add(p.bookValue.amount.toRational()), zero);
  expect(balance.toString()).toBe("-1/100");
  expect(replayed.state.lotHoldings.find((h) => h.id === "audit-lot-a")?.remainingQuantity.toString()).toBe("0/1");
});
