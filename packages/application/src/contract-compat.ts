/** Compatibility between two versions of the operation contract: what a frozen contract promised
 * and what the current build offers. Pure and portable (no runtime imports), so the landing gate
 * (scripts/generate-application-contracts.ts) and the tests use the same code; the Go client has a
 * port of the same rules (apps/terminal/internal/api/compat.go) checked against the same vectors
 * (test/fixtures/contract-compat-vectors.json).
 *
 * The rules, in one sentence each (docs/reference/contract-policy.md has the policy):
 * - A request the frozen contract accepted must still be accepted: nothing becomes required, no
 *   field or choice is removed, no limit gets tighter, no format changes.
 * - A reply must stay readable by a client written against the frozen contract: every field it
 *   named is still there with the same type, no field it required goes optional, no limit gets
 *   looser and no new choice appears in a set of choices. New optional fields are additions.
 * - An operation is never removed or renamed, and its permission and whether it writes never change. */
import type { BusinessPermission, OperationDefinition, Schema } from "./schema-kit.ts";

export interface FrozenOperation {
  readonly permission: BusinessPermission;
  readonly writes: boolean;
  readonly input: Schema;
  readonly output: Schema;
}

/** The part of a contract compatibility is judged on. A golden snapshot is this plus a few labels. */
export interface ContractView {
  readonly contract: string;
  /** The permission needed to commit each kind of prepared action. */
  readonly preparedPermissions: Readonly<Record<string, BusinessPermission>>;
  readonly definitions: Readonly<Record<string, Schema>>;
  readonly operations: Readonly<Record<string, FrozenOperation>>;
}

export interface ContractSnapshot extends ContractView {
  /** The date the contract was frozen, YYYY-MM-DD. */
  readonly frozenOn: string;
  readonly note: string;
}

export interface Finding {
  readonly operation: string;
  /** Where in the operation's input or output: "input.data.lines[]", "output.token.status". */
  readonly path: string;
  readonly message: string;
}

export interface Comparison {
  /** What the new contract no longer honours. Any entry needs a new major version. */
  readonly breaking: readonly Finding[];
  /** Operations only the new contract has. */
  readonly added: readonly string[];
  /** Operations both have whose contract grew in a compatible way. */
  readonly extended: readonly string[];
}

type Definitions = Readonly<Record<string, Schema>>;
const REF = "#/$defs/";

/** The names a schema refers to, followed through their definitions. */
function reachable(schema: Schema, definitions: Definitions, into: Set<string>): void {
  if (schema.$ref) {
    const name = schema.$ref.slice(REF.length);
    if (into.has(name)) return;
    into.add(name);
    const target = definitions[name];
    if (!target) throw new Error(`Unknown schema reference ${schema.$ref}`);
    reachable(target, definitions, into);
    return;
  }
  for (const child of Object.values(schema.properties ?? {})) reachable(child, definitions, into);
  if (schema.items) reachable(schema.items, definitions, into);
  for (const variant of schema.anyOf ?? []) reachable(variant, definitions, into);
}

/** The view of the current catalog, limited to `only` when given. */
export function viewOf(
  contract: string,
  catalog: readonly OperationDefinition[],
  definitions: Definitions,
  preparedPermissions: Readonly<Record<string, BusinessPermission>>,
  only?: ReadonlySet<string>,
): ContractView {
  const operations: Record<string, FrozenOperation> = {};
  const names = new Set<string>();
  for (const operation of catalog) {
    if (only && !only.has(operation.name)) continue;
    operations[operation.name] = {
      permission: operation.permission,
      writes: operation.writes,
      input: operation.input,
      output: operation.output,
    };
    reachable(operation.input, definitions, names);
    reachable(operation.output, definitions, names);
  }
  const used: Record<string, Schema> = {};
  for (const name of [...names].sort()) used[name] = definitions[name] as Schema;
  return { contract, preparedPermissions, definitions: used, operations };
}

interface Context {
  readonly aDefinitions: Definitions;
  readonly bDefinitions: Definitions;
  /** What to do with a property one side names and the other does not. In a request the receiver
   * refuses it ("forbid"); in a reply the reader ignores it ("ignore"). */
  readonly extras: "forbid" | "ignore";
  readonly request: boolean;
  readonly findings: Finding[];
  readonly operation: string;
  readonly seen: Set<string>;
}

const side = (context: Context, requestText: string, replyText: string): string =>
  context.request ? requestText : replyText;

function dereference(schema: Schema, definitions: Definitions): Schema {
  let current = schema;
  for (let hops = 0; current.$ref; hops++) {
    if (hops > 32) throw new Error("Schema reference chain is too long");
    const target = definitions[current.$ref.slice(REF.length)];
    if (!target) throw new Error(`Unknown schema reference ${current.$ref}`);
    current = target;
  }
  return current;
}

const unconstrained = (schema: Schema): boolean =>
  schema.type === undefined &&
  schema.anyOf === undefined &&
  schema.enum === undefined &&
  schema.properties === undefined &&
  schema.items === undefined;

function fail(context: Context, path: string, message: string): void {
  context.findings.push({ operation: context.operation, path, message });
}

/** Does every value that satisfies `a` satisfy `b`? Differences are recorded as findings. */
function subset(a: Schema, b: Schema, context: Context, path: string): void {
  if (a.$ref && b.$ref) {
    const pair = `${a.$ref}|${b.$ref}`;
    if (context.seen.has(pair)) return;
    context.seen.add(pair);
  }
  const left = dereference(a, context.aDefinitions);
  const right = dereference(b, context.bDefinitions);
  if (unconstrained(right)) return;
  if (unconstrained(left)) {
    fail(
      context,
      path,
      side(
        context,
        "now limits what it accepts here",
        "may now return anything here, where it named a shape",
      ),
    );
    return;
  }
  if (left.anyOf) {
    for (const variant of left.anyOf)
      if (right.anyOf) {
        if (!right.anyOf.some((option) => holds(variant, option, context, path)))
          fail(
            context,
            path,
            side(
              context,
              "a shape it accepted is no longer accepted",
              "it can return a shape it did not name",
            ),
          );
      } else subset(variant, right, context, path);
    return;
  }
  if (right.anyOf) {
    if (!right.anyOf.some((option) => holds(left, option, context, path)))
      fail(
        context,
        path,
        side(
          context,
          "what it accepted no longer matches any accepted shape",
          "it can return a shape it did not name",
        ),
      );
    return;
  }
  if (left.type !== right.type) {
    fail(context, path, `the type changed from ${right.type ?? "any"} to ${left.type ?? "any"}`);
    return;
  }
  if (right.enum) {
    if (!left.enum) {
      fail(
        context,
        path,
        side(
          context,
          "now accepts only a fixed set of values",
          "can now return values outside the set it named",
        ),
      );
    } else
      for (const value of left.enum)
        if (!right.enum.includes(value))
          fail(
            context,
            path,
            side(
              context,
              `no longer accepts ${JSON.stringify(value)}`,
              `can now return ${JSON.stringify(value)}, which it did not name`,
            ),
          );
  }
  switch (left.type) {
    case "object":
      subsetObject(left, right, context, path);
      break;
    case "array": {
      if (right.items) {
        if (left.items) subset(left.items, right.items, context, `${path}[]`);
        else fail(context, path, "the items are no longer described");
      }
      if ((right.minItems ?? 0) > (left.minItems ?? 0))
        fail(context, path, side(context, "now needs more items", "can now return fewer items"));
      if (
        right.maxItems !== undefined &&
        (left.maxItems ?? Number.POSITIVE_INFINITY) > right.maxItems
      )
        fail(context, path, side(context, "now accepts fewer items", "can now return more items"));
      break;
    }
    case "string": {
      if ((right.minLength ?? 0) > (left.minLength ?? 0))
        fail(
          context,
          path,
          side(context, "now needs a longer text", "can now return a shorter text"),
        );
      if (
        right.maxLength !== undefined &&
        (left.maxLength ?? Number.POSITIVE_INFINITY) > right.maxLength
      )
        fail(
          context,
          path,
          side(context, "now accepts a shorter text", "can now return a longer text"),
        );
      if (right.pattern !== undefined && left.pattern !== right.pattern)
        fail(context, path, "the required format changed");
      break;
    }
    case "integer": {
      if ((right.minimum ?? Number.NEGATIVE_INFINITY) > (left.minimum ?? Number.NEGATIVE_INFINITY))
        fail(
          context,
          path,
          side(context, "now accepts a smaller range", "can now return smaller numbers"),
        );
      if ((right.maximum ?? Number.POSITIVE_INFINITY) < (left.maximum ?? Number.POSITIVE_INFINITY))
        fail(
          context,
          path,
          side(context, "now accepts a smaller range", "can now return larger numbers"),
        );
      break;
    }
    default:
  }
}

/** Does `a` fit in `b`, without recording what differs? */
function holds(a: Schema, b: Schema, context: Context, path: string): boolean {
  const trial: Context = { ...context, findings: [], seen: new Set(context.seen) };
  subset(a, b, trial, path);
  return trial.findings.length === 0;
}

function subsetObject(a: Schema, b: Schema, context: Context, path: string): void {
  const aProperties = a.properties ?? {};
  const bProperties = b.properties ?? {};
  const aRequired = new Set(a.required ?? []);
  for (const name of b.required ?? [])
    if (!aRequired.has(name))
      fail(context, `${path}.${name}`, side(context, "is now required", "may now be missing"));
  for (const [name, child] of Object.entries(aProperties)) {
    const other = bProperties[name];
    if (other) subset(child, other, context, `${path}.${name}`);
    else if (context.extras === "forbid") fail(context, `${path}.${name}`, "is no longer accepted");
  }
  if (context.extras === "ignore")
    for (const name of Object.keys(bProperties))
      if (!(name in aProperties)) fail(context, `${path}.${name}`, "is no longer returned");
  if (
    context.extras === "forbid" &&
    a.additionalProperties === true &&
    b.additionalProperties !== true
  )
    fail(context, path, "no longer accepts additional fields");
}

function operationFindings(
  name: string,
  old: FrozenOperation,
  current: FrozenOperation,
  oldDefinitions: Definitions,
  newDefinitions: Definitions,
): Finding[] {
  const findings: Finding[] = [];
  if (old.permission !== current.permission)
    findings.push({
      operation: name,
      path: "permission",
      message: `changed from ${old.permission} to ${current.permission}`,
    });
  if (old.writes !== current.writes)
    findings.push({
      operation: name,
      path: "writes",
      message: old.writes ? "no longer writes" : "now writes",
    });
  // A request: what the old contract accepted must fit in what the new one accepts.
  subset(
    old.input,
    current.input,
    {
      aDefinitions: oldDefinitions,
      bDefinitions: newDefinitions,
      extras: "forbid",
      request: true,
      findings,
      operation: name,
      seen: new Set(),
    },
    "input",
  );
  // A reply: what the new contract can return must fit in what the old one described.
  subset(
    current.output,
    old.output,
    {
      aDefinitions: newDefinitions,
      bDefinitions: oldDefinitions,
      extras: "ignore",
      request: false,
      findings,
      operation: name,
      seen: new Set(),
    },
    "output",
  );
  return findings;
}

/** A schema with every reference followed and every key in a fixed order, so two schemas that mean
 * the same thing give the same text. */
function inlined(schema: Schema, definitions: Definitions, depth = 0): unknown {
  if (depth > 40) throw new Error("Schema nests too deeply");
  const resolved = dereference(schema, definitions);
  const out: Record<string, unknown> = {};
  for (const key of Object.keys(resolved).sort()) {
    const value = (resolved as Record<string, unknown>)[key];
    if (key === "properties")
      out[key] = Object.fromEntries(
        Object.entries(value as Record<string, Schema>)
          .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
          .map(([name, child]) => [name, inlined(child, definitions, depth + 1)]),
      );
    else if (key === "items") out[key] = inlined(value as Schema, definitions, depth + 1);
    else if (key === "anyOf")
      out[key] = (value as Schema[]).map((variant) => inlined(variant, definitions, depth + 1));
    else if (key === "required") out[key] = [...(value as string[])].sort();
    else out[key] = value;
  }
  return out;
}

const resolvedText = (schema: Schema, definitions: Definitions): string =>
  JSON.stringify(inlined(schema, definitions));

/** What the new contract no longer honours of the old one. */
export function compareContracts(old: ContractView, current: ContractView): Comparison {
  const breaking: Finding[] = [];
  const extended: string[] = [];
  if (old.contract !== current.contract)
    breaking.push({
      operation: "(contract)",
      path: "version",
      message: `the contract is ${current.contract}, the frozen one is ${old.contract}`,
    });
  for (const [name, frozen] of Object.entries(old.operations)) {
    const now = current.operations[name];
    if (!now) {
      breaking.push({ operation: name, path: "", message: "was removed or renamed" });
      continue;
    }
    const findings = operationFindings(name, frozen, now, old.definitions, current.definitions);
    breaking.push(...findings);
    if (
      findings.length === 0 &&
      (resolvedText(frozen.input, old.definitions) !==
        resolvedText(now.input, current.definitions) ||
        resolvedText(frozen.output, old.definitions) !==
          resolvedText(now.output, current.definitions))
    )
      extended.push(name);
  }
  for (const [kind, permission] of Object.entries(old.preparedPermissions)) {
    const now = current.preparedPermissions[kind];
    if (now === undefined)
      breaking.push({
        operation: "(commit)",
        path: kind,
        message: "this kind of plan was removed",
      });
    else if (now !== permission)
      breaking.push({
        operation: "(commit)",
        path: kind,
        message: `committing it needed ${permission} and now needs ${now}`,
      });
  }
  const added = Object.keys(current.operations)
    .filter((name) => !(name in old.operations))
    .sort();
  return { breaking, added, extended: extended.sort() };
}

/** JSON with sorted keys and a final newline, so a snapshot is the same bytes every time. */
export function stableJson(value: unknown): string {
  const sort = (input: unknown): unknown =>
    Array.isArray(input)
      ? input.map(sort)
      : input && typeof input === "object"
        ? Object.fromEntries(
            Object.entries(input as Record<string, unknown>)
              .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
              .map(([key, child]) => [key, sort(child)]),
          )
        : input;
  return `${JSON.stringify(sort(value), null, 2)}\n`;
}
