import { expect, test } from "bun:test";
import { distribution, widePosting } from "../scripts/local-profile.ts";
import { executeBookCommand } from "@rastrata/kernel";
import { activation, genesis } from "./fixtures.ts";

test("profile distributions retain slow samples and reject invalid populations", () => {
  expect(distribution([1, 2, 3, 100])).toEqual({
    count: 4,
    mean: 26.5,
    p50: 3,
    p95: 100,
    p99: 100,
    max: 100,
  });
  for (const invalid of [[], [Number.NaN], [-1], [Infinity]])
    expect(() => distribution(invalid)).toThrow();
});

test("wide journal profiles use admitted balanced transactions, not fabricated SQL rows", () => {
  const initial = genesis(),
    active = executeBookCommand(initial.state, initial.protocol, activation());
  for (const lines of [2, 20, 100]) {
    const command = widePosting("wide", 1n, lines);
    expect(command.type === "postJournal" && command.resolved.journal.postings.length).toBe(lines);
    expect(executeBookCommand(active.state, active.protocol, command).result.disposition).toBe(
      "committed",
    );
  }
  expect(() => widePosting("invalid", 1n, 3)).toThrow();
});

test("local campaign smoke-verifies every workflow, bounded overload and raw sample totals", async () => {
  const child = Bun.spawn(
    [process.execPath, new URL("../scripts/local-profile.ts", import.meta.url).pathname, "--quick"],
    { stdout: "pipe", stderr: "pipe" },
  );
  const [stdout, stderr, exit] = await Promise.all([
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
    child.exited,
  ]);
  expect({ exit, error: exit === 0 ? "" : stderr }).toEqual({ exit: 0, error: "" });
  const report = JSON.parse(stdout);
  expect(report.quick).toBe(true);
  expect(report.results).toHaveLength(19);
  expect(report.results.filter((r: { name: string }) => r.name === "paced-books-100")).toHaveLength(
    1,
  );
  for (const row of report.results) {
    if (row.name === "paced-books-100") {
      expect(row).toMatchObject({
        books: 100,
        accountsPerBook: 2,
        offeredPerSecond: 100,
        completed: 200,
      });
      expect(row.observations).toHaveLength(200);
      for (const [index, observation] of row.observations.entries()) {
        expect(observation.index).toBe(index);
        expect(observation.latenessMs).toBeGreaterThanOrEqual(0);
        expect(observation.serviceMs).toBeGreaterThanOrEqual(0);
        expect(observation.scheduledResponseMs).toBeGreaterThanOrEqual(observation.serviceMs);
        expect(observation.sql).toBe(7);
      }
      expect(row.scheduledResponseMs).toEqual(
        distribution(
          row.observations.map((s: { scheduledResponseMs: number }) => s.scheduledResponseMs),
        ),
      );
      expect(row.cpuCoreEquivalent).toBe(row.cpuMs / row.elapsedMs);
      expect(row.localTargets.lessThanOneCpuCore).toBe(row.cpuCoreEquivalent < 1);
      expect(row.localTargets.scheduledP95Below50Ms).toBe(row.scheduledResponseMs.p95 < 50);
      continue;
    }
    expect(
      Object.values(row.byKind).reduce(
        (n: number, value) => n + (value as { wallMs: { count: number } }).wallMs.count,
        0,
      ),
    ).toBe(row.samples.length);
    expect(
      row.samples.every(
        (s: { cpuMs: number; sql: number }) => Number.isFinite(s.cpuMs) && s.sql >= 0,
      ),
    ).toBe(true);
  }
  expect(report.results.find((r: { name: string }) => r.name === "same-book-32")).toMatchObject({
    committed: 16,
    overloaded: 16,
  });
}, 60000);

test("targeted profiling selects one case and refuses an empty campaign", async () => {
  for (const name of ["chart-1000", "unknown"]) {
    const child = Bun.spawn(
      [
        process.execPath,
        new URL("../scripts/local-profile.ts", import.meta.url).pathname,
        "--quick",
        `--case=${name}`,
      ],
      { stdout: "pipe", stderr: "pipe" },
    );
    const [stdout, stderr, exit] = await Promise.all([
      new Response(child.stdout).text(),
      new Response(child.stderr).text(),
      child.exited,
    ]);
    if (name === "unknown") {
      expect(exit).not.toBe(0);
      expect(stderr).toContain("Unknown profiling case");
    } else {
      expect({ exit, error: exit === 0 ? "" : stderr }).toEqual({ exit: 0, error: "" });
      const report = JSON.parse(stdout);
      expect(report.results.map((row: { name: string }) => row.name)).toEqual([name]);
      expect(report.results[0].samples[0].sql).toBe(14);
      expect(report.results[0].byKind.commit.sql.max).toBe(7);
    }
  }
}, 60000);
