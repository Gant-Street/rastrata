import { readFileSync } from "node:fs";

/** A small validator for Stripe's published object shapes. It reads a compact subset of Stripe's
 * OpenAPI spec (openapi-subset.json: spec3.json 2026-09-30.endive, schemas the lane reads) and
 * checks that a fixture is a valid object of the named schema: required fields present, types and
 * enums right, nothing invented. Properties of schemas outside the subset are accepted unchecked
 * (`x-opaque`), so a fixture is only as strict as the subset, but it can never be looser than
 * Stripe's documented required fields for the objects the lane decodes. */

interface Schema {
  readonly $ref?: string;
  readonly anyOf?: readonly Schema[];
  readonly type?: string;
  readonly nullable?: boolean;
  readonly enum?: readonly unknown[];
  readonly format?: string;
  readonly properties?: Readonly<Record<string, Schema>>;
  readonly required?: readonly string[];
  readonly items?: Schema;
  readonly "x-opaque"?: boolean;
}

const subset = JSON.parse(
  readFileSync(new URL("./openapi-subset.json", import.meta.url), "utf8"),
) as { readonly specVersion: string; readonly schemas: Readonly<Record<string, Schema>> };

export const SPEC_VERSION = subset.specVersion;
export const SCHEMA_NAMES: readonly string[] = Object.keys(subset.schemas);

function check(value: unknown, schema: Schema, path: string, errors: string[]): void {
  if (schema["x-opaque"]) return;
  if (value === null || value === undefined) {
    if (value === null && (schema.nullable || schema.anyOf?.some((s) => s.nullable))) return;
    errors.push(`${path}: ${value === null ? "null" : "undefined"} is not allowed here`);
    return;
  }
  if (schema.$ref) {
    const target = subset.schemas[schema.$ref];
    if (!target) {
      errors.push(`${path}: unknown schema ${schema.$ref}`);
      return;
    }
    check(value, target, path, errors);
    return;
  }
  if (schema.anyOf) {
    const attempts = schema.anyOf.map((variant) => {
      const found: string[] = [];
      check(value, variant, path, found);
      return found;
    });
    if (!attempts.some((found) => found.length === 0))
      errors.push(`${path}: matches none of the documented shapes (${attempts[0]?.[0] ?? "?"})`);
    return;
  }
  if (schema.enum && !schema.enum.includes(value as never))
    errors.push(`${path}: ${JSON.stringify(value)} is not one of ${schema.enum.join(", ")}`);
  switch (schema.type) {
    case "string":
      if (typeof value !== "string") errors.push(`${path}: expected a string`);
      break;
    case "integer":
      if (typeof value !== "number" || !Number.isInteger(value))
        errors.push(`${path}: expected an integer`);
      break;
    case "number":
      if (typeof value !== "number") errors.push(`${path}: expected a number`);
      break;
    case "boolean":
      if (typeof value !== "boolean") errors.push(`${path}: expected true or false`);
      break;
    case "array":
      if (!Array.isArray(value)) errors.push(`${path}: expected an array`);
      else if (schema.items)
        for (const [index, item] of value.entries())
          check(item, schema.items, `${path}[${index}]`, errors);
      break;
    case "object": {
      if (typeof value !== "object" || Array.isArray(value)) {
        errors.push(`${path}: expected an object`);
        break;
      }
      const record = value as Record<string, unknown>;
      if (!schema.properties) break;
      for (const name of schema.required ?? [])
        if (!(name in record)) errors.push(`${path}.${name}: required by Stripe's schema`);
      for (const [name, member] of Object.entries(record)) {
        const known = schema.properties[name];
        if (!known) errors.push(`${path}.${name}: not a documented property`);
        else check(member, known, `${path}.${name}`, errors);
      }
      break;
    }
    default:
      break;
  }
}

/** Problems with `value` as a Stripe `schemaName` object; empty when it conforms. */
export function conformance(schemaName: string, value: unknown): string[] {
  const schema = subset.schemas[schemaName];
  if (!schema) return [`unknown schema ${schemaName}`];
  const errors: string[] = [];
  check(value, schema, schemaName, errors);
  return errors;
}

/** Stripe's list envelope around `schemaName` objects, checked in full. */
export function listConformance(schemaName: string, list: unknown): string[] {
  const errors: string[] = [];
  if (!list || typeof list !== "object") return ["list: expected an object"];
  const o = list as Record<string, unknown>;
  for (const field of ["object", "data", "has_more", "url"])
    if (!(field in o)) errors.push(`list.${field}: required by Stripe's list schema`);
  for (const field of Object.keys(o))
    if (!["object", "data", "has_more", "url"].includes(field))
      errors.push(`list.${field}: not a documented property`);
  if (o.object !== "list") errors.push('list.object: expected "list"');
  if (typeof o.has_more !== "boolean") errors.push("list.has_more: expected true or false");
  if (typeof o.url !== "string" || !o.url.startsWith("/v1/"))
    errors.push("list.url: expected a /v1/ path");
  if (!Array.isArray(o.data)) errors.push("list.data: expected an array");
  else
    o.data.forEach((item, index) => {
      for (const e of conformance(schemaName, item)) errors.push(`data[${index}] ${e}`);
    });
  return errors;
}
