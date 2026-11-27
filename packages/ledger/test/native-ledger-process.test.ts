import { expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { evaluateOutcomePayload } from "../src/outcome-payload.ts";
import { activation, genesis, posting } from "./fixtures.ts";

async function child(path: string, mode: string, crash: string, kind: string) {
  const process = Bun.spawn(
    [
      Bun.which("bun") ?? "bun",
      join(import.meta.dir, "native-ledger-process-worker.ts"),
      path,
      mode,
      crash,
      kind,
    ],
    { stdout: "pipe", stderr: "pipe" },
  );
  const [stdout, stderr, exit] = await Promise.all([
    new Response(process.stdout).text(),
    new Response(process.stderr).text(),
    process.exited,
  ]);
  return { stdout, stderr, exit, signal: process.signalCode };
}
for (const kind of ["commit", "reject"]) {
  const cuts = ["INSERT INTO ledger_native_outcomes", "UPDATE ledger_native_book", "after-commit"];
  if (kind === "commit") cuts.push("INSERT INTO ledger_native_facts");
  for (const cut of cuts)
    test(`native ${kind} recovers after SIGKILL at ${cut}`, async () => {
      const directory = mkdtempSync(join(tmpdir(), "rastrata-native-kill-"));
      const path = join(directory, "book.sqlite");
      try {
        const initial = await child(path, "provision", "", kind);
        expect(initial.exit).toBe(0);
        const killed = await child(path, "execute", cut, kind);
        expect(killed.signal).toBe("SIGKILL");
        expect(killed.stdout).toBe("");
        const reopened = await child(path, "execute", "", kind);
        expect(reopened.exit).toBe(0);
        expect(reopened.stderr).toBe("");
        const value = JSON.parse(reopened.stdout);
        expect(value.disposition).toBe(
          cut === "after-commit" ? "replayed" : kind === "commit" ? "committed" : "rejected",
        );
        expect(value.outcomeSequence).toBe("2");
        expect(value.head.sequence).toBe("2");
        expect(value.head.bookRevision).toBe(kind === "commit" ? "2" : "1");
        expect(value.count).toEqual({ count: 2 });
        expect(value.integrity).toEqual({ integrity_check: "ok" });
        const active = evaluateOutcomePayload(genesis(), activation()).transition;
        const expected = evaluateOutcomePayload(
          { state: active.state, protocol: active.protocol },
          posting("crash-command", kind === "reject" ? 0n : 1n),
        );
        expect(value.encoded).toBe(expected.encoded);
      } finally {
        rmSync(directory, { recursive: true, force: true });
      }
    }, 30000);
}
