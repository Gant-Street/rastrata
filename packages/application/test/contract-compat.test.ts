import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import {
  compareContracts,
  stableJson,
  viewOf,
  type ContractSnapshot,
  type ContractView,
} from "../src/contract-compat.ts";
import {
  APPLICATION_API_VERSION,
  PREPARED_OPERATION_PERMISSIONS,
  applicationSchema,
  definitions,
  operationCatalog,
} from "../src/schema.ts";
import type { Schema } from "../src/schema-kit.ts";

const root = resolve(import.meta.dir, "../../..");
const golden = JSON.parse(
  readFileSync(resolve(root, "packages/application/schema/contract-v1.golden.json"), "utf8"),
) as ContractSnapshot;

interface Vector {
  name: string;
  direction: "input" | "output";
  old: Schema;
  new: Schema;
  expect: "compatible" | "breaking";
  path?: string;
  definitions?: { old: Record<string, Schema>; new: Record<string, Schema> };
}
const vectors = JSON.parse(
  readFileSync(resolve(import.meta.dir, "fixtures/contract-compat-vectors.json"), "utf8"),
) as Vector[];

const empty: Schema = { type: "object", properties: {}, required: [], additionalProperties: false };
function probe(side: "old" | "new", vector: Vector): ContractView {
  const request = vector.direction === "input";
  return {
    contract: "probe",
    preparedPermissions: {},
    definitions: vector.definitions?.[side] ?? {},
    operations: {
      probe: {
        permission: "read",
        writes: false,
        input: request ? vector[side] : empty,
        output: request ? empty : vector[side],
      },
    },
  };
}

test("the shared vectors: what a frozen contract promised is judged the same way every time", () => {
  expect(vectors.length).toBeGreaterThan(50);
  for (const vector of vectors) {
    const result = compareContracts(probe("old", vector), probe("new", vector));
    if (vector.expect === "compatible") expect(result.breaking, vector.name).toEqual([]);
    else {
      expect(result.breaking.length, vector.name).toBeGreaterThan(0);
      if (vector.path)
        expect(
          result.breaking.map((finding) => finding.path),
          vector.name,
        ).toContain(vector.path);
    }
  }
});

test("a contract compared with itself is compatible and grew nowhere", () => {
  const view = viewOf(
    APPLICATION_API_VERSION,
    operationCatalog,
    definitions,
    PREPARED_OPERATION_PERMISSIONS,
  );
  const result = compareContracts(view, view);
  expect(result).toEqual({ breaking: [], added: [], extended: [] });
});

const frozenNames = Object.keys(golden.operations);
const current = viewOf(
  APPLICATION_API_VERSION,
  operationCatalog,
  definitions,
  PREPARED_OPERATION_PERMISSIONS,
  new Set(frozenNames),
);
const clone = <T>(value: T): T => JSON.parse(JSON.stringify(value)) as T;

// biome-ignore lint/suspicious/noExplicitAny: these tests edit arbitrary parts of the contract
type Loose = any;
interface Editable {
  operations: Record<string, Loose>;
  preparedPermissions: Record<string, string>;
  definitions: Record<string, Loose>;
}

test("the committed golden snapshot is honoured by the current catalog", () => {
  const result = compareContracts(golden, current);
  expect(result.breaking).toEqual([]);
  expect(golden.contract).toBe(APPLICATION_API_VERSION);
  for (const name of [
    "book.get",
    "capabilities.get",
    "drafts.create",
    "journal.prepare",
    "operations.commit",
    "reports.get",
    "periods.prepare",
    "tokens.create",
    "tokens.list",
    "tokens.revoke",
    "tokens.activity",
  ])
    expect(frozenNames, name).toContain(name);
  // Every frozen operation still exists, and its commit permissions are frozen with it.
  for (const name of frozenNames)
    expect(
      operationCatalog.some((operation) => operation.name === name),
      name,
    ).toBe(true);
  expect(golden.preparedPermissions.postDraft).toBe("post");
});

test("both copies of the snapshot are the same bytes, written by stableJson", () => {
  const first = readFileSync(
    resolve(root, "packages/application/schema/contract-v1.golden.json"),
    "utf8",
  );
  const second = readFileSync(
    resolve(root, "apps/terminal/internal/api/contract-v1.golden.json"),
    "utf8",
  );
  expect(second).toBe(first);
  expect(stableJson(JSON.parse(first))).toBe(first);
  expect(stableJson({ b: 1, a: [{ d: 1, c: 2 }] })).toBe(
    '{\n  "a": [\n    {\n      "c": 2,\n      "d": 1\n    }\n  ],\n  "b": 1\n}\n',
  );
});

test("the catalog the service publishes carries the plan kinds a commit is judged by", () => {
  expect(applicationSchema.preparedPermissions).toEqual(PREPARED_OPERATION_PERMISSIONS);
  expect(applicationSchema.preparedPermissions.closePeriod).toBe("close");
});

/** Edit the real current contract the way a careless change would, and see what the gate says. */
function broken(edit: (view: Editable) => void) {
  const copy = clone(current) as unknown as Editable;
  edit(copy);
  return compareContracts(golden, copy as unknown as ContractView);
}

test("removing, renaming or re-permissioning a frozen operation is breaking", () => {
  expect(
    broken((view) => {
      delete view.operations["drafts.create"];
    }).breaking,
  ).toEqual([{ operation: "drafts.create", path: "", message: "was removed or renamed" }]);
  const renamed = broken((view) => {
    view.operations["drafts.make"] = view.operations["drafts.create"];
    delete view.operations["drafts.create"];
  });
  expect(renamed.breaking.map((finding) => finding.operation)).toEqual(["drafts.create"]);
  expect(renamed.added).toEqual(["drafts.make"]);
  expect(
    broken((view) => {
      view.operations["journal.prepare"].permission = "draft";
    }).breaking[0],
  ).toEqual({
    operation: "journal.prepare",
    path: "permission",
    message: "changed from post to draft",
  });
  expect(
    broken((view) => {
      view.operations["accounts.list"].writes = true;
    }).breaking[0]?.message,
  ).toBe("now writes");
});

test("changing which permission commits a kind of plan is breaking, in either direction", () => {
  const result = broken((view) => {
    view.preparedPermissions.postDraft = "draft";
    delete view.preparedPermissions.closePeriod;
  });
  expect(result.breaking).toEqual([
    { operation: "(commit)", path: "closePeriod", message: "this kind of plan was removed" },
    {
      operation: "(commit)",
      path: "postDraft",
      message: "committing it needed post and now needs draft",
    },
  ]);
});

test("a reply that drops, retypes or loosens what it promised is breaking; a new optional field is not", () => {
  const dropped = broken((view) => {
    const properties = view.definitions.JournalEntry.properties;
    delete properties.narration;
  });
  expect(dropped.breaking.map((finding) => finding.path)).toContain("output.narration");
  const retyped = broken((view) => {
    view.definitions.JournalEntry.properties.date = { type: "integer" };
  });
  expect(retyped.breaking.length).toBeGreaterThan(0);
  const added = broken((view) => {
    view.definitions.JournalEntry.properties.aFieldAddedLater = { type: "string", maxLength: 10 };
  });
  expect(added.breaking).toEqual([]);
  expect(added.extended).toContain("journal.get");
  const grown = broken((view) => {
    view.definitions.OperationStatus.properties.disposition.enum.push("paused");
  });
  expect(grown.breaking.map((finding) => finding.operation)).toContain("operations.get");
});

test("a request that starts demanding more, or refusing more, is breaking; accepting more is not", () => {
  const required = broken((view) => {
    view.definitions.DraftCreateInput.required.push("extra");
    view.definitions.DraftCreateInput.properties.extra = { type: "string" };
  });
  expect(required.breaking.map((finding) => finding.path)).toContain("input.extra");
  // SourceListInput is used only in requests, so a change to it is judged as a request.
  const narrowed = broken((view) => {
    view.definitions.SourceListInput.properties.text.maxLength = 10;
  });
  expect(narrowed.breaking.map((finding) => finding.path)).toContain("input.text");
  const widened = broken((view) => {
    view.definitions.SourceListInput.properties.text.maxLength = 500;
    view.definitions.SourceListInput.properties.note = { type: "string" };
  });
  expect(widened.breaking).toEqual([]);
  expect(widened.extended).toContain("sources.list");
  // A shape used both ways is judged both ways: raising a limit in a reply is breaking.
  const shared = broken((view) => {
    view.definitions.SourceEvent.properties.description.maxLength = 5000;
  });
  expect(shared.breaking.map((finding) => finding.path)).toContain("output.source.description");
});

test("operations only the new contract has are additions, and are not judged", () => {
  const view = viewOf(
    APPLICATION_API_VERSION,
    operationCatalog,
    definitions,
    PREPARED_OPERATION_PERMISSIONS,
  );
  const result = compareContracts(golden, view);
  expect(result.breaking).toEqual([]);
  const previews = operationCatalog
    .map((operation) => operation.name)
    .filter((name) => !frozenNames.includes(name))
    .sort();
  expect(result.added).toEqual(previews);
});

test("a different contract version is breaking by itself", () => {
  const other = { ...clone(current), contract: "rastrata-application-v2" };
  expect(compareContracts(golden, other).breaking[0]).toEqual({
    operation: "(contract)",
    path: "version",
    message: "the contract is rastrata-application-v2, the frozen one is rastrata-application-v1",
  });
});
