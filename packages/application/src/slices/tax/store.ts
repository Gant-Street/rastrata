/** The tax lane's product state: what a person recorded about vendors, and which accounts they marked
 * 1099-reportable. It changes what a figure says (who a payment belongs to, whether it counts), so it
 * is kept the way tags are: append-only, with who and when, and the whole state hashes into the
 * population of the report it feeds, so a report reproduces.
 *
 * One table, `tax_events`, is the whole history. A row says "from now on, this vendor reads like
 * this" (the full record, not a patch) or "this account is, or is no longer, reportable". Nothing is
 * edited or deleted; the newest row for a subject is what is in force, and `throughRevision` reads
 * the state as it was at any earlier row. Reached only through `service.store`. */
import { hashCanonical } from "@rastrata/kernel";

import type { ApplicationService } from "../../service.ts";
import type { ApplicationStore } from "../../storage.ts";
import {
  CLASSIFICATIONS,
  EXEMPT_REASONS,
  PAID_BY,
  VENDOR_REPORTING,
  W9_STATES,
  type Classification,
  type ExemptReason,
  type PaidBy,
  type Vendor,
  type VendorReporting,
  type W9State,
} from "../../tax/vendors.ts";
import { migrate, sliceState } from "../state.ts";

export const TAX_MIGRATIONS: readonly string[] = [
  // 1: the history of vendors and reportable accounts.
  `CREATE TABLE tax_events (
     seq INTEGER PRIMARY KEY AUTOINCREMENT,
     kind TEXT NOT NULL CHECK (kind IN ('vendor', 'account')),
     subject TEXT NOT NULL,
     body TEXT NOT NULL,
     recorded_at TEXT NOT NULL,
     principal TEXT NOT NULL,
     operation_id TEXT NOT NULL,
     UNIQUE (operation_id, kind, subject)
   );
   CREATE INDEX tax_events_subject ON tax_events (kind, subject, seq)`,
];

export interface TaxRuntime {
  readonly store: ApplicationStore;
  /** The lane's clock, an ISO instant. Replaceable so tests are deterministic. */
  now: () => string;
}

export function taxRuntime(service: ApplicationService): TaxRuntime {
  return sliceState(service, "tax", (store) => {
    migrate(store, "tax", TAX_MIGRATIONS);
    return { store, now: () => service.now() } as TaxRuntime;
  });
}

/** What is stored for a vendor in each row: everything except the identity, the version and who and
 * when, which belong to the row. */
export interface VendorBody {
  readonly name: string;
  readonly payeeKeys: readonly string[];
  readonly reporting: VendorReporting;
  readonly reason: ExemptReason | null;
  readonly w9: W9State;
  readonly w9On: string | null;
  readonly classification: Classification | null;
  readonly paidBy: PaidBy;
  readonly notes: string;
}

interface Row {
  seq: number;
  kind: "vendor" | "account";
  subject: string;
  body: string;
  recorded_at: string;
  principal: string;
}

const oneOf = <T extends string>(list: readonly T[], value: unknown, fallback: T): T =>
  typeof value === "string" && (list as readonly string[]).includes(value)
    ? (value as T)
    : fallback;

/** The body of a stored row, read defensively: a row this release wrote is always well formed, and a
 * row it cannot read becomes the most cautious reading rather than an exception that hides every
 * vendor. */
function bodyOf(raw: string): VendorBody {
  let value: Record<string, unknown> = {};
  try {
    value = JSON.parse(raw) as Record<string, unknown>;
  } catch {
    // an unreadable row reads as an unnamed, undecided vendor
  }
  const keys = Array.isArray(value.payeeKeys)
    ? value.payeeKeys.filter((key): key is string => typeof key === "string")
    : [];
  return {
    name: typeof value.name === "string" ? value.name : "(unreadable)",
    payeeKeys: keys,
    reporting: oneOf(VENDOR_REPORTING, value.reporting, "undecided"),
    reason: value.reason === null ? null : oneOf(EXEMPT_REASONS, value.reason, "other"),
    w9: oneOf(W9_STATES, value.w9, "not_requested"),
    w9On: typeof value.w9On === "string" ? value.w9On : null,
    classification:
      value.classification === null || value.classification === undefined
        ? null
        : oneOf(CLASSIFICATIONS, value.classification, "other"),
    paidBy: oneOf(PAID_BY, value.paidBy, "unknown"),
    notes: typeof value.notes === "string" ? value.notes : "",
  };
}

export interface VendorHistoryEntry extends VendorBody {
  readonly seq: number;
  readonly version: number;
  readonly recordedAt: string;
  readonly principal: string;
}

export interface TaxState {
  /** The sequence of the newest row read: 0 when nothing was ever recorded. Pass it back as
   * `throughRevision` to read the state as it was. */
  readonly revision: number;
  /** Changes whenever anything that affects a figure changes, and only then. */
  readonly hash: string;
  readonly vendors: readonly Vendor[];
  readonly reportable: ReadonlySet<string>;
  /** Every version of every vendor read, oldest first. */
  readonly history: ReadonlyMap<string, readonly VendorHistoryEntry[]>;
}

const compareText = (a: string, b: string) => (a < b ? -1 : a > b ? 1 : 0);

/** The state as of `throughRevision` (the newest row by default). */
export function readTaxState(
  store: ApplicationStore,
  options: { readonly throughRevision?: number } = {},
): TaxState {
  const limit = options.throughRevision ?? Number.MAX_SAFE_INTEGER;
  const rows = store
    .query(
      "SELECT seq, kind, subject, body, recorded_at, principal FROM tax_events WHERE seq <= ? ORDER BY seq",
    )
    .all(limit) as Row[];
  const history = new Map<string, VendorHistoryEntry[]>();
  const latestAccount = new Map<string, boolean>();
  for (const row of rows) {
    if (row.kind === "vendor") {
      const list = history.get(row.subject) ?? [];
      history.set(row.subject, list);
      list.push({
        ...bodyOf(row.body),
        seq: row.seq,
        version: list.length + 1,
        recordedAt: row.recorded_at,
        principal: row.principal,
      });
    } else {
      try {
        latestAccount.set(
          row.subject,
          (JSON.parse(row.body) as { reportable?: unknown }).reportable === true,
        );
      } catch {
        latestAccount.set(row.subject, false);
      }
    }
  }
  const vendors: Vendor[] = [];
  for (const [id, list] of history) {
    const newest = list.at(-1);
    if (!newest) continue;
    vendors.push({
      id,
      version: newest.version,
      name: newest.name,
      payeeKeys: newest.payeeKeys,
      reporting: newest.reporting,
      reason: newest.reason,
      w9: newest.w9,
      w9On: newest.w9On,
      classification: newest.classification,
      paidBy: newest.paidBy,
      notes: newest.notes,
      recordedAt: newest.recordedAt,
      principal: newest.principal,
    });
  }
  vendors.sort(
    (a, b) => compareText(a.name.toLowerCase(), b.name.toLowerCase()) || compareText(a.id, b.id),
  );
  const reportable = new Set([...latestAccount].filter(([, on]) => on).map(([id]) => id));
  return {
    revision: rows.at(-1)?.seq ?? 0,
    // Everything a vendor list or a file shows: who a payment belongs to, whether it counts, the
    // W-9 and the notes, and which accounts are read. Who recorded a version and when are not in it
    // (the history keeps them), so recording the same facts again does not move the hash.
    hash: hashCanonical({
      type: "TaxVendorState",
      vendors: vendors.map((vendor) => ({
        id: vendor.id,
        name: vendor.name,
        keys: [...vendor.payeeKeys],
        reporting: vendor.reporting,
        reason: vendor.reason,
        w9: vendor.w9,
        w9On: vendor.w9On,
        classification: vendor.classification,
        paidBy: vendor.paidBy,
        notes: vendor.notes,
      })),
      accounts: [...reportable].sort(compareText),
    }).digest,
    vendors,
    reportable,
    history,
  };
}

/** Append one row. */
export function appendEvent(
  runtime: TaxRuntime,
  event: {
    readonly kind: "vendor" | "account";
    readonly subject: string;
    readonly body: unknown;
    readonly principal: string;
    readonly operationId: string;
  },
): void {
  runtime.store
    .query(
      "INSERT INTO tax_events (kind, subject, body, recorded_at, principal, operation_id) VALUES (?, ?, ?, ?, ?, ?)",
    )
    .run(
      event.kind,
      event.subject,
      JSON.stringify(event.body),
      runtime.now(),
      event.principal,
      event.operationId,
    );
}
