import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { inspectFile } from "../../src/intake/inspect.ts";

/** The statements lane's fixtures were written by another lane, from how each bank documents its
 * export. Scanning them is an independent check of the role guess: nothing in the heuristics was
 * tuned to a file the intake lane did not make, except where this test says so. */

const dir = join(import.meta.dir, "../statements/fixtures");

// kind, role, confidence. A statement that does not say whether it is a card's is a bank's with low
// confidence (American Express's three columns could be any bank's), and the plan, which knows the
// account, is what decides.
const EXPECTED: Record<string, readonly [string, string, string]> = {
  "amex-basic.csv": ["csv", "bank_statement", "low"],
  "amex-extended.csv": ["csv", "card_statement", "medium"],
  "bofa-card.csv": ["csv", "card_statement", "medium"],
  "bofa-checking.csv": ["csv", "bank_statement", "medium"],
  "capital-one-bank.csv": ["csv", "bank_statement", "medium"],
  "capital-one-card.csv": ["csv", "card_statement", "medium"],
  "chase-card.csv": ["csv", "card_statement", "medium"],
  "chase-card.qfx": ["qfx", "card_statement", "high"],
  "chase-checking.csv": ["csv", "bank_statement", "medium"],
  "chase-checking.qfx": ["qfx", "bank_statement", "high"],
  "citi-card-negative-credit.csv": ["csv", "card_statement", "medium"],
  "citi-card.csv": ["csv", "card_statement", "medium"],
  "generic-ofx2.ofx": ["ofx", "bank_statement", "high"],
  // Mercury's export names the debit card ("Name On Card"); its own preset says it is a bank's.
  "mercury.csv": ["csv", "bank_statement", "medium"],
  "rho-card.csv": ["csv", "bank_statement", "low"],
  "rho-checking.csv": ["csv", "bank_statement", "medium"],
  "schwab-bank.csv": ["csv", "bank_statement", "medium"],
  "us-bank.csv": ["csv", "bank_statement", "medium"],
  "wells-fargo.csv": ["csv", "bank_statement", "low"],
};

test("the statements lane's fixtures are typed and given the role their banks' exports have", () => {
  for (const [name, [kind, role, confidence]] of Object.entries(EXPECTED)) {
    const facts = inspectFile(new Uint8Array(readFileSync(join(dir, name))), {
      name,
      today: "2026-12-31",
    });
    expect([name, facts.kind, facts.role, facts.confidence], name).toEqual([
      name,
      kind,
      role,
      confidence,
    ]);
    expect(facts.parsed, name).toBe(true);
  }
});

test("a file a preset reads needs nothing, one it cannot read alone needs a recipe, and balances are reported", () => {
  const read = (name: string) =>
    inspectFile(new Uint8Array(readFileSync(join(dir, name))), { name, today: "2026-12-31" });
  for (const name of ["chase-checking.csv", "bofa-checking.csv", "schwab-bank.csv", "mercury.csv"])
    expect(read(name).need, name).toBe("none");
  // A card issuer's layout the presets do not know is read by detection, with pending lines it cannot filter.
  expect(read("rho-card.csv").need).toBe("recipe");
  // Chase's own running balance is the proof of a checking export; a card export has none.
  expect(read("chase-checking.csv").statement?.balance).toBe("running");
  expect(read("chase-card.csv").statement?.balance).toBe("none");
  // An OFX file reports its closing balance and the opening is worked out from the lines.
  const ofx = read("chase-checking.qfx").statement;
  expect(ofx?.balance).toBe("reported");
  expect(ofx?.opening).toBeString();
});
