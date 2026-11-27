import { expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import type { EntryInfo } from "../src/runtime.ts";

/** The application's own acceptance story (a founder's first month: statements, Stripe, the Inbox,
 * reconciliation, backups, a restart, an agent with a token) is run with its book served from the
 * log instead of a file. Its several thousand assertions are the application's, unchanged; what this
 * adds is that the storage cannot be told apart, and that a process holding only the log ends with
 * the same book as the live one (the backend checks that when the world closes).
 *
 * It also holds the accounting to two rules the cost of the log depends on: a read waits for an
 * append only when it is an agent token's (its audit row is on record before the answer), and the
 * owner's reads never do (what they write is carried by the next write or by a timer); and a read
 * never changes the schema (every slice's tables are made when the book is opened). */
test("the first-month acceptance story passes unchanged on a book in the log", async () => {
  const root = resolve(import.meta.dir, "../../..");
  const story = "packages/application/test/acceptance/first-month.test.ts";
  const directory = mkdtempSync(join(tmpdir(), "booklog-acceptance-"));
  const accounts = join(directory, "account.jsonl");
  try {
    const run = Bun.spawn([process.execPath, "test", "--timeout", "120000", story], {
      cwd: root,
      env: {
        ...process.env,
        ACCEPTANCE_BACKEND: resolve(import.meta.dir, "support/acceptance-backend.ts"),
        ACCEPTANCE_ACCOUNT_FILE: accounts,
      },
      stdout: "pipe",
      stderr: "pipe",
    });
    const [out, err, code] = await Promise.all([
      new Response(run.stdout).text(),
      new Response(run.stderr).text(),
      run.exited,
    ]);
    const output = `${out}\n${err}`;
    expect(code, output.slice(-4000)).toBe(0);
    expect(output).toMatch(/\b17 pass\b/);
    expect(output).toMatch(/\b0 fail\b/);

    const lines = readFileSync(accounts, "utf8")
      .split("\n")
      .filter(Boolean)
      .map((line) => JSON.parse(line) as Record<string, unknown>);
    // A world that could not be closed and checked says so here (the story's world swallows the error).
    expect(lines.filter((line) => "error" in line)).toEqual([]);
    const worlds = lines as unknown as {
      world: number;
      entries: EntryInfo[];
      readFlushes: number;
      commits: number;
    }[];
    expect(worlds.length).toBeGreaterThanOrEqual(5);
    for (const world of worlds) {
      const label = `world ${world.world}`;
      // A read that had to be logged before its answer is an agent token's (its audit row); nothing
      // else makes a person wait for the tail.
      const first = world.entries.filter(
        (entry) => entry.cause === "read" && entry.label !== "(deferred)",
      );
      expect(world.readFlushes, label).toBe(first.length);
      for (const entry of first) {
        const changed = Object.entries(entry.tables)
          .filter(([, n]) => n.insert + n.update + n.delete + n.replace > 0)
          .map(([name]) => name);
        expect(
          changed.length > 0 && changed.every((name) => name.startsWith("agent_")),
          label,
        ).toBe(true);
        expect(entry.ddl, label).toBe(0);
      }
      // No entry caused by a read changed the schema; the schema changes when the book is opened and set up.
      expect(
        world.entries.filter((entry) => entry.cause === "read" && entry.ddl > 0),
        label,
      ).toEqual([]);
      expect(world.entries.length, label).toBe(world.commits);
    }
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
}, 300_000);
