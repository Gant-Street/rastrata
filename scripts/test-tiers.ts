/** Which Bun test files run in the everyday check (`bun run gate`, under a minute) and which wait for the slow tier
 * (`bun run test:slow`, before a release). A file is slow when it builds thousands of entries, builds the install
 * package, rehearses a whole path end to end, or kills processes and waits on clocks: what it proves holds between
 * releases, and it would hold every change back by tens of seconds. Everything else is fast and runs every time.
 *
 * The storage experiment (packages/ledger, apps/ledger-service, apps/ledger-acceptance) is not in the product, so it
 * is in neither: its own scripts still run it. */

/** The folders whose tests are the everyday check, run as one pool across every core. */
export const FAST_ROOTS = [
  "./packages/application/test",
  "./packages/kernel/test",
  "./packages/booklog/test",
  "./packages/telemetry/test",
  "./apps/api/test",
  "./apps/mcp/test",
  "./apps/web/tests/unit",
  "./packages/ui/unit",
  "./scripts",
] as const;

/** Files under those folders that belong to the slow tier, measured on 2026-10-29 (seconds alone, on ten cores). */
export const SLOW_FILES = [
  // Thousands of entries, five years of months, a file over the size limit.
  "packages/application/test/changes/volume.test.ts", // 74
  "packages/application/test/recpack/volume.test.ts", // 49
  "packages/application/test/recpack/too-large.test.ts", // 47
  "packages/application/test/stripe/volume.test.ts", // 10
  "packages/application/test/calendar-five-years.test.ts", // 10
  "packages/kernel/test/inventory-ownership-limits.test.ts", // 11
  "packages/kernel/test/accounting-resource-bounds.test.ts", // 11
  // A process killed in the middle of a write, and the clocks it waits on.
  "packages/application/test/entries-recategorize-kill.test.ts", // 24
  "packages/application/test/entries-recategorize-sigkill.test.ts", // 8
  "apps/api/test/hosted-main.test.ts", // 21
  "apps/api/test/hosted-many.test.ts", // 7 alone: pods that hand each other requests, on timers
  // Every revision rebuilt from nothing and compared, the golden statements, the commitment and validation checked
  // against their independent forms: the invariants of the books, proved across many cases before each release.
  "packages/application/test/reports-incremental.test.ts", // 9 alone
  "packages/application/test/reports-golden.test.ts", // 5 alone
  "packages/application/test/state-commitment.test.ts", // 4.5 alone
  "packages/application/test/replay-trusted.test.ts", // 4.5 alone
  "packages/kernel/test/validation-equivalence.test.ts", // 4.6 alone
  // The process's own CPU time and memory, measured: they move with whatever else the computer is doing.
  "packages/telemetry/test/runtime.test.ts",
  // A storm of requests at the telemetry collector, timed.
  "apps/api/test/telemetry-storm.test.ts", // 14
  "packages/telemetry/test/storm.test.ts", // 14
  // The install package built and run, and the book's size read from disk.
  "apps/api/test/package.test.ts", // 24
  "apps/api/test/package-cli.test.ts", // 7
  "apps/api/test/installed.test.ts", // 8
  "apps/api/test/capacity.test.ts", // 18
  // An agent's whole path through the command line, and the question set.
  "apps/mcp/test/cli-path.test.ts", // 59
  "apps/mcp/test/questions.test.ts", // 11
  // The boundary checker's own tests, on sample repositories (the check itself runs on the real code in every gate).
  "scripts/repository.test.ts", // 11 alone
] as const;
