import { hashCanonical } from "@rastrata/kernel";
import type { AccountTagMap, CashFlowClass } from "../../src/account-tags.ts";

/** A tag map for tests, shaped like the chart lane's: tags by account id, the same in force on every
 * date, and a content hash that changes whenever any tag does. */
export function tagMap(
  byAccount: Readonly<Record<string, CashFlowClass | undefined>>,
  revision = 0,
): AccountTagMap {
  const entries = Object.entries(byAccount)
    .filter((entry): entry is [string, CashFlowClass] => entry[1] !== undefined)
    .sort(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0));
  return {
    hash: hashCanonical({ type: "TestTagMap", tags: entries.map(([id, tag]) => [id, tag]) }).digest,
    revision,
    tagsFor: (accountId) => {
      const tag = byAccount[accountId];
      return tag === undefined ? {} : { cashFlowClass: tag };
    },
  };
}

/** The tags the chart lane's templates give the scenario chart: every balance-sheet account carries
 * the section its changes belong to, and no income or expense account carries any. */
export const FULL_TAGS: Readonly<Record<string, CashFlowClass>> = {
  "1000": "cash",
  "1100": "operating",
  "1500": "investing",
  "1600": "noncash",
  "2000": "operating",
  "2500": "financing",
  "3000": "financing",
  "3100": "financing",
};
