#!/usr/bin/env bun
/** Write the golden snapshot of the operation contract.
 *
 *   bun scripts/freeze-contract.ts --init              first freeze: the manual-bookkeeping core and tokens
 *   bun scripts/freeze-contract.ts                     record compatible growth of what is already frozen
 *   bun scripts/freeze-contract.ts --promote a.b c.d   also freeze these operations (they stop being previews)
 *   bun scripts/freeze-contract.ts --all               freeze every operation: the release step
 *
 * A change that breaks the frozen contract is refused here; it needs a new contract version
 * (docs/reference/contract-policy.md). Operations are never removed from the snapshot. */
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import {
  compareContracts,
  stableJson,
  type ContractSnapshot,
} from "../packages/application/src/contract-compat.ts";
import {
  PREPARED_OPERATION_PERMISSIONS,
  operationCatalog,
} from "../packages/application/src/schema.ts";
import {
  GOLDEN_FILES,
  GOLDEN_NOTE,
  currentView,
  describeFindings,
  initialFrozenKinds,
  initialFrozenOperations,
  readGolden,
  root,
} from "./contract-freeze.ts";

const args = process.argv.slice(2);
const die = (message: string): never => {
  console.error(`freeze-contract: ${message}`);
  process.exit(1);
};
const known = new Set(["--init", "--all", "--promote"]);
const promote: string[] = [];
let mode: "init" | "all" | "refreeze" = "refreeze";
for (let index = 0; index < args.length; index++) {
  const arg = args[index] as string;
  if (arg === "--init") mode = "init";
  else if (arg === "--all") mode = "all";
  else if (arg === "--promote") {
    while (args[index + 1] && !args[index + 1]?.startsWith("--"))
      promote.push(args[++index] as string);
    if (!promote.length) die("--promote needs operation names");
  } else if (!known.has(arg)) die(`unknown argument ${arg}`);
}

const existing = readGolden();
const catalog = new Set(operationCatalog.map((operation) => operation.name));
if (mode === "init" && existing) die("the contract is already frozen; run without --init");
if (mode !== "init" && !existing) die("nothing is frozen yet; run with --init");

let names: Set<string>;
let kinds: string[];
if (mode === "init") {
  names = initialFrozenOperations();
  kinds = initialFrozenKinds();
} else {
  names = new Set(Object.keys(existing?.operations ?? {}));
  kinds = Object.keys(existing?.preparedPermissions ?? {});
}
if (mode === "all") {
  names = new Set(catalog);
  kinds = Object.keys(PREPARED_OPERATION_PERMISSIONS);
}
for (const name of promote) {
  if (!catalog.has(name)) die(`${name} is not an operation`);
  names.add(name);
}

const view = currentView(names, kinds);
if (existing) {
  const comparison = compareContracts(existing, view);
  if (comparison.breaking.length)
    die(
      `the change breaks the frozen contract and needs a new version:\n${describeFindings(
        comparison,
      )
        .map((line) => `  - ${line}`)
        .join("\n")}`,
    );
  console.log(
    `freeze-contract: ${comparison.extended.length} frozen operations grew compatibly${
      comparison.extended.length ? `: ${comparison.extended.join(", ")}` : ""
    }`,
  );
}
const snapshot: ContractSnapshot = {
  ...view,
  frozenOn: new Date().toISOString().slice(0, 10),
  note: GOLDEN_NOTE,
};
const text = stableJson(snapshot);
for (const file of GOLDEN_FILES) {
  const path = resolve(root, file);
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, text);
}
const preview = [...catalog].filter((name) => !names.has(name));
console.log(
  `freeze-contract: ${names.size} operations frozen, ${preview.length} still previews${
    preview.length ? ` (${preview.join(", ")})` : ""
  }`,
);
