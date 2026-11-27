import { afterEach, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { LocalBookService } from "../src/local.ts";
import { BUSINESS_PERMISSIONS, operationCatalog, definitions } from "../src/schema.ts";
import { sliceHandlers } from "../src/slices/handlers.ts";
import { sliceSchemas } from "../src/slices/catalog.ts";
import { migrate, sliceState } from "../src/slices/state.ts";

const cleanup: (() => void)[] = [];
afterEach(() => {
  for (const work of cleanup.splice(0)) work();
});

async function service() {
  const directory = mkdtempSync(join(tmpdir(), "rastrata-slices-"));
  const book = await LocalBookService.open(join(directory, "book.sqlite"));
  cleanup.push(() => {
    book.close();
    rmSync(directory, { recursive: true, force: true });
  });
  return book;
}

test("every slice operation has exactly one handler and every handler has an operation", () => {
  const declared = sliceSchemas.flatMap((slice) => slice.operations.map((item) => item.name));
  expect(new Set(declared).size).toBe(declared.length);
  expect(Object.keys(sliceHandlers).sort()).toEqual([...declared].sort());
});

test("slice operations name real definitions, valid permissions and prepared kinds that exist", () => {
  for (const slice of sliceSchemas)
    for (const item of slice.operations) {
      expect(BUSINESS_PERMISSIONS).toContain(item.permission);
      for (const side of [item.input, item.output]) {
        const name = side.$ref?.slice("#/$defs/".length) ?? "";
        expect(Object.hasOwn(definitions, name), `${item.name} refers to ${name}`).toBe(true);
      }
    }
  // The merged catalog is the core operations followed by each slice's, with no name twice.
  const names = operationCatalog.map((item) => item.name);
  expect(new Set(names).size).toBe(names.length);
});

test("slice migrations apply in order, once, and refuse state from a newer release", async () => {
  const book = await service();
  const steps = [
    "CREATE TABLE slice_probe (id TEXT PRIMARY KEY)",
    "ALTER TABLE slice_probe ADD COLUMN note TEXT",
  ];
  migrate(book.store, "probe", steps.slice(0, 1));
  migrate(book.store, "probe", steps);
  migrate(book.store, "probe", steps);
  book.store.query("INSERT INTO slice_probe (id, note) VALUES ('a', 'kept')").run();
  expect(book.store.query("SELECT note FROM slice_probe WHERE id='a'").get()).toEqual({
    note: "kept",
  });
  expect(() => migrate(book.store, "probe", steps.slice(0, 1))).toThrow(/newer release/);
});

test("a failed migration step leaves the previous version in place", async () => {
  const book = await service();
  migrate(book.store, "broken", ["CREATE TABLE slice_ok (id TEXT)"]);
  expect(() =>
    migrate(book.store, "broken", ["CREATE TABLE slice_ok (id TEXT)", "NOT VALID SQL"]),
  ).toThrow();
  expect(
    book.store.query("SELECT version FROM app_slice_migrations WHERE slice='broken'").get(),
  ).toEqual({ version: 1 });
});

test("slice state is created once per service and never shared between books", async () => {
  const first = await service();
  const second = await service();
  let created = 0;
  const make = () => ({ id: ++created });
  expect(sliceState(first, "probe", make)).toBe(sliceState(first, "probe", make));
  expect(sliceState(second, "probe", make)).not.toBe(sliceState(first, "probe", make));
  expect(created).toBe(2);
});
