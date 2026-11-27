import type { ApplicationStore } from "../../storage.ts";
import type { XeroAccount } from "../../shadow/xero/chart.ts";
import type { Choice } from "../../shadow/xero/mapping.ts";
import type { TrialBalanceRow } from "../../shadow/xero/trial-balance.ts";
import type { TransactionBlock } from "../../shadow/xero/transactions.ts";
import type { OpeningRole } from "../../shadow/opening.ts";

/** What was imported from Xero, kept so the mapping, the opening balances and the tie-out can use it
 * again without the file. Amounts are integer cents held as text (an amount may be larger than a
 * JavaScript number holds exactly), and nothing here is edited: an import replaces what it covers and
 * every file that was imported stays in `xero_file`.
 *
 * - `xero_file`: one row for every file imported, with its hash, who imported it and when.
 * - `xero_account`: the chart of the newest chart file, by code.
 * - `xero_mapping`: the owner's decisions: which account of the book a Xero account is, or that it is
 *   left out. An account with no row is matched automatically.
 * - `xero_tb`: trial balance rows, by the date they are as at; an import for a date replaces it.
 * - `xero_line`: account transactions; an import replaces the lines of the accounts it has, on the
 *   dates it covers.
 * - `xero_reconciled`: the date each Xero bank account was reconciled through. */
export const XERO_MIGRATION = `CREATE TABLE xero_file (
    seq INTEGER PRIMARY KEY AUTOINCREMENT,
    kind TEXT NOT NULL,
    sha256 TEXT NOT NULL,
    name TEXT NOT NULL,
    organisation TEXT,
    as_of TEXT,
    period_from TEXT,
    period_to TEXT,
    rows INTEGER NOT NULL,
    imported_at TEXT NOT NULL,
    operation_id TEXT NOT NULL,
    principal TEXT NOT NULL
  );
  CREATE TABLE xero_account (
    code TEXT NOT NULL PRIMARY KEY COLLATE NOCASE,
    name TEXT NOT NULL,
    type TEXT NOT NULL,
    type_label TEXT,
    role TEXT,
    bank INTEGER NOT NULL,
    system INTEGER NOT NULL,
    tax_code TEXT NOT NULL,
    description TEXT NOT NULL,
    balance TEXT,
    archived INTEGER NOT NULL,
    source_row INTEGER NOT NULL,
    file_seq INTEGER NOT NULL
  );
  CREATE TABLE xero_mapping (
    xero_code TEXT NOT NULL PRIMARY KEY COLLATE NOCASE,
    account_id TEXT,
    skip INTEGER NOT NULL,
    set_at TEXT NOT NULL,
    principal TEXT NOT NULL
  );
  CREATE TABLE xero_tb (
    file_seq INTEGER NOT NULL,
    as_of TEXT NOT NULL,
    source_row INTEGER NOT NULL,
    section TEXT,
    code TEXT,
    name TEXT NOT NULL,
    type TEXT,
    debit TEXT NOT NULL,
    credit TEXT NOT NULL,
    ytd_debit TEXT NOT NULL,
    ytd_credit TEXT NOT NULL
  );
  CREATE INDEX xero_tb_as_of ON xero_tb (as_of);
  CREATE TABLE xero_line (
    file_seq INTEGER NOT NULL,
    source_row INTEGER NOT NULL,
    code TEXT,
    name TEXT NOT NULL,
    date TEXT NOT NULL,
    source TEXT NOT NULL,
    description TEXT NOT NULL,
    reference TEXT NOT NULL,
    debit TEXT NOT NULL,
    credit TEXT NOT NULL
  );
  CREATE INDEX xero_line_date ON xero_line (date);
  CREATE TABLE xero_reconciled (
    xero_code TEXT NOT NULL PRIMARY KEY COLLATE NOCASE,
    through TEXT NOT NULL,
    note TEXT NOT NULL,
    set_at TEXT NOT NULL,
    principal TEXT NOT NULL
  )`;

export type XeroFileKind = "chart" | "trial_balance" | "transactions";

export interface FileInput {
  readonly kind: XeroFileKind;
  readonly sha256: string;
  readonly name: string;
  readonly organisation: string | null;
  readonly asOf: string | null;
  readonly from: string | null;
  readonly to: string | null;
  readonly rows: number;
  readonly importedAt: string;
  readonly operationId: string;
  readonly principal: string;
}

export interface FileRow {
  readonly seq: number;
  readonly kind: XeroFileKind;
  readonly sha256: string;
  readonly name: string;
  readonly organisation: string | null;
  readonly asOf: string | null;
  readonly from: string | null;
  readonly to: string | null;
  readonly rows: number;
  readonly importedAt: string;
}

export interface StoredAccount extends Omit<XeroAccount, "row"> {
  readonly row: number;
}

export interface StoredTbRow {
  readonly row: number;
  readonly section: string | null;
  readonly code: string | null;
  readonly name: string;
  readonly type: string | null;
  readonly debit: bigint;
  readonly credit: bigint;
  readonly ytdDebit: bigint;
  readonly ytdCredit: bigint;
}

export interface StoredLine {
  readonly fileSeq: number;
  readonly row: number;
  readonly code: string | null;
  readonly name: string;
  readonly date: string;
  readonly source: string;
  readonly description: string;
  readonly reference: string;
  readonly debit: bigint;
  readonly credit: bigint;
}

export interface ReconciledRow {
  readonly code: string;
  readonly through: string;
  readonly note: string;
  readonly setAt: string;
}

export interface Range {
  readonly seq: number;
  readonly from: string;
  readonly to: string;
}

type Raw = Record<string, string | number | null>;

export class XeroStore {
  constructor(readonly db: ApplicationStore) {}

  // ---- Files ----
  private addFile(file: FileInput): number {
    this.db
      .query(
        "INSERT INTO xero_file (kind, sha256, name, organisation, as_of, period_from, period_to, rows, imported_at, operation_id, principal) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
      )
      .run(
        file.kind,
        file.sha256,
        file.name,
        file.organisation,
        file.asOf,
        file.from,
        file.to,
        file.rows,
        file.importedAt,
        file.operationId,
        file.principal,
      );
    const row = this.db.query("SELECT last_insert_rowid() AS seq").get() as { seq: number };
    return row.seq;
  }

  files(limit = 100): FileRow[] {
    return (
      this.db
        .query(
          "SELECT seq, kind, sha256, name, organisation, as_of, period_from, period_to, rows, imported_at FROM xero_file ORDER BY seq DESC LIMIT ?",
        )
        .all(limit) as Raw[]
    ).map((row) => ({
      seq: row.seq as number,
      kind: row.kind as XeroFileKind,
      sha256: row.sha256 as string,
      name: row.name as string,
      organisation: (row.organisation as string | null) ?? null,
      asOf: (row.as_of as string | null) ?? null,
      from: (row.period_from as string | null) ?? null,
      to: (row.period_to as string | null) ?? null,
      rows: row.rows as number,
      importedAt: row.imported_at as string,
    }));
  }

  /** The file of this kind and hash imported most recently, if any: the same file again is a no-op. */
  fileByHash(kind: XeroFileKind, sha256: string): FileRow | null {
    return this.files(1000).find((file) => file.kind === kind && file.sha256 === sha256) ?? null;
  }

  // ---- The chart ----
  chartImportedAt(): string | null {
    const row = this.db
      .query("SELECT imported_at FROM xero_file WHERE kind = 'chart' ORDER BY seq DESC LIMIT 1")
      .get() as { imported_at: string } | null;
    return row?.imported_at ?? null;
  }

  accounts(): StoredAccount[] {
    return (
      this.db
        .query(
          "SELECT code, name, type, type_label, role, bank, system, tax_code, description, balance, archived, source_row FROM xero_account ORDER BY source_row, code",
        )
        .all() as Raw[]
    ).map((row) => ({
      code: row.code as string,
      name: row.name as string,
      type: row.type as string,
      typeLabel: (row.type_label as string | null) ?? null,
      role: ((row.role as string | null) ?? null) as OpeningRole | null,
      bank: row.bank === 1,
      system: row.system === 1,
      taxCode: row.tax_code as string,
      description: row.description as string,
      balance: (row.balance as string | null) ?? null,
      archived: row.archived === 1,
      row: row.source_row as number,
    }));
  }

  /** Replace the stored chart with the one in a file. Returns whether there was one before. */
  replaceChart(
    file: FileInput,
    accounts: readonly XeroAccount[],
  ): { seq: number; replaced: boolean } {
    return this.db.transaction(() => {
      const replaced = this.chartImportedAt() !== null;
      const seq = this.addFile(file);
      this.db.query("DELETE FROM xero_account").run();
      const insert = this.db.query(
        "INSERT INTO xero_account (code, name, type, type_label, role, bank, system, tax_code, description, balance, archived, source_row, file_seq) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
      );
      for (const account of accounts)
        insert.run(
          account.code,
          account.name,
          account.type,
          account.typeLabel,
          account.role,
          account.bank ? 1 : 0,
          account.system ? 1 : 0,
          account.taxCode,
          account.description,
          account.balance,
          account.archived ? 1 : 0,
          account.row,
          seq,
        );
      return { seq, replaced };
    });
  }

  // ---- The mapping ----
  mapping(): Map<string, Choice> {
    const map = new Map<string, Choice>();
    for (const row of this.db
      .query("SELECT xero_code, account_id, skip FROM xero_mapping")
      .all() as Raw[])
      map.set((row.xero_code as string).toLowerCase(), {
        accountId: (row.account_id as string | null) ?? null,
        skip: row.skip === 1,
      });
    return map;
  }

  saveChoices(
    choices: readonly { readonly code: string; readonly choice: Choice }[],
    meta: { readonly setAt: string; readonly principal: string },
  ): void {
    this.db.transaction(() => {
      const upsert = this.db.query(
        "INSERT INTO xero_mapping (xero_code, account_id, skip, set_at, principal) VALUES (?, ?, ?, ?, ?) ON CONFLICT(xero_code) DO UPDATE SET account_id=excluded.account_id, skip=excluded.skip, set_at=excluded.set_at, principal=excluded.principal",
      );
      for (const { code, choice } of choices)
        upsert.run(
          code,
          choice.skip ? null : choice.accountId,
          choice.skip ? 1 : 0,
          meta.setAt,
          meta.principal,
        );
    });
  }

  clearChoices(codes: readonly string[]): number {
    let cleared = 0;
    this.db.transaction(() => {
      const remove = this.db.query("DELETE FROM xero_mapping WHERE xero_code = ?");
      for (const code of codes) cleared += remove.run(code).changes;
    });
    return cleared;
  }

  // ---- Trial balances ----
  trialBalanceDates(): string[] {
    return (this.db.query("SELECT DISTINCT as_of FROM xero_tb ORDER BY as_of").all() as Raw[]).map(
      (row) => row.as_of as string,
    );
  }

  trialBalance(asOf: string): StoredTbRow[] {
    return (
      this.db
        .query(
          "SELECT source_row, section, code, name, type, debit, credit, ytd_debit, ytd_credit FROM xero_tb WHERE as_of = ? ORDER BY source_row",
        )
        .all(asOf) as Raw[]
    ).map((row) => ({
      row: row.source_row as number,
      section: (row.section as string | null) ?? null,
      code: (row.code as string | null) ?? null,
      name: row.name as string,
      type: (row.type as string | null) ?? null,
      debit: BigInt(row.debit as string),
      credit: BigInt(row.credit as string),
      ytdDebit: BigInt(row.ytd_debit as string),
      ytdCredit: BigInt(row.ytd_credit as string),
    }));
  }

  /** Store a trial balance, replacing any already stored for the same date. */
  replaceTrialBalance(
    file: FileInput,
    asOf: string,
    rows: readonly TrialBalanceRow[],
  ): { seq: number; replaced: boolean } {
    return this.db.transaction(() => {
      const replaced = this.trialBalanceDates().includes(asOf);
      const seq = this.addFile({ ...file, asOf });
      this.db.query("DELETE FROM xero_tb WHERE as_of = ?").run(asOf);
      const insert = this.db.query(
        "INSERT INTO xero_tb (file_seq, as_of, source_row, section, code, name, type, debit, credit, ytd_debit, ytd_credit) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
      );
      for (const row of rows)
        insert.run(
          seq,
          asOf,
          row.row,
          row.section,
          row.code,
          row.name,
          row.type,
          row.debit.toString(),
          row.credit.toString(),
          row.ytdDebit.toString(),
          row.ytdCredit.toString(),
        );
      return { seq, replaced };
    });
  }

  // ---- Account transactions ----
  /** The date ranges account transactions were imported for, one per file. */
  transactionRanges(): Range[] {
    return (
      this.db
        .query(
          "SELECT seq, period_from, period_to FROM xero_file WHERE kind = 'transactions' AND period_from IS NOT NULL AND period_to IS NOT NULL ORDER BY period_from, seq",
        )
        .all() as Raw[]
    ).map((row) => ({
      seq: row.seq as number,
      from: row.period_from as string,
      to: row.period_to as string,
    }));
  }

  lines(from: string, to: string): StoredLine[] {
    return (
      this.db
        .query(
          "SELECT file_seq, source_row, code, name, date, source, description, reference, debit, credit FROM xero_line WHERE date >= ? AND date <= ? ORDER BY date, file_seq, source_row",
        )
        .all(from, to) as Raw[]
    ).map((row) => ({
      fileSeq: row.file_seq as number,
      row: row.source_row as number,
      code: (row.code as string | null) ?? null,
      name: row.name as string,
      date: row.date as string,
      source: row.source as string,
      description: row.description as string,
      reference: row.reference as string,
      debit: BigInt(row.debit as string),
      credit: BigInt(row.credit as string),
    }));
  }

  lineCount(): number {
    return (this.db.query("SELECT COUNT(*) AS n FROM xero_line").get() as { n: number }).n;
  }

  /** Store the blocks of an Account Transactions file. For each account in it, the lines already
   * stored for that account on the dates the file covers are replaced. */
  replaceTransactions(
    file: FileInput,
    blocks: readonly (TransactionBlock & { readonly key: string })[],
    from: string,
    to: string,
  ): { seq: number; stored: number; replaced: number } {
    return this.db.transaction(() => {
      const seq = this.addFile({ ...file, from, to });
      let replaced = 0;
      let stored = 0;
      const remove = this.db.query(
        "DELETE FROM xero_line WHERE (code = ? OR (code IS NULL AND name = ?)) AND date >= ? AND date <= ?",
      );
      const insert = this.db.query(
        "INSERT INTO xero_line (file_seq, source_row, code, name, date, source, description, reference, debit, credit) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
      );
      for (const block of blocks) {
        replaced += remove.run(block.code ?? "", block.name, from, to).changes;
        for (const line of block.lines) {
          insert.run(
            seq,
            line.row,
            block.code,
            block.name,
            line.date,
            line.source,
            line.description,
            line.reference,
            line.debit.toString(),
            line.credit.toString(),
          );
          stored++;
        }
      }
      return { seq, stored, replaced };
    });
  }

  // ---- Where Xero was reconciled ----
  reconciled(): ReconciledRow[] {
    return (
      this.db
        .query("SELECT xero_code, through, note, set_at FROM xero_reconciled ORDER BY xero_code")
        .all() as Raw[]
    ).map((row) => ({
      code: row.xero_code as string,
      through: row.through as string,
      note: row.note as string,
      setAt: row.set_at as string,
    }));
  }

  setReconciled(
    entries: readonly { readonly code: string; readonly through: string; readonly note: string }[],
    meta: { readonly setAt: string; readonly principal: string },
  ): void {
    this.db.transaction(() => {
      const upsert = this.db.query(
        "INSERT INTO xero_reconciled (xero_code, through, note, set_at, principal) VALUES (?, ?, ?, ?, ?) ON CONFLICT(xero_code) DO UPDATE SET through=excluded.through, note=excluded.note, set_at=excluded.set_at, principal=excluded.principal",
      );
      for (const entry of entries)
        upsert.run(entry.code, entry.through, entry.note, meta.setAt, meta.principal);
    });
  }

  clearReconciled(codes: readonly string[]): number {
    let cleared = 0;
    this.db.transaction(() => {
      const remove = this.db.query("DELETE FROM xero_reconciled WHERE xero_code = ?");
      for (const code of codes) cleared += remove.run(code).changes;
    });
    return cleared;
  }
}
