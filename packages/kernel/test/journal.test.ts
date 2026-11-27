import { describe, expect, test } from "bun:test";

import {
  ExactDecimal,
  ExactRational,
  accountId,
  admitJournal,
  bookId,
  commodityId,
  dimensionId,
  dimensionMemberId,
  instant,
  journalId,
  localDate,
  postingId,
  validateAccountingCoordinate,
  type AccountingCoordinate,
  type AccountSnapshot,
  type JournalAdmissionSnapshot,
  type JournalTransaction,
  type Posting,
} from "../src/index.ts";

const BOOK = bookId("book-acme");
const OTHER_BOOK = bookId("book-other");
const USD = commodityId("USD");
const CASH = accountId("account-cash");
const REVENUE = accountId("account-revenue");
const DEPARTMENT = dimensionId("dimension-department");
const SALES = dimensionMemberId("dimension-member-sales");

function account(
  id: typeof CASH | typeof REVENUE,
  code: string,
  overrides: Partial<AccountSnapshot> = {},
): AccountSnapshot {
  return {
    id,
    bookId: BOOK,
    code,
    name: code === "1000" ? "Cash" : "Revenue",
    role: code === "1000" ? "asset" : "income",
    normalSide: code === "1000" ? "debit" : "credit",
    postingAllowed: true,
    openedOn: localDate("2026-01-01"),
    allowedCommodityIds: [],
    ...overrides,
  };
}

function snapshot(overrides: Partial<JournalAdmissionSnapshot> = {}): JournalAdmissionSnapshot {
  return {
    bookId: BOOK,
    functionalCommodityId: USD,
    accounts: [account(CASH, "1000"), account(REVENUE, "4000")],
    dimensions: [
      {
        id: DEPARTMENT,
        bookId: BOOK,
        code: "department",
        name: "Department",
        openedOn: localDate("2026-01-01"),
      },
    ],
    dimensionMembers: [
      {
        id: SALES,
        dimensionId: DEPARTMENT,
        code: "sales",
        name: "Sales",
        openedOn: localDate("2026-01-01"),
      },
    ],
    requiredDimensionIds: [DEPARTMENT],
    ...overrides,
  };
}

function posting(
  id: "debit" | "credit",
  ordinal: bigint,
  targetAccountId: typeof CASH | typeof REVENUE,
  amount: string,
  overrides: Partial<Posting> = {},
): Posting {
  const sourceNumber = ExactDecimal.parse(amount);
  return {
    id: postingId(`posting-${id}`),
    ordinal,
    accountId: targetAccountId,
    units: {
      canonicalNumber: sourceNumber.toRational(),
      commodityId: USD,
      sourceNumber,
    },
    bookValue: {
      amount: ExactDecimal.parse(amount),
      functionalCommodityId: USD,
    },
    dimensionMemberIds: [SALES],
    ...overrides,
  };
}

function balancedJournal(overrides: Partial<JournalTransaction> = {}): JournalTransaction {
  return {
    id: journalId("journal-sale-1"),
    kind: "ordinary",
    bookId: BOOK,
    functionalCommodityId: USD,
    economicAt: instant("2026-02-01T15:00:00Z"),
    accountingDate: localDate("2026-02-01"),
    recordedAt: instant("2026-02-01T15:01:00Z"),
    narration: "Cash sale",
    postings: [posting("debit", 1n, CASH, "100.00"), posting("credit", 2n, REVENUE, "-100.00")],
    ...overrides,
  };
}

function diagnosticCodes(result: ReturnType<typeof admitJournal>): string[] {
  return result.disposition === "rejected"
    ? result.diagnostics.map((diagnostic) => diagnostic.code)
    : [];
}

describe("monetary-independent accounting coordinates", () => {
  const coordinate: AccountingCoordinate = {
    bookId: BOOK,
    functionalCommodityId: USD,
    accountingDate: localDate("2026-02-01"),
    accountId: CASH,
    unitsCommodityId: USD,
    dimensionMemberIds: [SALES],
  };

  test("validates without a journal, posting identity, ordinal, amount or quantity", () => {
    const result = validateAccountingCoordinate(snapshot(), coordinate, [DEPARTMENT]);
    expect(result).toEqual([]);
    expect(Object.isFrozen(result)).toBe(true);
    expect(Object.keys(coordinate).sort()).toEqual([
      "accountId", "accountingDate", "bookId", "dimensionMemberIds",
      "functionalCommodityId", "unitsCommodityId",
    ]);
    // Validation of a coordinate does not waive the journal's monetary rules.
    expect(diagnosticCodes(admitJournal(snapshot(), balancedJournal({
      postings: [posting("debit", 1n, CASH, "0"), posting("credit", 2n, REVENUE, "0")],
    })))).toContain("invalid_journal_structure");
  });

  test("requires explicit resolved dimensions, not fabricated posting-ID overrides", () => {
    const supplied = snapshot({ requiredDimensionIdsByPosting: { "posting-debit": [] } });
    const missing = { ...coordinate, dimensionMemberIds: [] };
    expect(validateAccountingCoordinate(supplied, missing, [DEPARTMENT])).toEqual([{
      code: "invalid_dimension_selection", path: "coordinate.dimensionMemberIds",
      message: `Movement omits required dimension ${DEPARTMENT}`,
      requirementIds: ["ACC-011", "ACC-037"],
    }]);
    // A resolved policy can intentionally have no requirements; the helper does
    // not select that policy or silently union it with snapshot defaults.
    expect(validateAccountingCoordinate(supplied, missing, [])).toEqual([]);
    for (const required of [[DEPARTMENT, DEPARTMENT], [dimensionId("missing")]]) {
      expect(validateAccountingCoordinate(snapshot(), coordinate, required)).toContainEqual({
        code: "invalid_dimension_selection", path: "coordinate.requiredDimensionIds",
        message: "Resolved dimension requirements must be distinct and belong to the supplied chart",
        requirementIds: ["ACC-011", "ACC-037", "ACC-038"],
      });
    }
  });

  test("rejects foreign book and functional commodity independently", () => {
    expect(validateAccountingCoordinate(snapshot(), {
      ...coordinate, bookId: OTHER_BOOK, functionalCommodityId: commodityId("EUR"),
    }, [DEPARTMENT])).toEqual([
      { code: "book_isolation_violation", path: "coordinate.bookId",
        message: "Movement and supplied snapshot belong to different books", requirementIds: ["ACC-026"] },
      { code: "monetary_type_mismatch", path: "coordinate.functionalCommodityId",
        message: "Movement and book snapshot use different functional commodities", requirementIds: ["ACC-002", "ACC-026"] },
    ]);
  });

  test("enforces chart admission and inclusive lifecycle boundaries", () => {
    for (const overrides of [
      { postingAllowed: false }, { openedOn: localDate("2026-02-02") },
      { closedOn: localDate("2026-01-31") },
    ]) {
      expect(validateAccountingCoordinate(snapshot({ accounts: [account(CASH, "1000", overrides)] }),
        coordinate, [DEPARTMENT])).toEqual([{
        code: "invalid_chart_or_account", path: "coordinate.accountId",
        message: `Account ${CASH} is not active and posting-enabled on 2026-02-01`, requirementIds: ["ACC-014"],
      }]);
    }
    expect(validateAccountingCoordinate(snapshot({ accounts: [] }), coordinate, [DEPARTMENT])).toEqual([{
      code: "invalid_chart_or_account", path: "coordinate.accountId",
      message: `Account ${CASH} does not resolve in the supplied chart`, requirementIds: ["ACC-014", "ACC-038"],
    }]);
    const day = coordinate.accountingDate;
    const endpoint = snapshot({
      accounts: [account(CASH, "1000", { openedOn: day, closedOn: day, allowedCommodityIds: [USD] })],
      dimensions: snapshot().dimensions.map((d) => ({ ...d, openedOn: day, closedOn: day })),
      dimensionMembers: snapshot().dimensionMembers.map((m) => ({ ...m, openedOn: day, closedOn: day })),
    });
    expect(validateAccountingCoordinate(endpoint, coordinate, [DEPARTMENT])).toEqual([]);
    expect(validateAccountingCoordinate(endpoint, { ...coordinate, unitsCommodityId: commodityId("EUR") }, [DEPARTMENT])).toEqual([{
      code: "invalid_chart_or_account", path: "coordinate.unitsCommodityId",
      message: `Commodity EUR is not admitted by account ${CASH}`, requirementIds: ["ACC-014"],
    }]);
  });

  test("rejects absent, inactive, foreign and multiply selected analytic members", () => {
    const invalidSnapshots = [
      snapshot({ dimensions: [] , requiredDimensionIds: [] }),
      ...["dimensions", "dimensionMembers"].flatMap((field) => [
        { openedOn: localDate("2026-02-02") }, { closedOn: localDate("2026-01-31") },
      ].map((dates) => field === "dimensions"
        ? snapshot({ dimensions: snapshot().dimensions.map((d) => ({ ...d, ...dates })) })
        : snapshot({ dimensionMembers: snapshot().dimensionMembers.map((m) => ({ ...m, ...dates })) }))),
      snapshot({ dimensions: snapshot().dimensions.map((d) => ({ ...d, bookId: OTHER_BOOK })) }),
    ];
    for (const supplied of invalidSnapshots) {
      expect(validateAccountingCoordinate(supplied, coordinate, [DEPARTMENT])).toContainEqual({
        code: "invalid_dimension_selection", path: "coordinate.dimensionMemberIds",
        message: `Dimension member ${SALES} is not active in the specified book on the accounting date`,
        requirementIds: ["ACC-026", "ACC-037"],
      });
    }
    expect(validateAccountingCoordinate(snapshot({ dimensionMembers: [] }), coordinate, [])).toEqual([{
      code: "invalid_dimension_selection", path: "coordinate.dimensionMemberIds",
      message: `Dimension member ${SALES} does not resolve`, requirementIds: ["ACC-037", "ACC-038"],
    }]);
    expect(validateAccountingCoordinate(snapshot(), { ...coordinate, dimensionMemberIds: [SALES, SALES] }, [DEPARTMENT])).toEqual([{
      code: "invalid_dimension_selection", path: "coordinate.dimensionMemberIds",
      message: `Movement selects more than one member of dimension ${DEPARTMENT}`, requirementIds: ["ACC-037"],
    }]);
  });

  test("shares coordinate failures with journals without changing original diagnostic wording", () => {
    const supplied = snapshot({ accounts: [account(CASH, "1000", { allowedCommodityIds: [commodityId("EUR")] }), account(REVENUE, "4000")] });
    const diagnostics = validateAccountingCoordinate(supplied, { ...coordinate, dimensionMemberIds: [] }, [DEPARTMENT]);
    const result = admitJournal(supplied, balancedJournal({ postings: [
      posting("debit", 1n, CASH, "100", { dimensionMemberIds: [] }), posting("credit", 2n, REVENUE, "-100"),
    ] }));
    expect(result.disposition).toBe("rejected");
    if (result.disposition !== "rejected") throw new Error("Expected rejected journal");
    expect(result.diagnostics).toEqual(diagnostics.map((d) => ({ ...d,
      path: d.path.replace("coordinate", "journal.postings[0]").replace("unitsCommodityId", "units.commodityId"),
      message: d.message.replace("Movement", "Posting"),
    })));
    expect(result.diagnostics.map((d) => d.message)).toEqual([
      `Commodity USD is not admitted by account ${CASH}`, `Posting omits required dimension ${DEPARTMENT}`,
    ]);
  });
});

describe("journal admission", () => {
  test("rejects impossible supplied dates and instants (ACC-013)", () => {
    expect(() => localDate("2026-02-29")).toThrow("Invalid local date");
    expect(() => instant("2026-02-01T25:00:00Z")).toThrow("Invalid supplied instant");
    expect(() => instant("2026-02-01T12:00:00+14:01")).toThrow("Invalid supplied instant");
    expect(() => instant("2026-02-01T12:00:00+13:59")).not.toThrow();
  });

  test("admits one exactly balanced, typed, same-book journal (V01)", () => {
    const result = admitJournal(snapshot(), balancedJournal());

    expect(result.disposition).toBe("admitted");
    if (result.disposition === "admitted") {
      expect(result.canonicalHash.algorithm).toBe("sha256");
      expect(result.canonicalHash.digest).toMatch(/^[0-9a-f]{64}$/);
    }
  });

  test("admits exact lifecycle endpoints and posting ordinal zero", () => {
    const day = localDate("2026-02-01");
    const endpointSnapshot = snapshot({
      accounts: [account(CASH, "1000", { openedOn: day, closedOn: day }), account(REVENUE, "4000", { openedOn: day, closedOn: day })],
      dimensions: [{ id: DEPARTMENT, bookId: BOOK, code: "department", name: "Department", openedOn: day, closedOn: day }],
      dimensionMembers: [{ id: SALES, dimensionId: DEPARTMENT, code: "sales", name: "Sales", openedOn: day, closedOn: day }],
    });
    const endpointJournal = balancedJournal({ postings: [posting("debit", 0n, CASH, "100.00"), posting("credit", 1n, REVENUE, "-100.00")] });
    expect(admitJournal(endpointSnapshot, endpointJournal).disposition).toBe("admitted");
  });

  test("canonicalizes economically identical posting order (V07)", () => {
    const journal = balancedJournal();
    const reordered = balancedJournal({ postings: [...journal.postings].reverse() });
    const first = admitJournal(snapshot(), journal);
    const second = admitJournal(snapshot(), reordered);

    expect(first.disposition).toBe("admitted");
    expect(second.disposition).toBe("admitted");
    if (first.disposition === "admitted" && second.disposition === "admitted") {
      expect(first.canonicalHash).toEqual(second.canonicalHash);
    }
  });

  test("rejects a one-cent imbalance exactly (I03)", () => {
    const result = admitJournal(
      snapshot(),
      balancedJournal({
        postings: [posting("debit", 1n, CASH, "100.00"), posting("credit", 2n, REVENUE, "-99.99")],
      }),
    );

    expect(result.disposition).toBe("rejected");
    expect(diagnosticCodes(result)).toContain("journal_imbalance");
  });

  test("rejects duplicate posting identity and ordinal (I13)", () => {
    const duplicate = posting("debit", 1n, CASH, "-100.00");
    const result = admitJournal(
      snapshot(),
      balancedJournal({
        postings: [posting("debit", 1n, CASH, "100.00"), duplicate],
      }),
    );

    expect(result.disposition).toBe("rejected");
    expect(diagnosticCodes(result)).toContain("invalid_journal_structure");
  });

  test("rejects cross-book accounts before admission (I12)", () => {
    const wrongBookCash = account(CASH, "1000", { bookId: OTHER_BOOK });
    const result = admitJournal(
      snapshot({ accounts: [wrongBookCash, account(REVENUE, "4000")] }),
      balancedJournal(),
    );

    expect(result.disposition).toBe("rejected");
    expect(diagnosticCodes(result)).toContain("book_isolation_violation");
  });

  test("rejects inactive accounts on the accounting date (I12)", () => {
    const closedCash = account(CASH, "1000", { closedOn: localDate("2026-01-31") });
    const result = admitJournal(
      snapshot({ accounts: [closedCash, account(REVENUE, "4000")] }),
      balancedJournal(),
    );

    expect(result.disposition).toBe("rejected");
    expect(diagnosticCodes(result)).toContain("invalid_chart_or_account");
  });

  test("rejects contradictory source and canonical quantities (I01)", () => {
    const result = admitJournal(
      snapshot(),
      balancedJournal({
        postings: [
          posting("debit", 1n, CASH, "100.00", {
            units: {
              canonicalNumber: ExactRational.of(99n, 1n),
              commodityId: USD,
              sourceNumber: ExactDecimal.parse("100.00"),
            },
          }),
          posting("credit", 2n, REVENUE, "-100.00"),
        ],
      }),
    );

    expect(result.disposition).toBe("rejected");
    expect(diagnosticCodes(result)).toContain("invalid_exact_number");
  });

  test("rejects binary floating and monetary type substitution with typed diagnostics (I01, I02)", () => {
    const invalid = structuredClone(balancedJournal()) as unknown as JournalTransaction;
    const mutable = invalid as unknown as {
      postings: Array<{ bookValue: { amount: number } }>;
    };
    mutable.postings[0]!.bookValue.amount = 100.01;
    const result = admitJournal(snapshot(), invalid);
    expect(result.disposition).toBe("rejected");
    if (result.disposition === "rejected") {
      expect(result.diagnostics.some((item) => item.code === "monetary_type_mismatch")).toBeTrue();
    }
  });

  test("rejects reversed account lifecycle intervals (I12)", () => {
    const invalidCash = account(CASH, "1000", {
      openedOn: localDate("2026-02-01"),
      closedOn: localDate("2026-01-31"),
    });
    const result = admitJournal(
      snapshot({ accounts: [invalidCash, account(REVENUE, "4000")] }),
      balancedJournal(),
    );

    expect(result.disposition).toBe("rejected");
    expect(diagnosticCodes(result)).toContain("invalid_chart_or_account");
  });

  test("rejects omitted and duplicate required dimensions (I23)", () => {
    const omitted = admitJournal(
      snapshot(),
      balancedJournal({
        postings: [
          posting("debit", 1n, CASH, "100.00", { dimensionMemberIds: [] }),
          posting("credit", 2n, REVENUE, "-100.00"),
        ],
      }),
    );
    const duplicated = admitJournal(
      snapshot(),
      balancedJournal({
        postings: [
          posting("debit", 1n, CASH, "100.00", { dimensionMemberIds: [SALES, SALES] }),
          posting("credit", 2n, REVENUE, "-100.00"),
        ],
      }),
    );

    expect(diagnosticCodes(omitted)).toContain("invalid_dimension_selection");
    expect(diagnosticCodes(duplicated)).toContain("invalid_dimension_selection");
  });

  test("rejects duplicate canonical account identity (I24)", () => {
    const result = admitJournal(
      snapshot({ accounts: [account(CASH, "1000"), account(CASH, "1001"), account(REVENUE, "4000")] }),
      balancedJournal(),
    );

    expect(result.disposition).toBe("rejected");
    expect(diagnosticCodes(result)).toContain("canonical_identity_conflict");
  });
});
