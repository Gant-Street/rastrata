import type { ApplicationInputs, ApplicationOutputs } from "../client-contracts.gen.ts";

/** The records of the book that are not the ledger but belong to the business: the reconciliations it finished, its rules, its payees, the tags on its
 * accounts and the history of what changed in it. The open export holds them beside the ledger as plain files, so a person who takes their books away takes
 * these too. Each file is the reply of the application's own read operation (see `rastrata schema OPERATION`), read when the export is written, so it is
 * the same record the screens show and carries no second format to keep in step.
 *
 * The names are flat (no folder): a `rastrata-export-v1` manifest lists files by a name of letters, digits, dots and hyphens, and a reader of that version
 * checks every file it lists and ignores the ones it does not know. */

/** Reads one operation of the application as the book's owner would, for a file of records. */
export type ReadOperation = <K extends keyof ApplicationOutputs>(
  name: K,
  input?: ApplicationInputs[K],
) => Promise<ApplicationOutputs[K]>;

/** One file of records beside the ledger. `produce` reads everything and returns the whole text, so a record that cannot be read leaves no half-written file:
 * the export goes on without it and the README says which it left out. */
export interface RecordFile {
  readonly path: string;
  /** One record to a line (JSON Lines): the manifest counts the lines. */
  readonly lineOriented: boolean;
  /** What the file is, for the README's table: a sentence. */
  readonly what: string;
  readonly produce: () => Promise<string>;
}

const PAGE = 200;

const line = (value: unknown): string => `${JSON.stringify(value)}\n`;
const document = (value: unknown): string => `${JSON.stringify(value, null, 2)}\n`;
const earlier = (left: string, right: string): number => (left < right ? -1 : left > right ? 1 : 0);

/** Every reconciliation that was finished or voided, oldest statement first, one per line: the statement date and balance, the opening balance, the lines it cleared
 * and the hash that chains it to the one before. A draft is working state and is not a record. */
function reconciliations(read: ReadOperation): RecordFile {
  return {
    path: "records-reconciliations.jsonl",
    lineOriented: true,
    what: "One JSON object per line: every reconciliation that was completed or voided, oldest statement first, with the lines it cleared. Each is the reply of `reconcile.get`.",
    async produce() {
      const found: { readonly id: string; readonly statementDate: string }[] = [];
      for (let page = 1; ; page += 1) {
        const listed = await read("reconcile.list", { page });
        for (const item of listed.items)
          if (item.status !== "draft")
            found.push({ id: item.id, statementDate: item.statementDate });
        if (listed.items.length === 0 || page * listed.pageSize >= listed.count) break;
      }
      found.sort(
        (left, right) =>
          earlier(left.statementDate, right.statementDate) || earlier(left.id, right.id),
      );
      let text = "";
      for (const item of found) text += line(await read("reconcile.get", { id: item.id }));
      return text;
    },
  };
}

/** The rules in the order they are tried, and the ones that were deleted. */
function rules(read: ReadOperation): RecordFile {
  return {
    path: "records-rules.json",
    lineOriented: false,
    what: "The owner's rules in the order they are tried (`rules.list`), and the rules that were deleted.",
    async produce() {
      const active = await read("rules.list", {});
      const deleted = await read("rules.list", { status: "deleted" });
      return document({
        rulesRevision: active.rulesRevision,
        orderedBy: active.orderedBy,
        orderedAt: active.orderedAt,
        rules: active.rules,
        deletedRules: deleted.rules,
      });
    },
  };
}

/** The one list of payees, retired ones too, read as one revision of it. */
function payees(read: ReadOperation): RecordFile {
  return {
    path: "records-payees.json",
    lineOriented: false,
    what: "The payees: each business or person the book pays or is paid by, with the words that find it in a bank's text, its default account and its 1099 details, retired ones included (`payees.list`).",
    async produce() {
      const all: ApplicationOutputs["payees.list"]["payees"][number][] = [];
      let revision = "";
      let hash = "";
      for (let page = 1; ; page += 1) {
        const listed = await read("payees.list", {
          includeRetired: true,
          page,
          pageSize: PAGE,
          ...(revision ? { payeesRevision: revision } : {}),
        });
        revision = listed.payeesRevision;
        hash = listed.payeesHash;
        all.push(...listed.payees);
        if (listed.payees.length === 0 || page * listed.pageSize >= listed.count) break;
      }
      return document({ payeesRevision: revision, payeesHash: hash, payees: all });
    },
  };
}

/** Every recorded change to the tags on an account (its cash-flow class, tax line and role key), for each account that has any, in the order of the chart. */
function accountTags(read: ReadOperation): RecordFile {
  return {
    path: "records-account-tags.jsonl",
    lineOriented: true,
    what: "One JSON object per line: each account that has tags (its cash-flow class, tax line or role key), with every change to them, oldest first, from setup on (`accounts.tagHistory`).",
    async produce() {
      const chart = await read("accounts.list", {});
      let text = "";
      const accounts = [...chart.accounts].sort(
        (left, right) => earlier(left.code, right.code) || earlier(left.id, right.id),
      );
      for (const account of accounts) {
        const history = await read("accounts.tagHistory", { accountId: account.id });
        if (history.events.length === 0) continue;
        text += line({
          accountId: account.id,
          code: account.code,
          name: account.name,
          events: history.events,
        });
      }
      return text;
    },
  };
}

/** What changed in the books since they were opened: entries posted and reversed, periods closed and reopened, accounts, rules, tags, reconciliations and who had
 * access, each with who made it and how, oldest first. The list says in `notCovered` and `attribution` what it does not hold. */
function changes(read: ReadOperation, since: string): RecordFile {
  return {
    path: "records-changes.json",
    lineOriented: false,
    what: "What changed in the books since they were opened, oldest first, one change to a line: what happened, who made it and how (or that it was not recorded). It names in `notCovered` the changes the list does not hold (`changes.list`).",
    async produce() {
      const all: ApplicationOutputs["changes.list"]["changes"][number][] = [];
      let first: ApplicationOutputs["changes.list"] | undefined;
      for (let page = 1; ; page += 1) {
        const listed = await read("changes.list", {
          since,
          page,
          pageSize: PAGE,
          // Every page of the list is read at the revision, and at the time, the first was.
          ...(first ? { revision: first.revision, asOf: first.asOf } : {}),
        });
        first ??= listed;
        all.push(...listed.changes);
        if (listed.changes.length === 0 || page * listed.pageSize >= listed.count) break;
      }
      if (!first) return "";
      // Newest first as the list gives it; a file that is kept reads from the day the books were opened.
      all.reverse();
      const head = JSON.stringify({
        revision: first.revision,
        since,
        count: all.length,
        actors: first.actors,
        sources: first.sources,
        notCovered: first.notCovered,
        attribution: first.attribution,
      });
      return `${head.slice(0, -1)},"changes":[\n${all.map((change) => JSON.stringify(change)).join(",\n")}\n]}\n`;
    },
  };
}

/** The files of records for the export of a book whose calendar begins on `firstDate`. */
export function recordFiles(read: ReadOperation, firstDate: string): readonly RecordFile[] {
  return [
    reconciliations(read),
    rules(read),
    payees(read),
    accountTags(read),
    changes(read, firstDate),
  ];
}
