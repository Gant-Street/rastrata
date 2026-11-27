import { expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import {
  encodeDurableBook,
  encodeBookOutcome,
  decodeDurableBook,
  decodeBookRow,
  createBookState,
  createBookProtocolState,
  commandId,
  accountId,
  lotHoldingId,
  lotAllocationId,
  ExactRational,
  canonicalPostingValue,
  hashCanonical,
  dimensionId,
  dimensionMemberId,
  postingId,
  ExactDecimal,
  resolveJournal,
  type ResolvedTransaction,
  inventoryValueAdjustmentId,
  instant,
  localDate,
  semanticVersion,
  INVENTORY_VALUE_ADJUSTMENT_ALGORITHM_VERSION,
  executeBookCommand,
  sealCommand,
  type BookCommand,
} from "@rastrata/kernel";
import {
  COMPACT_LEDGER_FORMAT,
  LEDGER_FORMAT,
  ProductionLedger,
  SqliteBookStorage,
  type SqliteStorage,
  type LedgerFormat,
} from "../src/index.ts";
import { BOOK, activation, genesis, posting } from "./fixtures.ts";
import { outcomeRecord, verifiedOutcomeRecordHash, type StoredBook } from "../src/records.ts";
import { compactOutcomeRecord } from "../src/compact-records.ts";
import { resolveOutcomeSourceRow } from "../src/outcome-source.ts";
import { projectLegacyLogicalBook } from "../src/logical-book.ts";
import { lotIdentityWorkflow, workflowValue } from "./accounting-workflows.ts";

function fixture(bookId: string = BOOK, format: LedgerFormat = LEDGER_FORMAT) {
  const db = new Database(":memory:");
  const faults = { afterSql: "", sync: false };
  const port: SqliteStorage = {
    sql: {
      exec(query, ...bindings) {
        const rows = db
          .query(query)
          .all(
            ...bindings.map((v) => (v instanceof ArrayBuffer ? new Uint8Array(v) : v)),
          ) as Record<string, unknown>[];
        if (faults.afterSql && query.startsWith(faults.afterSql))
          throw new Error("Injected transaction failure");
        return rows.map((row) =>
          Object.fromEntries(
            Object.entries(row).map(([key, value]) => [
              key,
              value instanceof Uint8Array
                ? value.buffer.slice(value.byteOffset, value.byteOffset + value.byteLength)
                : value,
            ]),
          ),
        );
      },
    },
    transactionSync: (operation) => db.transaction(operation)(),
    async sync() {
      if (faults.sync) {
        faults.sync = false;
        throw new Error("Uncertain durability");
      }
    },
  };
  const storage = new SqliteBookStorage("object", port);
  const scope = { tenantId: "tenant", bookId, objectId: "object" };
  const open = () =>
    new ProductionLedger(
      storage,
      format === COMPACT_LEDGER_FORMAT
        ? { ...scope, namespaceId: "historical-test", generation: "0" }
        : scope,
      format,
    );
  return { db, storage, open, ledger: open(), faults, port };
}

const sourceScope = {
  tenantId: "tenant",
  bookId: BOOK,
  objectId: "object",
  namespaceId: "historical-test",
  generation: "0",
};

for (const format of [LEDGER_FORMAT, COMPACT_LEDGER_FORMAT] as const) {
  for (const chronology of [
    "before-lot-acquisition",
    "before-holding-acquisition",
    "before-destination-transfer",
    "valid-backdated-transfer",
    "valid-backdated",
    "same-instant",
    "same-instant-offset",
    "submillisecond-shortage",
  ] as const) {
    test(`${format}: inventory attribution chronology ${chronology} survives restart without rewriting history`, async () => {
      const scenario = lotIdentityWorkflow();
      const f = fixture(BOOK, format);
      const at = (day: number) => instant(`2026-01-${day}T12:00:00Z`);
      const beforeSource =
        chronology.startsWith("before-") || chronology === "submillisecond-shortage";
      const commands = scenario.commands.map((command, index) => {
        if (command.type !== "postJournal") return command;
        if (command.lotOperations === undefined) throw new Error("Expected lot operations");
        const acquisition = index === 1 || index === 2;
        const economicDay =
          chronology === "valid-backdated"
            ? acquisition
              ? 13
              : 14
            : chronology === "same-instant" ||
                chronology === "same-instant-offset" ||
                chronology === "submillisecond-shortage"
              ? 15
              : chronology === "before-destination-transfer"
                ? index === 3 || index === 4
                  ? 15
                  : 14
                : chronology === "valid-backdated-transfer"
                  ? index === 3
                    ? 15
                    : 14
                  : acquisition
                    ? 15
                    : 14;
        const destinationDisposal =
          (chronology === "before-destination-transfer" ||
            chronology === "valid-backdated-transfer") &&
          index === 5;
        const disposalQuantity = chronology === "valid-backdated-transfer" ? 2n : 5n;
        const journal = {
          ...command.resolved.journal,
          economicAt:
            chronology === "submillisecond-shortage"
              ? instant(`2026-01-15T12:00:00.000${acquisition ? "2" : "1"}Z`)
              : chronology === "same-instant-offset" && !acquisition
                ? instant("2026-01-15T07:00:00.000000-05:00")
                : at(economicDay),
          accountingDate: localDate(`2026-01-${economicDay}`),
          postings: command.resolved.journal.postings.map((posting, ordinal) => {
            if (!destinationDisposal) return posting;
            const quantity = ordinal === 0 ? -disposalQuantity : disposalQuantity;
            return {
              ...posting,
              accountId: ordinal === 0 ? accountId("second-location") : posting.accountId,
              units: { ...posting.units, canonicalNumber: ExactRational.of(quantity, 1n) },
              bookValue: { ...posting.bookValue, amount: ExactDecimal.of(quantity * 100n, 2n) },
              ...(posting.costBasis === undefined
                ? {}
                : {
                    costBasis: { ...posting.costBasis, totalBasis: ExactRational.of(quantity, 1n) },
                  }),
            };
          }),
        };
        const resolved = resolveJournal(
          journal,
          scenario.initial.state.policies,
          scenario.initial.state.identity.ownerId,
          workflowValue(scenario.initial.state.quantizationPolicies[0]),
          journal.postings.map((posting) => posting.bookValue.amount.toRational()),
        );
        if (Array.isArray(resolved)) throw new Error("Expected dated journal");
        return sealCommand({
          ...command,
          resolved: resolved as ResolvedTransaction,
          lotOperations: command.lotOperations.map((operation) =>
            operation.type === "acquire"
              ? {
                  ...operation,
                  lot: {
                    ...operation.lot,
                    acquiredAt: at(
                      chronology === "before-lot-acquisition" ||
                        chronology === "same-instant" ||
                        chronology === "same-instant-offset"
                        ? 15
                        : 13,
                    ),
                  },
                }
              : destinationDisposal && operation.type === "dispose"
                ? {
                    ...operation,
                    holdingIds: [scenario.destination],
                    requestedQuantity: ExactRational.of(disposalQuantity, 1n),
                    selection: {
                      method: "specificIdentification" as const,
                      allocations: [
                        {
                          holdingId: scenario.destination,
                          quantity: ExactRational.of(disposalQuantity, 1n),
                        },
                      ],
                    },
                    identities: operation.identities.map((identity) => ({
                      ...identity,
                      holdingId: scenario.destination,
                    })),
                  }
                : operation,
          ),
        });
      });
      try {
        await f.ledger.provision(scenario.initial);
        for (const command of commands)
          expect((await f.ledger.execute(command)).result.disposition).toBe("committed");
        const before = await f.open().read();
        const audit = await f.open().auditInventoryPostedBalances();
        if (beforeSource) {
          expect(audit.disposition).toBe("requiresReview");
          if (audit.disposition !== "requiresReview") throw new Error("Missed source chronology");
          expect(audit.findings).toContainEqual({
            code: "negative_economic_quantity",
            reference:
              chronology === "before-destination-transfer" ? scenario.destination : scenario.source,
            observedAmount: chronology === "before-destination-transfer" ? "-5/1" : "-3/1",
            bookRevision: chronology === "before-destination-transfer" ? 6n : 4n,
          });
          if (chronology === "before-lot-acquisition")
            expect(audit.findings).toContainEqual({
              code: "movement_precedes_lot_acquisition",
              reference: scenario.source,
              bookRevision: 4n,
            });
          expect("balances" in audit).toBe(false);
          expect("movements" in audit).toBe(false);
          const sourcePosting = workflowValue(
            before.aggregate.state.journals[0]?.journal.postings[0],
          );
          const proposed = await f.open().auditInventoryPostedBalances(
            JSON.stringify({
              version: "legacy-inventory-posted-attribution-v1",
              sourceHash: audit.sourceHash,
              postings: [
                {
                  postingId: sourcePosting.id,
                  postingHash: hashCanonical(canonicalPostingValue(sourcePosting)),
                  shares: [{ holdingId: scenario.source, postedAmount: "10.00" }],
                },
              ],
            }),
          );
          expect(proposed.disposition).toBe("requiresReview");
          if (proposed.disposition !== "requiresReview")
            throw new Error("Proposal overrode chronology");
          expect(proposed.findings).toEqual(audit.findings);
        } else {
          expect(audit.disposition).toBe("attributed");
          if (audit.disposition !== "attributed") throw new Error("Rejected legitimate chronology");
          expect(audit.balances.map((balance) => balance.postedCarryingAmount.toString())).toEqual(
            chronology === "valid-backdated-transfer"
              ? ["5/1", "7/1", "3/1"]
              : ["0/1", "7/1", "5/1"],
          );
        }
        expect(encodeDurableBook((await f.open().read()).aggregate)).toBe(
          encodeDurableBook(before.aggregate),
        );
        expect((await f.open().read()).head).toEqual(before.head);
      } finally {
        f.db.close();
      }
    });
  }

  for (const issue of ["dimensions", "transfer-value"] as const) {
    test(`${format}: inventory boundary ${issue} cannot become accepted posted ownership`, async () => {
      const scenario = lotIdentityWorkflow();
      const state = scenario.initial.state;
      const department = dimensionId("department");
      const north = dimensionMemberId("north");
      const initial = {
        ...scenario.initial,
        state: createBookState(
          state.identity,
          state.periods,
          {
            ...state.admissionSnapshot,
            dimensions: [
              {
                id: department,
                bookId: BOOK,
                code: "DEPT",
                name: "Department",
                openedOn: localDate("2020-01-01"),
              },
            ],
            dimensionMembers: [
              {
                id: north,
                dimensionId: department,
                code: "N",
                name: "North",
                openedOn: localDate("2020-01-01"),
              },
            ],
          },
          state.policies,
          state.quantizationPolicies,
          state.accountingPolicySnapshot.policies,
          state.activeConfigurationSnapshot.effectiveAt,
        ),
      };
      const f = fixture(BOOK, format);
      try {
        await f.ledger.provision(initial);
        for (const command of scenario.commands.slice(0, 3))
          expect((await f.ledger.execute(command)).result.disposition).toBe("committed");
        const template = workflowValue(scenario.commands[3]);
        if (template.type !== "postJournal") throw new Error("Expected transfer");
        const journal = {
          ...template.resolved.journal,
          postings: template.resolved.journal.postings.map((posting, index) =>
            issue === "dimensions"
              ? { ...posting, dimensionMemberIds: [north] }
              : index === 1
                ? {
                    ...posting,
                    bookValue: { ...posting.bookValue, amount: ExactDecimal.of(400n, 2n) },
                  }
                : posting,
          ),
        };
        if (issue === "transfer-value") {
          const offset = workflowValue(journal.postings[1]);
          journal.postings.push({
            ...offset,
            id: postingId("mismatch-offset"),
            ordinal: 2n,
            accountId: accountId("income"),
            units: { ...offset.units, canonicalNumber: ExactRational.of(-1n, 1n) },
            bookValue: { ...offset.bookValue, amount: ExactDecimal.of(-100n, 2n) },
          });
        }
        const resolved = resolveJournal(
          journal,
          state.policies,
          state.identity.ownerId,
          workflowValue(state.quantizationPolicies[0]),
          journal.postings.map((posting) => posting.bookValue.amount.toRational()),
        );
        if (Array.isArray(resolved)) throw new Error("Expected resolved journal");
        const executed = await f.ledger.execute(
          sealCommand({ ...template, resolved: resolved as ResolvedTransaction }),
        );
        if (issue === "transfer-value") {
          expect(executed.result.disposition).toBe("rejected");
          expect(executed.result.diagnostics[0]?.code).toBe("lot_overallocation");
          expect(executed.head.bookRevision).toBe("3");
          const audit = await f.open().auditInventoryPostedBalances();
          expect(audit.disposition).toBe("attributed");
          return;
        }
        expect(executed.result.disposition).toBe("committed");
        const before = await f.ledger.read();
        const audit = await f.open().auditInventoryPostedBalances();
        expect(audit.disposition).toBe("requiresReview");
        if (audit.disposition !== "requiresReview") throw new Error("Invented ownership");
        expect(audit.findings.some((finding) => finding.code === "coordinate_conflict")).toBe(true);
        expect("balances" in audit).toBe(false);
        expect(encodeDurableBook((await f.open().read()).aggregate)).toBe(
          encodeDurableBook(before.aggregate),
        );
      } finally {
        f.db.close();
      }
    });
  }

  test(`${format}: formerly admitted posted-value defects retain stable rejection outcomes after restart`, async () => {
    const evidence: {
      initial: { sha256: string; aggregateGzipBase64: string };
      cases: { name: string; sha256: string; aggregateGzipBase64: string }[];
    } = await Bun.file(
      new URL(
        "../../kernel/test/data/inventory-posted-admission-defect-legacy.json",
        import.meta.url,
      ),
    ).json();
    const unpack = (record: { sha256: string; aggregateGzipBase64: string }) => {
      const raw = new TextDecoder().decode(
        Bun.gunzipSync(Buffer.from(record.aggregateGzipBase64, "base64")),
      );
      expect(new Bun.CryptoHasher("sha256").update(raw).digest("hex")).toBe(record.sha256);
      return raw;
    };
    const field = (node: unknown, name: string): unknown => {
      if (!Array.isArray(node) || node[0] !== "o") throw new Error("Expected frozen object");
      const pair = (node[1] as [string, unknown][]).find(([key]) => key === name);
      if (pair === undefined) throw new Error("Missing frozen field");
      return pair[1];
    };
    const initial = decodeDurableBook(unpack(evidence.initial));
    if (initial.disposition !== "decoded") throw new Error(initial.message);
    for (const captured of evidence.cases) {
      const raw = unpack(captured);
      const array = field(field(JSON.parse(raw).body, "protocol"), "retainedResults");
      if (!Array.isArray(array) || array[0] !== "a") throw new Error("Expected retained rows");
      const retained = (array[1] as unknown[]).map((node) => {
        const decoded = decodeBookRow("protocol.retainedResults", JSON.stringify(node));
        if (decoded.disposition !== "decoded") throw new Error(decoded.message);
        return decoded.row;
      });
      const f = fixture(initial.aggregate.state.identity.bookId, format);
      try {
        await f.ledger.provision(initial.aggregate);
        for (const row of retained.slice(0, -1)) {
          const result = await f.ledger.execute(row.command);
          expect(result.result.disposition).toBe("committed");
          expect(result.result.resultHash).toEqual(row.resultHash);
        }
        const original = workflowValue(retained.at(-1));
        const before = await f.ledger.read();
        const rejected = await f.ledger.execute(original.command);
        expect(rejected.result.disposition).toBe("rejected");
        expect(rejected.result.diagnostics[0]?.code).toBe(
          captured.name.startsWith("acquisition")
            ? "canonical_identity_conflict"
            : "lot_overallocation",
        );
        expect(rejected.head.bookRevision).toBe(before.head.bookRevision);
        expect(rejected.head.postingSequence).toBe(before.head.postingSequence);
        expect(rejected.head.stateHash).toBe(before.head.stateHash);
        expect(BigInt(rejected.head.sequence)).toBe(BigInt(before.head.sequence) + 1n);
        const reopened = await f.open().read();
        const retried = await f.open().execute(original.command);
        expect(retried.result.disposition).toBe("replayed");
        expect(retried.result.resultHash).toEqual(rejected.result.resultHash);
        expect(retried.originalResult).toEqual(rejected.result);
        expect(retried.head).toEqual(rejected.head);
        expect(encodeDurableBook((await f.open().read()).aggregate)).toBe(
          encodeDurableBook(reopened.aggregate),
        );
        expect(new Bun.CryptoHasher("sha256").update(raw).digest("hex")).toBe(captured.sha256);
      } finally {
        f.db.close();
      }
    }
  });

  test(`${format}: inventory posted audit refuses undocumented shares of a multi-holding disposal`, async () => {
    const scenario = lotIdentityWorkflow();
    const f = fixture(BOOK, format);
    try {
      await f.ledger.provision(scenario.initial);
      for (const command of scenario.commands.slice(0, 3))
        expect((await f.ledger.execute(command)).result.disposition).toBe("committed");
      const template = workflowValue(scenario.commands[5]);
      if (template.type !== "postJournal") throw new Error("Expected disposal");
      const operation = workflowValue(template.lotOperations?.[0]);
      if (operation.type !== "dispose") throw new Error("Expected disposal operation");
      const second = lotHoldingId("lot-second");
      const command = sealCommand({
        ...template,
        expectedBookRevision: 3n,
        lotOperations: [
          {
            ...operation,
            holdingIds: [scenario.source, second],
            selection: {
              method: "specificIdentification" as const,
              allocations: [
                { holdingId: scenario.source, quantity: ExactRational.of(2n, 1n) },
                { holdingId: second, quantity: ExactRational.of(3n, 1n) },
              ],
            },
            identities: [
              ...operation.identities,
              { holdingId: second, allocationId: lotAllocationId("second-share") },
            ],
          },
        ],
      });
      expect((await f.ledger.execute(command)).result.disposition).toBe("committed");
      const before = await f.ledger.read();
      const audit = await f.open().auditInventoryPostedBalances();
      expect(audit.disposition).toBe("requiresReview");
      if (audit.disposition !== "requiresReview")
        throw new Error("Invented historical posted shares");
      expect(
        audit.findings.some(
          (finding) =>
            finding.code === "ambiguous_posted_allocation" && finding.reference === command.id,
        ),
      ).toBe(true);
      expect("balances" in audit).toBe(false);
      const disposal = workflowValue(
        before.aggregate.state.journals
          .at(-1)
          ?.journal.postings.find((posting) => posting.id === operation.journalPostingId),
      );
      const proposal = {
        version: "legacy-inventory-posted-attribution-v1",
        sourceHash: audit.sourceHash,
        postings: [
          {
            postingId: disposal.id,
            postingHash: hashCanonical(canonicalPostingValue(disposal)),
            shares: [
              { holdingId: scenario.source, postedAmount: "-2.00" },
              { holdingId: second, postedAmount: "-3.00" },
            ],
          },
        ],
      };
      const proposed = await f.open().auditInventoryPostedBalances(JSON.stringify(proposal));
      expect(proposed.disposition).toBe("proposedAttribution");
      if (proposed.disposition === "requiresReview")
        throw new Error(JSON.stringify(proposed.findings));
      expect(
        proposed.balances.map((balance) => [
          balance.holdingId,
          balance.postedCarryingAmount.toString(),
        ]),
      ).toEqual([
        [scenario.source, "8/1"],
        [second, "4/1"],
      ]);
      expect(
        proposed.movements
          .filter((movement) => movement.attribution === "proposed")
          .map((movement) => [movement.holdingId, movement.postedAmount.toString()]),
      ).toEqual([
        [scenario.source, "-2/1"],
        [second, "-3/1"],
      ]);
      expect(proposed.witnessHash).toBeDefined();
      expect(Object.isFrozen(proposed.movements)).toBe(true);
      const row = workflowValue(proposal.postings[0]);
      expect(
        await f.open().auditInventoryPostedBalances(
          JSON.stringify({
            ...proposal,
            postings: [{ ...row, shares: [...row.shares].reverse() }],
          }),
        ),
      ).toEqual(proposed);
      for (const shares of [
        [
          { holdingId: scenario.source, postedAmount: "-1.00" },
          { holdingId: second, postedAmount: "-4.00" },
        ],
        [
          { holdingId: scenario.source, postedAmount: "2.00" },
          { holdingId: second, postedAmount: "-7.00" },
        ],
        [
          { holdingId: scenario.source, postedAmount: "-2.001" },
          { holdingId: second, postedAmount: "-2.999" },
        ],
        [{ holdingId: scenario.source, postedAmount: "-5.00" }],
        [...row.shares, { holdingId: "unrelated", postedAmount: "0.00" }],
      ]) {
        const refused = await f
          .open()
          .auditInventoryPostedBalances(
            JSON.stringify({ ...proposal, postings: [{ ...row, shares }] }),
          );
        expect(refused.disposition).toBe("requiresReview");
        if (refused.disposition !== "requiresReview") throw new Error("Accepted invalid share");
        expect(refused.findings.some((finding) => finding.code === "posted_witness_mismatch")).toBe(
          true,
        );
        expect("balances" in refused).toBe(false);
      }
      for (const badProposal of [
        { ...proposal, sourceHash: { ...proposal.sourceHash, digest: "0".repeat(64) } },
        {
          ...proposal,
          postings: [{ ...row, postingHash: { ...row.postingHash, digest: "0".repeat(64) } }],
        },
        { ...proposal, postings: [...proposal.postings, { ...row, postingId: "not-a-source" }] },
      ]) {
        const refused = await f.open().auditInventoryPostedBalances(JSON.stringify(badProposal));
        expect(refused.disposition).toBe("requiresReview");
        expect("balances" in refused).toBe(false);
      }
      // Invalid envelopes fail before even a SELECT; they cannot be treated as
      // an absent optional proposal after parse failure.
      f.faults.afterSql = "SELECT";
      for (const invalid of [
        "{",
        JSON.stringify({ ...proposal, version: "future" }),
        JSON.stringify({ ...proposal, extra: true }),
        JSON.stringify({ ...proposal, postings: [row, row] }),
        JSON.stringify({
          ...proposal,
          postings: [{ ...row, shares: [row.shares[0], row.shares[0]] }],
        }),
        JSON.stringify({
          ...proposal,
          postings: [{ ...row, postingHash: { ...row.postingHash, algorithm: "sha512" } }],
        }),
        " ".repeat(1_048_577),
      ]) {
        await expect(f.open().auditInventoryPostedBalances(invalid)).rejects.toThrow(
          "ledger_inventory_witness_invalid",
        );
      }
      f.faults.afterSql = "";
      expect(encodeDurableBook((await f.open().read()).aggregate)).toBe(
        encodeDurableBook(before.aggregate),
      );
      expect(await f.open().auditInventoryPostedBalances(JSON.stringify(proposal))).toEqual(
        proposed,
      );
      const rejected = await f.ledger.execute(posting("stale-witness-rejection", 999n));
      expect(rejected.result.disposition).toBe("rejected");
      expect(rejected.head.bookRevision).toBe(before.head.bookRevision);
      const stale = await f.open().auditInventoryPostedBalances(JSON.stringify(proposal));
      expect(stale.disposition).toBe("requiresReview");
      if (stale.disposition !== "requiresReview") throw new Error("Ignored outcome head change");
      expect(stale.findings.map((finding) => finding.code)).toEqual([
        "posted_witness_source_mismatch",
      ]);
    } finally {
      f.db.close();
    }
  });

  test(`${format}: inventory proposal transfers each accepted source share to its own destination`, async () => {
    const scenario = lotIdentityWorkflow();
    const f = fixture(BOOK, format);
    try {
      await f.ledger.provision(scenario.initial);
      for (const command of scenario.commands.slice(0, 3))
        expect((await f.ledger.execute(command)).result.disposition).toBe("committed");
      const template = workflowValue(scenario.commands[3]);
      if (template.type !== "postJournal") throw new Error("Expected transfer");
      const operation = workflowValue(template.lotOperations?.[0]);
      if (operation.type !== "transfer") throw new Error("Expected transfer operation");
      const second = lotHoldingId("lot-second");
      const firstDestination = lotHoldingId("z-first-destination");
      const secondDestination = lotHoldingId("a-second-destination");
      const command = sealCommand({
        ...template,
        lotOperations: [
          {
            ...operation,
            sourceHoldingIds: [scenario.source, second],
            selection: {
              method: "specificIdentification" as const,
              allocations: [
                { holdingId: scenario.source, quantity: ExactRational.of(2n, 1n) },
                { holdingId: second, quantity: ExactRational.of(1n, 1n) },
              ],
            },
            allocationIdentities: [
              ...operation.allocationIdentities,
              { holdingId: second, allocationId: lotAllocationId("second-transfer-share") },
            ],
            destinationIdentities: [
              { sourceHoldingId: scenario.source, destinationHoldingId: firstDestination },
              { sourceHoldingId: second, destinationHoldingId: secondDestination },
            ],
          },
        ],
      });
      expect((await f.ledger.execute(command)).result.disposition).toBe("committed");
      const before = await f.ledger.read();
      const unresolved = await f.open().auditInventoryPostedBalances();
      expect(unresolved.disposition).toBe("requiresReview");
      const source = workflowValue(
        before.aggregate.state.journals
          .at(-1)
          ?.journal.postings.find((posting) => posting.id === operation.sourcePostingId),
      );
      const proposal = {
        version: "legacy-inventory-posted-attribution-v1",
        sourceHash: unresolved.sourceHash,
        postings: [
          {
            postingId: source.id,
            postingHash: hashCanonical(canonicalPostingValue(source)),
            shares: [
              { holdingId: scenario.source, postedAmount: "-2.00" },
              { holdingId: second, postedAmount: "-1.00" },
            ],
          },
        ],
      };
      const accepted = await f.open().auditInventoryPostedBalances(JSON.stringify(proposal));
      expect(accepted.disposition).toBe("proposedAttribution");
      if (accepted.disposition === "requiresReview")
        throw new Error(JSON.stringify(accepted.findings));
      expect(
        accepted.balances.map((balance) => [
          balance.holdingId,
          balance.postedCarryingAmount.toString(),
        ]),
      ).toEqual([
        [scenario.source, "8/1"],
        [second, "6/1"],
        [firstDestination, "2/1"],
        [secondDestination, "1/1"],
      ]);
      expect(
        accepted.movements
          .filter((movement) => movement.postingId === operation.destinationPostingId)
          .map((movement) => [
            movement.holdingId,
            movement.postedAmount.toString(),
            movement.attribution,
          ]),
      ).toEqual([
        [secondDestination, "1/1", "proposed"],
        [firstDestination, "2/1", "proposed"],
      ]);
      const destination = workflowValue(
        before.aggregate.state.journals
          .at(-1)
          ?.journal.postings.find((posting) => posting.id === operation.destinationPostingId),
      );
      for (const wrong of [false, true]) {
        const result = await f.open().auditInventoryPostedBalances(
          JSON.stringify({
            ...proposal,
            postings: [
              ...proposal.postings,
              {
                postingId: destination.id,
                postingHash: hashCanonical(canonicalPostingValue(destination)),
                shares: [
                  { holdingId: firstDestination, postedAmount: wrong ? "1.00" : "2.00" },
                  { holdingId: secondDestination, postedAmount: wrong ? "2.00" : "1.00" },
                ],
              },
            ],
          }),
        );
        expect(result.disposition).toBe(wrong ? "requiresReview" : "proposedAttribution");
        if (wrong) expect("balances" in result).toBe(false);
      }
      expect(encodeDurableBook((await f.open().read()).aggregate)).toBe(
        encodeDurableBook(before.aggregate),
      );
      expect(await f.open().auditInventoryPostedBalances(JSON.stringify(proposal))).toEqual(
        accepted,
      );
    } finally {
      f.db.close();
    }
  });

  test(`${format}: inventory proposal attributes a multi-holding value adjustment from actual generated postings`, async () => {
    const decoded = decodeDurableBook(
      await Bun.file(
        new URL("../../kernel/test/data/inventory-adjustment-legacy.json", import.meta.url),
      ).text(),
    );
    if (decoded.disposition !== "decoded") throw new Error(decoded.message);
    const legacy = decoded.aggregate;
    const config = workflowValue(legacy.state.configurationSnapshots[0]);
    const old = workflowValue(legacy.protocol.retainedResults[3]).command;
    if (old.type !== "adjustInventoryValue") throw new Error("Expected value adjustment");
    const version = semanticVersion("1.0.1");
    const initial = {
      state: createBookState(
        legacy.state.identity,
        config.periods,
        config.admissionSnapshot,
        config.policies,
        config.quantizationPolicies,
        config.accountingPolicySnapshot.policies.map((policy) =>
          policy.kind !== "inventoryValueAdjustment"
            ? policy
            : {
                ...policy,
                version,
                algorithmVersion: INVENTORY_VALUE_ADJUSTMENT_ALGORITHM_VERSION,
                capability: {
                  ...policy.capability,
                  implementationVersion: INVENTORY_VALUE_ADJUSTMENT_ALGORITHM_VERSION,
                },
              },
        ),
        config.effectiveAt,
      ),
      protocol: createBookProtocolState(),
    };
    const f = fixture(legacy.state.identity.bookId, format);
    try {
      await f.ledger.provision(initial);
      for (const retained of legacy.protocol.retainedResults.slice(0, 2))
        expect((await f.ledger.execute(retained.command)).result.disposition).toBe("committed");
      const template = workflowValue(legacy.protocol.retainedResults[2]).command;
      if (template.type !== "postJournal") throw new Error("Expected acquisition");
      const operation = workflowValue(template.lotOperations?.[0]);
      if (operation.type !== "acquire") throw new Error("Expected acquisition operation");
      const inventory = accountId("account-inventory");
      const journal = {
        ...template.resolved.journal,
        postings: template.resolved.journal.postings.map((posting) =>
          posting.id !== operation.journalPostingId
            ? posting
            : { ...posting, accountId: inventory },
        ),
      };
      const resolved = resolveJournal(
        journal,
        config.policies,
        legacy.state.identity.ownerId,
        workflowValue(config.quantizationPolicies[0]),
        template.resolved.exactBookValues,
      );
      if (Array.isArray(resolved)) throw new Error("Expected resolved acquisition");
      expect(
        (
          await f.ledger.execute(
            sealCommand({
              ...template,
              resolved: resolved as ResolvedTransaction,
              lotOperations: [
                { ...operation, holding: { ...operation.holding, accountId: inventory } },
              ],
            }),
          )
        ).result.disposition,
      ).toBe("committed");
      const allocation = workflowValue(old.request.allocations[0]);
      const adjusted = sealCommand({
        ...old,
        request: {
          ...old.request,
          policyVersion: version,
          derivation: { ...old.request.derivation, policyVersion: version },
          exactSourceAmount: ExactRational.of(5n, 1n),
          allocations: [
            { ...allocation, remainingBasisChange: ExactRational.of(2n, 1n) },
            {
              ...allocation,
              ordinal: 2n,
              holdingId: operation.holding.id,
              lotId: operation.lot.id,
              remainingBasisChange: ExactRational.of(3n, 1n),
            },
          ],
        },
      });
      expect((await f.ledger.execute(adjusted)).result.disposition).toBe("committed");
      const before = await f.ledger.read();
      const unresolved = await f.open().auditInventoryPostedBalances();
      expect(unresolved.disposition).toBe("requiresReview");
      const posted = workflowValue(
        before.aggregate.state.journals
          .at(-1)
          ?.journal.postings.find((posting) => posting.id === `${old.request.id}-inventory`),
      );
      expect(posted.bookValue.amount.toRational().toString()).toBe("5/1");
      const proposal = {
        version: "legacy-inventory-posted-attribution-v1",
        sourceHash: unresolved.sourceHash,
        postings: [
          {
            postingId: posted.id,
            postingHash: hashCanonical(canonicalPostingValue(posted)),
            shares: [
              { holdingId: allocation.holdingId, postedAmount: "2.00" },
              { holdingId: operation.holding.id, postedAmount: "3.00" },
            ],
          },
        ],
      };
      const accepted = await f.open().auditInventoryPostedBalances(JSON.stringify(proposal));
      expect(accepted.disposition).toBe("proposedAttribution");
      if (accepted.disposition === "requiresReview")
        throw new Error(JSON.stringify(accepted.findings));
      expect(accepted.balances.map((balance) => balance.postedCarryingAmount.toString())).toEqual([
        "12/1",
        "13/1",
      ]);
      expect(
        accepted.movements
          .filter((movement) => movement.attribution === "proposed")
          .map((movement) => movement.postedAmount.toString()),
      ).toEqual(["2/1", "3/1"]);
      expect(await f.open().auditInventoryPostedBalances(JSON.stringify(proposal))).toEqual(
        accepted,
      );
      expect(encodeDurableBook((await f.open().read()).aggregate)).toBe(
        encodeDurableBook(before.aggregate),
      );
    } finally {
      f.db.close();
    }
  });

  test(`${format}: posted inventory audit attributes actual acquisition, transfer, coalescing and depletion without writes`, async () => {
    const scenario = lotIdentityWorkflow();
    const f = fixture(BOOK, format);
    try {
      await f.ledger.provision(scenario.initial);
      for (const command of scenario.commands)
        expect((await f.ledger.execute(command)).result.disposition).toBe("committed");
      const before = await f.ledger.read();
      const audit = await f.ledger.auditInventoryPostedBalances();
      expect(audit.disposition).toBe("attributed");
      if (audit.disposition === "requiresReview") throw new Error(JSON.stringify(audit.findings));
      expect(
        audit.balances.map((balance) => [
          balance.holdingId,
          balance.postedCarryingAmount.toString(),
        ]),
      ).toEqual([
        ["lot-first", "0/1"],
        ["lot-second", "7/1"],
        ["lot-destination", "5/1"],
      ]);
      expect(audit.movements.length).toBe(7);
      for (const movement of audit.movements) {
        const journal = workflowValue(
          before.aggregate.state.journals.find(
            (journal) => journal.journal.id === movement.journalId,
          ),
        );
        const source = workflowValue(
          journal.journal.postings.find((posting) => posting.id === movement.postingId),
        );
        expect(movement.postedAmount).toEqual(source.bookValue.amount.toRational());
        expect(movement.postingHash).toEqual(hashCanonical(canonicalPostingValue(source)));
        expect(movement.quantizationPolicyHash).toEqual(journal.quantizationPolicySnapshotHash);
        expect(movement.effectKey).toBe(journal.effectKey);
      }
      expect(audit.head).toEqual(before.head);
      expect(audit.scope).toEqual(before.scope);
      expect(Object.isFrozen(audit)).toBe(true);
      expect(Object.isFrozen(audit.balances)).toBe(true);
      expect(await f.open().auditInventoryPostedBalances()).toEqual(audit);
      expect(encodeDurableBook((await f.open().read()).aggregate)).toBe(
        encodeDurableBook(before.aggregate),
      );
      const pinnedAudit = f.ledger.auditInventoryPostedBalances();
      await f.ledger.execute(posting("unclassified-cash", 6n));
      expect((await pinnedAudit).head).toEqual(before.head);
      const unresolved = await f.open().auditInventoryPostedBalances();
      expect(unresolved.disposition).toBe("requiresReview");
      if (unresolved.disposition !== "requiresReview")
        throw new Error("Unclassified posting was ignored");
      expect(
        unresolved.findings.some(
          (finding) =>
            finding.code === "unattributed_posting" && finding.reference === "unclassified-cash-0",
        ),
      ).toBe(true);
      expect("balances" in unresolved).toBe(false);
      f.faults.afterSql = "SELECT";
      await expect(f.open().auditInventoryPostedBalances()).rejects.toThrow(
        "Injected transaction failure",
      );
      f.faults.afterSql = "";
      expect(await f.open().auditInventoryPostedBalances()).toEqual(unresolved);
    } finally {
      f.db.close();
    }
  });

  test(`${format}: inventory audit exposes the frozen posted residual and cannot silently initialize it to zero`, async () => {
    const evidence = await Bun.file(
      new URL("../../kernel/test/data/inventory-rounding-legacy.json", import.meta.url),
    ).json();
    const encoded = new TextDecoder().decode(
      Bun.gunzipSync(Buffer.from(evidence.aggregate.aggregateGzipBase64, "base64")),
    );
    expect(new Bun.CryptoHasher("sha256").update(encoded).digest("hex")).toBe(
      evidence.aggregate.sha256,
    );
    const decoded = decodeDurableBook(encoded);
    if (decoded.disposition !== "decoded") throw new Error(decoded.message);
    const old = decoded.aggregate;
    const configuration = workflowValue(old.state.configurationSnapshots[0]);
    const initial = {
      state: createBookState(
        old.state.identity,
        configuration.periods,
        configuration.admissionSnapshot,
        configuration.policies,
        configuration.quantizationPolicies,
        configuration.accountingPolicySnapshot.policies,
        configuration.effectiveAt,
      ),
      protocol: createBookProtocolState(),
    };
    const f = fixture(old.state.identity.bookId, format);
    try {
      await f.ledger.provision(initial);
      for (const retained of old.protocol.retainedResults)
        expect((await f.ledger.execute(retained.command)).result.resultHash).toEqual(
          retained.resultHash,
        );
      const before = await f.ledger.read();
      expect(encodeDurableBook(before.aggregate)).toBe(encoded);
      const audit = await f.open().auditInventoryPostedBalances();
      expect(audit.disposition).toBe("requiresReview");
      if (audit.disposition !== "requiresReview") throw new Error("Depleted residual was hidden");
      expect(audit.findings).toContainEqual({
        code: "depleted_posted_residual",
        reference: "audit-lot-a",
        observedAmount: "-1/100",
      });
      expect(audit.findings).toContainEqual({
        code: "negative_posted_balance",
        reference: "audit-lot-a",
        observedAmount: "-1/100",
      });
      expect("balances" in audit).toBe(false);
      expect(audit.head).toEqual(before.head);
      expect(await f.open().auditInventoryPostedBalances()).toEqual(audit);
      expect(encodeDurableBook((await f.open().read()).aggregate)).toBe(encoded);
    } finally {
      f.db.close();
    }
  });

  for (const defect of [
    "source-id",
    "other-account-id",
    "same-account",
    "source-account",
    "source-basis",
    "reused-postings",
  ] as const) {
    test(`${format}: ${defect} transfer rejection survives restart without financial mutation`, async () => {
      const scenario = lotIdentityWorkflow();
      const f = fixture(BOOK, format);
      try {
        await f.ledger.provision(scenario.initial);
        for (const command of scenario.commands.slice(0, 3)) {
          expect((await f.ledger.execute(command)).result.disposition).toBe("committed");
        }
        const template = workflowValue(scenario.commands[3]);
        if (template.type !== "postJournal") throw new Error("Expected transfer journal");
        const operation = workflowValue(template.lotOperations?.[0]);
        if (operation.type !== "transfer") throw new Error("Expected transfer operation");
        const destination =
          defect === "same-account" ? accountId("cash") : operation.destinationAccountId;
        const journal = {
          ...template.resolved.journal,
          postings: template.resolved.journal.postings.map((posting) => {
            if (posting.id === operation.destinationPostingId)
              return { ...posting, accountId: destination };
            if (defect === "source-account") return { ...posting, accountId: accountId("income") };
            if (defect === "source-basis")
              return {
                ...posting,
                costBasis: {
                  basisCommodityId: scenario.initial.state.identity.functionalCommodityId,
                  totalBasis: ExactRational.of(-99n, 1n),
                },
              };
            return posting;
          }),
        };
        const resolved = resolveJournal(
          journal,
          scenario.initial.state.policies,
          scenario.initial.state.identity.ownerId,
          workflowValue(scenario.initial.state.quantizationPolicies[0]),
          journal.postings.map((posting) => posting.bookValue.amount.toRational()),
        );
        if (Array.isArray(resolved)) throw new Error("Expected resolved transfer");
        const command = sealCommand({
          ...template,
          resolved: resolved as ResolvedTransaction,
          lotOperations: [
            {
              ...operation,
              destinationAccountId: destination,
              policies: operation.policies.map((policy) => ({
                ...policy,
                destinationAccountId: destination,
              })),
              destinationIdentities: operation.destinationIdentities.map((identity) => ({
                ...identity,
                destinationHoldingId:
                  defect === "source-id" || defect === "other-account-id"
                    ? lotHoldingId(defect === "source-id" ? "lot-first" : "lot-second")
                    : identity.destinationHoldingId,
              })),
            },
            ...(defect === "reused-postings"
              ? [
                  {
                    ...operation,
                    allocationIdentities: operation.allocationIdentities.map((identity) => ({
                      ...identity,
                      allocationId: lotAllocationId("duplicate-allocation"),
                    })),
                  },
                ]
              : []),
          ],
        });
        const before = await f.ledger.read();
        const rejected = await f.ledger.execute(command);
        expect(rejected.result.disposition).toBe("rejected");
        expect(rejected.result.diagnostics[0]?.code).toBe(
          defect === "source-id" || defect === "other-account-id"
            ? "canonical_identity_conflict"
            : "lot_overallocation",
        );
        expect(rejected.outcomeSequence).toBe(4n);
        const reopened = f.open();
        const restored = await reopened.read();
        expect(restored.aggregate.state).toEqual(before.aggregate.state);
        expect(restored.aggregate.protocol.retainedResults.length).toBe(4);
        expect(restored.head.bookRevision).toBe("3");
        expect(restored.head.postingSequence).toBe(before.head.postingSequence);
        expect(restored.head.stateHash).toBe(before.head.stateHash);
        const retry = await reopened.execute(command);
        expect(retry.result.disposition).toBe("replayed");
        expect(retry.originalResult).toEqual(rejected.result);
        expect(retry.head).toEqual(restored.head);
        expect(encodeDurableBook((await f.open().read()).aggregate)).toBe(
          encodeDurableBook(restored.aggregate),
        );
      } finally {
        f.db.close();
      }
    });
  }

  test(`${format}: malformed hash leaves history unchanged and identity reusable after reopening`, async () => {
    const f = fixture(BOOK, format);
    try {
      await f.ledger.provision(genesis());
      await f.ledger.execute(activation());
      const before = await f.ledger.read();
      const command = posting("bad-hash");
      const rejected = await f.ledger.execute({
        ...command,
        inputHash: { ...command.inputHash, digest: "0".repeat(64) },
      });
      expect(rejected.result.disposition).toBe("rejected");
      expect(rejected.result.diagnostics[0]?.code).toBe("command_identity_conflict");
      expect(rejected.outcomeSequence).toBeNull();
      expect(rejected.head).toEqual(before.head);
      const reopened = f.open();
      expect(encodeDurableBook((await reopened.read()).aggregate)).toBe(
        encodeDurableBook(before.aggregate),
      );
      const accepted = await reopened.execute(command);
      expect(accepted.result.disposition).toBe("committed");
      expect(accepted.outcomeSequence).toBe(2n);
      expect((await f.open().execute(command)).originalResult).toEqual(accepted.result);
    } finally {
      f.db.close();
    }
  });

  test(`${format}: unknown command fields fail admission before storage and cannot poison restart`, async () => {
    const f = fixture(BOOK, format);
    try {
      await f.ledger.provision(genesis());
      await f.ledger.execute(activation());
      const before = await f.ledger.read();
      const command = posting("bad-shape");
      let queries = 0;
      const exec = f.port.sql.exec.bind(f.port.sql);
      f.port.sql.exec = (sql, ...bindings) => {
        queries++;
        return exec(sql, ...bindings);
      };
      const extraField = { ...command, extra: "unknown" };
      expect(() => f.ledger.execute(extraField)).toThrow("ledger_command_invalid");
      expect(queries).toBe(0);
      expect(encodeDurableBook((await f.open().read()).aggregate)).toBe(
        encodeDurableBook(before.aggregate),
      );
      const accepted = await f.open().execute(command);
      expect(accepted.result.disposition).toBe("committed");
      expect(accepted.outcomeSequence).toBe(2n);
    } finally {
      f.db.close();
    }
  });
}

test("previously retained bad-hash compact outcomes fail recovery without rewriting history", async () => {
  const f = fixture(BOOK, COMPACT_LEDGER_FORMAT);
  try {
    await f.ledger.provision(genesis());
    await f.ledger.execute(activation());
    const before = await f.ledger.read();
    const original = posting("historical-invalid-hash");
    const command = { ...original, inputHash: { ...original.inputHash, digest: "0".repeat(64) } };
    const result = executeBookCommand(
      before.aggregate.state,
      before.aggregate.protocol,
      command,
    ).result;
    if (result.disposition !== "rejected") throw new Error("Expected invalid request rejection");
    // Reconstruct precisely the previous retention defect, not an altered
    // valid history: the diagnostic and result hash have not changed.
    const retained = {
      command,
      commandId: command.id,
      inputHash: command.inputHash,
      outcome: "rejected" as const,
      observedBookRevision: result.observedBookRevision,
      resultHash: result.resultHash,
      completedAt: result.completedAt,
      diagnostics: result.diagnostics,
    };
    const poisoned = {
      state: before.aggregate.state,
      protocol: { retainedResults: [...before.aggregate.protocol.retainedResults, retained] },
    };
    expect(decodeDurableBook(encodeDurableBook(poisoned)).disposition).toBe("rejected");
    const body = encodeBookOutcome({
      command,
      originalResult: { ...result, disposition: "rejected" },
      revision: null,
    });
    const record = compactOutcomeRecord(sourceScope, before.head, poisoned, body);
    await f.storage.commitTransition(before.head, record);
    const bytesBefore = JSON.stringify(f.storage.load(sourceScope));
    await expect(f.open().read()).rejects.toThrow("recovery_outcome_mismatch");
    await expect(f.open().execute(original)).rejects.toThrow("recovery_outcome_mismatch");
    expect(JSON.stringify(f.storage.load(sourceScope))).toBe(bytesBefore);
  } finally {
    f.db.close();
  }
});

test("canonical source lookup remains four bounded SQL reads as unrelated history grows", async () => {
  const f = fixture(BOOK, COMPACT_LEDGER_FORMAT);
  try {
    await f.ledger.provision(genesis());
    await f.ledger.execute(activation());
    const book = f.storage.load(sourceScope);
    const original = book?.outcomes[0];
    if (!book || !original) throw new Error("Missing verified test source");
    const commitment = verifiedOutcomeRecordHash(original);
    const projection = await projectLegacyLogicalBook(
      encodeDurableBook((await f.ledger.read()).aggregate),
    );
    const retainedCollection = projection.collections.find(
      (c) => c.name === "protocol.retainedResults",
    );
    const retainedRow = retainedCollection?.rows[0];
    if (!retainedCollection || !retainedRow) throw new Error("Missing retained source oracle");
    const exec = f.port.sql.exec.bind(f.port.sql);
    const calls: { sql: string; rows: number; bytes: number }[] = [];
    f.port.sql.exec = (sql, ...bindings) => {
      const rows = Array.from(exec(sql, ...bindings));
      calls.push({
        sql,
        rows: rows.length,
        bytes: rows.reduce(
          (n, row) =>
            n +
            Object.values(row).reduce<number>(
              (m, v) => m + (v instanceof ArrayBuffer ? v.byteLength : 0),
              0,
            ),
          0,
        ),
      });
      return rows;
    };
    const fetch = async () => {
      const current = await f.ledger.read();
      calls.length = 0;
      const record = f.storage.readVerifiedOutcome(sourceScope, current.head, 1n, commitment);
      expect(record).toEqual(original);
      expect(
        resolveOutcomeSourceRow(
          record,
          commitment,
          { collection: retainedCollection.name, selector: { kind: "retained" }, ordinal: 1n },
          retainedCollection.domain,
          retainedRow.contentHash,
        ),
      ).toBe(retainedRow.encoded);
      expect(calls.length).toBe(4);
      expect(calls.filter((c) => c.sql.includes("FROM ledger_outcomes"))).toHaveLength(1);
      expect(calls.find((c) => c.sql.includes("FROM ledger_outcomes"))?.rows).toBe(1);
      expect(calls.every((c) => c.sql.includes("LIMIT"))).toBe(true);
      expect(calls.reduce((n, c) => n + c.rows, 0)).toBe(4);
      return calls.reduce((n, c) => n + c.bytes, 0);
    };
    const small = await fetch();
    for (let i = 0; i < 100; i++)
      expect(
        (await f.ledger.execute(posting(`source-growth-${i}`, BigInt(i + 1)))).result.disposition,
      ).toBe("committed");
    expect(await fetch()).toBe(small);
    const plan = f.db
      .query("EXPLAIN QUERY PLAN SELECT header FROM ledger_outcomes WHERE sequence = ? LIMIT 2")
      .all("1") as { detail: string }[];
    expect(plan.some((row) => row.detail.includes("SEARCH") && row.detail.includes("INDEX"))).toBe(
      true,
    );
    expect(plan.some((row) => row.detail.includes("SCAN"))).toBe(false);
  } finally {
    f.db.close();
  }
});

test("canonical source fetch rejects forged commitments, foreign scope, bad cutoffs and accessor heads before source I/O", async () => {
  const f = fixture(BOOK, COMPACT_LEDGER_FORMAT);
  try {
    await f.ledger.provision(genesis());
    await f.ledger.execute(activation());
    const book = f.storage.load(sourceScope);
    if (!book?.outcomes[0]) throw new Error("Missing source");
    const hash = verifiedOutcomeRecordHash(book.outcomes[0]);
    const fetch = (sequence: bigint) =>
      f.storage.readVerifiedOutcome(sourceScope, book.head, sequence, hash);
    expect(() => fetch(0n)).toThrow("ledger_source_sequence_invalid");
    expect(() => fetch(2n)).toThrow("ledger_source_sequence_invalid");
    expect(() => fetch(1001n)).toThrow("ledger_source_sequence_invalid");
    expect(() => f.storage.readVerifiedOutcome(sourceScope, book.head, 1n, "0".repeat(64))).toThrow(
      "ledger_source_commitment_mismatch",
    );
    expect(() =>
      f.storage.readVerifiedOutcome({ ...sourceScope, tenantId: "foreign" }, book.head, 1n, hash),
    ).toThrow("ledger_identity_mismatch");
    let invoked = false;
    const head = {
      ...book.head,
      get stateHash() {
        invoked = true;
        return book.head.stateHash;
      },
    };
    expect(() => f.storage.readVerifiedOutcome(sourceScope, head, 1n, hash)).toThrow(
      "ledger_source_head_invalid",
    );
    expect(invoked).toBe(false);
    expect(fetch(1n)).toEqual(book.outcomes[0]);
  } finally {
    f.db.close();
  }
});

test("genesis source fetch uses bounded chunks and rejects a substituted commitment", async () => {
  const f = fixture(BOOK, COMPACT_LEDGER_FORMAT);
  try {
    await f.ledger.provision(genesis());
    await f.ledger.execute(activation());
    const stored = f.storage.load(sourceScope);
    if (!stored) throw new Error("Missing genesis source fixture");
    const exec = f.port.sql.exec.bind(f.port.sql);
    const calls: { sql: string; bindings: unknown[] }[] = [];
    f.port.sql.exec = (sql, ...bindings) => {
      calls.push({ sql, bindings });
      return exec(sql, ...bindings);
    };
    expect(f.storage.readVerifiedGenesis(sourceScope, stored.head, stored.genesisDigest)).toBe(
      stored.genesis,
    );
    expect(calls.length).toBe(3);
    expect(calls.every((c) => c.sql.includes("LIMIT"))).toBe(true);
    expect(calls.some((c) => c.sql.includes("ledger_outcomes"))).toBe(false);
    expect(calls.find((c) => c.sql.includes("ledger_chunks"))?.bindings[0]).toBe("genesis");
    expect(() => f.storage.readVerifiedGenesis(sourceScope, stored.head, "0".repeat(64))).toThrow(
      "ledger_source_commitment_mismatch",
    );
    expect(() => f.storage.readVerifiedGenesis(sourceScope, stored.head, "malformed")).toThrow(
      "ledger_source_hash_invalid",
    );
  } finally {
    f.db.close();
  }
});

for (const format of [LEDGER_FORMAT, COMPACT_LEDGER_FORMAT] as const)
  test(`${format}: an injected header body cannot be silently overwritten by chunk reconstruction`, async () => {
    const f = fixture(BOOK, format);
    try {
      await f.ledger.provision(genesis());
      await f.ledger.execute(activation());
      const row = f.db.query("SELECT header FROM ledger_outcomes WHERE sequence = '1'").get() as {
        header: string;
      };
      f.db
        .query("UPDATE ledger_outcomes SET header = ? WHERE sequence = '1'")
        .run(JSON.stringify({ ...JSON.parse(row.header), body: "ignored corruption" }));
      await expect(f.ledger.read()).rejects.toThrow("recovery_record_corrupt");
    } finally {
      f.db.close();
    }
  });

test("canonical source fetch detects a full-head change during its chunk read", async () => {
  const f = fixture(BOOK, COMPACT_LEDGER_FORMAT);
  try {
    await f.ledger.provision(genesis());
    await f.ledger.execute(activation());
    const book = f.storage.load(sourceScope);
    if (!book?.outcomes[0]) throw new Error("Missing source");
    const exec = f.port.sql.exec.bind(f.port.sql);
    f.port.sql.exec = (sql, ...bindings) => {
      const rows = exec(sql, ...bindings);
      if (sql.includes("FROM ledger_chunks"))
        f.db
          .query("UPDATE ledger_metadata SET head = ?")
          .run(JSON.stringify({ ...book.head, protocolHash: "0".repeat(64) }));
      return rows;
    };
    expect(() =>
      f.storage.readVerifiedOutcome(
        sourceScope,
        book.head,
        1n,
        verifiedOutcomeRecordHash(book.outcomes[0] as NonNullable<(typeof book.outcomes)[0]>),
      ),
    ).toThrow("ledger_head_conflict");
  } finally {
    f.db.close();
  }
});

test("canonical source fetch authenticates framing and refuses missing rows or hidden format suffixes", async () => {
  const f = fixture(BOOK, COMPACT_LEDGER_FORMAT);
  try {
    await f.ledger.provision(genesis());
    await f.ledger.execute(activation());
    const book = f.storage.load(sourceScope);
    const original = book?.outcomes[0];
    if (!book || !original) throw new Error("Missing source");
    const hash = verifiedOutcomeRecordHash(original);
    const fetch = () => f.storage.readVerifiedOutcome(sourceScope, book.head, 1n, hash);
    f.db.query("UPDATE ledger_metadata SET format = format || char(0)").run();
    expect(fetch).toThrow("ledger_format_unsupported");
    f.db.query("UPDATE ledger_metadata SET format = ?").run(COMPACT_LEDGER_FORMAT);
    const row = f.db.query("SELECT header FROM ledger_outcomes WHERE sequence = '1'").get() as {
      header: string;
    };
    const header = JSON.parse(row.header);
    f.db
      .query("UPDATE ledger_outcomes SET header = ? WHERE sequence = '1'")
      .run(JSON.stringify({ ...header, frame: { ...header.frame, commandHash: "0".repeat(64) } }));
    expect(fetch).toThrow("ledger_source_commitment_mismatch");
    f.db
      .query("UPDATE ledger_outcomes SET header = ? WHERE sequence = '1'")
      .run(JSON.stringify({ ...header, body: "ignored corruption" }));
    expect(fetch).toThrow("recovery_record_corrupt");
    f.db.query("DELETE FROM ledger_outcomes WHERE sequence = '1'").run();
    expect(fetch).toThrow("recovery_segment_gap_detected");
  } finally {
    f.db.close();
  }
});

test("oversized chunks are sliced before JavaScript allocation and digest suffixes still fail closed", async () => {
  const f = fixture(BOOK, COMPACT_LEDGER_FORMAT);
  try {
    await f.ledger.provision(genesis());
    await f.ledger.execute(activation());
    const book = f.storage.load(sourceScope);
    const original = book?.outcomes[0];
    if (!book || !original) throw new Error("Missing source");
    const exec = f.port.sql.exec.bind(f.port.sql);
    let returned = 0;
    f.port.sql.exec = (sql, ...bindings) => {
      const rows = Array.from(exec(sql, ...bindings));
      for (const row of rows)
        if (row.bytes instanceof ArrayBuffer) returned = Math.max(returned, row.bytes.byteLength);
      return rows;
    };
    f.db.query("UPDATE ledger_chunks SET digest = digest || char(0) WHERE record_id = '1'").run();
    expect(() =>
      f.storage.readVerifiedOutcome(
        sourceScope,
        book.head,
        1n,
        verifiedOutcomeRecordHash(original),
      ),
    ).toThrow("recovery_record_corrupt");
    f.db.query("UPDATE ledger_chunks SET bytes = zeroblob(1048576) WHERE record_id = '1'").run();
    expect(() =>
      f.storage.readVerifiedOutcome(
        sourceScope,
        book.head,
        1n,
        verifiedOutcomeRecordHash(original),
      ),
    ).toThrow("recovery_record_corrupt");
    expect(returned).toBe(262145);
  } finally {
    f.db.close();
  }
});

for (const format of [LEDGER_FORMAT, COMPACT_LEDGER_FORMAT] as const) {
  test(`${format}: verified replay reuses immutable accounting state but rereads every stored outcome`, async () => {
    const f = fixture(BOOK, format);
    try {
      let loadedOutcomes = 0;
      const load = f.storage.load.bind(f.storage);
      f.storage.load = (scope) => {
        const stored = load(scope);
        loadedOutcomes += stored?.outcomes.length ?? 0;
        return stored;
      };
      await f.ledger.provision(genesis());
      await f.ledger.execute(activation());
      const receipt = await f.ledger.execute(posting());
      const first = await f.ledger.read();
      loadedOutcomes = 0;
      const second = await f.ledger.read();
      expect(second.aggregate).toBe(first.aggregate);
      expect(loadedOutcomes).toBe(2);
      expect(Object.isFrozen(second.aggregate)).toBe(true);
      expect(Reflect.set(second.aggregate, "state", genesis().state)).toBe(false);
      expect(Reflect.set(second.head, "sequence", "999")).toBe(false);
      expect(Reflect.set(receipt.head, "sequence", "999")).toBe(false);
      const seen = new WeakSet<object>();
      const assertImmutable = (value: unknown): void => {
        if (value === null || typeof value !== "object" || seen.has(value)) return;
        seen.add(value);
        expect(Object.isFrozen(value)).toBe(true);
        for (const child of Object.values(value)) assertImmutable(child);
      };
      assertImmutable(second.aggregate);
      const cold = await f.open().read();
      expect(cold.aggregate).not.toBe(first.aggregate);
      expect(encodeDurableBook(cold.aggregate)).toBe(encodeDurableBook(first.aggregate));
      const historical = await f.ledger.readAt(1n);
      expect(historical.aggregate.state.journals.length).toBe(0);
      expect((await f.ledger.read()).head).toEqual(second.head);
      const retry = await f.ledger.execute(posting());
      expect(retry.result.disposition).toBe("replayed");
      expect(retry.originalResult).toEqual(receipt.result);
      expect(retry.outcomeSequence).toBe(2n);
      expect((await f.ledger.provision(genesis())).sequence).toBe("2");
    } finally {
      f.db.close();
    }
  });

  test(`${format}: verified prefix admits and replays another owner's complete suffix`, async () => {
    const f = fixture(BOOK, format);
    try {
      await f.ledger.provision(genesis());
      await f.ledger.execute(activation());
      const before = await f.ledger.read();
      const other = f.open();
      const rejection = await other.execute(posting("other-rejection", 0n));
      const accepted = await other.execute(posting("other-post", 1n));
      const after = await f.ledger.read();
      expect(after.aggregate).not.toBe(before.aggregate);
      expect(after.head.sequence).toBe("3");
      expect(after.head.bookRevision).toBe("2");
      expect(encodeDurableBook(after.aggregate)).toBe(
        encodeDurableBook((await f.open().read()).aggregate),
      );
      for (const [command, original, sequence] of [
        [posting("other-rejection", 0n), rejection, 2n],
        [posting("other-post", 1n), accepted, 3n],
      ] as const) {
        const retry = await f.ledger.execute(command);
        expect(retry.result.disposition).toBe("replayed");
        expect(retry.originalResult).toEqual(original.result);
        expect(retry.outcomeSequence).toBe(sequence);
      }
    } finally {
      f.db.close();
    }
  });

  for (const field of [
    "body",
    "commandId",
    "revision",
    "resultDigest",
    "payloadDigest",
    "before",
    "after",
    "extra",
    "frame",
  ]) {
    test(`${format}: warm replay rejects altered ${field} with unchanged terminal head`, async () => {
      const f = fixture(BOOK, format);
      try {
        await f.ledger.provision(genesis());
        await f.ledger.execute(activation());
        await f.ledger.execute(posting());
        const load = f.storage.load.bind(f.storage);
        f.storage.load = (scope) => {
          const stored = load(scope);
          if (!stored) throw new Error("Missing test book");
          return {
            ...stored,
            outcomes: stored.outcomes.map((record, index) =>
              index === 0 ? { ...record, [field]: "tampered" } : record,
            ),
          } as StoredBook;
        };
        // Alternate ordinary and historical reads to cover both cache entry paths.
        await expect(field.length % 2 ? f.ledger.read() : f.ledger.readAt(0n)).rejects.toThrow(
          "recovery_record_corrupt",
        );
        expect(f.db.query("SELECT COUNT(*) AS n FROM ledger_outcomes").get()).toEqual({ n: 2 });
        f.storage.load = load;
        expect((await f.ledger.read()).head.sequence).toBe("2");
      } finally {
        f.db.close();
      }
    });
  }

  test(`${format}: live verification detects a fully self-consistent rollback`, async () => {
    const f = fixture(BOOK, format);
    try {
      await f.ledger.provision(genesis());
      await f.ledger.execute(activation());
      let old: StoredBook | undefined;
      const load = f.storage.load.bind(f.storage);
      f.storage.load = (scope) => {
        const stored = load(scope);
        old = stored;
        return stored;
      };
      await f.ledger.read();
      f.storage.load = load;
      await f.ledger.execute(posting());
      f.storage.load = () => old;
      await expect(f.ledger.execute(posting())).rejects.toThrow("recovery_segment_gap_detected");
      // A fresh process has no independent rollback witness; do not claim otherwise.
      expect((await f.open().read()).head.sequence).toBe("1");
      f.storage.load = load;
      expect((await f.ledger.read()).head.sequence).toBe("2");
    } finally {
      f.db.close();
    }
  });

  test(`${format}: a warm cache cannot hide corrupt historical SQLite chunks`, async () => {
    const f = fixture(BOOK, format);
    try {
      await f.ledger.provision(genesis());
      await f.ledger.execute(activation());
      await f.ledger.execute(posting());
      const before = await f.ledger.read();
      expect((await f.ledger.read()).aggregate).toBe(before.aggregate);
      f.db.query("UPDATE ledger_chunks SET bytes = x'00' WHERE record_id = '1'").run();
      await expect(f.ledger.read()).rejects.toThrow("recovery_record_corrupt");
      await expect(f.ledger.execute(posting())).rejects.toThrow("recovery_record_corrupt");
      expect(f.db.query("SELECT COUNT(*) AS n FROM ledger_outcomes").get()).toEqual({ n: 2 });
    } finally {
      f.db.close();
    }
  });

  test(`${format}: validation, durability and transaction exceptions invalidate verified replay`, async () => {
    const f = fixture(BOOK, format);
    try {
      await f.ledger.provision(genesis());
      await f.ledger.execute(activation());
      let prior = await f.ledger.read();
      const validating = Object.assign(f.storage, {
        async validateRecovered(): Promise<void> {
          throw new Error("Derived history mismatch");
        },
      });
      await expect(f.ledger.read()).rejects.toThrow("Derived history mismatch");
      validating.validateRecovered = async () => {};
      const revalidated = await f.ledger.read();
      expect(revalidated.aggregate).not.toBe(prior.aggregate);
      expect(encodeDurableBook(revalidated.aggregate)).toBe(encodeDurableBook(prior.aggregate));
      prior = revalidated;
      for (const barrier of [1, 2]) {
        let calls = 0;
        f.port.sync = async () => {
          if (++calls === barrier) throw new Error("Uncertain durability");
        };
        await expect(f.ledger.read()).rejects.toThrow("Uncertain durability");
        f.port.sync = async () => {};
        const recovered = await f.ledger.read();
        expect(recovered.aggregate).not.toBe(prior.aggregate);
        expect(encodeDurableBook(recovered.aggregate)).toBe(encodeDurableBook(prior.aggregate));
        prior = recovered;
      }
      f.faults.afterSql = "INSERT INTO ledger_chunks";
      await expect(f.ledger.execute(posting())).rejects.toThrow("Injected transaction failure");
      f.faults.afterSql = "";
      const recovered = await f.ledger.read();
      expect(recovered.aggregate).not.toBe(prior.aggregate);
      expect(recovered.head.sequence).toBe("1");
      expect((await f.ledger.execute(posting())).result.disposition).toBe("committed");
    } finally {
      f.db.close();
    }
  });
}

test("historical reads return exact outcome cutoffs, including rejection-only protocol advances", async () => {
  const f = fixture();
  try {
    await f.ledger.provision(genesis());
    const snapshots = [await f.ledger.read()];
    for (const command of [
      activation(),
      posting("historical-rejected", 1n, false),
      posting("historical-post", 1n),
    ]) {
      await f.ledger.execute(command);
      snapshots.push(await f.ledger.read());
    }
    for (let i = 0; i < snapshots.length; i++) {
      const expected = snapshots[i];
      if (!expected) throw new Error("Missing expected cutoff");
      const actual = await f.open().readAt(BigInt(i));
      expect(actual.head).toEqual(expected.head);
      expect(encodeDurableBook(actual.aggregate)).toBe(encodeDurableBook(expected.aggregate));
      expect(actual.scope).toEqual({ tenantId: "tenant", bookId: BOOK, objectId: "object" });
      expect(Object.isFrozen(actual.scope)).toBe(true);
    }
    expect((await f.ledger.readAt(2n)).head.bookRevision).toBe("1");
    expect((await f.ledger.readAt(2n)).aggregate.protocol.retainedResults.length).toBe(2);
    expect((await f.ledger.read()).head.sequence).toBe("3");
    await expect(f.ledger.readAt(4n)).rejects.toThrow("ledger_cutoff_unavailable");
    expect(() => f.ledger.readAt(-1n)).toThrow("ledger_cutoff_invalid");
    f.db.query("DELETE FROM ledger_outcomes WHERE sequence = ?").run("3");
    await expect(f.open().readAt(1n)).rejects.toThrow(); // A later retained-history gap is not ignored.
  } finally {
    f.db.close();
  }
});

test("historical read keeps its captured cutoff when another instance commits during confirmation", async () => {
  const f = fixture();
  try {
    await f.ledger.provision(genesis());
    const first = await f.ledger.execute(activation());
    const other = f.open();
    let calls = 0;
    f.port.sync = async () => {
      calls++;
      if (calls === 2)
        expect((await other.execute(posting("during-historical-read"))).result.disposition).toBe(
          "committed",
        );
    };
    const captured = await f.ledger.readAt(1n);
    expect(captured.head).toEqual(first.head);
    expect(captured.aggregate.state.journals.length).toBe(0);
    expect((await f.ledger.read()).head.sequence).toBe("2");
  } finally {
    f.db.close();
  }
});

for (const format of [LEDGER_FORMAT, COMPACT_LEDGER_FORMAT] as const)
  test(`L11: ${format} SQL recovery preserves pre-repair rejection across inventory policy upgrade`, async () => {
    const raw = (
      await Bun.file(
        new URL("../../kernel/test/data/inventory-adjustment-legacy.json", import.meta.url),
      ).text()
    ).trim();
    const decoded = decodeDurableBook(raw);
    if (decoded.disposition !== "decoded") throw new Error(decoded.message);
    const legacy = decoded.aggregate;
    const config = legacy.state.configurationSnapshots[0];
    if (config === undefined) throw new Error("Missing historical configuration");
    const f = fixture(legacy.state.identity.bookId, format);
    try {
      await f.ledger.provision({
        state: createBookState(
          legacy.state.identity,
          config.periods,
          config.admissionSnapshot,
          config.policies,
          config.quantizationPolicies,
          config.accountingPolicySnapshot.policies,
          config.effectiveAt,
        ),
        protocol: createBookProtocolState(),
      });
      for (const retained of legacy.protocol.retainedResults) {
        const receipt = await f.ledger.execute(retained.command);
        expect(receipt.result.resultHash).toEqual(retained.resultHash);
      }
      expect(encodeDurableBook((await f.open().read()).aggregate)).toBe(raw);
      const old = legacy.protocol.retainedResults[3];
      if (old?.command.type !== "adjustInventoryValue")
        throw new Error("Missing historical command");
      const originalPolicy = config.accountingPolicySnapshot.policies.find(
        (policy) => policy.kind === "inventoryValueAdjustment",
      );
      if (originalPolicy?.kind !== "inventoryValueAdjustment")
        throw new Error("Missing historical policy");
      const version = semanticVersion("1.0.1");
      const updatedPolicy = {
        ...originalPolicy,
        version,
        validFrom: instant("2026-01-16T00:00:00Z"),
        algorithmVersion: INVENTORY_VALUE_ADJUSTMENT_ALGORITHM_VERSION,
        capability: {
          ...originalPolicy.capability,
          implementationVersion: INVENTORY_VALUE_ADJUSTMENT_ALGORITHM_VERSION,
        },
      };
      const times = {
        issuedAt: instant("2026-01-16T14:00:00Z"),
        completedAt: instant("2026-01-16T14:00:00Z"),
        committedAt: instant("2026-01-16T14:00:00Z"),
      };
      const upgraded = await f.ledger.execute(
        sealCommand({
          id: commandId("ledger-value-upgrade"),
          type: "replaceConfiguration",
          protocolVersion: semanticVersion("1.0.0"),
          actorId: old.command.actorId,
          bookId: legacy.state.identity.bookId,
          expectedBookRevision: 3n,
          expectedConfigurationRevision: 0n,
          effectiveOn: localDate("2026-01-16"),
          ...times,
          periods: config.periods,
          admissionSnapshot: config.admissionSnapshot,
          policies: config.policies,
          quantizationPolicies: config.quantizationPolicies,
          accountingPolicies: config.accountingPolicySnapshot.policies.map((policy) =>
            policy === originalPolicy ? updatedPolicy : policy,
          ),
        }),
      );
      expect(upgraded.result.disposition).toBe("committed");
      const command = sealCommand({
        ...old.command,
        id: commandId("ledger-value-fixed"),
        expectedBookRevision: 4n,
        ...times,
        request: {
          ...old.command.request,
          id: inventoryValueAdjustmentId("ledger-value-fixed"),
          generatedEffectKey: "ledger-value-fixed:journal:0" as never,
          policyVersion: version,
          policyEffectiveAt: instant("2026-01-16T00:00:00Z"),
          effectiveOn: localDate("2026-01-16"),
          derivation: { ...old.command.request.derivation, policyVersion: version },
        },
      });
      const accepted = await f.open().execute(command);
      expect(accepted.result.disposition).toBe("committed");
      expect(accepted.outcomeSequence).toBe(6n);
      const restarted = f.open();
      const rejectedRetry = await restarted.execute(old.command);
      expect(rejectedRetry.outcomeSequence).toBe(4n);
      expect(rejectedRetry.result.disposition).toBe("replayed");
      expect(rejectedRetry.originalResult?.disposition).toBe("rejected");
      expect(rejectedRetry.result.resultHash.digest).toBe(
        "bd43ade0477fab46033ed0172eb8a98f9e26c27d8f990871ee564a89c9a81e4b",
      );
      expect((await restarted.execute(command)).originalResult).toEqual(accepted.result);
      const final = await restarted.read();
      expect(final.head.sequence).toBe("6");
      expect(encodeDurableBook((await restarted.readAt(4n)).aggregate)).toBe(raw);
      expect(
        final.aggregate.state.lotHoldings.map((holding) => holding.remainingTotalBasis.toString()),
      ).toEqual(["11/1", "10/1"]);
    } finally {
      f.db.close();
    }
  });

test("L01-L03: provision, post, reject, restart and replay exact retained outcomes", async () => {
  const f = fixture();
  try {
    const first = await f.ledger.provision(genesis());
    expect(await f.ledger.provision(genesis())).toEqual(first);
    const active = await f.ledger.execute(activation());
    expect(active.result.disposition).toBe("committed");
    const accepted = await f.ledger.execute(posting());
    expect(accepted.result.disposition).toBe("committed");
    const rejected = await f.ledger.execute(posting("unbalanced", 2n, false));
    expect(rejected.result.disposition).toBe("rejected");
    expect(rejected.outcomeSequence).toBe(3n);
    await f.ledger.execute(posting("later", 2n));
    const restarted = f.open();
    expect((await restarted.execute(posting())).originalResult).toEqual(accepted.result);
    const retry = await restarted.execute(posting("unbalanced", 2n, false));
    expect(retry.result.disposition).toBe("replayed");
    expect(retry.originalResult).toEqual(rejected.result);
    expect(retry.outcomeSequence).toBe(3n);
    expect((await restarted.read()).head.sequence).toBe("4");
    expect((await restarted.read()).aggregate.state.journals).toHaveLength(2);
  } finally {
    f.db.close();
  }
});

test("L04-L06: identity races and stale financial revisions retain separate outcomes", async () => {
  const f = fixture();
  try {
    await f.ledger.provision(genesis());
    await f.ledger.execute(activation());
    const pair = await Promise.all([
      f.ledger.execute(posting("same")),
      f.ledger.execute(posting("same")),
    ]);
    expect(pair.map((r) => r.result.disposition)).toEqual(["committed", "replayed"]);
    const conflict = await f.ledger.execute(posting("same", 2n));
    expect(conflict.result.disposition).toBe("rejected");
    expect(conflict.outcomeSequence).toBeNull();
    const stale = await Promise.all([
      f.ledger.execute(posting("stale-a")),
      f.ledger.execute(posting("stale-b")),
    ]);
    expect(stale.map((r) => r.result.disposition)).toEqual(["rejected", "rejected"]);
    expect(stale.map((r) => r.outcomeSequence)).toEqual([3n, 4n]);
    const clients = await Promise.all([
      f.open().execute(posting("client-a", 2n)),
      f.open().execute(posting("client-b", 2n)),
    ]);
    expect(clients.map((r) => r.result.disposition).sort()).toEqual(["committed", "rejected"]);
    expect((await f.open().read()).head.sequence).toBe("6");
  } finally {
    f.db.close();
  }
});

for (const afterSql of [
  "INSERT INTO ledger_outcomes",
  "INSERT INTO ledger_chunks",
  "UPDATE ledger_metadata",
]) {
  test(`L07: rollback after ${afterSql}`, async () => {
    const f = fixture();
    try {
      await f.ledger.provision(genesis());
      await f.ledger.execute(activation());
      const before = await f.ledger.read();
      f.faults.afterSql = afterSql;
      await expect(f.ledger.execute(posting())).rejects.toThrow("Injected transaction failure");
      f.faults.afterSql = "";
      expect(await f.open().read()).toEqual(before);
      expect((await f.ledger.execute(posting())).result.disposition).toBe("committed");
    } finally {
      f.db.close();
    }
  });
}

test("L09: an uncertain acknowledgement recovers the persisted outcome before retry", async () => {
  const f = fixture();
  try {
    await f.ledger.provision(genesis());
    await f.ledger.execute(activation());
    const storage = {
      objectId: f.storage.objectId,
      load: f.storage.load.bind(f.storage),
      provision: f.storage.provision.bind(f.storage),
      sync: () => f.storage.sync(),
      commitTransition: (...args: Parameters<SqliteBookStorage["commitTransition"]>) => {
        f.storage.commitTransition(...args);
        f.faults.sync = true;
      },
    };
    const ledger = new ProductionLedger(storage, {
      tenantId: "tenant",
      bookId: BOOK,
      objectId: "object",
    });
    await expect(ledger.execute(posting())).rejects.toThrow("Uncertain durability");
    const replay = await ledger.execute(posting());
    expect(replay.result.disposition).toBe("replayed");
    expect(replay.outcomeSequence).toBe(2n);
  } finally {
    f.db.close();
  }
});

for (const [name, damage] of [
  ["missing suffix", "DELETE FROM ledger_outcomes WHERE sequence = '2'"],
  ["corrupt chunk", "UPDATE ledger_chunks SET bytes = x'00' WHERE record_id = '2'"],
  ["missing metadata", "DELETE FROM ledger_metadata"],
  ["unsupported format", "UPDATE ledger_metadata SET format = 'unknown'"],
] as const) {
  test(`L10: ${name} fails closed`, async () => {
    const f = fixture();
    try {
      await f.ledger.provision(genesis());
      await f.ledger.execute(activation());
      await f.ledger.execute(posting());
      f.db.exec(damage);
      await expect(f.open().read()).rejects.toThrow();
      await expect(f.open().provision(genesis())).rejects.toThrow();
    } finally {
      f.db.close();
    }
  });
}

test("L01: tenant and actual object identity are checked before replay", async () => {
  const f = fixture();
  try {
    expect(
      () =>
        new ProductionLedger(f.storage, { tenantId: "tenant", bookId: BOOK, objectId: "other" }),
    ).toThrow();
    await f.ledger.provision(genesis());
    await f.ledger.execute(activation());
    const other = new ProductionLedger(f.storage, {
      tenantId: "other",
      bookId: BOOK,
      objectId: "object",
    });
    await expect(other.execute(activation())).rejects.toThrow("ledger_identity_mismatch");
    const direct = executeBookCommand(genesis().state, genesis().protocol, activation());
    expect(encodeDurableBook((await f.ledger.read()).aggregate)).toBe(
      encodeDurableBook({ state: direct.state, protocol: direct.protocol }),
    );
  } finally {
    f.db.close();
  }
});

test("L01/L12: explicit provisioning rejects changed genesis and oversize records", async () => {
  const f = fixture();
  try {
    await expect(f.ledger.read()).rejects.toThrow("ledger_not_provisioned");
    await f.ledger.provision(genesis());
    await expect(f.ledger.provision(genesis("Other cash name"))).rejects.toThrow(
      "ledger_genesis_mismatch",
    );
    expect(() => f.ledger.provision(genesis("x".repeat(1_048_576)))).toThrow(
      "ledger_capacity_exceeded",
    );
    expect((await f.ledger.read()).head.sequence).toBe("0");
  } finally {
    f.db.close();
  }
});

test("L12: multibyte UTF-8 spans multiple exact, digested chunks", async () => {
  const f = fixture();
  try {
    const initial = genesis("€😀".repeat(15_000));
    await f.ledger.provision(initial);
    const count = f.db.query("SELECT COUNT(*) AS count FROM ledger_chunks").get() as {
      count: number;
    };
    expect(count.count).toBeGreaterThan(1);
    expect(encodeDurableBook((await f.open().read()).aggregate)).toBe(encodeDurableBook(initial));
  } finally {
    f.db.close();
  }
});

test("L04: caller mutation cannot change a queued command", async () => {
  const f = fixture();
  try {
    await f.ledger.provision(genesis());
    await f.ledger.execute(activation());
    const original = posting();
    if (original.type !== "postJournal") throw new Error("Expected post fixture");
    const command = {
      ...original,
      resolved: { ...original.resolved, journal: { ...original.resolved.journal } },
    };
    const submitted = f.ledger.execute(command);
    command.resolved.journal.narration = "Changed after submission";
    expect((await submitted).result.disposition).toBe("committed");
    expect((await f.ledger.execute(original)).result.disposition).toBe("replayed");
  } finally {
    f.db.close();
  }
});

test("L12: accessors, unsupported values and oversized requests cannot claim an outcome", async () => {
  const f = fixture();
  try {
    await f.ledger.provision(genesis());
    await f.ledger.execute(activation());
    let invoked = false;
    const accessor = {
      ...posting(),
      get extra() {
        invoked = true;
        return "unsafe";
      },
    };
    expect(() => f.ledger.execute(accessor)).toThrow("ledger_command_invalid");
    expect(invoked).toBe(false);
    expect(() => f.ledger.execute({ ...posting(), extra: 1 } as unknown as BookCommand)).toThrow(
      "ledger_command_invalid",
    );
    const original = posting();
    if (original.type !== "postJournal") throw new Error("Expected post fixture");
    const large = sealCommand({
      ...original,
      resolved: {
        ...original.resolved,
        journal: { ...original.resolved.journal, narration: "x".repeat(262_145) },
      },
    });
    expect(() => f.ledger.execute(large)).toThrow("ledger_capacity_exceeded");
    expect((await f.ledger.read()).head.sequence).toBe("1");
  } finally {
    f.db.close();
  }
});

test("L10: a missing rejection-only suffix is detected even after its chunks are removed", async () => {
  const f = fixture();
  try {
    await f.ledger.provision(genesis());
    await f.ledger.execute(activation());
    await f.ledger.execute(posting("reject", 0n));
    f.db.exec(
      "DELETE FROM ledger_outcomes WHERE sequence = '2'; DELETE FROM ledger_chunks WHERE record_id = '2';",
    );
    await expect(f.open().read()).rejects.toThrow("recovery_head_mismatch");
  } finally {
    f.db.close();
  }
});

test("L06: an intervening rejection invalidates the full head even without a financial change", async () => {
  const f = fixture();
  try {
    await f.ledger.provision(genesis());
    await f.ledger.execute(activation());
    const scope = { tenantId: "tenant", bookId: BOOK, objectId: "object" };
    const current = await f.ledger.read();
    const competing = executeBookCommand(
      current.aggregate.state,
      current.aggregate.protocol,
      posting("other-rejection", 0n),
    );
    expect(competing.result.disposition).toBe("rejected");
    const record = outcomeRecord(
      scope,
      current.head,
      competing,
      competing.result,
      "other-rejection",
    );
    let attempts = 0;
    const storage = {
      objectId: f.storage.objectId,
      load: f.storage.load.bind(f.storage),
      provision: f.storage.provision.bind(f.storage),
      sync: f.storage.sync.bind(f.storage),
      commitTransition: (...args: Parameters<SqliteBookStorage["commitTransition"]>) => {
        if (attempts++ === 0) f.storage.commitTransition(current.head, record);
        f.storage.commitTransition(...args);
      },
    };
    const ledger = new ProductionLedger(storage, scope);
    const receipt = await ledger.execute(posting("client", 0n));
    expect(attempts).toBe(2);
    expect(receipt.result.disposition).toBe("rejected");
    expect(receipt.outcomeSequence).toBe(3n);
    expect(receipt.head.bookRevision).toBe(current.head.bookRevision);
    expect(
      (await f.open().read()).aggregate.protocol.retainedResults.at(-1)?.command
        .expectedBookRevision,
    ).toBe(0n);
  } finally {
    f.db.close();
  }
});

test("L03/L09: durability blocks the receipt and subsequent queued reads", async () => {
  const f = fixture();
  const committed = Promise.withResolvers<void>();
  const durable = Promise.withResolvers<void>();
  let pending = false;
  try {
    await f.ledger.provision(genesis());
    const storage = {
      objectId: f.storage.objectId,
      load: f.storage.load.bind(f.storage),
      provision: f.storage.provision.bind(f.storage),
      async sync() {
        if (pending) await durable.promise;
      },
      commitTransition: (...args: Parameters<SqliteBookStorage["commitTransition"]>) => {
        f.storage.commitTransition(...args);
        pending = true;
        committed.resolve();
      },
    };
    const ledger = new ProductionLedger(storage, {
      tenantId: "tenant",
      bookId: BOOK,
      objectId: "object",
    });
    let responded = false;
    const write = ledger.execute(activation()).then((receipt) => {
      responded = true;
      return receipt;
    });
    await committed.promise;
    let readReturned = false;
    const read = ledger.read().then((result) => {
      readReturned = true;
      return result;
    });
    await Promise.resolve();
    expect(responded).toBe(false);
    expect(readReturned).toBe(false);
    durable.resolve();
    expect((await write).result.disposition).toBe("committed");
    expect((await read).head.sequence).toBe("1");
  } finally {
    durable.resolve();
    f.db.close();
  }
});
