import type { AmountMapping, ColumnInfo, ColumnRef, ImportMapping } from "./types";

/** The pure half of the column editor: turning a person's choices into the mapping the service
 * reads, and the mapping back into choices. No component state lives here, so the rules are tested
 * on their own. */

export const normalizeHeader = (text: string): string =>
  text.replace(/\s+/g, " ").trim().toLowerCase();

/** A mapping with nothing chosen yet. `headerRow` is where the file's header was found (0: none). */
export function emptyMapping(headerRow: number): ImportMapping {
  return {
    headerRow,
    date: {},
    dateOrder: "auto",
    amount: { kind: "signed" },
    description: [],
  };
}

/** A column named the way a mapping names it: by header when the file has one, and always by
 * position, so a file whose header changes still maps and a headerless file can be mapped at all. */
export function refFor(
  columns: readonly ColumnInfo[],
  index: number,
  headerRow: number,
): ColumnRef {
  const column = columns.find((item) => item.index === index);
  const header = headerRow > 0 && column ? column.header.trim() : "";
  return header ? { header, index } : { index };
}

/** The one-based position of the column a reference names in this file, or 0 when it names none. */
export function indexOf(columns: readonly ColumnInfo[], ref: ColumnRef | undefined): number {
  if (!ref) return 0;
  if (ref.header !== undefined && ref.header !== "") {
    const wanted = normalizeHeader(ref.header);
    const byName = columns.find((item) => normalizeHeader(item.header) === wanted);
    if (byName) return byName.index;
  }
  if (ref.index !== undefined && columns.some((item) => item.index === ref.index)) return ref.index;
  return 0;
}

const named = (ref: ColumnRef | undefined): boolean =>
  ref !== undefined && (ref.index !== undefined || (ref.header ?? "") !== "");

/** Whether the mapping holds everything the service needs. An incomplete one is never sent. */
export function isComplete(mapping: ImportMapping): boolean {
  if (!named(mapping.date)) return false;
  if (mapping.description.length === 0 || !mapping.description.every(named)) return false;
  const amount = mapping.amount;
  if (amount.kind === "signed") return named(amount.amount);
  if (amount.kind === "debitCredit") return named(amount.debit) && named(amount.credit);
  return (
    named(amount.amount) &&
    named(amount.direction) &&
    (amount.outValues ?? []).length > 0 &&
    (amount.inValues ?? []).length > 0
  );
}

/** What is still missing, in words for a person choosing columns. */
export function missingParts(mapping: ImportMapping): string[] {
  const missing: string[] = [];
  if (!named(mapping.date)) missing.push("the date column");
  const amount = mapping.amount;
  if (amount.kind === "signed" && !named(amount.amount)) missing.push("the amount column");
  if (amount.kind === "debitCredit") {
    if (!named(amount.debit)) missing.push("the money out column");
    if (!named(amount.credit)) missing.push("the money in column");
  }
  if (amount.kind === "direction") {
    if (!named(amount.amount)) missing.push("the amount column");
    if (!named(amount.direction)) missing.push("the debit or credit column");
    if ((amount.outValues ?? []).length === 0 || (amount.inValues ?? []).length === 0)
      missing.push("the values that mean money out and money in");
  }
  if (mapping.description.length === 0 || !mapping.description.every(named))
    missing.push("the description column");
  return missing;
}

export const splitValues = (text: string): string[] =>
  text
    .split(",")
    .map((value) => value.trim())
    .filter((value, index, all) => value !== "" && all.indexOf(value) === index)
    .slice(0, 20);

export const joinValues = (values: readonly string[] | undefined): string =>
  (values ?? []).join(", ");

/** Switch how the amounts are written, keeping the choices that still apply. */
export function withAmountKind(amount: AmountMapping, kind: AmountMapping["kind"]): AmountMapping {
  const keep = amount.invert ? { invert: true } : {};
  if (kind === "signed")
    return { kind, ...(amount.amount ? { amount: amount.amount } : {}), ...keep };
  if (kind === "debitCredit")
    return {
      kind,
      ...(amount.debit ? { debit: amount.debit } : {}),
      ...(amount.credit ? { credit: amount.credit } : {}),
      ...keep,
    };
  return {
    kind,
    ...(amount.amount ? { amount: amount.amount } : {}),
    ...(amount.direction ? { direction: amount.direction } : {}),
    outValues: amount.outValues ?? ["Debit"],
    inValues: amount.inValues ?? ["Credit"],
    ...keep,
  };
}

/** The mapping with one optional column set or cleared. */
export function withOptional(
  mapping: ImportMapping,
  field: "counterparty" | "reference" | "balance",
  ref: ColumnRef | undefined,
): ImportMapping {
  const { [field]: _dropped, ...rest } = mapping;
  return ref ? { ...rest, [field]: ref } : rest;
}

/** The amount mapping with one of its columns set or cleared. */
export function withAmountColumn(
  amount: AmountMapping,
  field: "amount" | "debit" | "credit" | "direction",
  ref: ColumnRef | undefined,
): AmountMapping {
  const { [field]: _dropped, ...rest } = amount;
  return (ref ? { ...rest, [field]: ref } : rest) as AmountMapping;
}
