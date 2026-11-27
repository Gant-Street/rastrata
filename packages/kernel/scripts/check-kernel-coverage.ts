/**
 * Kernel coverage gate: 100% line AND function coverage on all production sources.
 *
 * Bun's LCOV reporter omits function records, so this gate runs the suite with
 * the console coverage table and parses the per-file "% Funcs" and "% Lines"
 * columns, failing unless every production module reports exactly 100.00 on
 * both. Branch/condition proof is delivered separately by the mutation gate.
 */
const proc = Bun.spawnSync(
  ["bun", "test", "packages/kernel/test", "--coverage", "--coverage-reporter=text"],
  {
    stdout: "pipe",
    stderr: "pipe",
  },
);
const output = `${proc.stdout.toString()}${proc.stderr.toString()}`;

const tableRows = [
  ...output.matchAll(
    /^\s+(packages\/kernel\/src\/[a-z-]+\.ts)\s+\|\s+([\d.]+)\s+\|\s+([\d.]+)\s+\|/gm,
  ),
];
if (tableRows.length === 0) {
  console.error("Coverage gate could not parse the Bun coverage table.\n" + output.slice(-2000));
  process.exit(1);
}

const expectedFiles = [...new Bun.Glob("packages/kernel/src/*.ts").scanSync(".")].sort();
const reported = new Map(
  tableRows.map((row) => [row[1]!, { funcs: Number(row[2]), lines: Number(row[3]) }]),
);

const failures: string[] = [];
for (const path of expectedFiles) {
  const coverage = reported.get(path);
  if (coverage === undefined) failures.push(`${path}: missing from coverage table`);
  else {
    if (coverage.funcs !== 100)
      failures.push(`${path}: function coverage ${coverage.funcs}% (must be 100%)`);
    if (coverage.lines !== 100)
      failures.push(`${path}: line coverage ${coverage.lines}% (must be 100%)`);
  }
}
for (const path of reported.keys()) {
  if (!expectedFiles.includes(path))
    failures.push(`${path}: unexpected production source in coverage report`);
}

if (proc.exitCode !== 0 && failures.length === 0) {
  failures.push("Kernel test suite failed during coverage run.");
}

if (failures.length > 0) {
  console.error(`Kernel coverage gate failed:\n${failures.join("\n")}`);
  process.exit(1);
}
console.log(
  `kernel coverage: 100% functions and 100% lines across ${expectedFiles.length} production sources`,
);
