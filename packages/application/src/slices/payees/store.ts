/** The payees' product state: the one list of people and businesses the book pays or is paid by, each
 * with one name and the words that identify it in a bank's text.
 *
 * It is kept the way the tax lane keeps vendors and the chart lane keeps tags: append-only, with who
 * and when. One table, `payee_events`, is the whole history; a row is the whole record of a payee from
 * then on, nothing is edited or deleted, the newest row for a payee is what is in force, a payee's
 * version is the count of its rows, and the sequence of the newest row is the **payees revision**, which
 * `throughRevision` pins to read the list as it was. The state hashes everything a report shows (names
 * and words), so a report reproduces.
 *
 * A 1099 vendor is a payee with 1099 details: the vendor's id is the payee's id. `taxVendors.save`
 * writes the vendor's name and words here as well as its 1099 facts in `tax_events`, in one
 * transaction, and `payees.save` writes a vendor's new name and words to `tax_events` too; a book that
 * kept vendors before this list existed gets a payee for each of them the first time the list is
 * opened (`ensureVendorPayees`), which is idempotent and removes nothing. */
import { hashCanonical } from "@rastrata/kernel";

import type { ApplicationService } from "../../service.ts";
import type { ApplicationStore } from "../../storage.ts";
import { migrate, sliceState } from "../state.ts";
import { readTaxState, taxRuntime } from "../tax/store.ts";

export const PAYEE_MIGRATIONS: readonly string[] = [
  // 1: the history of payees.
  `CREATE TABLE payee_events (
     seq INTEGER PRIMARY KEY AUTOINCREMENT,
     payee TEXT NOT NULL,
     version INTEGER NOT NULL,
     body TEXT NOT NULL,
     recorded_at TEXT NOT NULL,
     principal TEXT NOT NULL,
     via TEXT NOT NULL,
     operation_id TEXT NOT NULL,
     UNIQUE (operation_id, payee),
     UNIQUE (payee, version)
   );
   CREATE INDEX payee_events_payee ON payee_events (payee, seq)`,
];

export interface PayeesRuntime {
  readonly store: ApplicationStore;
  /** The lane's clock, an ISO instant. Replaceable so tests are deterministic. */
  now: () => string;
}

export function payeesRuntime(service: ApplicationService): PayeesRuntime {
  return sliceState(service, "payees", (store) => {
    // The vendors' table is read to give each vendor its payee, so it must exist first.
    taxRuntime(service);
    migrate(store, "payees", PAYEE_MIGRATIONS);
    const runtime: PayeesRuntime = { store, now: () => service.now() };
    ensureVendorPayees(runtime);
    return runtime;
  });
}

/** What is stored for a payee in each row: everything except the identity, the version, and who and
 * when, which belong to the row. */
export interface PayeeBody {
  readonly name: string;
  /** Plain words, lower case, single-spaced: what a bank line's text is matched against. */
  readonly words: readonly string[];
  readonly defaultAccountId: string | null;
  readonly note: string;
  readonly retired: boolean;
}

export interface Payee extends PayeeBody {
  readonly id: string;
  readonly version: number;
  readonly recordedAt: string;
  readonly principal: string;
}

export interface PayeeHistoryEntry extends PayeeBody {
  readonly seq: number;
  readonly version: number;
  readonly recordedAt: string;
  readonly principal: string;
  /** Which operation wrote the row. */
  readonly via: string;
}

export interface PayeeState {
  /** The sequence of the newest row read: 0 when nothing was ever recorded. */
  readonly revision: number;
  /** Changes whenever anything a report shows changes, and only then. */
  readonly hash: string;
  /** Every payee, by name. */
  readonly payees: readonly Payee[];
  /** Every version of every payee read, oldest first. */
  readonly history: ReadonlyMap<string, readonly PayeeHistoryEntry[]>;
}

interface Row {
  seq: number;
  payee: string;
  version: number;
  body: string;
  recorded_at: string;
  principal: string;
  via: string;
}

const compareText = (a: string, b: string) => (a < b ? -1 : a > b ? 1 : 0);

/** The body of a stored row, read defensively: a row this release wrote is always well formed, and a
 * row it cannot read becomes the most cautious reading (a payee with no words, which matches nothing)
 * rather than an exception that hides every payee. */
function bodyOf(raw: string): PayeeBody {
  let value: Record<string, unknown> = {};
  try {
    value = JSON.parse(raw) as Record<string, unknown>;
  } catch {
    // an unreadable row reads as an unnamed payee that matches nothing
  }
  return {
    name: typeof value.name === "string" ? value.name : "(unreadable)",
    words: Array.isArray(value.words)
      ? value.words.filter((word): word is string => typeof word === "string")
      : [],
    defaultAccountId: typeof value.defaultAccountId === "string" ? value.defaultAccountId : null,
    note: typeof value.note === "string" ? value.note : "",
    retired: value.retired === true,
  };
}

/** The list as of `throughRevision` (the newest row by default). */
export function readPayeeState(
  store: ApplicationStore,
  options: { readonly throughRevision?: number } = {},
): PayeeState {
  const limit = options.throughRevision ?? Number.MAX_SAFE_INTEGER;
  const rows = store
    .query(
      "SELECT seq, payee, version, body, recorded_at, principal, via FROM payee_events WHERE seq <= ? ORDER BY seq",
    )
    .all(limit) as Row[];
  const history = new Map<string, PayeeHistoryEntry[]>();
  for (const row of rows) {
    const list = history.get(row.payee) ?? [];
    history.set(row.payee, list);
    list.push({
      ...bodyOf(row.body),
      seq: row.seq,
      version: row.version,
      recordedAt: row.recorded_at,
      principal: row.principal,
      via: row.via,
    });
  }
  const payees: Payee[] = [];
  for (const [id, list] of history) {
    const newest = list.at(-1);
    if (!newest) continue;
    payees.push({
      id,
      version: newest.version,
      name: newest.name,
      words: newest.words,
      defaultAccountId: newest.defaultAccountId,
      note: newest.note,
      retired: newest.retired,
      recordedAt: newest.recordedAt,
      principal: newest.principal,
    });
  }
  payees.sort(
    (a, b) => compareText(a.name.toLowerCase(), b.name.toLowerCase()) || compareText(a.id, b.id),
  );
  return {
    revision: rows.at(-1)?.seq ?? 0,
    // Everything a report or a list shows. Who recorded a version and when are not in it (the history
    // keeps them), so recording the same facts again does not move the hash.
    hash: hashCanonical({
      type: "PayeeState",
      payees: payees.map((payee) => ({
        id: payee.id,
        name: payee.name,
        words: [...payee.words],
        defaultAccountId: payee.defaultAccountId,
        note: payee.note,
        retired: payee.retired,
      })),
    }).digest,
    payees,
    history,
  };
}

/** Append one row for a payee: its whole record from now on. The version is the next one. */
export function appendPayee(
  runtime: PayeesRuntime,
  event: {
    readonly payee: string;
    readonly body: PayeeBody;
    readonly principal: string;
    readonly operationId: string;
    readonly via: "payees.save" | "taxVendors.save" | "migration";
  },
): void {
  const last = runtime.store
    .query("SELECT MAX(version) AS version FROM payee_events WHERE payee = ?")
    .get(event.payee) as { version: number | null } | null;
  runtime.store
    .query(
      "INSERT INTO payee_events (payee, version, body, recorded_at, principal, via, operation_id) VALUES (?, ?, ?, ?, ?, ?, ?)",
    )
    .run(
      event.payee,
      (last?.version ?? 0) + 1,
      JSON.stringify(event.body),
      runtime.now(),
      event.principal,
      event.via,
      event.operationId,
    );
}

/** Give every 1099 vendor its payee, with the vendor's id, name and words. A vendor that has one is
 * left alone, so this can run again at any time: it is how a book that kept vendors before the list of
 * payees existed gets its payees, and how a vendor written by an older release is picked up. It adds
 * rows and removes nothing; the vendor's own rows are not touched. */
export function ensureVendorPayees(runtime: PayeesRuntime): number {
  const vendors = readTaxState(runtime.store).vendors;
  if (vendors.length === 0) return 0;
  const have = new Set(
    (
      runtime.store.query("SELECT DISTINCT payee FROM payee_events").all() as { payee: string }[]
    ).map((row) => row.payee),
  );
  const missing = vendors.filter((vendor) => !have.has(vendor.id));
  if (missing.length === 0) return 0;
  runtime.store.transaction(() => {
    for (const vendor of missing)
      appendPayee(runtime, {
        payee: vendor.id,
        body: {
          name: vendor.name,
          words: vendor.payeeKeys,
          defaultAccountId: null,
          note: "",
          retired: false,
        },
        // Made by the move, not by a person: the vendor's own history says who recorded the vendor.
        principal: "service:payees-migration",
        operationId: `vendor-${vendor.id}`,
        via: "migration",
      });
  });
  return missing.length;
}
