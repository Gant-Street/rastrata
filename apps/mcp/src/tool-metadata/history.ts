import type { ToolMetadata } from "./types.ts";

/** MCP tool metadata for the operations the history slice owns, keyed by operation name. Written for a
 * model: what each tool does, what it cannot do, and what to read first. */
export const historyTools: Readonly<Record<string, ToolMetadata>> = {
  "history.preview": {
    name: "rastrata_preview_history",
    title: "Preview bringing in a journal file",
    description:
      "Read an uploaded journal file and say what importing it would do, changing nothing. The file is a CSV with one row for each line of an entry: a date, an account (a code, a name or both), a debit and a credit (or one signed amount), and optionally an entry number, a reference and a description; a row with no date or number belongs to the entry above it. Upload it first with the command line (`rastrata history preview FILE` uploads and previews) and pass its SHA-256 as `file`; a tool call cannot carry the file. Returns the entries and lines, the dates by fiscal year, how each account of the file maps to the book's accounts, every problem with its row number, and what the book already holds that the history would meet. An entry with a problem is never guessed at. The file is ready only when `ready` is true: nothing wrong, every account mapped (add `map` pairs: `{account, to}` posts an account of the file to the book's account with that code, `{account, add}` adds it to the book as a new account of a kind, which is possible only while the book has no entries, needs configure permission, and should be confirmed with the user, since a wrong kind changes the reports; each account of the file without one says `suggestedRole` when its number or name suggests a kind), and no entry in the book dated within the file's dates that is not from this file. Read it with the user before importing; history is brought in once, in order of date, into a book whose dates it does not overlap.",
  },
  "history.tieOut": {
    name: "rastrata_tie_out_history",
    title: "Compare the book with the old books' trial balance",
    description:
      "Compare the book's balance of every account at a date with the trial balance the old system gave for that date, changing nothing. The file is a CSV of the old trial balance: an account (a code, a name or both) and a debit and a credit, or one signed balance (a debit is positive); upload it with the command line and pass its SHA-256 as `file`, with the date it is as at as `asOf`. Returns each account with the file's balance, the book's and the difference, the accounts of the file the book has no account for, and `tied`. This is the proof that a history was brought in whole: ask for the last day of each imported year, show the user every difference, and close a year (rastrata_prepare_year_end) only when it ties.",
  },
  "history.import": {
    name: "rastrata_import_history",
    title: "Post the next chunk of a journal file",
    description:
      "Post the next chunk (up to `limit` entries, 20 by default and 500 at most; a hosted book refuses a call that would store more than about a megabyte with `entry_too_large`, nothing of it posted, and then the call is made again with a smaller `limit`) of a journal file whose preview said `ready`, dated as they are in the file, each under an identity taken from the file and its entry number, so a call sent again, or the same file imported again, posts nothing twice. The books begin on the first day of the file. Call it again with the same input until `remaining` is 0 and `done` is true; it stops at the first entry the book refuses and `failed` says which, with everything before it posted. This is a posting, so it needs post permission (and configure permission when `map` adds accounts) and the user's authorization of exactly this file and these accounts. Send the same `map` as the preview; the first call adds the accounts, and a call sent again adds nothing twice. Afterwards compare the book with the old books year by year (a trial balance at each year end from the old system against `rastrata_get_reports`), then close each imported year with `rastrata_prepare_year_end`. If the reply is lost, call again with the same operationId.",
    destructive: true,
  },
};
