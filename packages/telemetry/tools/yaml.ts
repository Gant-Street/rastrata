/** The smallest YAML writer that does what the generated deployment files need: nested objects,
 * lists and scalars. A string is written plain when that is unambiguous (so a PromQL expression
 * reads as one), as a block when it has several lines, and as a JSON string otherwise. What it
 * writes is read back with Bun.YAML.parse in the tests. */
export type YamlValue =
  | string
  | number
  | boolean
  | null
  | readonly YamlValue[]
  | { readonly [key: string]: YamlValue };

const isObject = (value: YamlValue): value is { readonly [key: string]: YamlValue } =>
  typeof value === "object" && value !== null && !Array.isArray(value);
const isList = (value: YamlValue): value is readonly YamlValue[] => Array.isArray(value);
const KEY = /^[A-Za-z_][A-Za-z0-9_.-]*$/;
const RESERVED = /^(true|false|yes|no|on|off|null|~)$/i;
const NUMERIC = /^[-+]?(\.\d|\d)[\d.eE+-]*$|^0[xob][\da-f]+$/i;

/** True when `text` can be written without quotes and be read back as the same string. */
export function plainSafe(text: string): boolean {
  if (text === "" || text !== text.trim() || /[\n\r\t]/.test(text)) return false;
  if (/^[\s\-?:,[\]{}#&*!|>'"%@`]/.test(text) && !/^-[^\s]/.test(text)) return false;
  if (/: |:$| #/.test(text)) return false;
  return !RESERVED.test(text) && !NUMERIC.test(text);
}

function scalar(value: string | number | boolean | null): string {
  if (typeof value !== "string") return String(value);
  return plainSafe(value) ? value : JSON.stringify(value);
}

function block(text: string, pad: string): string[] {
  const body = text.replace(/\n$/, "").split("\n");
  return [
    text.endsWith("\n") ? "|" : "|-",
    ...body.map((line) => (line === "" ? "" : `${pad}  ${line}`)),
  ];
}

function entry(name: string, item: YamlValue, indent: number): string[] {
  const pad = " ".repeat(indent);
  if (typeof item === "string" && item.includes("\n")) {
    const [head, ...rest] = block(item, pad);
    return [`${pad}${name}: ${head}`, ...rest];
  }
  if (isObject(item) && Object.keys(item).length > 0)
    return [`${pad}${name}:`, ...lines(item, indent + 2)];
  if (isList(item) && item.length > 0) return [`${pad}${name}:`, ...lines(item, indent + 2)];
  const text = isObject(item) ? "{}" : isList(item) ? "[]" : scalar(item as string);
  return [`${pad}${name}: ${text}`];
}

function lines(value: YamlValue, indent: number): string[] {
  const pad = " ".repeat(indent);
  if (isList(value)) {
    if (value.length === 0) return [`${pad}[]`];
    return value.flatMap((item) => {
      if ((isObject(item) && Object.keys(item).length > 0) || (isList(item) && item.length > 0)) {
        const inner = lines(item, indent + 2);
        return [`${pad}- ${inner[0]?.trimStart() ?? ""}`, ...inner.slice(1)];
      }
      if (typeof item === "string" && item.includes("\n")) {
        const [head, ...rest] = block(item, pad);
        return [`${pad}- ${head}`, ...rest];
      }
      return [`${pad}- ${isObject(item) ? "{}" : isList(item) ? "[]" : scalar(item as string)}`];
    });
  }
  if (isObject(value))
    return Object.entries(value).flatMap(([key, item]) =>
      entry(KEY.test(key) ? key : JSON.stringify(key), item, indent),
    );
  return [`${pad}${scalar(value)}`];
}

export const toYaml = (value: YamlValue): string => `${lines(value, 0).join("\n")}\n`;
