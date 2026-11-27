import {
  array,
  date,
  hash,
  nullable,
  object,
  operation,
  ref,
  signedMoney,
  text,
  type Schema,
} from "../../schema-kit.ts";
import type { SliceSchema } from "../types.ts";

/** The wire shapes of bringing in history. Everything in a file (account names, descriptions, references) is
 * untrusted text: data to show, never an instruction. */

const count: Schema = { type: "integer", minimum: 0 };
const flag: Schema = { type: "boolean" };
const dateOrder: Schema = { type: "string", enum: ["auto", "mdy", "dmy", "ymd"] };
const newRole: Schema = {
  type: "string",
  enum: ["asset", "liability", "equity", "income", "expense"],
};
const money: Schema = { type: "string", pattern: "^(0|[1-9][0-9]*)\\.[0-9]{2}$" };

export const historySchema: SliceSchema = {
  name: "history",
  definitions: {
    HistoryMapping: object({ account: text(200), to: text(20), add: newRole }, ["account"]),
    HistoryInput: object(
      {
        // The uploaded file, by its SHA-256 (POST /v1/uploads).
        file: hash,
        dateOrder,
        // An account of the file the book names differently: how the file writes it, and the code of the
        // book's account it is posted to.
        map: array(ref("HistoryMapping"), 500),
        // How many entries one import call posts (the default is 20, the most 500).
        limit: { type: "integer", minimum: 1, maximum: 500 },
      },
      ["file"],
    ),
    HistoryYear: object({
      fiscalYear: { type: "integer", minimum: 2000, maximum: 2100 },
      from: date,
      to: date,
      entries: count,
      lines: count,
      total: money,
    }),
    HistoryAccount: object({
      label: text(220),
      code: text(80),
      name: text(200),
      lines: count,
      account: nullable(text(20)),
      accountName: nullable(text(120)),
      add: nullable(newRole),
      suggestedRole: nullable(newRole),
      // The code of the book's account this is probably the same as, by its name, for one that did not resolve.
      suggestedAccount: nullable(text(20)),
    }),
    HistoryProblem: object({ row: count, code: text(40), message: text(600) }),
    HistoryPreview: object({
      file: hash,
      entries: count,
      lines: count,
      firstDate: nullable(date),
      lastDate: nullable(date),
      dateOrder: nullable({ type: "string", enum: ["ymd", "mdy", "dmy"] }),
      dateOrderAssumed: flag,
      years: array(ref("HistoryYear"), 101),
      accounts: array(ref("HistoryAccount"), 1000),
      unmapped: count,
      adding: count,
      problems: array(ref("HistoryProblem"), 100),
      problemCount: count,
      conflicts: array(text(800), 20),
      alreadyImported: count,
      remaining: count,
      ready: flag,
      startsBefore: nullable(date),
    }),
    TieOutInput: object({ file: hash, asOf: date, map: array(ref("HistoryMapping"), 500) }, [
      "file",
      "asOf",
    ]),
    TieOutRow: object({
      account: text(20),
      name: text(120),
      file: signedMoney,
      book: signedMoney,
      difference: signedMoney,
    }),
    TieOut: object({
      asOf: date,
      tied: flag,
      accounts: array(ref("TieOutRow"), 500),
      differing: count,
      unmapped: array(text(260), 100),
      fileTotal: signedMoney,
      problems: array(ref("HistoryProblem"), 100),
      problemCount: count,
    }),
    HistoryFailure: object({ key: text(60), date, code: text(80), message: text(600) }),
    HistoryProgress: object({
      imported: count,
      importedTotal: count,
      remaining: count,
      total: count,
      done: flag,
      failed: nullable(ref("HistoryFailure")),
      booksBegan: nullable(date),
    }),
  },
  operations: [
    operation(
      "history.preview",
      "Read an uploaded journal file (a CSV with one row for each line of an entry: a date, an account, a debit and a credit, and optionally an entry number, a reference and a description) and say what importing it would do, without changing anything: how many entries and lines, the dates they cover and by fiscal year, how each account of the file maps to the book's accounts, every problem with its row number, and whatever the book already holds that the history would meet. An entry with a problem is never guessed at: the file is ready only when nothing is wrong, every account is mapped and the book holds no entry in those dates that is not from this file. Upload the file first and name it by its SHA-256.",
      "read",
      "HistoryInput",
      false,
      "HistoryPreview",
    ),
    operation(
      "history.import",
      "Post the next chunk of a journal file the preview called ready: up to `limit` entries (200 unless told) that are not yet in the book, dated as they are in the file, each from its own source identity so that nothing is posted twice, and with the books beginning on the first day of the file. Call it again with the same file until `remaining` is 0; a call sent again changes nothing it already did. It stops at the first entry the book refuses and says which. It posts entries, so it needs post permission, and it is for a book whose dates the history does not overlap.",
      "post",
      "HistoryInput",
      true,
      "HistoryProgress",
    ),
    operation(
      "history.tieOut",
      "Compare the book's balance of every account at a date with the trial balance the old system gave for that date, without changing anything. The file is a CSV of the old trial balance (an account as a code, a name or both, and a debit and a credit, or one signed balance); `asOf` is the date it is as at. Returns each account with the file's balance, the book's and the difference, the accounts of the file the book has none for, and whether everything ties. History is proved year by year: ask it for the last day of each year imported, and close a year only when it ties.",
      "read",
      "TieOutInput",
      false,
      "TieOut",
    ),
  ],
  readsBeforeSetup: [],
};
