import { expect, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  identityRow,
  layouts,
  measureIndex,
  projectedBytes,
} from "../scripts/index-capacity-probe.ts";

test("identity experiment is deterministic, width-controlled and distinguishes inputs", () => {
  for (const width of [36, 256]) {
    const row = identityRow(1, width);
    expect(row).toEqual(identityRow(1, width));
    expect(row.id.length).toBe(width);
    expect(row.inputHash.length).toBe(32);
    expect(row.id).not.toBe(identityRow(2, width).id);
  }
  for (const value of [0, -1, 1.1, NaN, Infinity]) expect(() => identityRow(value, 36)).toThrow();
  expect(() => identityRow(1, 35)).toThrow();
});

test("storage projections round up exactly and cannot count partial evidence as measured capacity", () => {
  expect(projectedBytes(10n, 3n, 4n)).toBe(14n);
  expect(projectedBytes(10n, 3n, 0n)).toBe(0n);
  expect(() => projectedBytes(0n, 3n, 4n)).toThrow();
  expect(() => projectedBytes(10n, 0n, 4n)).toThrow();
  expect(() => projectedBytes(10n, 3n, -1n)).toThrow();
});

test("all six real SQLite layouts preserve mappings and refuse to overwrite existing evidence", () => {
  expect(layouts).toHaveLength(6);
  const directory = mkdtempSync(join(tmpdir(), "rastrata-index-test-"));
  for (const layout of layouts) {
    const path = join(directory, `${layout.id}.sqlite`);
    const evidence = measureIndex(path, layout, 37);
    expect(evidence.allMappingsVerified).toBe(true);
    expect(evidence.samples).toHaveLength(1);
    expect(evidence.samples[0]?.rows).toBe(37);
    expect(evidence.projections.every((item) => item.measuredAtTargetVolume === false)).toBe(true);
    expect(() => measureIndex(path, layout, 37)).toThrow("already exists");
  }
  expect(() => measureIndex(join(directory, "invalid.sqlite"), layouts[0], 300_001)).toThrow();
});
