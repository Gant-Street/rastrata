import { expect, test } from "bun:test";
import { renderTable, runHarness } from "./support/intake-harness.ts";

/** The scripted customer's agent, from a folder of files to reconciled months, through the command
 * line only (see support/intake-harness.ts). Every check of its table must pass; the table is the
 * failure message. `bun scripts/intake-harness.ts` prints the same table. */

test("a scripted agent moves a synthetic business in: scan, plan, recipes, gates, opening balances, imports, posting, reconciliation", async () => {
  const result = await runHarness();
  const table = renderTable(result.rows);
  const failed = result.rows.filter((row) => !row.pass);
  expect(
    failed.map((row) => `${row.section}: ${row.check}: ${row.detail}`),
    table,
  ).toEqual([]);

  // Every part of the move-in was exercised, not skipped.
  const sections = new Set(result.rows.map((row) => row.section));
  for (const section of [
    "book",
    "scan",
    "plan",
    "recipe",
    "gates",
    "opening",
    "import",
    "post",
    "reconcile",
    "status",
    "scopes",
  ])
    expect(sections.has(section), `${section} did not run\n${table}`).toBe(true);
  // At least twelve statement layouts, each proven, imported and reconciled.
  expect(result.rows.filter((row) => row.section === "recipe").length).toBeGreaterThanOrEqual(12);
  expect(result.rows.filter((row) => row.section === "reconcile").length).toBeGreaterThanOrEqual(
    12,
  );
  // And every gate has its negative control.
  const gates = result.rows.filter((row) => row.section === "gates").map((row) => row.check);
  for (const word of [
    "sign",
    "D/M",
    "missing month",
    "missing line",
    "duplicate",
    "trial balance",
    "byte-order",
    "pending",
    "several lines",
    "ending balance",
    "hostile",
  ])
    expect(
      gates.some((check) => check.includes(word)),
      `no negative control for ${word}`,
    ).toBe(true);
}, 600_000);
