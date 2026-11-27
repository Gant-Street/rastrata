import { describe, expect, test } from "bun:test";
import * as kernel from "../src/index.ts";
import golden from "./data/validation-golden.json";
import { TAMPERS, observeScenario } from "./validation-scenarios.ts";

/**
 * The validators that run when a book enters the kernel from outside (`validateBookState`,
 * `validateBookProtocol`, and so `decodeDurableBook`) were rewritten to read the history once instead
 * of once per revision or per retained result. The table in data/validation-golden.json was produced
 * by running these very scenarios against the kernel before that rewrite: books without the state
 * commitment profile against the base kernel, books with it against the kernel that introduced the
 * profile. Every observable must be unchanged: each command's disposition and result hash, each
 * state's content hash, the durable encoding of the finished book (so a book keeps its exact bytes),
 * and the exact diagnostics of both validators on the book and on two tampered copies of each of 23
 * kinds.
 */
const EMPTY_LIST = new Bun.CryptoHasher("sha256").update("[]").digest("hex");

for (const kind of ["legacy", "profiled"] as const) {
  const table = golden[kind];
  describe(`the single-pass validators say what they said: books ${kind === "legacy" ? "without" : "with"} the state commitment profile`, () => {
    for (const [seed, expected] of Object.entries(table.scenarios)) {
      test(`scenario ${seed}: ${golden.steps} random commands, then 23 kinds of tampering`, () => {
        const observed = observeScenario(kernel, Number(seed), golden.steps, kind === "profiled");
        expect(Object.keys(observed)).toEqual(Object.keys(expected));
        for (const [key, digest] of Object.entries(expected)) expect(observed[key], `${seed} ${key}`).toBe(digest);
      });
    }

    test("the golden table is a real test: a valid book passes and most tampered copies are flagged", () => {
      const valid = observeScenario(kernel, 1, golden.steps, kind === "profiled");
      expect(valid.stateDiagnostics).toBe(EMPTY_LIST);
      expect(valid.protocolDiagnostics).toBe(EMPTY_LIST);
      expect(TAMPERS).toHaveLength(23);
      let flagged = 0;
      let total = 0;
      for (const row of Object.values(table.scenarios)) {
        for (const [key, digest] of Object.entries(row)) {
          if (!key.includes("#")) continue;
          total += 1;
          if (digest !== EMPTY_LIST) flagged += 1;
        }
      }
      expect(total).toBe(6 * 23 * 2 * 2);
      expect(flagged / total).toBeGreaterThan(0.5);
    });
  });
}

describe("the two tables describe different books", () => {
  test("the same commands give different state hashes and encodings with and without the profile", () => {
    const without = golden.legacy.scenarios["1"] as Record<string, string>;
    const withProfile = golden.profiled.scenarios["1"] as Record<string, string>;
    expect(without.steps).not.toBe(withProfile.steps);
    expect(without.encoded).not.toBe(withProfile.encoded);
  });
});
