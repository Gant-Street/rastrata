#!/usr/bin/env bun
/** The headline cost table for the synthetic usage, as quoted in
 * docs/reference/program/hosting/hostobs.md between its cost-table markers.
 *
 *   bun packages/telemetry/tools/cost-table.ts            print it
 *   bun packages/telemetry/tools/cost-table.ts --write    put it in the document
 *
 * A test fails when the document and the code disagree. */
import { readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { headlineTable, parsePricebook, priceMatrix } from "../src/cost/index.ts";
import { FILE as SYNTHETIC } from "./synthetic-usage.ts";

const root = resolve(import.meta.dir, "../../..");
export const DOCUMENT = resolve(root, "docs/reference/program/hosting/hostobs.md");
export const START = "<!-- cost-table:start -->";
export const END = "<!-- cost-table:end -->";

export function costTable(): string {
  const book = parsePricebook(
    JSON.parse(readFileSync(resolve(root, "ops/pricebook.json"), "utf8")),
  );
  const synthetic = JSON.parse(readFileSync(SYNTHETIC, "utf8")) as {
    variants: Record<string, never>;
  };
  const rows = priceMatrix(synthetic.variants, book).map((row) => ({
    label: row.variant,
    result: row,
  }));
  return headlineTable(rows).join("\n");
}

if (import.meta.main) {
  const table = costTable();
  if (!process.argv.includes("--write")) console.log(table);
  else {
    const text = readFileSync(DOCUMENT, "utf8");
    const from = text.indexOf(START);
    const to = text.indexOf(END);
    if (from < 0 || to < from)
      throw new Error("the cost-table markers are missing from the document");
    writeFileSync(DOCUMENT, `${text.slice(0, from + START.length)}\n${table}\n${text.slice(to)}`);
    console.log(`updated ${DOCUMENT}`);
  }
}
