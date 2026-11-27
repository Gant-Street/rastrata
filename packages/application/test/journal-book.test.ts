/** The Journal screen's page, built for the entries on the page only, says exactly what the version that
 * built a row for every journal in the book said. `legacyJournalBook` below is that version, kept as it was
 * (the body of `ApplicationService.journalBook` before this lane) as the reference, but for the corrections it
 * lists: the ones that name an entry of the page and not every one of the book, which is what a screen reads
 * about the entries it shows and what costs the page and not the book. The real function is compared with it
 * on random books, with drafts (including a draft that shares its id with an entry, which is what a posting
 * whose reply was lost looks like), references, corrections of every kind, entries from every kind of source,
 * and every kind of query. */
import { describe, expect, test } from "bun:test";
import { ExactDecimal, type BookState } from "@rastrata/kernel";
import type { SavedDraft } from "../src/contracts.ts";
import { JOURNAL_PAGE_SIZE, journalBookPage, type JournalQuery } from "../src/journal-book.ts";
import { entryType } from "../src/journal-type.ts";
import { bookView } from "../src/reports/ledger.ts";
import { sequence } from "./support/kernel-book.ts";
import { playRandomBook } from "./support/random-book.ts";

interface Inputs {
  readonly state: BookState;
  readonly drafts: readonly SavedDraft[];
  readonly references: ReadonlyMap<string, string>;
  readonly accountLabel: ReadonlyMap<string, string>;
  readonly query: JournalQuery;
}

/** The page as `ApplicationService.journalBook` built it before: a row for every journal, searched with
 * `find` for each correction, filtered and sorted whole. */
function legacyJournalBook({ state, drafts, references, accountLabel, query }: Inputs) {
  const abs = (coefficient: bigint, scale: bigint) =>
    ExactDecimal.of(coefficient < 0n ? -coefficient : coefficient, scale).toString();
  const sequenceOf = new Map<string, string>(
    state.journals.map((booked) => [booked.journal.id, booked.postingSequence.toString()]),
  );
  const numbered = (journalId: string): string => {
    const sequence = sequenceOf.get(journalId);
    return sequence === undefined ? journalId : `No. ${sequence}`;
  };
  const journalSource = (booked: (typeof state.journals)[number]) => {
    const link = state.corrections.find((item) => item.correctionJournalId === booked.journal.id);
    const original = link
      ? state.journals.find((item) => item.journal.id === link.originalJournalId)
      : booked;
    const evidence = original?.derivations
      .flatMap((item) => item.evidence)
      .find((item) => item.sourceSystem === "rastrata-source-v1");
    return evidence && original
      ? {
          id: evidence.sourceRecordId,
          contentHash: evidence.contentHash.digest,
          originalJournalId: original.journal.id,
        }
      : undefined;
  };
  const posted = state.journals.map((booked) => {
    const journal = booked.journal;
    const correctedBy = state.corrections.find((link) => link.originalJournalId === journal.id);
    const corrects = state.corrections.find((link) => link.correctionJournalId === journal.id);
    const debit = journal.postings
      .filter((posting) => posting.bookValue.amount.coefficient > 0n)
      .reduce((sum, posting) => sum + posting.bookValue.amount.coefficient, 0n);
    const debitText = ExactDecimal.of(debit, 2n).toString();
    return {
      id: journal.id,
      date: journal.accountingDate,
      isoDate: journal.accountingDate,
      reference: references.get(journal.id) ?? journal.narration,
      postingSequence: booked.postingSequence.toString(),
      description: journal.narration,
      type: entryType(journalSource(booked)?.id),
      amount: debitText,
      status: "Posted" as const,
      lines: journal.postings.map((posting) => ({
        id: posting.id,
        accountId: posting.accountId,
        debit:
          posting.bookValue.amount.coefficient > 0n
            ? abs(posting.bookValue.amount.coefficient, posting.bookValue.amount.scale)
            : null,
        credit:
          posting.bookValue.amount.coefficient < 0n
            ? abs(posting.bookValue.amount.coefficient, posting.bookValue.amount.scale)
            : null,
      })),
      debitTotal: debitText,
      creditTotal: debitText,
      history: [
        { at: journal.recordedAt, description: `Posted at book revision ${booked.bookRevision}` },
        ...(correctedBy
          ? [
              {
                at: journal.recordedAt,
                description: `Reversed by ${numbered(correctedBy.correctionJournalId)}`,
              },
            ]
          : []),
        ...(corrects
          ? [
              {
                at: journal.recordedAt,
                description: `Reversal of ${numbered(corrects.originalJournalId)}`,
              },
            ]
          : []),
      ],
    };
  });
  const pending = drafts.map((draft) => ({
    id: draft.id,
    date: draft.data.date,
    isoDate: draft.data.date,
    reference: draft.data.reference,
    description: draft.data.narration.trim() || draft.data.reference.trim(),
    type: entryType(draft.data.source?.id),
    amount: "—",
    status: "Draft" as const,
    lines: draft.data.lines.map((line, index) => ({
      id: `${draft.id}-${index}`,
      accountId: line.accountId,
      debit: line.debit || null,
      credit: line.credit || null,
    })),
    debitTotal: "—",
    creditTotal: "—",
    history: [{ at: draft.data.date, description: "Saved draft; not posted" }],
  }));
  const allEntries = [...posted, ...pending];
  const order = new Map(allEntries.map((entry, index) => [entry.id, index]));
  const searchable = (entry: (typeof allEntries)[number]): string =>
    [
      entry.id,
      entry.reference,
      entry.description,
      entry.date,
      "postingSequence" in entry ? `no. ${entry.postingSequence} #${entry.postingSequence}` : "",
      entry.amount,
      ...entry.lines.map((line) => accountLabel.get(line.accountId) ?? ""),
    ]
      .join(" ")
      .toLowerCase();
  const filtered = allEntries.filter(
    (entry) =>
      (!query.text || searchable(entry).includes(query.text.toLowerCase())) &&
      (!query.from || entry.isoDate >= query.from) &&
      (!query.to || entry.isoDate <= query.to) &&
      (!query.accountId || entry.lines.some((line) => line.accountId === query.accountId)) &&
      (!query.status || entry.status === query.status) &&
      (!query.type || entry.type === query.type),
  );
  filtered.sort(
    (left, right) =>
      right.isoDate.localeCompare(left.isoDate) ||
      (order.get(right.id) ?? 0) - (order.get(left.id) ?? 0),
  );
  const pageEntries = filtered.slice(
    (query.page - 1) * JOURNAL_PAGE_SIZE,
    query.page * JOURNAL_PAGE_SIZE,
  );
  const draftById = new Map(drafts.map((draft) => [draft.id, draft]));
  return {
    entries: pageEntries,
    count: filtered.length,
    drafts: pageEntries.flatMap((entry) => {
      const draft = draftById.get(entry.id);
      return draft ? [{ id: draft.id, version: draft.version, status: draft.status }] : [];
    }),
    corrections: state.corrections
      .filter(
        (link) =>
          pageEntries.some((entry) => entry.id === link.originalJournalId) ||
          pageEntries.some((entry) => entry.id === link.correctionJournalId),
      )
      .map((link) => {
        const original = sequenceOf.get(link.originalJournalId);
        const correction = sequenceOf.get(link.correctionJournalId);
        return {
          originalJournalId: link.originalJournalId,
          correctionJournalId: link.correctionJournalId,
          kind: link.kind,
          ...(original !== undefined ? { originalPostingSequence: original } : {}),
          ...(correction !== undefined ? { correctionPostingSequence: correction } : {}),
        };
      }),
  };
}

const page = ({ references, ...inputs }: Inputs) =>
  journalBookPage({
    ...inputs,
    view: bookView(inputs.state),
    referenceOf: (booked) => references.get(booked.journal.id),
  });

/** Everything a test varies, from a seed: drafts, references and queries for a state. */
function scenario(state: BookState, seed: number) {
  const random = sequence(seed);
  const below = (count: number) => Math.floor(random() * count);
  const pick = <T>(list: readonly T[]): T => list[below(list.length)] as T;
  const accounts = state.admissionSnapshot.accounts;
  const accountLabel = new Map<string, string>(
    accounts.map((account) => [account.id as string, `${account.code} · ${account.name}`]),
  );
  const ids = state.journals.map((booked) => booked.journal.id as string);
  const references = new Map<string, string>();
  for (const id of ids)
    if (random() < 0.3)
      references.set(id, `Ref ${id.slice(-3)} ${pick(["rent", "Sales", "INV-9", "payout"])}`);
  const dates = [
    "2025-03-05",
    "2025-06-30",
    "2026-02-14",
    "2025-3-5",
    "",
    "not a date",
    ...state.journals.slice(0, 4).map((booked) => booked.journal.accountingDate as string),
  ];
  const drafts: SavedDraft[] = Array.from({ length: below(7) }, (_, index) => ({
    // Some drafts carry the id of an entry already in the book: a posting whose reply was lost.
    id: random() < 0.3 && ids.length > 0 ? pick(ids) : `draft-${seed}-${index}`,
    version: 1 + below(3),
    status: pick(["draft", "posting"] as const),
    data: {
      date: pick(dates),
      reference: pick(["INV-1", "rent", " ", "Cash sale", "payout 88"]),
      narration: pick(["", "  ", "A draft entry", "ingest stripe payout"]),
      ...(random() < 0.4
        ? {
            source: {
              id: pick(["ingest-bank-1", "stripe-po_1", "opening-2025", "import-7"]),
              description: "x",
            },
          }
        : {}),
      lines: [
        { accountId: pick(accounts).id as string, debit: "12.50", credit: "" },
        { accountId: pick(accounts).id as string, debit: "", credit: "12.50" },
      ],
    },
  }));
  // Two drafts cannot share an id.
  const unique = drafts.filter(
    (draft, index) => drafts.findIndex((other) => other.id === draft.id) === index,
  );
  const queries: JournalQuery[] = [
    { page: 1, text: "", from: "", to: "", accountId: "", status: "" },
    { page: 2, text: "", from: "", to: "", accountId: "", status: "" },
    { page: 9, text: "", from: "", to: "", accountId: "", status: "" },
    ...Array.from({ length: 48 }, () => ({
      page: 1 + below(3),
      text: pick([
        "",
        "",
        "",
        "cash",
        "RENT",
        "no. 5",
        "#7",
        "12.50",
        "ref",
        "entry",
        "fx-0000",
        "stripe",
        "zzz",
        "2025-03",
        "1000 ·",
      ]),
      from: pick(["", "", "2025-02-01", "2025-06-01", "2026-01-01", "2024-01-01"]),
      to: pick(["", "", "2025-06-30", "2026-03-31", "2025-01-31", "2030-01-01"]),
      accountId: pick(["", "", "", ...accounts.map((account) => account.id as string)]),
      status: pick(["", "", "Posted", "Draft", "Other"]),
      type: pick(["", "", "manual", "opening", "bank", "stripe", "nothing"]),
    })),
  ];
  return { drafts: unique, references, accountLabel, queries };
}

describe("the Journal screen's page", () => {
  for (const seed of [101, 102, 103, 104, 105, 106])
    test(`says what the version that built every row said, on a random book (seed ${seed})`, () => {
      const states: BookState[] = [];
      playRandomBook({
        seed,
        steps: 220,
        sources: true,
        onState: ({ state, step }) => {
          if (step % 55 === 0) states.push(state);
        },
      });
      let compared = 0;
      const seen = {
        entries: 0,
        types: new Set<string>(),
        reversedBy: 0,
        reversalOf: 0,
        drafts: 0,
        shared: 0,
        referenced: 0,
        empty: 0,
      };
      for (const [at, state] of states.entries()) {
        const { drafts, references, accountLabel, queries } = scenario(state, seed * 10 + at);
        for (const query of queries) {
          const inputs = { state, drafts, references, accountLabel, query };
          const got = page(inputs);
          expect(JSON.stringify(got), JSON.stringify(query)).toBe(
            JSON.stringify(legacyJournalBook(inputs)),
          );
          compared += 1;
          seen.empty += got.entries.length === 0 ? 1 : 0;
          for (const entry of got.entries) {
            seen.entries += 1;
            seen.types.add(entry.type);
            seen.drafts += entry.status === "Draft" ? 1 : 0;
            seen.shared +=
              got.drafts.some((draft) => draft.id === entry.id) && entry.status === "Posted"
                ? 1
                : 0;
            seen.referenced += references.has(entry.id) ? 1 : 0;
            for (const step of entry.history) {
              seen.reversedBy += step.description.startsWith("Reversed by") ? 1 : 0;
              seen.reversalOf += step.description.startsWith("Reversal of") ? 1 : 0;
            }
          }
        }
      }
      expect(compared).toBe(states.length * 51);
      // The comparison is worth something: pages with entries, of several kinds, with corrections, drafts
      // and a draft that shares its id with an entry.
      expect(seen.entries).toBeGreaterThan(200);
      expect(seen.types.size).toBeGreaterThanOrEqual(3);
      expect(seen.reversedBy + seen.reversalOf).toBeGreaterThan(0);
      expect(seen.drafts).toBeGreaterThan(0);
      expect(seen.referenced).toBeGreaterThan(0);
      expect(seen.empty).toBeLessThan(compared);
    });

  for (const seed of [121, 122, 123])
    test(`a page narrowed by an account says what the scan of every entry said, for any dates, on any page, with drafts that share an id with an entry (seed ${seed})`, () => {
      const states: BookState[] = [];
      playRandomBook({
        seed,
        steps: 200,
        sources: true,
        noSupersession: seed % 2 === 1,
        onState: ({ state, step }) => {
          if (step % 50 === 0) states.push(state);
        },
      });
      const random = sequence(seed);
      const pick = <T>(list: readonly T[]): T => list[Math.floor(random() * list.length)] as T;
      let compared = 0;
      let entries = 0;
      let twice = 0;
      for (const state of states) {
        const { drafts, references, accountLabel } = scenario(state, seed);
        // Drafts that share an id with entries that touch the accounts asked for, as often as not.
        const sharing: SavedDraft[] = state.journals
          .filter(() => random() < 0.08)
          .map((booked, index) => ({
            id: booked.journal.id as string,
            version: 1,
            status: pick(["draft", "posting"] as const),
            data: {
              date: booked.journal.accountingDate as string,
              reference: `sharing ${index}`,
              narration: "",
              lines: [],
            },
          }));
        const all = [
          ...drafts.filter((draft) => !sharing.some((s) => s.id === draft.id)),
          ...sharing,
        ];
        const dates = [
          "",
          "",
          "2025-02-01",
          "2025-06-30",
          "2026-01-01",
          "2026-09-15",
          "2024-01-01",
          "2030-01-01",
        ];
        for (const account of accountLabel.keys()) {
          // Entries that touch an account more than once are the ones that are counted once.
          twice += state.journals.filter(
            (booked) =>
              booked.journal.postings.filter((posting) => posting.accountId === account).length > 1,
          ).length;
          for (let round = 0; round < 4; round += 1) {
            const query = {
              page: pick([1, 1, 2, 3]),
              text: "",
              from: pick(dates),
              to: pick(dates),
              accountId: account,
              status: pick(["", "", "Posted"]),
            };
            const inputs = { state, drafts: all, references, accountLabel, query };
            const got = page(inputs);
            expect(JSON.stringify(got), JSON.stringify(query)).toBe(
              JSON.stringify(legacyJournalBook(inputs)),
            );
            compared += 1;
            entries += got.entries.length;
          }
        }
      }
      expect(compared).toBeGreaterThan(150);
      expect(entries).toBeGreaterThan(300);
      expect(twice).toBeGreaterThan(0);
    });

  test("a draft that shares its id with an entry puts both where the draft stands", () => {
    const states: BookState[] = [];
    playRandomBook({
      seed: 111,
      steps: 80,
      onState: ({ state, step }) => step === 80 && states.push(state),
    });
    const state = states[0] as BookState;
    const id = state.journals[3]?.journal.id as string;
    const drafts: SavedDraft[] = [
      {
        id,
        version: 1,
        status: "posting",
        data: {
          date: state.journals[3]?.journal.accountingDate as string,
          reference: "being posted",
          narration: "",
          lines: [],
        },
      },
    ];
    const query = { page: 1, text: "", from: "", to: "", accountId: "", status: "" };
    const inputs = { state, drafts, references: new Map(), accountLabel: new Map(), query };
    const got = page(inputs);
    expect(JSON.stringify(got)).toBe(JSON.stringify(legacyJournalBook(inputs)));
    // Both the posted entry and the draft with that id are on the screen, the draft's count included.
    const narrowed = { ...inputs, query: { ...query, text: id } };
    const found = page(narrowed);
    expect(found.entries.map((entry) => `${entry.status} ${entry.id}`)).toContain(`Draft ${id}`);
    expect(found.entries.map((entry) => `${entry.status} ${entry.id}`)).toContain(`Posted ${id}`);
    expect(JSON.stringify(found)).toBe(JSON.stringify(legacyJournalBook(narrowed)));
  });

  test("a book with nothing in it and a draft with nothing to say", () => {
    const book = playRandomBook({ seed: 7, steps: 0, sources: true });
    const query = { page: 1, text: "", from: "", to: "", accountId: "", status: "" };
    const inputs = {
      state: book.state,
      drafts: [] as SavedDraft[],
      references: new Map<string, string>(),
      accountLabel: new Map<string, string>(),
      query,
    };
    expect(page(inputs)).toEqual(legacyJournalBook(inputs));
    expect(page(inputs).count).toBe(0);
  });
});
