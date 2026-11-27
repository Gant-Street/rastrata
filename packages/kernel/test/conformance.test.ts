import { describe, expect, test } from "bun:test";
import { DESIGN_CASE_EXECUTORS, type ObservedDesignCase } from "./design-case-executors.ts";
import { ACCOUNTING_CASE_EXECUTORS, rejectWith } from "./accounting-case-executors.ts";

interface DesignCase {
  readonly id: string;
  readonly outcome: "admit" | "reject";
  readonly requirements: readonly string[];
  readonly expect: Readonly<Record<string, unknown>>;
}

interface CoverageEntry {
  readonly admit: string;
  readonly reject: string;
  readonly tests: readonly string[];
}

const KERNEL_REQUIREMENTS = Object.freeze([
  "ACC-001", "ACC-002", "ACC-003", "ACC-004", "ACC-005", "ACC-006", "ACC-007",
  "ACC-008", "ACC-009", "ACC-010", "ACC-011", "ACC-012", "ACC-013", "ACC-014",
  "ACC-017", "ACC-018", "ACC-019", "ACC-021", "ACC-022", "ACC-023", "ACC-026",
  "ACC-027", "ACC-028", "ACC-029", "ACC-030", "ACC-031", "ACC-032", "ACC-034",
  "ACC-037", "ACC-038", "ACC-039", "ACC-040", "ACC-041", "ACC-042", "ACC-043",
  "ACC-044", "ACC-045", "ACC-046", "ACC-047",
]);

describe("SysML kernel conformance", () => {
  test("an unexpectedly admitted hostile fixture cannot report a successful rejection", () => {
    expect(() => rejectWith("inventory_cost_policy_incoherent", { hostile_admitted: true })).toThrow("Hostile fixture was admitted");
    expect(rejectWith("inventory_cost_policy_incoherent").outcome).toBe("reject");
  });
  test("tax ambiguity and consolidation imbalance fixtures exercise their actual input", async () => {
    const catalog = await Bun.file("packages/kernel/spec/kernel-design-verification-cases.json").json();
    const scenarios = catalog.cases.flatMap((item: { scenarios?: { id: string; input: Record<string, unknown> }[] }) => item.scenarios ?? []);
    const tax = scenarios.find((item: { id: string }) => item.id === "D14e-overlapping-tax-policy")!;
    const consolidation = scenarios.find((item: { id: string }) => item.id === "D16g-unbalanced-consolidation-adjustment")!;
    // Distinct explicit versions are not ambiguous. A balanced adjustment is
    // not hostile. Both controls must expose admission, not fake a rejection.
    expect(() => ACCOUNTING_CASE_EXECUTORS[tax.id]!({ ...tax.input, applicable_policy_versions: ["1.2.0", "1.3.0"] })).toThrow("Hostile fixture was admitted");
    expect(() => ACCOUNTING_CASE_EXECUTORS[consolidation.id]!({ ...consolidation.input, adjustment_postings_cents: [5000, -5000] })).toThrow("Hostile fixture was admitted");
  });
  test("executes every SysML design oracle and maps every Ring A/B requirement to both polarities", async () => {
    const design = (await Bun.file("packages/kernel/spec/kernel-v1-verification-cases.json").json()) as {
      readonly cases: readonly DesignCase[];
    };
    const coverage = (await Bun.file("packages/kernel/test/kernel-requirement-coverage.json").json()) as {
      readonly requirements: Readonly<Record<string, CoverageEntry>>;
    };
    expect(Object.keys(coverage.requirements).sort()).toEqual([...KERNEL_REQUIREMENTS].sort());
    const accountingDesign = (await Bun.file("packages/kernel/spec/kernel-design-verification-cases.json").json()) as {
      readonly status: string;
      readonly cases: readonly (DesignCase & { readonly scenarios?: readonly (DesignCase & { readonly atomic_requirements: readonly string[] })[] })[];
    };
    expect(accountingDesign.status).toBe("implemented-and-executable");
    const cases = new Map(design.cases.map((item) => [item.id, item] as const));
    for (const item of accountingDesign.cases) {
      if (item.outcome === "admit") cases.set(item.id, item);
      else for (const scenario of item.scenarios ?? []) cases.set(scenario.id, { ...scenario, outcome: "reject", requirements: item.requirements });
    }
    const accountingFixtureIds = accountingDesign.cases.flatMap((item) => item.outcome === "admit" ? [item.id] : (item.scenarios ?? []).map((scenario) => scenario.id));
    expect(Object.keys(ACCOUNTING_CASE_EXECUTORS).sort()).toEqual([...accountingFixtureIds].sort());
    expect(Object.keys(DESIGN_CASE_EXECUTORS).sort()).toEqual(design.cases.map((item) => item.id).sort());
    for (const item of design.cases) {
      const runner = DESIGN_CASE_EXECUTORS[item.id];
      if (runner === undefined) throw new Error(`Missing executable SysML oracle ${item.id}`);
      const observed = await runner();
      expect(observed.outcome, item.id).toBe(item.outcome);
      for (const [fact, expected] of Object.entries(item.expect)) {
        expect(observed.facts[fact], `${item.id}.${fact}`).toEqual(expected);
      }
    }
    for (const [requirement, entry] of Object.entries(coverage.requirements)) {
      expect(cases.get(entry.admit)?.outcome, `${requirement} admitting oracle`).toBe("admit");
      expect(cases.get(entry.reject)?.outcome, `${requirement} rejecting oracle`).toBe("reject");
      expect(cases.get(entry.admit)?.requirements).toContain(requirement);
      expect(cases.get(entry.reject)?.requirements).toContain(requirement);
      const admitExecutor = DESIGN_CASE_EXECUTORS[entry.admit] ?? (ACCOUNTING_CASE_EXECUTORS[entry.admit] === undefined ? undefined : () => {
        throw new Error("accounting oracles execute against their fixture data, not standalone");
      });
      const rejectExecutor = DESIGN_CASE_EXECUTORS[entry.reject] ?? (ACCOUNTING_CASE_EXECUTORS[entry.reject] === undefined ? undefined : () => {
        throw new Error("accounting oracles execute against their fixture data, not standalone");
      });
      expect(admitExecutor, `${requirement} admitting oracle must be executable`).toBeFunction();
      expect(rejectExecutor, `${requirement} rejecting oracle must be executable`).toBeFunction();
    }
  });

  test("executes all 69 accounting-extension fixtures against production APIs", async () => {
    const catalog = (await Bun.file("packages/kernel/spec/kernel-design-verification-cases.json").json()) as {
      readonly status: string;
      readonly cases: readonly (DesignCase & { readonly scenarios?: readonly (DesignCase & { readonly input: Readonly<Record<string, unknown>> })[] })[];
    };
    const fixtures: readonly { readonly id: string; readonly outcome: "admit" | "reject"; readonly input: Readonly<Record<string, unknown>>; readonly expect: Readonly<Record<string, unknown>> }[] = (catalog.cases.flatMap((item): readonly { readonly id: string; readonly outcome: "admit" | "reject"; readonly input: Readonly<Record<string, unknown>>; readonly expect: Readonly<Record<string, unknown>> }[] =>
      item.outcome === "admit"
        ? [{ id: item.id, outcome: "admit" as const, input: (item as unknown as { input: Readonly<Record<string, unknown>> }).input, expect: item.expect }]
        : (item.scenarios ?? []).map((scenario) => ({ id: scenario.id, outcome: "reject" as const, input: scenario.input, expect: scenario.expect })))).flat();
    expect(catalog.status).toBe("implemented-and-executable");
    expect(fixtures).toHaveLength(69);
    expect(Object.keys(ACCOUNTING_CASE_EXECUTORS).sort()).toEqual(fixtures.map((fixture) => fixture.id).sort());
    for (const fixture of fixtures) {
      const runner = ACCOUNTING_CASE_EXECUTORS[fixture.id];
      if (runner === undefined) throw new Error(`Missing executable accounting oracle ${fixture.id}`);
      const observed: ObservedDesignCase = await runner(fixture.input);
      expect(observed.outcome, fixture.id).toBe(fixture.outcome);
      for (const [fact, expected] of Object.entries(fixture.expect)) {
        expect(observed.facts[fact], `${fixture.id}.${fact}`).toEqual(expected);
      }
    }
  });
});
