/** The sources of changes besides the ledger, in the order they are read. How an entry was decided in
 * For review is not one of them: it adds to the changes the ledger gave (see ./review.ts). */
import { accessSource } from "./access.ts";
import { reconciliationSource } from "./reconcile.ts";
import { rulesSource } from "./rules.ts";
import { tagsSource } from "./tags.ts";
import type { SourceReader } from "./types.ts";

export const SOURCES: readonly SourceReader[] = [
  rulesSource,
  tagsSource,
  reconciliationSource,
  accessSource,
];
