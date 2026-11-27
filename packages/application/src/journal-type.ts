/** Where an entry in the book came from, for the Transactions screen's Type filter. Pure: it reads only
 * the identity of the entry's source event, which the book keeps for every entry that came from
 * somewhere.
 *
 * - `bank`: a line of a statement file or a bank connection (`ingest-csv-...`, `ingest-ofx-...`,
 *   `ingest-simplefin-...`),
 * - `stripe`: a Stripe payout or event (`stripe-payout-po_...`, `ingest-stripe-...`),
 * - `opening`: the opening balances (`opening-<date>-<hash>`),
 * - `manual`: everything else, which is an entry a person wrote, with or without a source id of their own.
 *
 * A reversal has no source of its own and takes the type of the entry it reverses, so the two stay
 * together under one filter. */
export const ENTRY_TYPES = ["bank", "stripe", "manual", "opening"] as const;
export type EntryType = (typeof ENTRY_TYPES)[number];

export function entryType(sourceId: string | undefined): EntryType {
  if (!sourceId) return "manual";
  if (sourceId.startsWith("opening-")) return "opening";
  if (sourceId.startsWith("stripe-") || sourceId.startsWith("ingest-stripe-")) return "stripe";
  if (sourceId.startsWith("ingest-")) return "bank";
  return "manual";
}
