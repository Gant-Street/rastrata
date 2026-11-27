import { afterEach, expect, test } from "bun:test";
import {
  BOOK,
  closeFixtures,
  type Fixture,
  ingestFixture,
  type Json,
} from "./support/ingest-fixture.ts";

afterEach(closeFixtures);

const uuid = () => crypto.randomUUID();

// Hidden characters are built, never typed, so this file stays plain text a reviewer can read.
const OVERRIDE = String.fromCodePoint(0x202e);
const ZERO_WIDTH = String.fromCodePoint(0x200b);

const update = async (f: Fixture, input: unknown, operationId = uuid()) => {
  const reply = await f.call("book.update", input, operationId);
  expect(reply.body.ok, JSON.stringify(reply.body)).toBe(true);
  return reply.body.data as Json;
};
const context = async (f: Fixture): Promise<Json> => (await f.call("book.get", {})).body.data;

const DEFAULTS = { dateFormat: "medium", showAccountNumbers: false, acceptMode: "post" };

test("a configured book reads its default settings, and a book not yet set up has none", async () => {
  const empty = await ingestFixture({ setup: false });
  const before = await context(empty);
  expect(before.setup).toBeNull();
  expect(before.settings).toBeUndefined();
  const refused = await empty.call("book.update", { name: "Nobody" }, uuid());
  expect(refused.status).toBe(409);
  expect(refused.body.error.code).toBe("book_not_configured");

  const f = await ingestFixture();
  const book = await context(f);
  expect(book.setup.name).toBe(BOOK.name);
  expect(book.settings).toEqual(DEFAULTS);
});

test("renaming the business reaches everything that reads the name", async () => {
  const f = await ingestFixture();
  const result = await update(f, { name: "Willow Lane Studio" });
  expect(result).toEqual({
    name: "Willow Lane Studio",
    settings: DEFAULTS,
    changed: ["name"],
    previousName: BOOK.name,
  });
  const book = await context(f);
  expect(book.setup.name).toBe("Willow Lane Studio");
  // Only the name moved: the rest of the setup is the book as it was created.
  expect(book.setup).toEqual({
    ...BOOK,
    name: "Willow Lane Studio",
    basis: "accrual",
    fiscalYearStartMonth: 1,
    calendarThrough: expect.any(Number),
  });
  expect((await f.call("journal.list", {})).body.data.context.bookName).toBe("Willow Lane Studio");
  const exported = await f.call("reports.export", {
    statement: "trial-balance",
    asOf: "2026-03-31",
  });
  expect(exported.body.ok, JSON.stringify(exported.body)).toBe(true);
  expect(JSON.stringify(exported.body.data)).toContain("Willow Lane Studio");
  expect(JSON.stringify(exported.body.data)).not.toContain(BOOK.name);
});

test("the display settings are saved, read back and kept across a restart", async () => {
  const f = await ingestFixture();
  const saved = await update(f, {
    dateFormat: "numeric",
    showAccountNumbers: true,
    acceptMode: "draft",
  });
  expect(saved.settings).toEqual({
    dateFormat: "numeric",
    showAccountNumbers: true,
    acceptMode: "draft",
  });
  expect(saved.changed).toEqual(["dateFormat", "showAccountNumbers", "acceptMode"]);
  expect(saved.previousName).toBeNull();
  expect(saved.name).toBe(BOOK.name);
  expect((await context(f)).settings).toEqual(saved.settings);

  // One setting at a time leaves the others alone.
  const one = await update(f, { dateFormat: "iso" });
  expect(one.settings).toEqual({
    dateFormat: "iso",
    showAccountNumbers: true,
    acceptMode: "draft",
  });
  expect(one.changed).toEqual(["dateFormat"]);

  await f.restart();
  expect((await context(f)).settings).toEqual(one.settings);
  const back = await update(f, { acceptMode: "post", showAccountNumbers: false });
  expect(back.settings).toEqual({
    dateFormat: "iso",
    showAccountNumbers: false,
    acceptMode: "post",
  });
});

test("asking for what is already so changes nothing and says so", async () => {
  const f = await ingestFixture();
  const same = await update(f, { name: BOOK.name, dateFormat: "medium", acceptMode: "post" });
  expect(same.changed).toEqual([]);
  expect(same.previousName).toBeNull();
  expect(f.service.store.query("SELECT COUNT(*) AS n FROM app_book_changes").get()).toEqual({
    n: 0,
  });
  // A name that differs only in spacing is the same name once it is written the way it is stored.
  await update(f, { name: "  Willow   Lane  " });
  const again = await update(f, { name: "Willow Lane" });
  expect(again.changed).toEqual([]);
});

test("a retried update returns the first answer; the same identity for other input is a conflict", async () => {
  const f = await ingestFixture();
  const operationId = uuid();
  const first = await update(f, { name: "Willow Lane Studio", acceptMode: "draft" }, operationId);
  expect(first.changed).toEqual(["name", "acceptMode"]);
  // The retry is answered from the first call, so it still says what that call changed.
  const retry = await update(f, { name: "Willow Lane Studio", acceptMode: "draft" }, operationId);
  expect(retry).toEqual(first);
  const conflict = await f.call("book.update", { name: "Another Name" }, operationId);
  expect(conflict.status).toBe(409);
  expect(conflict.body.error.code).toBe("operation_identity_conflict");
  expect((await context(f)).setup.name).toBe("Willow Lane Studio");
  // Every real change is on the record once.
  expect(f.service.store.query("SELECT COUNT(*) AS n FROM app_book_changes").get()).toEqual({
    n: 2,
  });
});

test("every change is recorded with who made it and what it was before", async () => {
  const f = await ingestFixture();
  await update(f, { name: "Willow Lane Studio", showAccountNumbers: true });
  const rows = f.service.store
    .query("SELECT actor, setting, before, after FROM app_book_changes ORDER BY seq")
    .all();
  expect(rows).toEqual([
    { actor: "owner", setting: "name", before: BOOK.name, after: "Willow Lane Studio" },
    { actor: "owner", setting: "showAccountNumbers", before: "false", after: "true" },
  ]);
});

test("a name is one line of plain text, and nonsense is refused before anything changes", async () => {
  const f = await ingestFixture();
  const clean = await update(f, { name: `  Acme${OVERRIDE}${ZERO_WIDTH}   Studio\n(2026)\t` });
  expect(clean.name).toBe("Acme Studio (2026)");

  const refuse = async (input: unknown, code = "invalid_input") => {
    const reply = await f.call("book.update", input, uuid());
    expect(reply.body.ok, JSON.stringify(input)).toBe(false);
    expect(reply.body.error.code, JSON.stringify(input)).toBe(code);
    expect(reply.status).toBe(400);
  };
  await refuse({});
  await refuse({ name: "A" });
  await refuse({ name: "   " });
  await refuse({ name: ZERO_WIDTH.repeat(3) });
  await refuse({ name: "x".repeat(121) });
  await refuse({ name: 42 });
  await refuse({ dateFormat: "long" });
  await refuse({ acceptMode: "both" });
  await refuse({ showAccountNumbers: "yes" });
  await refuse({ currency: "EUR" });
  await refuse({ fiscalYear: 2027 });
  expect((await context(f)).setup.name).toBe("Acme Studio (2026)");
});

test("changing the book needs the permission to configure it, and nothing else", async () => {
  const f = await ingestFixture();
  const denied = await f.call("book.update", { name: "Nope Co" }, uuid(), [
    "read",
    "draft",
    "post",
    "correct",
    "close",
  ]);
  expect(denied.status).toBe(403);
  expect(denied.body.error.code).toBe("permission_denied");
  expect((await context(f)).setup.name).toBe(BOOK.name);
  const allowed = await f.call("book.update", { name: "Yes Co" }, uuid(), ["read", "configure"]);
  expect(allowed.body.ok, JSON.stringify(allowed.body)).toBe(true);
  // Reading the settings is reading: it needs read and no more.
  const read = await f.call("book.get", {}, undefined, ["read"]);
  expect(read.body.data.settings).toEqual(DEFAULTS);
  expect(read.body.data.setup.name).toBe("Yes Co");
});

test("the ledger is untouched by a rename or a setting", async () => {
  const f = await ingestFixture();
  const before = (await context(f)).head;
  await update(f, { name: "Willow Lane Studio", dateFormat: "iso", acceptMode: "draft" });
  expect((await context(f)).head).toEqual(before);
});

test("setting the book up again with the original name is refused once it has been renamed", async () => {
  const f = await ingestFixture();
  // Before a rename the same setup is the same book: setting it up again changes nothing.
  const same = await f.call("book.setup", BOOK, uuid());
  expect(same.body.ok, JSON.stringify(same.body)).toBe(true);
  await update(f, { name: "Willow Lane Studio" });
  const refused = await f.call("book.setup", BOOK, uuid());
  expect(refused.status).toBe(409);
  expect(refused.body.error.code).toBe("book_configuration_conflict");
  expect((await context(f)).setup.name).toBe("Willow Lane Studio");
});
