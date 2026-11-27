/**
 * Compare this kernel with another build of it, observable by observable.
 *
 * Both kernels run the same deterministic books (`test/validation-scenarios.ts`): random commands of
 * every kind the application issues, then tampered copies of the finished book. Every disposition,
 * result hash, state hash, durable encoding and validator diagnostic is compared. Use it to show that
 * a change to the full-state path moved no result, against a build from before the change:
 *
 *   mkdir /tmp/oracle && git archive <commit> packages/kernel/src | tar -x -C /tmp/oracle
 *   bun packages/kernel/scripts/compare-kernels.ts compare /tmp/oracle/packages/kernel/src/index.ts
 *   COMMITMENT=yes bun packages/kernel/scripts/compare-kernels.ts compare /tmp/oracle/.../index.ts
 *
 * `compare` takes SCENARIOS (default 40) and STEPS (default 80) from the environment and exits 1 on
 * any difference. `golden` writes test/data/validation-golden.json from two builds, one for books
 * without the state commitment profile and one for books with it (PRODUCED_BY_LEGACY and
 * PRODUCED_BY_PROFILED say in words which builds); the table is what `validation-equivalence.test.ts`
 * pins:
 *
 *   bun packages/kernel/scripts/compare-kernels.ts golden <legacy index.ts> <profiled index.ts>
 */
import * as current from "../src/index.ts";
import { type Kernel, observeScenario } from "../test/validation-scenarios.ts";

const [mode, ...paths] = process.argv.slice(2);
const load = async (path: string) => (await import(path)) as Kernel;
const GOLDEN = "packages/kernel/test/data/validation-golden.json";

if (mode === "compare" && paths[0] !== undefined) {
  const oracle = await load(paths[0]);
  const commitment = process.env.COMMITMENT === "yes";
  const scenarios = Number(process.env.SCENARIOS ?? "40");
  const steps = Number(process.env.STEPS ?? "80");
  let observations = 0;
  let differences = 0;
  for (let seed = 1; seed <= scenarios; seed += 1) {
    const expected = observeScenario(oracle, seed, steps, commitment);
    const observed = observeScenario(current as Kernel, seed, steps, commitment);
    for (const key of new Set([...Object.keys(expected), ...Object.keys(observed)])) {
      observations += 1;
      if (expected[key] === observed[key]) continue;
      differences += 1;
      if (differences <= 10)
        console.log(`seed ${seed} ${key}: ${expected[key]} then ${observed[key]}`);
    }
  }
  console.log(
    `${scenarios} scenarios of ${steps} commands, ${commitment ? "with" : "without"} the state commitment profile: ${observations} observations, ${differences} differences`,
  );
  process.exit(differences === 0 ? 0 : 1);
} else if (mode === "golden" && paths[0] !== undefined && paths[1] !== undefined) {
  const [legacyKernel, profiledKernel] = [await load(paths[0]), await load(paths[1])];
  const seeds = [1, 2, 3, 4, 5, 6];
  const steps = 40;
  const table = (kernel: Kernel, commitment: boolean) =>
    Object.fromEntries(
      seeds.map((seed) => [String(seed), observeScenario(kernel, seed, steps, commitment)]),
    );
  const golden = {
    steps,
    legacy: {
      produced_by: process.env.PRODUCED_BY_LEGACY ?? paths[0],
      scenarios: table(legacyKernel, false),
    },
    profiled: {
      produced_by: process.env.PRODUCED_BY_PROFILED ?? paths[1],
      scenarios: table(profiledKernel, true),
    },
  };
  await Bun.write(GOLDEN, `${JSON.stringify(golden, null, 1)}\n`);
  console.log(`wrote ${GOLDEN}`);
} else {
  console.error(
    "usage: compare-kernels.ts compare <oracle index.ts> | golden <legacy index.ts> <profiled index.ts>",
  );
  process.exit(2);
}
