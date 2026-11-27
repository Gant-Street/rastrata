/**
 * Semantic SysML-to-code trace gate.
 *
 * Requirement bindings contain live references to kernel exports. Fixture
 * execution is checked against the actual executor registries. No source-text
 * search and no parent-requirement fallback are permitted.
 */
import { readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import {
  BOUNDARY_REQUIREMENT_DISPOSITIONS,
  DESIGN_PENDING_REQUIREMENT_DISPOSITIONS,
  KERNEL_REQUIREMENT_BINDINGS,
  type SemanticImplementationBinding,
} from "../spec/kernel-semantic-bindings.ts";
import { DESIGN_CASE_EXECUTORS } from "../test/design-case-executors.ts";
import { ACCOUNTING_CASE_EXECUTORS } from "../test/accounting-case-executors.ts";

const MODEL_PATH = "packages/kernel/spec/rastrata-accounting-backend.sysml";
const MANIFEST_PATH = "packages/kernel/spec/kernel-code-trace-manifest.json";
const SOURCE_DIR = "packages/kernel/src";
const CATALOGS = [
  {
    path: "packages/kernel/spec/kernel-v1-verification-cases.json",
    executors: DESIGN_CASE_EXECUTORS,
  },
  {
    path: "packages/kernel/spec/kernel-design-verification-cases.json",
    executors: ACCOUNTING_CASE_EXECUTORS,
  },
] as const;
const requirementPattern = /ACC-\d{3}(?:\.\d+)?/g;
const requireComplete = process.argv.includes("--require-complete");

function sourceFiles(dir: string): string[] {
  const entries: string[] = [];
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) entries.push(...sourceFiles(full));
    else if (entry.endsWith(".ts")) entries.push(full);
  }
  return entries.sort();
}

interface FixtureEntry {
  readonly id: string;
  readonly outcome: string;
  readonly requirements: readonly string[];
  readonly executable: boolean;
}

interface SemanticLocation {
  readonly module: string;
  readonly export: string;
}

const failures: string[] = [];
const model = await Bun.file(MODEL_PATH).text();
const sysmlRequirementIds = [...new Set(model.match(requirementPattern) ?? [])].sort();
const sysmlRequirementSet = new Set(sysmlRequirementIds);
const sources = sourceFiles(SOURCE_DIR);

const fixturesByRequirement = new Map<string, FixtureEntry[]>();
const catalogExecutorIds = new Set<string>();
const pushFixture = (
  id: string,
  outcome: string,
  requirements: readonly string[],
  executable: boolean,
) => {
  catalogExecutorIds.add(id);
  for (const requirement of new Set(requirements)) {
    const list = fixturesByRequirement.get(requirement) ?? [];
    if (!list.some((fixture) => fixture.id === id))
      list.push({ id, outcome, requirements, executable });
    fixturesByRequirement.set(requirement, list);
  }
};

for (const catalogSource of CATALOGS) {
  const catalog = await Bun.file(catalogSource.path).json();
  for (const item of catalog.cases) {
    const requirements: string[] = [
      ...(item.requirements ?? []),
      ...(item.atomic_requirements ?? []),
    ];
    for (const scenario of item.scenarios ?? []) {
      const scenarioRequirements = [
        ...requirements,
        ...(scenario.requirements ?? []),
        ...(scenario.atomic_requirements ?? []),
      ];
      pushFixture(
        scenario.id,
        "reject",
        scenarioRequirements,
        Object.hasOwn(catalogSource.executors, scenario.id),
      );
    }
    pushFixture(
      item.id,
      item.outcome,
      requirements,
      Object.hasOwn(catalogSource.executors, item.id),
    );
  }
  for (const executorId of Object.keys(catalogSource.executors)) {
    if (!catalogExecutorIds.has(executorId))
      failures.push(`${executorId}: executable case has no catalog entry`);
  }
}

const moduleCache = new Map<string, Record<string, unknown>>();
async function semanticLocation(
  binding: SemanticImplementationBinding,
): Promise<SemanticLocation | undefined> {
  if (!sources.includes(binding.module)) {
    failures.push(`${binding.module}: bound production module does not exist`);
    return undefined;
  }
  let module = moduleCache.get(binding.module);
  if (module === undefined) {
    module = (await import(`../../../${binding.module}`)) as Record<string, unknown>;
    moduleCache.set(binding.module, module);
  }
  const entry = Object.entries(module).find(([, value]) => value === binding.implementation);
  if (entry === undefined) {
    failures.push(`${binding.module}: bound implementation is not a live named export`);
    return undefined;
  }
  return Object.freeze({ module: binding.module, export: entry[0] });
}

for (const requirementId of Object.keys(KERNEL_REQUIREMENT_BINDINGS)) {
  if (!sysmlRequirementSet.has(requirementId))
    failures.push(`${requirementId}: semantic binding has no SysML requirement`);
  if (Object.hasOwn(BOUNDARY_REQUIREMENT_DISPOSITIONS, requirementId))
    failures.push(`${requirementId}: cannot be both kernel-bound and a boundary disposition`);
}
for (const requirementId of Object.keys(BOUNDARY_REQUIREMENT_DISPOSITIONS)) {
  if (!sysmlRequirementSet.has(requirementId))
    failures.push(`${requirementId}: boundary disposition has no SysML requirement`);
  if (Object.hasOwn(DESIGN_PENDING_REQUIREMENT_DISPOSITIONS, requirementId))
    failures.push(`${requirementId}: cannot be both boundary and design-pending`);
}
for (const requirementId of Object.keys(DESIGN_PENDING_REQUIREMENT_DISPOSITIONS)) {
  if (!sysmlRequirementSet.has(requirementId))
    failures.push(`${requirementId}: design-pending disposition has no SysML requirement`);
  if (requireComplete)
    failures.push(`${requirementId}: design-pending requirement blocks technical closure`);
}

const requirementEntries: [string, object][] = [];
for (const requirementId of sysmlRequirementIds) {
  const boundaryRationale = BOUNDARY_REQUIREMENT_DISPOSITIONS[requirementId];
  const pendingRationale = DESIGN_PENDING_REQUIREMENT_DISPOSITIONS[requirementId];
  const bindings = KERNEL_REQUIREMENT_BINDINGS[requirementId] ?? [];
  const implementations = (await Promise.all(bindings.map(semanticLocation))).filter(
    (item): item is SemanticLocation => item !== undefined,
  );
  const uniqueImplementations = [
    ...new Map(implementations.map((item) => [`${item.module}:${item.export}`, item])).values(),
  ].sort((left, right) =>
    `${left.module}:${left.export}`.localeCompare(`${right.module}:${right.export}`),
  );
  const fixtures = (fixturesByRequirement.get(requirementId) ?? []).sort((left, right) =>
    left.id.localeCompare(right.id),
  );
  const executableFixtures = fixtures.filter((fixture) => fixture.executable);
  if (
    boundaryRationale === undefined &&
    pendingRationale === undefined &&
    uniqueImplementations.length === 0
  )
    failures.push(`${requirementId}: no exact semantic implementation binding`);
  if (
    boundaryRationale === undefined &&
    pendingRationale === undefined &&
    executableFixtures.length === 0
  )
    failures.push(`${requirementId}: no exact executable fixture binding`);
  requirementEntries.push([
    requirementId,
    pendingRationale !== undefined
      ? {
          disposition: "design-pending",
          rationale: pendingRationale,
          implementations: uniqueImplementations,
          fixtures,
          traced: false,
        }
      : boundaryRationale === undefined
        ? {
            disposition: "kernel",
            implementations: uniqueImplementations,
            fixtures,
            traced: uniqueImplementations.length > 0 && executableFixtures.length > 0,
          }
        : {
            disposition: "boundary",
            rationale: boundaryRationale,
            implementations: [],
            fixtures,
            traced: true,
          },
  ]);
}

const manifest = {
  manifest_version: "rastrata-kernel-semantic-trace-manifest-v3",
  model: MODEL_PATH,
  disposition_reference: "docs/reference/reviews/kernel-v1/closure-audit.md",
  generated_from: {
    sysml_requirement_ids: sysmlRequirementIds.length,
    production_sources: sources.length,
    semantic_bindings: "packages/kernel/spec/kernel-semantic-bindings.ts",
    executable_fixture_catalogs: CATALOGS.map((item) => item.path),
  },
  requirements: Object.fromEntries(requirementEntries),
};

const committedFile = Bun.file(MANIFEST_PATH);
const committed = (await committedFile.exists()) ? JSON.parse(await committedFile.text()) : null;
const regeneratedRaw = JSON.stringify(manifest, null, 1) + "\n";
if (committed === null || JSON.stringify(committed, null, 1) + "\n" !== regeneratedRaw) {
  await Bun.write(MANIFEST_PATH, regeneratedRaw);
  failures.push(
    committed === null
      ? "Manifest created; review and commit it."
      : "Manifest drifted from the semantic trace; file updated — review and commit it.",
  );
}

if (failures.length > 0) {
  console.error(`Semantic trace manifest check failed:\n${failures.join("\n")}`);
  process.exit(1);
}
console.log(
  `semantic trace manifest: ${sysmlRequirementIds.length} exact SysML requirements; ${Object.keys(KERNEL_REQUIREMENT_BINDINGS).length} executable bindings, ${Object.keys(BOUNDARY_REQUIREMENT_DISPOSITIONS).length} boundary dispositions, ${Object.keys(DESIGN_PENDING_REQUIREMENT_DISPOSITIONS).length} design-pending`,
);
