/** Building blocks for the operation contract. Slices import from here and never from
 * schema.ts, so the merged catalog in schema.ts can depend on every slice without a cycle. */

export type BusinessPermission =
  | "read"
  | "draft"
  | "post"
  | "configure"
  | "correct"
  | "close"
  | "provision";
export const BUSINESS_PERMISSIONS: readonly BusinessPermission[] = [
  "read",
  "draft",
  "post",
  "configure",
  "correct",
  "close",
  "provision",
];

export interface Schema {
  readonly $ref?: string;
  readonly type?: "string" | "integer" | "boolean" | "object" | "array" | "null";
  readonly anyOf?: readonly Schema[];
  readonly enum?: readonly (string | boolean | number)[];
  readonly properties?: Readonly<Record<string, Schema>>;
  readonly required?: readonly string[];
  readonly additionalProperties?: boolean;
  readonly items?: Schema;
  readonly minLength?: number;
  readonly maxLength?: number;
  readonly pattern?: string;
  readonly minimum?: number;
  readonly maximum?: number;
  readonly minItems?: number;
  readonly maxItems?: number;
}

export const text = (maxLength = 1000): Schema => ({ type: "string", maxLength });
export const id: Schema = {
  type: "string",
  minLength: 1,
  maxLength: 128,
  pattern: "^[A-Za-z0-9][A-Za-z0-9_-]*$",
};
export const code: Schema = {
  type: "string",
  minLength: 2,
  maxLength: 20,
  pattern: "^[A-Za-z0-9][A-Za-z0-9_-]{1,19}$",
};
export const date: Schema = { type: "string", pattern: "^[0-9]{4}-[0-9]{2}-[0-9]{2}$" };
export const revision: Schema = { type: "string", pattern: "^(0|[1-9][0-9]{0,18})$" };
export const page: Schema = { type: "integer", minimum: 1, maximum: 100000 };
export const version: Schema = { type: "integer", minimum: 1, maximum: 2147483647 };
export const hash: Schema = { type: "string", pattern: "^[0-9a-f]{64}$" };
export const role: Schema = {
  type: "string",
  enum: ["asset", "liability", "equity", "income", "expense", "gain", "unrealizedGain"],
};
/** A non-negative amount with exactly two decimal places. */
export const money: Schema = { type: "string", pattern: "^(0|[1-9][0-9]{0,15})\\.[0-9]{2}$" };
export const amountInput: Schema = {
  type: "string",
  pattern: "^$|^(0|[1-9][0-9]{0,15})\\.[0-9]{2}$",
};
/** A signed amount with exactly two decimal places. Never parse it into a float; see money.ts. */
export const signedMoney: Schema = { type: "string", pattern: "^-?(0|[1-9][0-9]*)\\.[0-9]{2}$" };
export const ref = (name: string): Schema => ({ $ref: `#/$defs/${name}` });
export const object = (
  properties: Record<string, Schema>,
  required = Object.keys(properties),
): Schema => ({ type: "object", properties, required, additionalProperties: false });
export const array = (items: Schema, maxItems = 100000): Schema => ({
  type: "array",
  items,
  maxItems,
});
export const nullable = (schema: Schema): Schema => ({ anyOf: [schema, { type: "null" }] });

export interface OperationDefinition {
  readonly name: string;
  readonly description: string;
  readonly permission: BusinessPermission;
  readonly writes: boolean;
  readonly input: Schema;
  readonly output: Schema;
  /** Set while an operation is on its way out: since when, what replaces it, and the contract
   * version that removes it. It keeps working until that version (docs/reference/contract-policy.md). */
  readonly deprecated?: string;
}

/** Declare one operation. `input` and `output` name entries in the merged definitions. */
export const operation = (
  name: string,
  description: string,
  permission: BusinessPermission,
  input: string,
  writes: boolean,
  output: string,
): OperationDefinition => ({
  name,
  description,
  permission,
  writes,
  input: ref(input),
  output: ref(output),
});
