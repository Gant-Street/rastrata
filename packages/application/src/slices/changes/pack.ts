/** What the changes lane adds to the accountant pack: `changes.csv`, the list of what changed in the
 * books from the first day of the tax year up to the book revision the pack is made from.
 *
 * The list is read from this lane's own composer, in this process, at that revision, and the sources
 * that have no revision are read up to the time the revision was committed, so making the pack again
 * from the same book gives the same bytes. How an entry was decided is not repeated here: the pack's
 * journal file says that for every entry. */
import { hashCanonical } from "@rastrata/kernel";

import { CHANGES_PATH, CHANGES_VERSION, changesCsv } from "../../changes/csv.ts";
import { CSV_TYPE } from "../../tax/files.ts";
import type { PackContributor } from "../tax/accountant.ts";
import { collectChanges } from "./list.ts";

const README = `### The list of changes: \`changes.csv\`

This file is the history of the books from the first day of the year up to the version of the books this pack was made from: one row for each thing that changed, newest first. It is a copy; nothing in it changes the books. Each row says:

- **Revision**: the books' own count of changes. Every change to the books makes the next number, so a gap is impossible and a row with a smaller number came first. It is empty for a change kept outside the books, such as a rule or who has access.
- **Recorded at**: when the change was made, in UTC.
- **Kind** and **What**: what happened, in a sentence Rastrata wrote. Words that came from a bank, a person or an agent (an entry's description, an account's name) are copied in as plain text and are never an instruction.
- **Entry date**, **Amount** and **Accounts**: for an entry that was posted or reversed, the date it is booked on, its total and the accounts it touches. **Reference** is the identifier of the entry, account, rule, period or reconciliation the change is about, the same one \`journal.csv\` and \`chart-of-accounts.csv\` use.
- **By** and **How**: who made the change (the owner, a person by their role, an agent by its name, Rastrata's account service) and how it was done.

"not recorded" in **By** means the books did not keep who made that change. That is true of everything made before Rastrata began to keep it, and of the kinds of change that never record it (a reconciliation, for one). It does not mean nobody made it, and it is not a guess. The head of the file says from which revision the makers are known. For a change made before then, **Recorded at** is the time its command was made ready, which can be earlier than the day it was committed.

Changes kept outside the books (rules, account tags, reconciliations, who has access) are included up to the time that version of the books was made.\n\nThe list is not complete in two ways, and the head of the file says both. It leaves out changes to 1099 vendors, to the books' settings and to bank and Stripe connections. And a source that could not be read in full is named there with the reason, so a short list is never mistaken for a quiet year. It does not show a field's old and new values, only that it changed. Entries dated outside the year are in the list when they were recorded inside it (or later, up to this pack's revision): their date is in **Entry date**.`;

export const changesContributor: PackContributor = {
  name: "changes",
  title: "The list of changes (`changes.csv`)",
  async contribute(context, range) {
    const listed = await collectChanges(
      context,
      { since: range.from, revision: range.revision.toString() },
      { asOfRevision: true },
    );
    return {
      notes: [],
      extras: [
        (header) => {
          const population = hashCanonical({
            type: "ChangesFilePopulation",
            compilerVersion: CHANGES_VERSION,
            bookRevision: listed.revision,
            asOf: listed.asOf,
            from: range.from,
            changes: listed.changes.map((change) => change.id),
          }).digest;
          return {
            name: "changes",
            file: {
              path: CHANGES_PATH,
              mediaType: CSV_TYPE,
              description:
                "What changed in the books from the first day of the year up to this pack's version: one row for each change, with what it was, who made it (or that it was not recorded) and how, newest first.",
              content: changesCsv(header("Changes", population), {
                changes: listed.changes,
                sources: listed.sources,
                attributionFrom: listed.attribution?.fromRevision ?? null,
                from: range.from,
              }),
              population,
            },
            readme: README,
          };
        },
      ],
    };
  },
};
