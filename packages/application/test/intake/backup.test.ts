import { afterEach, expect, test } from "bun:test";
import { join } from "node:path";
import { ApplicationHttp } from "../../src/http.ts";
import { LocalBookService } from "../../src/local.ts";
import { restoreBackup } from "../../src/local/restore.ts";
import { APPLICATION_API_VERSION, BUSINESS_PERMISSIONS } from "../../src/schema.ts";
import { closingOf, openingOf } from "../support/intake-corpus.ts";
import { corpusFixture, type CorpusFixture, type Json, M1, money } from "./fixture.ts";

/** The friction log and the recipes are kept in the book's own database, which is why a backup
 * holds them and a restore brings them back: one snapshot is the whole product. */

const open: CorpusFixture[] = [];
afterEach(() => {
  for (const fixture of open.splice(0)) fixture.close();
});

test("a backup holds the friction log and the recipes, and a restored book has them", async () => {
  const c = await corpusFixture();
  open.push(c);
  const source = c.source("juniper-card");
  const sha = await c.upload(c.fileFor(source, M1));
  const balances = {
    openingBalance: money(openingOf(source, M1)),
    endingBalance: money(closingOf(source, M1)),
  };
  const saved = await c.f.call(
    "intake.recipeSave",
    { recipe: source.recipe, proofs: [{ sha256: sha, ...balances }] },
    crypto.randomUUID(),
  );
  expect(saved.status, JSON.stringify(saved.body)).toBe(200);
  const logged = await c.f.call(
    "intake.friction",
    {
      events: [
        { kind: "scan", source: "folder", reason: "scanned the folder" },
        {
          kind: "coverage_gap",
          source: "1010",
          reason: "no statement for June",
          key: "coverage:1010:2026-06",
        },
      ],
    },
    crypto.randomUUID(),
  );
  expect(logged.status).toBe(200);

  const host = c.f.service.host.safety;
  if (!host) throw new Error("no safety host");
  const made = await host.createBackup("manual", new Date());
  // The manifest names the lane, so a restore knows what wrote the file.
  expect(Object.keys(made.manifest.application.stores)).toContain("intake");

  const target = join(c.f.path, "..", "restored", "book.sqlite");
  await restoreBackup({
    backup: made.manifest.id,
    to: target,
    backupDirectory: host.directories.backups,
    quick: true,
  });
  const book = await LocalBookService.open(target, { safety: false });
  try {
    const http = new ApplicationHttp(book, {
      bookId: book.bookId,
      permissions: BUSINESS_PERMISSIONS,
    });
    const call = async (name: string, input: unknown = {}) => {
      const response = await http.fetch(
        new Request(`http://127.0.0.1:4010/v1/${name}`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ version: APPLICATION_API_VERSION, bookId: book.bookId, input }),
        }),
      );
      return response.json() as Promise<{ data: Json }>;
    };
    const log = (await call("intake.frictionList")).data;
    expect(log.count).toBe(2);
    expect(log.events.map((event: { kind: string }) => event.kind)).toEqual([
      "scan",
      "coverage_gap",
    ]);
    expect((await call("intake.status")).data.unresolvedGaps).toBe(1);
    const recipes = (await call("intake.recipeList")).data.recipes;
    expect(recipes).toMatchObject([{ name: source.recipe?.name, revision: 1 }]);
    expect((await call("import.profileList")).data.profiles).toHaveLength(1);
  } finally {
    book.close();
  }
}, 120_000);
