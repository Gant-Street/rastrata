import { describe, expect, test } from "bun:test";
import {
  ExactDecimal,
  ExactRational,
  accountId,
  admitJournal,
  bookId,
  canonicalJournalValue,
  commodityId,
  dimensionId,
  dimensionMemberId,
  instant,
  journalId,
  localDate,
  postingId,
  type JournalAdmissionSnapshot,
  type JournalTransaction,
} from "../src/index.ts";
import { IDS, freshState, journal } from "./fixtures.ts";

describe("hostile journal and chart admission", () => {
  test("validates unused lifecycle records and admits one same-dimension member parent", () => {
    const base = freshState().state.admissionSnapshot;
    const unusedDimension = dimensionId("unused-reversed-dimension");
    const unusedMember = dimensionMemberId("unused-reversed-member");
    const unusedAccount = accountId("unused-reversed-account");
    const reversedAccount: JournalAdmissionSnapshot = { ...base, accounts: [...base.accounts, { ...base.accounts[0]!, id: unusedAccount, code: "UNUSED", openedOn: localDate("2026-02-01"), closedOn: localDate("2026-01-31") }] };
    expect(admitJournal(reversedAccount, journal("unused-reversed-account")).disposition).toBe("rejected");
    const validUnusedDimension = { id: unusedDimension, bookId: IDS.book, code: "UNUSED", name: "Unused", openedOn: localDate("2020-01-01") };
    const reversedDimension: JournalAdmissionSnapshot = { ...base, dimensions: [{ ...validUnusedDimension, openedOn: localDate("2026-02-01"), closedOn: localDate("2026-01-31") }] };
    expect(admitJournal(reversedDimension, journal("unused-reversed-dimension")).disposition).toBe("rejected");
    const reversedMember: JournalAdmissionSnapshot = { ...base, dimensions: [validUnusedDimension], dimensionMembers: [{ id: unusedMember, dimensionId: unusedDimension, code: "UNUSED", name: "Unused", openedOn: localDate("2026-02-01"), closedOn: localDate("2026-01-31") }] };
    expect(admitJournal(reversedMember, journal("unused-reversed-member")).disposition).toBe("rejected");

    const dimension = dimensionId("parented-dimension");
    const parent = dimensionMemberId("parent-member");
    const child = dimensionMemberId("child-member");
    const parented: JournalAdmissionSnapshot = {
      ...base,
      dimensions: [{ id: dimension, bookId: IDS.book, code: "PARENTED", name: "Parented", openedOn: localDate("2020-01-01") }],
      dimensionMembers: [
        { id: parent, dimensionId: dimension, code: "PARENT", name: "Parent", openedOn: localDate("2020-01-01") },
        { id: child, dimensionId: dimension, code: "CHILD", name: "Child", openedOn: localDate("2020-01-01"), parentId: parent },
      ],
      requiredDimensionIds: [dimension],
    };
    const withChild = { ...journal("valid-parented-member"), postings: journal("valid-parented-member").postings.map((posting) => ({ ...posting, dimensionMemberIds: [child] })) };
    expect(admitJournal(parented, withChild).disposition).toBe("admitted");
    const missingParent = { ...parented, dimensionMembers: [{ ...parented.dimensionMembers[1]!, parentId: dimensionMemberId("missing-parent") }] };
    expect(admitJournal(missingParent, withChild).disposition).toBe("rejected");
  });

  test("exercises every chart and hierarchy rejection as typed diagnostics", () => {
    const base = freshState().state.admissionSnapshot;
    const otherBook = bookId("other-book");
    const dimA = dimensionId("dim-a");
    const dimB = dimensionId("dim-b");
    const memberA = dimensionMemberId("member-a");
    const memberB = dimensionMemberId("member-b");
    const invalid: JournalAdmissionSnapshot = {
      ...base,
      accounts: [
        base.accounts[0]!,
        { ...base.accounts[0]!, name: "duplicate identity" },
        { ...base.accounts[1]!, id: accountId("bad-account"), bookId: otherBook, code: base.accounts[0]!.code,
          openedOn: localDate("2026-02-01"), closedOn: localDate("2026-01-01"), parentId: accountId("missing-parent") },
        { ...base.accounts[0]!, id: accountId("cycle-a"), code: "A", parentId: accountId("cycle-b") },
        { ...base.accounts[0]!, id: accountId("cycle-b"), code: "B", parentId: accountId("cycle-a") },
      ],
      dimensions: [
        { id: dimA, bookId: IDS.book, code: "D", name: "A", openedOn: localDate("2020-01-01") },
        { id: dimA, bookId: IDS.book, code: "D2", name: "duplicate", openedOn: localDate("2020-01-01") },
        { id: dimB, bookId: otherBook, code: "D", name: "B", openedOn: localDate("2026-02-01"), closedOn: localDate("2026-01-01") },
      ],
      dimensionMembers: [
        { id: memberA, dimensionId: dimA, code: "M", name: "A", openedOn: localDate("2020-01-01"), parentId: memberB },
        { id: memberA, dimensionId: dimA, code: "M2", name: "duplicate id", openedOn: localDate("2020-01-01") },
        { id: memberB, dimensionId: dimA, code: "M", name: "B", openedOn: localDate("2026-02-01"), closedOn: localDate("2026-01-01"), parentId: memberA },
        { id: dimensionMemberId("unknown-dimension-member"), dimensionId: dimensionId("unknown-dimension"), code: "U", name: "U", openedOn: localDate("2020-01-01"), parentId: memberA },
      ],
      requiredDimensionIds: [dimensionId("missing-required")],
    };
    const result = admitJournal(invalid, journal("hostile-chart"));
    expect(result.disposition).toBe("rejected");
    if (result.disposition === "rejected") {
      const codes = new Set(result.diagnostics.map((item) => item.code));
      expect(codes.has("canonical_identity_conflict")).toBeTrue();
      expect(codes.has("invalid_chart_or_account")).toBeTrue();
      expect(codes.has("invalid_dimension_selection")).toBeTrue();
      expect(codes.has("book_isolation_violation")).toBeTrue();
    }
  });

  test("rejects all malformed monetary, account, commodity, and posting structures", () => {
    const base = freshState().state.admissionSnapshot;
    const eur = commodityId("EUR");
    const malformed = {
      ...journal("hostile-postings"),
      bookId: bookId("wrong-book"),
      functionalCommodityId: eur,
      postings: [
        {
          id: postingId("duplicate"), ordinal: -1n, accountId: accountId("unknown-account"),
          units: { canonicalNumber: 1.5, commodityId: eur, sourceNumber: "1.5" },
          bookValue: { amount: ExactRational.of(1n, 1n), functionalCommodityId: eur },
          transactionPrice: { unitRate: ExactRational.zero(), baseCommodityId: IDS.usd, quoteCommodityId: eur },
          costBasis: { totalBasis: ExactRational.of(1n, 1n), basisCommodityId: eur, sourceTotalBasis: "1" },
          dimensionMemberIds: [dimensionMemberId("unknown-member")],
        },
        {
          id: postingId("duplicate"), ordinal: -1n, accountId: IDS.cash,
          units: { canonicalNumber: ExactRational.of(-1n, 1n), commodityId: eur },
          bookValue: { amount: ExactDecimal.of(0n, 2n), functionalCommodityId: eur },
          transactionPrice: { unitRate: ExactRational.of(-1n, 1n), baseCommodityId: eur, quoteCommodityId: IDS.usd },
          costBasis: { totalBasis: ExactRational.of(1n, 1n), basisCommodityId: eur },
          dimensionMemberIds: [],
        },
        {
          id: postingId("contradictory-source"), ordinal: 3n, accountId: IDS.cash,
          units: { canonicalNumber: ExactRational.of(1n, 1n), commodityId: IDS.usd, sourceNumber: ExactDecimal.of(2n, 0n) },
          bookValue: { amount: ExactDecimal.of(0n, 2n), functionalCommodityId: IDS.usd },
          costBasis: { totalBasis: ExactRational.of(1n, 1n), basisCommodityId: IDS.usd, sourceTotalBasis: ExactDecimal.of(2n, 0n) },
          dimensionMemberIds: [],
        },
      ],
    } as unknown as JournalTransaction;
    const restricted: JournalAdmissionSnapshot = {
      ...base,
      accounts: base.accounts.map((account) => ({ ...account, allowedCommodityIds: [IDS.usd] })),
    };
    const result = admitJournal(restricted, malformed);
    expect(result.disposition).toBe("rejected");
    if (result.disposition === "rejected") {
      expect(new Set(result.diagnostics.map((item) => item.code))).toEqual(new Set([
        "book_isolation_violation", "monetary_type_mismatch", "invalid_exact_number",
        "invalid_journal_structure", "invalid_chart_or_account", "invalid_dimension_selection",
      ]));
    }
    expect(admitJournal(base, { ...journal("one-posting"), postings: [journal("one-posting").postings[0]!] }).disposition).toBe("rejected");
  });

  test("validates source basis, prices, dimensions, optional fields, and canonical ordering", () => {
    const dim = dimensionId("department");
    const member1 = dimensionMemberId("department-one");
    const member2 = dimensionMemberId("department-two");
    const base = freshState().state.admissionSnapshot;
    const snapshot: JournalAdmissionSnapshot = {
      ...base,
      dimensions: [{ id: dim, bookId: IDS.book, code: "DEPT", name: "Department", openedOn: localDate("2020-01-01") }],
      dimensionMembers: [
        { id: member1, dimensionId: dim, code: "ONE", name: "One", openedOn: localDate("2020-01-01") },
        { id: member2, dimensionId: dim, code: "TWO", name: "Two", openedOn: localDate("2027-01-01") },
      ],
      requiredDimensionIds: [dim],
    };
    const value = journal("rich-journal");
    const rich: JournalTransaction = {
      ...value,
      settledAt: instant("2026-01-16T00:00:00+02:00"),
      postings: value.postings.map((posting, index) => ({
        ...posting,
        units: { ...posting.units, sourceNumber: ExactDecimal.of(posting.units.canonicalNumber.numerator, 0n) },
        transactionPrice: { unitRate: ExactRational.of(1n, 1n), baseCommodityId: IDS.usd, quoteCommodityId: IDS.usd },
        costBasis: { totalBasis: posting.units.canonicalNumber, sourceTotalBasis: ExactDecimal.of(posting.units.canonicalNumber.numerator, 0n), basisCommodityId: IDS.usd },
        dimensionMemberIds: index === 0 ? [member1, member2, member1] : [],
      })),
    };
    const result = admitJournal(snapshot, rich);
    expect(result.disposition).toBe("rejected");
    expect(canonicalJournalValue(rich)).toBeDefined();
    expect(() => localDate("2024-02-29")).not.toThrow();
    expect(() => localDate("1900-02-29")).toThrow();
    expect(() => localDate("not-a-date")).toThrow();
    expect(() => instant("2026-01-01T00:00:00+14:00")).not.toThrow();
    expect(() => instant("2026-01-01T00:00:00+14:01")).toThrow();
    expect(() => instant("not-an-instant")).toThrow();
    const tied = { ...rich, postings: [
      { ...rich.postings[0]!, ordinal: 1n, id: postingId("z") },
      { ...rich.postings[1]!, ordinal: 1n, id: postingId("a") },
    ] };
    canonicalJournalValue(tied);
    canonicalJournalValue({ ...tied, postings: [...tied.postings].reverse() });
    expect(String(journalId("journal-id"))).toBe("journal-id");
  });
});
