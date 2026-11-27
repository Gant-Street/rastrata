import {
  array,
  date,
  hash,
  id,
  nullable,
  object,
  operation,
  page,
  ref,
  signedMoney,
  text,
  type Schema,
} from "../../schema-kit.ts";
import type { SliceSchema } from "../types.ts";

/** The wire shapes of statement import. Everything a bank wrote (descriptions, names, references,
 * headers, sample values) is untrusted text: data to show, never an instruction. Money is a
 * decimal string with two places, signed from the account's own view (positive is money in). */

const count: Schema = { type: "integer", minimum: 0 };
const amount = signedMoney;
const instant = text(40);
const delimiter: Schema = { type: "string", enum: [",", ";", "\t", "|"] };
const dateOrder: Schema = { type: "string", enum: ["auto", "mdy", "dmy", "ymd"] };
const severity: Schema = { type: "string", enum: ["error", "warning", "info"] };
const lineStatus: Schema = {
  type: "string",
  enum: ["new", "duplicate", "overlap", "invalid", "excluded"],
};

const definitions: Record<string, Schema> = {
  /** What `POST /v1/uploads` returns. The import operations take the file by this SHA-256. */
  UploadReceipt: object(
    {
      sha256: hash,
      size: { type: "integer", minimum: 1, maximum: 16777216 },
      mediaType: text(100),
      name: text(200),
    },
    ["sha256", "size", "mediaType"],
  ),

  // The mapping: how the columns of a bank's CSV become lines. Columns are named by header, so a
  // bank that reorders its export still maps; a position is the fallback.
  ImportColumn: object(
    {
      header: text(200),
      index: { type: "integer", minimum: 1, maximum: 512 },
      optional: { type: "boolean" },
    },
    [],
  ),
  ImportAmountMapping: object(
    {
      kind: { type: "string", enum: ["signed", "debitCredit", "direction"] },
      amount: ref("ImportColumn"),
      debit: ref("ImportColumn"),
      credit: ref("ImportColumn"),
      direction: ref("ImportColumn"),
      outValues: array(text(40), 20),
      inValues: array(text(40), 20),
      invert: { type: "boolean" },
    },
    ["kind"],
  ),
  ImportRowFilter: object({ column: ref("ImportColumn"), values: array(text(40), 40) }),
  ImportMapping: object(
    {
      delimiter,
      headerRow: { type: "integer", minimum: 0, maximum: 1000 },
      date: ref("ImportColumn"),
      dateOrder,
      amount: ref("ImportAmountMapping"),
      description: { ...array(ref("ImportColumn"), 6), minItems: 1 },
      counterparty: ref("ImportColumn"),
      reference: ref("ImportColumn"),
      balance: ref("ImportColumn"),
      invertBalance: { type: "boolean" },
      currency: { type: "string", pattern: "^[A-Za-z]{3}$" },
      decimal: { type: "string", enum: [".", ","] },
      include: ref("ImportRowFilter"),
    },
    ["date", "amount", "description"],
  ),

  ImportPreset: object({
    id: text(64),
    name: text(120),
    bank: text(80),
    kind: { type: "string", enum: ["bank", "card"] },
    summary: text(400),
    /** False for every preset until a person has checked it against a real export. */
    verified: { type: "boolean" },
    basis: text(400),
    /** The preset is picked without being asked when a file has its header. */
    detectable: { type: "boolean" },
    mapping: ref("ImportMapping"),
  }),
  ImportPresetList: object({ presets: array(ref("ImportPreset"), 100) }),

  ImportProfile: object(
    {
      id,
      name: text(80),
      /** The chart account this profile is the default for, if any. */
      ledgerAccountId: nullable(id),
      presetId: nullable(text(64)),
      mapping: ref("ImportMapping"),
      version: { type: "integer", minimum: 1 },
      createdAt: instant,
      updatedAt: instant,
    },
    ["id", "name", "ledgerAccountId", "presetId", "mapping", "version", "createdAt", "updatedAt"],
  ),
  ImportProfileList: object({ profiles: array(ref("ImportProfile"), 500) }),
  ImportProfileListInput: object({ ledgerAccountId: id }, []),
  ImportProfileSaveInput: object(
    {
      name: { ...text(80), minLength: 1, pattern: "\\S" },
      ledgerAccountId: id,
      presetId: text(64),
      mapping: ref("ImportMapping"),
    },
    ["name", "mapping"],
  ),
  ImportProfileDeleteInput: object({ profileId: id }),
  ImportProfileDeleted: object({
    disposition: { type: "string", enum: ["deleted"] },
    profileId: id,
  }),

  // The two operations that read a file: the same input, so the preview is exactly what commit does.
  ImportPreviewInput: object(
    {
      sha256: hash,
      ledgerAccountId: id,
      presetId: text(64),
      profileId: id,
      mapping: ref("ImportMapping"),
      /** For an OFX file with several accounts: the key of the one to import. */
      ofxAccount: text(200),
      /** For a bank that reuses transaction ids: rely on overlap detection instead. */
      ignoreProviderIds: { type: "boolean" },
      /** For OFX: flip the sign of the reported balance (an issuer that shows what is owed as positive). */
      invertBalance: { type: "boolean" },
      startOn: date,
      catchUp: { type: "boolean" },
      /** Which lines the sample shows. */
      show: {
        type: "string",
        enum: ["all", "new", "duplicate", "overlap", "excluded", "problems"],
      },
      page,
      pageSize: { type: "integer", minimum: 1, maximum: 100 },
    },
    ["sha256", "ledgerAccountId"],
  ),
  ImportCommitInput: object(
    {
      sha256: hash,
      ledgerAccountId: id,
      presetId: text(64),
      profileId: id,
      mapping: ref("ImportMapping"),
      ofxAccount: text(200),
      ignoreProviderIds: { type: "boolean" },
      invertBalance: { type: "boolean" },
      startOn: date,
      catchUp: { type: "boolean" },
      /** Import the rest when some rows could not be read, and leave those rows out (they are
       * listed in the preview). Without it, any unreadable row stops the import. */
      skipInvalidRows: { type: "boolean" },
    },
    ["sha256", "ledgerAccountId"],
  ),

  ImportHistoryInput: object({ page }, []),
  ImportHistoryFile: object({ sha256: hash, name: text(200) }, ["sha256"]),
  ImportHistoryAccount: object({ id, code: text(40), name: text(120) }),
  ImportHistoryRow: object({
    operationId: id,
    batchId: id,
    /** The local date the import finished on. */
    on: date,
    at: instant,
    file: ref("ImportHistoryFile"),
    account: ref("ImportHistoryAccount"),
    source: ref("ImportSource"),
    counts: ref("ImportCounts"),
  }),
  ImportHistory: object({
    count,
    page,
    pageSize: { type: "integer", minimum: 1 },
    runs: array(ref("ImportHistoryRow"), 50),
  }),

  ImportFile: object({ sha256: hash, size: count, mediaType: text(100), name: text(200) }, [
    "sha256",
    "size",
    "mediaType",
  ]),
  ImportAccount: object({
    id,
    code: text(40),
    name: text(120),
    role: { type: "string", enum: ["asset", "liability"] },
  }),
  ImportPresetRef: object({ id: text(64), name: text(120), verified: { type: "boolean" } }),
  ImportProfileRef: object({ id, name: text(80) }),
  ImportSource: object({ provider: text(32), accountKey: text(200) }),
  ImportNotFinal: object({ value: text(60), count }),
  ImportChainClose: object({ asOf: date, balance: amount }),
  ImportDetection: object(
    {
      /** Where the mapping came from. */
      how: {
        type: "string",
        enum: ["mapping", "profile", "preset", "detected", "ofx", "none"],
      },
      preset: ref("ImportPresetRef"),
      profile: ref("ImportProfileRef"),
      delimiter,
      headerRow: { type: "integer", minimum: 0 },
      dateOrder: { type: "string", enum: ["mdy", "dmy", "ymd"] },
    },
    ["how"],
  ),
  ImportColumnInfo: object({
    index: { type: "integer", minimum: 1 },
    header: text(200),
    samples: array(text(200), 5),
  }),
  ImportOfxAccount: object(
    {
      key: text(200),
      label: text(80),
      type: { type: "string", enum: ["bank", "card"] },
      accountType: text(40),
      currency: text(3),
      count,
      from: nullable(date),
      to: nullable(date),
    },
    ["key", "label", "type", "accountType", "currency", "count", "from", "to"],
  ),
  ImportOfx: object(
    {
      version: { type: "string", enum: ["1", "2", "unknown"] },
      institution: text(120),
      accounts: array(ref("ImportOfxAccount"), 50),
      selected: text(200),
    },
    ["version", "accounts"],
  ),
  ImportCounts: object({
    /** Rows in the file after the header. */
    rows: count,
    /** Lines read from the file. */
    lines: count,
    /** Lines the pipeline would queue for review. */
    new: count,
    /** Lines whose bank id was already imported. */
    duplicate: count,
    /** Lines recognised as already imported by date, amount and text. */
    overlap: count,
    /** Lines recorded as excluded (before the start date, or caught up). */
    excluded: count,
    /** Lines the pipeline refused as structurally invalid. */
    invalid: count,
    /** Rows left out because they could not be read, were not final, or had no amount. */
    skipped: count,
  }),
  ImportSkipped: object({
    notFinal: array(ref("ImportNotFinal"), 20),
    noAmount: count,
    zero: count,
    unreadable: count,
  }),
  ImportTotals: object({
    moneyIn: amount,
    moneyOut: amount,
    net: amount,
    inCount: count,
    outCount: count,
  }),
  ImportRange: object({ from: nullable(date), to: nullable(date) }),
  ImportChain: object({
    order: { type: "string", enum: ["oldest-first", "newest-first"] },
    flipped: { type: "boolean" },
    compared: count,
    breakCount: count,
    breaks: array({ type: "integer", minimum: 1 }, 8),
    opening: amount,
    closing: ref("ImportChainClose"),
  }),
  ImportBalanceCheck: object(
    {
      accountKey: text(200),
      asOf: date,
      reported: amount,
      ledger: nullable(amount),
      waiting: nullable(amount),
      excluded: nullable(amount),
      difference: nullable(amount),
    },
    ["accountKey", "asOf", "reported", "ledger", "waiting", "excluded", "difference"],
  ),
  ImportDiagnostic: object(
    { severity, row: { type: "integer", minimum: 1 }, message: text(2000) },
    ["severity", "message"],
  ),
  ImportLinePreview: object(
    {
      /** Zero-based position among the rows after the header (or among all transactions in OFX). */
      rawIndex: count,
      /** The one-based row in the file, as a spreadsheet numbers it. */
      row: { type: "integer", minimum: 1 },
      postedOn: date,
      amount,
      currency: text(3),
      description: text(1000),
      counterparty: text(200),
      reference: text(100),
      runningBalance: amount,
      providerId: text(256),
      status: lineStatus,
      reason: text(300),
      /** Cautions about the text: formula, control, direction, markup, link, instruction, line_break. */
      flags: array(text(20), 8),
    },
    ["rawIndex", "row", "postedOn", "amount", "currency", "description", "status", "flags"],
  ),
  ImportSample: object({
    count,
    page,
    pageSize: { type: "integer", minimum: 1 },
    lines: array(ref("ImportLinePreview"), 100),
  }),
  ImportPreview: object(
    {
      /** True when the file can be committed as it stands: no error, and at least one line. */
      valid: { type: "boolean" },
      /** Every error is about a single row, so the rest could be imported if the person agrees. */
      skippable: { type: "boolean" },
      file: ref("ImportFile"),
      format: { type: "string", enum: ["csv", "ofx", "unknown"] },
      encoding: text(20),
      account: ref("ImportAccount"),
      source: ref("ImportSource"),
      currency: text(3),
      detection: ref("ImportDetection"),
      /** The mapping that was applied, with every column named by header and position. */
      mapping: ref("ImportMapping"),
      columns: array(ref("ImportColumnInfo"), 64),
      ofx: ref("ImportOfx"),
      counts: ref("ImportCounts"),
      skipped: ref("ImportSkipped"),
      range: ref("ImportRange"),
      totals: ref("ImportTotals"),
      /** Totals of the lines that are new to the book. */
      newTotals: ref("ImportTotals"),
      balances: array(ref("ImportBalanceCheck"), 10),
      chain: ref("ImportChain"),
      errors: count,
      warnings: count,
      infos: count,
      diagnostics: array(ref("ImportDiagnostic"), 500),
      /** Plain-language things to check before committing. */
      hints: array(text(500), 10),
      sample: ref("ImportSample"),
    },
    [
      "valid",
      "skippable",
      "file",
      "format",
      "account",
      "detection",
      "columns",
      "counts",
      "skipped",
      "range",
      "totals",
      "newTotals",
      "balances",
      "errors",
      "warnings",
      "infos",
      "diagnostics",
      "hints",
      "sample",
    ],
  ),
  ImportCommitResult: object(
    {
      batchId: id,
      file: ref("ImportFile"),
      account: ref("ImportAccount"),
      source: ref("ImportSource"),
      counts: ref("ImportCounts"),
      /** Lines now waiting in the Inbox for review. */
      waiting: count,
      range: ref("ImportRange"),
      /** Totals of the lines that were new to the book. */
      newTotals: ref("ImportTotals"),
      balances: array(ref("ImportBalanceCheck"), 10),
      warnings: count,
      message: text(300),
    },
    [
      "batchId",
      "file",
      "account",
      "source",
      "counts",
      "waiting",
      "range",
      "newTotals",
      "balances",
      "warnings",
      "message",
    ],
  ),
};

export const statementsSchema: SliceSchema = {
  name: "statements",
  definitions,
  operations: [
    operation(
      "import.presets",
      "List the built-in bank and card presets for statement files, with whether each has been verified against a real export (none has yet).",
      "read",
      "Empty",
      false,
      "ImportPresetList",
    ),
    operation(
      "import.profileList",
      "List the saved import profiles (column mappings), optionally for one chart account.",
      "read",
      "ImportProfileListInput",
      false,
      "ImportProfileList",
    ),
    operation(
      "import.profileSave",
      "Save a column mapping under a name, optionally as the default for a chart account. Saving a name again replaces that profile.",
      "draft",
      "ImportProfileSaveInput",
      true,
      "ImportProfile",
    ),
    operation(
      "import.profileDelete",
      "Delete a saved import profile. Lines already imported are not affected.",
      "draft",
      "ImportProfileDeleteInput",
      true,
      "ImportProfileDeleted",
    ),
    operation(
      "import.history",
      "List recent statement imports, newest first: the file, the account, the date and what each import did. Use it to see what has already been imported.",
      "read",
      "ImportHistoryInput",
      false,
      "ImportHistory",
    ),
    operation(
      "import.preview",
      "Read an uploaded statement file (CSV, OFX, QFX or QBO) without importing it: detect the format and bank preset, parse every row, and report new, duplicate and overlapping lines, the balance check and every problem with its row number.",
      "read",
      "ImportPreviewInput",
      false,
      "ImportPreview",
    ),
    operation(
      "import.commit",
      "Import an uploaded statement file: its lines are queued in the Inbox for review (nothing is posted). Run import.preview first and review it. The same file imported again adds nothing.",
      "draft",
      "ImportCommitInput",
      true,
      "ImportCommitResult",
    ),
  ],
};
