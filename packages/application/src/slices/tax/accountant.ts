/** The operations behind the accountant pack: reading what the Inbox recorded about each posted line (through
 * its own operation, never its tables) and building the files.
 *
 * Reads only: nothing here records or changes anything. */
import type { InboxPage } from "../../client-contracts.gen.ts";
import { ApplicationError } from "../../errors.ts";
import { addDays } from "../../reports/dates.ts";
import type { AccountantExtraFactory, JournalProvenance } from "../../tax/accountant.ts";
import { changesContributor } from "../changes/pack.ts";
import { reconcileContributor } from "../reconcile/pack.ts";
import type { SliceContext } from "../types.ts";
import { callOperation } from "./operations.ts";

/** The range an accountant pack is made for, and the book revision it is made from. */
export interface PackRange {
  readonly taxYear: number;
  readonly from: string;
  readonly to: string;
  readonly revision: bigint;
}

/** What a part of Rastrata adds to the accountant pack: files, with the paragraphs of the README that say
 * what they are. */
export interface PackContribution {
  readonly extras: readonly AccountantExtraFactory[];
  /** Words for the README when something could not be added. */
  readonly notes: readonly string[];
}

/** A part of Rastrata that adds files to the accountant pack. It reads what it keeps through its own
 * operations, from the revision the pack is made from, and gives the pack data; it never writes. The pack
 * lists each file in its manifest with its size and SHA-256, so `rastrata tax verify-pack` needs no change
 * for a file added here. To add one, write a contributor and put it in `PACK_CONTRIBUTORS`. */
export interface PackContributor {
  readonly name: string;
  /** What the file is, for the README when it could not be made. */
  readonly title: string;
  contribute(context: SliceContext, range: PackRange): Promise<PackContribution>;
}

export const PACK_CONTRIBUTORS: readonly PackContributor[] = [
  changesContributor,
  reconcileContributor,
];

/** Every contribution, in order. A contributor that fails is named in the README with the reason, and
 * does not stop the rest of the pack: a missing file says why it is missing. */
export async function packContributions(
  context: SliceContext,
  range: PackRange,
  contributors: readonly PackContributor[] = PACK_CONTRIBUTORS,
): Promise<PackContribution> {
  const extras: AccountantExtraFactory[] = [];
  const notes: string[] = [];
  for (const contributor of contributors) {
    try {
      const made = await contributor.contribute(context, range);
      extras.push(...made.extras);
      notes.push(...made.notes);
    } catch (error) {
      notes.push(
        `${contributor.title} could not be made${
          error instanceof ApplicationError
            ? `: ${error.message.replace(/\.$/, "")}`
            : ", and nothing says why"
        }. The other files are not affected.`,
      );
    }
  }
  return { extras, notes };
}

/** What the Inbox says about the lines posted around a range, by the journal each was posted as. The
 * window is a little wider than the range because a journal's date can differ from the date of the
 * line that made it. A payout's own transactions are evidence that follows the payout and are left out.
 * `read` is false when the Inbox could not be read: the pack then says so and does not pretend the
 * journals had no Inbox line. */
export async function journalProvenance(
  context: SliceContext,
  from: string,
  to: string,
): Promise<{ readonly map: Map<string, JournalProvenance>; readonly read: boolean }> {
  const map = new Map<string, JournalProvenance>();
  try {
    for (let page = 1; ; page++) {
      const result = await callOperation<InboxPage>(context, "inbox.list", {
        filter: {
          status: ["posted"],
          covered: false,
          from: addDays(from, -31),
          to: addDays(to, 31),
        },
        sort: "date_asc",
        page,
        pageSize: 200,
      });
      for (const item of result.items) {
        if (!item.journalId) continue;
        map.set(item.journalId, {
          provider: item.line.provider,
          accountKey: item.line.accountKey,
          providerId: item.line.providerId ?? "",
          counterparty: item.line.counterparty ?? "",
          description: item.line.description,
          decidedBy: item.decision?.principal ?? item.decision?.by ?? "",
          decision: item.decision?.kind ?? "",
        });
      }
      if (result.items.length === 0 || page * result.pageSize >= result.count) break;
    }
    return { map, read: true };
  } catch (error) {
    if (error instanceof ApplicationError) return { map: new Map(), read: false };
    throw error;
  }
}
