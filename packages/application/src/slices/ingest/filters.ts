/** Turns an `InboxFilter` into SQL over `app_ingest_items` (alias `i`) joined to its source (alias
 * `s`). Every value is bound as a parameter. A person's search text is only ever a bound LIKE
 * pattern with wildcards escaped; no text from a line or a filter is interpolated into SQL. */
import { ApplicationError } from "../../errors.ts";
import { likePattern, normalizeForKey } from "../../ingest/text.ts";
import { isMoney, parseMoney } from "../../money.ts";
import type { ApplicationBinding } from "../../storage.ts";
import type { InboxFilter } from "../../client-contracts.gen.ts";

export interface Where {
  readonly sql: string;
  readonly bindings: ApplicationBinding[];
}

const FLAG = /^[a-z][a-z_]{0,39}$/;
const STATUSES = ["new", "proposed", "drafted", "posted", "excluded"];

const cents = (value: string, name: string): bigint => {
  if (!isMoney(value) || value.startsWith("-"))
    throw new ApplicationError("invalid_input", `${name} must be an amount such as 12.34`);
  return parseMoney(value);
};

export function buildWhere(filter: InboxFilter = {}): Where {
  const clauses: string[] = [];
  const bindings: ApplicationBinding[] = [];
  const add = (clause: string, ...values: ApplicationBinding[]) => {
    clauses.push(clause);
    bindings.push(...values);
  };
  if (filter.status && filter.status.length > 0) {
    const statuses = filter.status.filter((status) => STATUSES.includes(status));
    if (statuses.length === 0) add("0");
    else add(`i.status IN (${statuses.map(() => "?").join(", ")})`, ...statuses);
  }
  if (filter.provider !== undefined) add("i.provider = ?", filter.provider);
  if (filter.accountKey !== undefined) add("i.account_key = ?", filter.accountKey);
  if (filter.ledgerAccountId !== undefined) add("s.ledger_account_id = ?", filter.ledgerAccountId);
  if (filter.text !== undefined && filter.text.trim() !== "")
    add("i.search LIKE ? ESCAPE '\\'", likePattern(normalizeForKey(filter.text)));
  if (filter.from !== undefined) add("i.posted_on >= ?", filter.from);
  if (filter.to !== undefined) add("i.posted_on <= ?", filter.to);
  if (filter.minAmount !== undefined)
    add("ABS(i.cents) >= ?", cents(filter.minAmount, "minAmount"));
  if (filter.maxAmount !== undefined)
    add("ABS(i.cents) <= ?", cents(filter.maxAmount, "maxAmount"));
  if (filter.direction === "in") add("i.cents > 0");
  if (filter.direction === "out") add("i.cents < 0");
  if (filter.exclusion !== undefined) add("i.exclusion_code = ?", filter.exclusion);
  if (filter.kind !== undefined) add("i.kind = ?", filter.kind);
  if (filter.coveredBy !== undefined) add("i.covered_by = ?", filter.coveredBy);
  if (filter.covered === true) add("i.covered_by IS NOT NULL");
  if (filter.covered === false) add("i.covered_by IS NULL");
  if (filter.hasProposal === true)
    add("EXISTS (SELECT 1 FROM app_ingest_proposals p WHERE p.item_id = i.id)");
  if (filter.hasProposal === false)
    add("NOT EXISTS (SELECT 1 FROM app_ingest_proposals p WHERE p.item_id = i.id)");
  // A proposer name also names its family: "rule" covers "rule:42".
  if (filter.proposer !== undefined)
    add(
      "EXISTS (SELECT 1 FROM app_ingest_proposals p WHERE p.item_id = i.id AND p.rank = 0 AND (p.proposer = ? OR p.proposer LIKE ? ESCAPE '\\'))",
      filter.proposer,
      `${filter.proposer.replace(/[\\%_]/g, "\\$&")}:%`,
    );
  if (filter.flag !== undefined) {
    if (FLAG.test(filter.flag)) add("i.flags LIKE ?", `%"${filter.flag}"%`);
    else add("0");
  }
  return { sql: clauses.length > 0 ? clauses.join(" AND ") : "1", bindings };
}

export type Sort = "date_desc" | "date_asc" | "amount_desc" | "amount_asc" | "confidence_desc";

/** ORDER BY for a list. Ties always fall back to insertion order, so a page never reshuffles. */
export function orderBy(sort: Sort | undefined): { sql: string; join: string } {
  switch (sort ?? "date_desc") {
    case "date_asc":
      return { sql: "i.posted_on ASC, i.seq ASC", join: "" };
    case "amount_desc":
      return { sql: "ABS(i.cents) DESC, i.seq DESC", join: "" };
    case "amount_asc":
      return { sql: "ABS(i.cents) ASC, i.seq ASC", join: "" };
    case "confidence_desc":
      return {
        sql: "p0.confidence IS NULL, p0.confidence DESC, i.posted_on DESC, i.seq DESC",
        join: "LEFT JOIN app_ingest_proposals p0 ON p0.item_id = i.id AND p0.rank = 0",
      };
    default:
      return { sql: "i.posted_on DESC, i.seq DESC", join: "" };
  }
}
