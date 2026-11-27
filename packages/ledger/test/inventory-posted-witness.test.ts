import { expect, test } from "bun:test";
import {
  ExactDecimal,
  ExactRational,
  hashCanonical,
  lotHoldingId,
  postingId,
} from "@rastrata/kernel";
import {
  decodeInventoryPostedWitness,
  resolveInventoryPostedShares,
} from "../src/inventory-posted-witness.ts";
import { genesis } from "./fixtures.ts";

const sourceHash = hashCanonical({ head: "test" });
const postingHash = hashCanonical({ posting: "test" });
const policy = genesis().state.quantizationPolicies[0];
if (policy === undefined) throw new Error("Missing test policy");
const first = lotHoldingId("a-source"),
  second = lotHoldingId("z-source");
const R = (n: bigint, d = 1n) => ExactRational.of(n, d);
const D = (value: string) => ExactDecimal.parse(value);
const row = (firstAmount: string, secondAmount: string) => ({
  postingId: postingId("source"),
  postingHash,
  shares: [
    { holdingId: first, postedAmount: D(firstAmount) },
    { holdingId: second, postedAmount: D(secondAmount) },
  ],
});

test("posted proposal allocates a penny cumulatively and transfer destinations cannot reround it", () => {
  const targets = [
    { holdingId: first, exactWeight: R(1n) },
    { holdingId: second, exactWeight: R(1n) },
  ];
  expect(
    resolveInventoryPostedShares(targets, D("-0.01"), postingHash, policy, undefined).disposition,
  ).toBe("missing");
  const accepted = resolveInventoryPostedShares(
    targets,
    D("-0.01"),
    postingHash,
    policy,
    row("0.00", "-0.01"),
  );
  expect(accepted.disposition).toBe("resolved");
  if (accepted.disposition !== "resolved") throw new Error("Expected exact allocation");
  expect([...accepted.shares].map(([id, value]) => [id, value.toString()])).toEqual([
    [first, "0/1"],
    [second, "-1/100"],
  ]);
  expect(
    resolveInventoryPostedShares(targets, D("-0.01"), postingHash, policy, row("-0.01", "0.00"))
      .disposition,
  ).toBe("invalid");
  // Destination ID order is opposite source order. The cent must follow its
  // source lot, not be assigned to the second destination by independent rounding.
  const firstDestination = lotHoldingId("z-destination"),
    secondDestination = lotHoldingId("a-destination");
  const destinationTargets = [
    { holdingId: firstDestination, exactWeight: R(1n), prescribedAmount: R(0n) },
    { holdingId: secondDestination, exactWeight: R(1n), prescribedAmount: R(1n, 100n) },
  ];
  const transferred = resolveInventoryPostedShares(
    destinationTargets,
    D("0.01"),
    postingHash,
    policy,
    undefined,
  );
  expect(transferred.disposition).toBe("resolved");
  if (transferred.disposition !== "resolved") throw new Error("Expected source-coupled transfer");
  expect([...transferred.shares].map(([id, value]) => [id, value.toString()])).toEqual([
    [secondDestination, "1/100"],
    [firstDestination, "0/1"],
  ]);
  expect(
    resolveInventoryPostedShares(destinationTargets, D("0.01"), postingHash, policy, {
      postingId: postingId("destination"),
      postingHash,
      shares: [
        { holdingId: secondDestination, postedAmount: D("0.00") },
        { holdingId: firstDestination, postedAmount: D("0.01") },
      ],
    }).disposition,
  ).toBe("invalid");
});

test("posted proposal fails closed on invalid arithmetic, target populations and policy precision", () => {
  const targets = [
    { holdingId: first, exactWeight: R(1n) },
    { holdingId: second, exactWeight: R(1n) },
  ] as const;
  for (const invalidTargets of [
    [],
    [targets[0], targets[0]],
    [{ holdingId: first, exactWeight: R(-1n) }],
    [{ ...targets[0], prescribedAmount: R(1n) }, targets[1]],
    targets.map((target) => ({ ...target, prescribedAmount: R(1n, 200n) })),
    [
      { ...targets[0], prescribedAmount: R(-1n) },
      { ...targets[1], prescribedAmount: R(101n, 100n) },
    ],
  ]) {
    expect(
      resolveInventoryPostedShares(invalidTargets, D("0.01"), postingHash, policy, undefined)
        .disposition,
    ).toBe("invalid");
  }
  expect(
    resolveInventoryPostedShares([targets[0]], D("0.001"), postingHash, policy, undefined)
      .disposition,
  ).toBe("invalid");
  expect(
    resolveInventoryPostedShares(
      targets,
      D("0.01"),
      postingHash,
      { ...policy, targetScale: 0n },
      row("0.00", "0.01"),
    ).disposition,
  ).toBe("invalid");
  const zeroTargets = targets.map((target) => ({ ...target, exactWeight: R(0n) }));
  expect(
    resolveInventoryPostedShares(zeroTargets, D("0.01"), postingHash, policy, row("0.00", "0.01"))
      .disposition,
  ).toBe("invalid");
  expect(
    resolveInventoryPostedShares(zeroTargets, D("0.00"), postingHash, policy, row("0.00", "0.00"))
      .disposition,
  ).toBe("resolved");
  for (const alteredHash of [
    { ...postingHash, digest: "0".repeat(64) },
    { ...postingHash, algorithm: "sha512" },
    { ...postingHash, canonicalizationVersion: "future" },
  ]) {
    expect(
      resolveInventoryPostedShares(
        targets,
        D("0.01"),
        alteredHash as typeof postingHash,
        policy,
        row("0.00", "0.01"),
      ).disposition,
    ).toBe("invalid");
  }
});

test("posted witness decoder enforces bounded canonical JSON and immutable normalized receipts", () => {
  const proposal = {
    version: "legacy-inventory-posted-attribution-v1",
    sourceHash,
    postings: [
      {
        postingId: "source",
        postingHash,
        shares: [
          { holdingId: first, postedAmount: "0.00" },
          { holdingId: second, postedAmount: "-0.01" },
        ],
      },
    ],
  };
  const decoded = decodeInventoryPostedWitness(JSON.stringify(proposal));
  expect(Object.isFrozen(decoded)).toBe(true);
  expect(Object.isFrozen(decoded.postings)).toBe(true);
  expect(Object.isFrozen(decoded.postings[0]?.shares[0])).toBe(true);
  const baseRow = proposal.postings[0];
  if (baseRow === undefined) throw new Error("Missing test row");
  baseRow.shares.reverse();
  expect(decodeInventoryPostedWitness(JSON.stringify(proposal))).toEqual(decoded);
  for (const invalid of [
    null,
    [],
    {},
    { ...proposal, postings: [] },
    { ...proposal, sourceHash: { ...sourceHash, canonicalizationVersion: "future" } },
    {
      ...proposal,
      postings: [
        {
          ...baseRow,
          shares: Array.from({ length: 10_001 }, (_, i) => ({
            holdingId: `holding-${i}`,
            postedAmount: "0.00",
          })),
        },
      ],
    },
    ...["-0.00", "+1.00", "01.00", "1e2", "NaN"].map((postedAmount) => ({
      ...proposal,
      postings: [{ ...baseRow, shares: [{ holdingId: first, postedAmount }] }],
    })),
  ]) {
    expect(() => decodeInventoryPostedWitness(JSON.stringify(invalid))).toThrow(
      "ledger_inventory_witness_invalid",
    );
  }
  let touched = false;
  const hostile = {
    toString() {
      touched = true;
      throw new Error("Caller code");
    },
  };
  expect(() => decodeInventoryPostedWitness(hostile as unknown as string)).toThrow(
    "ledger_inventory_witness_invalid",
  );
  expect(touched).toBe(false);
});
