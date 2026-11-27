import type { ApplicationOutputs } from "@rastrata/application/client-contracts";
import { localToday } from "@rastrata/ui";
import type { BrowserApplicationClient } from "../../application-client";

export type TaxLines = ApplicationOutputs["taxLines.list"];

const FORM_NAMES: Readonly<Record<string, string>> = {
  scheduleC: "Schedule C",
  form1120S: "Form 1120-S",
  form1065: "Form 1065",
  form1125A: "Form 1125-A",
};

/** The tax lines for the year of today, kept inside the years the catalog covers. A failure only
 * means tax lines are shown by their ids and cannot be edited; it never blocks the page. */
export async function loadTaxLines(client: BrowserApplicationClient): Promise<TaxLines | null> {
  try {
    const latest = await client.read("taxLines.list", {});
    const wanted = Number(localToday().slice(0, 4));
    const year = Math.min(
      Math.max(wanted, Math.min(...latest.taxYears)),
      Math.max(...latest.taxYears),
    );
    return year === latest.taxYear ? latest : await client.read("taxLines.list", { taxYear: year });
  } catch {
    return null;
  }
}

/** The words shown for each tax line id: "Schedule C line 18 · Office expense". */
export function taxLineNames(lines: TaxLines | null | undefined): Map<string, string> {
  const map = new Map<string, string>();
  for (const form of lines?.forms ?? [])
    for (const line of form.lines)
      map.set(line.id, `${FORM_NAMES[form.id] ?? form.name} line ${line.number} · ${line.label}`);
  return map;
}
