import { ApplicationError } from "../../errors.ts";
import type { ColumnRef, CsvMapping } from "../../statements/csv-mapping.ts";

/** The schema checks the shape of a mapping; this checks that it means something. */
export function mappingProblems(mapping: CsvMapping): { path: string; message: string }[] {
  const problems: { path: string; message: string }[] = [];
  const noHeader = mapping.headerRow === 0;
  const column = (ref: ColumnRef | undefined, path: string, label: string, optional = false) => {
    if (!ref) {
      if (!optional) problems.push({ path, message: `Choose the ${label} column` });
      return;
    }
    const named = ref.header !== undefined && ref.header.trim() !== "";
    if (!named && ref.index === undefined)
      problems.push({ path, message: `The ${label} column needs a header or a position` });
    if (noHeader && !(ref.index !== undefined))
      problems.push({
        path,
        message: `The file has no header row, so the ${label} column must be chosen by position`,
      });
  };
  column(mapping.date, "input.mapping.date", "date");
  const amount = mapping.amount;
  if (amount.kind === "signed") column(amount.amount, "input.mapping.amount.amount", "amount");
  else if (amount.kind === "debitCredit") {
    column(amount.debit, "input.mapping.amount.debit", "debit");
    column(amount.credit, "input.mapping.amount.credit", "credit");
  } else {
    column(amount.amount, "input.mapping.amount.amount", "amount");
    column(amount.direction, "input.mapping.amount.direction", "direction");
    const out = new Set((amount.outValues ?? []).map((value) => value.trim().toLowerCase()));
    const into = new Set((amount.inValues ?? []).map((value) => value.trim().toLowerCase()));
    if (out.size === 0 || into.size === 0)
      problems.push({
        path: "input.mapping.amount",
        message: "List the direction values that mean money out and money in",
      });
    if ([...out].some((value) => into.has(value)))
      problems.push({
        path: "input.mapping.amount",
        message: "A direction value cannot mean both money out and money in",
      });
  }
  for (const [index, ref] of mapping.description.entries())
    column(ref, `input.mapping.description[${index}]`, "description");
  column(mapping.counterparty, "input.mapping.counterparty", "counterparty", true);
  column(mapping.reference, "input.mapping.reference", "reference", true);
  column(mapping.balance, "input.mapping.balance", "balance", true);
  if (mapping.include) {
    column(mapping.include.column, "input.mapping.include.column", "filter");
    if (mapping.include.values.length === 0)
      problems.push({ path: "input.mapping.include.values", message: "List the values to import" });
  }
  return problems;
}

export function assertMapping(mapping: CsvMapping): void {
  const problems = mappingProblems(mapping);
  if (problems.length > 0)
    throw new ApplicationError(
      "invalid_mapping",
      "The column mapping is incomplete or contradicts itself",
      400,
      problems,
    );
}
