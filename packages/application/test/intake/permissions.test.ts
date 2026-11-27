import { afterEach, expect, test } from "bun:test";
import { INTAKE_PERMISSIONS } from "../../src/intake/sets.ts";
import {
  BUSINESS_PERMISSIONS,
  type BusinessPermission,
  operationCatalog,
} from "../../src/schema.ts";
import { closingOf, openingOf } from "../support/intake-corpus.ts";
import { corpusFixture, type CorpusFixture, M1, money } from "./fixture.ts";

/** Which scope each operation of the intake needs, decided once and held here: the permission each
 * operation declares is the one in the table, nothing needs post, configure, correct, close or
 * provision, and a token that holds everything but the scope is refused. */

const open: CorpusFixture[] = [];
afterEach(() => {
  for (const fixture of open.splice(0)) fixture.close();
});

test("the lane's operations and the table of scopes are the same list", () => {
  const declared = Object.fromEntries(
    operationCatalog
      .filter((operation) => operation.name.startsWith("intake."))
      .map((operation) => [operation.name, operation.permission]),
  );
  expect(declared).toEqual(INTAKE_PERMISSIONS);
  // Reads read, and the only writes are a draft: nothing here posts, configures, corrects or closes.
  for (const operation of operationCatalog.filter((item) => item.name.startsWith("intake."))) {
    expect(["read", "draft"], operation.name).toContain(operation.permission);
    expect(operation.writes, operation.name).toBe(operation.permission === "draft");
  }
});

test("a token that holds every scope but the one an operation needs is refused", async () => {
  const c = await corpusFixture();
  open.push(c);
  const source = c.source("juniper-card");
  const sha = await c.upload(c.fileFor(source, M1));
  const balances = {
    openingBalance: money(openingOf(source, M1)),
    endingBalance: money(closingOf(source, M1)),
  };
  const inputs: Record<string, unknown> = {
    "intake.scan": { files: [sha] },
    "intake.plan": { sources: [{ account: source.code, files: [sha] }] },
    "intake.recipeTest": { sha256: sha, recipe: source.recipe, ...balances },
    "intake.recipeSave": { recipe: source.recipe, proofs: [{ sha256: sha, ...balances }] },
    "intake.recipeList": {},
    "intake.trialBalance": { sha256: sha },
    "intake.friction": { events: [{ kind: "note", reason: "a note" }] },
    "intake.frictionList": {},
    "intake.status": {},
  };
  expect(Object.keys(inputs).sort()).toEqual(Object.keys(INTAKE_PERMISSIONS).sort());
  for (const [name, needs] of Object.entries(INTAKE_PERMISSIONS)) {
    const others = BUSINESS_PERMISSIONS.filter((scope) => scope !== needs) as BusinessPermission[];
    const refused = await c.f.call(name, inputs[name], crypto.randomUUID(), others);
    expect(refused.status, `${name} without ${needs}`).toBe(403);
    expect(refused.body.error.code, name).toBe("permission_denied");
    const allowed = await c.f.call(name, inputs[name], crypto.randomUUID(), [needs]);
    expect(allowed.status, `${name} with only ${needs}: ${JSON.stringify(allowed.body)}`).toBe(200);
  }
});
