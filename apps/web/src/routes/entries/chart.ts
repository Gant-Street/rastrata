import type { AccountRow } from "@rastrata/application/client-contracts";
import type { QuickAccount } from "@rastrata/ui/entries/quick-entry";

/** The chart as the entry dialogs need it. Which accounts are a person's banks, cards and cash is not a
 * field of an account, so it is read from two things the books know: an account tagged as cash, and an
 * account a statement or a bank feed is mapped to (`mapped`, the ids of those). An account that other
 * accounts sit under is a group, and a closed account takes no new entries; the dialogs offer neither. */
export function quickAccounts(
  rows: readonly AccountRow[],
  mapped: ReadonlySet<string>,
): QuickAccount[] {
  const parents = new Set(rows.flatMap((row) => (row.parentId ? [row.parentId] : [])));
  return rows.map((row) => ({
    id: row.id,
    code: row.code,
    name: row.name,
    role: row.role,
    group: parents.has(row.id),
    closed: row.closedOn !== null,
    bank: row.tags?.cashFlowClass === "cash" || mapped.has(row.id),
  }));
}
