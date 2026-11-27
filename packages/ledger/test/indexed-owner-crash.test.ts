import { expect, test } from "bun:test";
import { mkdtempSync, rmSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  canonicalAccountingValue,
  canonicalEncode,
  encodeDurableBook,
  executeBookCommand,
} from "@rastrata/kernel";
import { activation, genesis, posting } from "./fixtures.ts";

async function run(path: string, operation: string, point: string, kind: string) {
  const child = Bun.spawn(
    [
      process.execPath,
      join(import.meta.dir, "indexed-owner-process-worker.ts"),
      path,
      operation,
      point,
      kind,
    ],
    { stdout: "pipe", stderr: "pipe" },
  );
  let timedOut = false;
  const timer = setTimeout(() => {
    timedOut = true;
    child.kill();
  }, 45000);
  try {
    const [exit, out, err] = await Promise.all([
      child.exited,
      new Response(child.stdout).text(),
      new Response(child.stderr).text(),
    ]);
    expect(timedOut).toBe(false);
    return { exit, out, err, signal: child.signalCode };
  } finally {
    clearTimeout(timer);
  }
}
function decoded(result: Awaited<ReturnType<typeof run>>) {
  expect({ exit: result.exit, err: result.err }).toEqual({ exit: 0, err: "" });
  return JSON.parse(result.out) as {
    snapshot: string;
    sequence: string;
    headHash: string;
    disposition: string | null;
    outcomeSequence: string | null;
    original: string | null;
  };
}

for (const kind of ["commit", "reject"] as const) {
  test(`new indexed owner SIGKILL preserves atomic roots and original ${kind} outcomes`, async () => {
    const initial = genesis();
    const activationResult = executeBookCommand(initial.state, initial.protocol, activation());
    const before = { state: activationResult.state, protocol: activationResult.protocol };
    const command = posting(
      kind === "commit" ? "crash-sale" : "crash-stale",
      kind === "commit" ? 1n : 0n,
    );
    const transition = executeBookCommand(before.state, before.protocol, command);
    const expected = { state: transition.state, protocol: transition.protocol };
    const original = new TextDecoder().decode(
      canonicalEncode(canonicalAccountingValue(transition.result)),
    );
    for (const point of ["root", "pin", "committed"]) {
      const directory = mkdtempSync(join(tmpdir(), "rastrata-indexed-owner-crash-"));
      const path = join(directory, "book.sqlite");
      try {
        const initialized = decoded(await run(path, "initialize", "none", kind));
        expect(initialized.snapshot).toBe(encodeDurableBook(before));
        const killed = await run(path, "execute", point, kind);
        expect(killed.signal).toBe("SIGKILL");
        expect(killed.err).toBe(`REACHED:${point}\n`);
        expect(killed.out).toBe(""); // No client receipt before the crash.
        const recovered = decoded(await run(path, "read", "none", kind));
        expect(recovered.sequence).toBe(point === "committed" ? "2" : "1");
        expect(recovered.snapshot).toBe(
          encodeDurableBook(point === "committed" ? expected : before),
        );
        if (point !== "committed") expect(recovered.headHash).toBe(initialized.headHash);
        const retried = decoded(await run(path, "execute", "none", kind));
        expect(retried.snapshot).toBe(encodeDurableBook(expected));
        expect(retried.sequence).toBe("2");
        expect(retried.outcomeSequence).toBe("2");
        expect(retried.original).toBe(original);
        expect(retried.disposition).toBe(
          point === "committed" ? "replayed" : kind === "commit" ? "committed" : "rejected",
        );
        const repeated = decoded(await run(path, "execute", "none", kind));
        expect(repeated.disposition).toBe("replayed");
        expect(repeated.original).toBe(original);
        expect(repeated.snapshot).toBe(retried.snapshot);
      } finally {
        rmSync(directory, { recursive: true, force: true });
      }
    }
  }, 90000);
}

test("indexed-owner crash driver rejects invalid target scope and hooks before opening SQLite", async () => {
  const directory = mkdtempSync(join(tmpdir(), "rastrata-indexed-owner-crash-"));
  try {
    const wrong = join(directory, "wrong.sqlite");
    const rejected = await run(wrong, "initialize", "none", "commit");
    expect(rejected.exit).not.toBe(0);
    expect(rejected.err).toContain("Invalid isolated indexed-owner process arguments");
    expect(existsSync(wrong)).toBe(false);
    const path = join(directory, "book.sqlite");
    const unknown = await run(path, "execute", "unknown-hook", "commit");
    expect(unknown.exit).not.toBe(0);
    expect(unknown.err).toContain("Invalid isolated indexed-owner process arguments");
    expect(existsSync(path)).toBe(false);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});
