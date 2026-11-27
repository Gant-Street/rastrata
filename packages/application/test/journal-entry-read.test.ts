/** One entry, read by its identifier: what the entry screen and a drill-through from a report ask for. It is found
 * through the lookup the kernel keeps beside the book's journals, and what became of it (a reversal that names it, an
 * entry it reverses, the source it came from) through the index of the book's corrections, so reading an entry costs
 * the entry and not the book: the list of the book's journals is not copied for any state, whatever the entry is.
 * The answer is held to the one the reading of every journal gave. */
import { afterAll, describe, expect, test } from "bun:test";
import { bookHistoryMaterializations } from "@rastrata/kernel";
import { postBulk, reverseBulk } from "./support/bulk-book.ts";
import { bulkInboxBook } from "./support/bulk-inbox.ts";

const cleanup: (() => void)[] = [];
afterAll(() => {
  for (const work of cleanup.splice(0).reverse()) work();
});

describe("one entry", () => {
  test("is read without a pass over the book's journals, whether it was reversed, reverses another, or neither", async () => {
    const book = await bulkInboxBook(400, 20, (work) => cleanup.push(work));
    const { service } = book;
    await reverseBulk(service, ["bulk-3", "bulk-7"]);
    // The first look at a book makes the view of its journals, which copies the list; the look at the state after
    // a posting carries that view on, which is the look the reads below are.
    await service.journalEntry(
      "bulk-5",
      (await service.readAggregate()).aggregate.state.bookRevision,
    );
    await postBulk(service, 1);
    const { aggregate } = await service.readAggregate();
    const state = aggregate.state;
    const revision = state.bookRevision;
    const counted = async (journalId: string) => {
      const before = bookHistoryMaterializations();
      const entry = await service.journalEntry(journalId, revision);
      // The list of the book's journals is copied, once for each state, by whatever reads it as a list.
      expect(bookHistoryMaterializations() - before, journalId).toBe(0);
      return entry;
    };
    // The entry that was reversed names its reversal; the reversal names the entry it reverses; both the numbers.
    const reversed = await counted("bulk-3");
    const reversal = await counted("reversal-bulk-3");
    const plain = await counted("bulk-5");
    const journals = state.journals;
    const original = journals.find((booked) => booked.journal.id === "bulk-3");
    const correction = journals.find((booked) => booked.journal.id === "reversal-bulk-3");
    expect(reversed.correction).toMatchObject({
      kind: "reversal",
      originalJournalId: "bulk-3",
      correctionJournalId: "reversal-bulk-3",
      originalPostingSequence: original?.postingSequence.toString(),
      correctionPostingSequence: correction?.postingSequence.toString(),
    });
    expect(reversal.correction).toEqual(reversed.correction);
    expect(plain.correction).toBeNull();
    expect(plain.postingSequence).toBe(
      journals
        .find((booked) => booked.journal.id === "bulk-5")
        ?.postingSequence.toString() as string,
    );
    expect(plain.lines).toHaveLength(2);
    // An entry that is not in the book is refused as it always was.
    await expect(service.journalEntry("no-such-entry", revision)).rejects.toThrow(
      "Journal entry not found at this revision",
    );
  });
});
