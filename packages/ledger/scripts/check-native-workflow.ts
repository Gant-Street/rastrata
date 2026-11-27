/** Minimum production command acceptance, not a complete production certificate.
 * Deliberately outside the fast development suite: unsupported native operations
 * must fail the RELEASE gate, never become skips or successful rejection tests. */
import assert from "node:assert/strict";
import { Database } from "bun:sqlite";
import {
  commandId,
  ExactRational,
  closePackageId,
  fiscalPeriodId,
  hashCanonical,
  instant,
  sealCommand,
  type BookCommand,
} from "@rastrata/kernel";
import { NativeLedger } from "../src/native-ledger.ts";
import { consolidationWorkflow } from "../test/commercial-workflow.ts";
import { nativeInventoryWorkflow, freeInventoryCycle } from "../test/native-inventory-workflow.ts";
import { SqliteLedgerRepository } from "../src/sqlite-ledger-repository.ts";
import { evaluateOutcomePayload } from "../src/outcome-payload.ts";
import { verifyNativeLedgerCopy } from "../src/native-ledger-copy.ts";
import {
  BOOK,
  CASH,
  activation,
  genesis,
  posting,
  openItemRecognition,
  settlementPayment,
  unallocatedPayment,
  applyExistingPayment,
} from "../test/fixtures.ts";
import {
  taxWorkflow,
  allocationAndTaxWorkflow,
  workflowTerminationCommand,
  currencyRecoveryWorkflow,
} from "../test/accounting-workflows.ts";

const core = activation();
const close = (id: string, revision: bigint): BookCommand =>
  sealCommand({
    type: "closePeriod",
    id: commandId(id),
    bookId: BOOK,
    actorId: core.actorId,
    protocolVersion: core.protocolVersion,
    expectedBookRevision: revision,
    issuedAt: instant("2026-02-01T00:00:00Z"),
    completedAt: instant("2026-02-01T00:00:01Z"),
    committedAt: instant("2026-02-01T00:00:02Z"),
    periodId: fiscalPeriodId("january"),
    closePackageId: closePackageId(id),
    reason: "Month-end close",
    reportPopulationHash: hashCanonical({ acceptance: "january-report-population" }),
    reportingPolicySnapshotHash: hashCanonical({ acceptance: "reporting-policy" }),
  });
const atClose = (command: BookCommand) =>
  sealCommand({
    ...command,
    issuedAt: instant("2026-02-01T00:00:00Z"),
    completedAt: instant("2026-02-01T00:00:01Z"),
    committedAt: instant("2026-02-01T00:00:02Z"),
  });
const reopen: BookCommand = sealCommand({
  type: "reopenPeriod",
  id: commandId("reopen"),
  bookId: BOOK,
  actorId: core.actorId,
  protocolVersion: core.protocolVersion,
  expectedBookRevision: 3n,
  issuedAt: instant("2026-02-01T00:00:00Z"),
  completedAt: instant("2026-02-01T00:00:01Z"),
  committedAt: instant("2026-02-01T00:00:02Z"),
  periodId: fiscalPeriodId("january"),
  reason: "Authorized correction window",
});
const steps = [
  { command: activation(), disposition: "committed" },
  { command: openItemRecognition("sale", 1n), disposition: "committed" },
  { command: close("first-close", 2n), disposition: "committed" },
  { command: atClose(posting("closed-period", 3n)), disposition: "rejected" },
  { command: reopen, disposition: "committed" },
  { command: atClose(posting("after-reopen", 4n)), disposition: "committed" },
  { command: close("second-close", 5n), disposition: "committed" },
];

// Establish actual full-kernel expected outcomes FIRST. A broken acceptance
// fixture must not be confused with missing production command support.
let oracle = genesis();
const expected = steps.map(({ command, disposition }) => {
  const result = evaluateOutcomePayload(oracle, command);
  assert.equal(
    result.transition.result.disposition,
    disposition,
    `Invalid acceptance fixture: ${command.id}`,
  );
  if (command.id === "closed-period")
    assert.ok(
      result.transition.result.diagnostics.some(
        (diagnostic) => diagnostic.code === "fiscal_period_admission",
      ),
    );
  assert.ok(result.encoded);
  oracle = { state: result.transition.state, protocol: result.transition.protocol };
  return result.encoded;
});
assert.equal(oracle.state.closePackages.length, 2);
assert.equal(oracle.state.bookRevision, 6n);
assert.equal(oracle.state.latestPostingSequence, 2n);
assert.equal(oracle.state.accountingState.openItems[0]?.bookValue.toString(), "100/1");
assert.deepEqual(
  oracle.state.journals.map((booked) => booked.journal.id),
  ["sale", "after-reopen"],
);
assert.deepEqual(
  oracle.state.closePackages.map((close) => close.cycle),
  [1n, 2n],
);
assert.deepEqual(
  oracle.state.periodTransitions.map((transition) => transition.kind),
  ["close", "reopen", "close"],
);

const db = new Database(":memory:");
const stagingDb = new Database(":memory:");
function repository(database: Database, objectId: string) {
  database.exec("PRAGMA foreign_keys=ON");
  return new SqliteLedgerRepository(
    {
      sql: {
        exec: (sql, ...bindings) =>
          database
            .query(sql)
            .all(
              ...bindings.map((binding) =>
                binding instanceof ArrayBuffer ? new Uint8Array(binding) : binding,
              ),
            ) as Record<string, unknown>[],
      },
      transactionSync: (operation) => database.transaction(operation)(),
      async sync() {}, // In-memory workflow acceptance, NOT a durability drill.
    },
    {
      tenantId: "production-acceptance",
      bookId: BOOK,
      namespaceId: "acceptance",
      generation: "0",
      objectId,
    },
    objectId,
    () => ({ fence: "0", pending: false }),
  );
}
try {
  for (const [index, step] of steps.entries()) {
    // Reconstruct the repository and evaluator to exclude owner-memory state.
    const source = repository(db, "source");
    const ledger = new NativeLedger(source);
    try {
      if (index === 0) await ledger.provision(genesis(), step.command);
      else await ledger.execute(step.command);
    } catch (cause) {
      throw new Error(
        `Native production acceptance failed at ${step.command.type} (${step.command.id})`,
        { cause },
      );
    }
    const retained = await source.transact((view) => ({
      write: false,
      value: view.outcome(step.command.id),
    }));
    assert.equal(retained.value?.encoded, expected[index], `Native mismatch: ${step.command.id}`);
    assert.equal(retained.value?.head.sequence, String(index + 1));
    if (index > 0) {
      const retry = await ledger.execute(step.command);
      assert.equal(retry.value.result.disposition, "replayed");
      assert.equal(retry.value.outcomeSequence, String(index + 1));
    }
  }
  const source = repository(db, "source");
  const tip = (await source.transact((view) => ({ write: false, value: view.head }))).value;
  const copy = await verifyNativeLedgerCopy(source, repository(stagingDb, "staging"), tip);
  console.log(
    JSON.stringify({
      status: "passed",
      scope: "minimum native open-item and close/reopen workflow only",
      outcomes: steps.length,
      verifiedFacts: copy.verifiedFacts,
    }),
  );
} finally {
  db.close();
  stagingDb.close();
}

const payments = new Database(":memory:");
const paymentCopy = new Database(":memory:");
try {
  const invoice = openItemRecognition("invoice", 1n);
  const commands = [
    activation(),
    invoice,
    settlementPayment("first-payment", 2n, [{ openItemId: invoice.request.value.id, amount: 40n }]),
    settlementPayment("final-payment", 3n, [{ openItemId: invoice.request.value.id, amount: 60n }]),
    settlementPayment("over-payment", 4n, [{ openItemId: invoice.request.value.id, amount: 1n }]),
  ];
  let oracle = genesis();
  for (const [index, command] of commands.entries()) {
    const expected = evaluateOutcomePayload(oracle, command);
    assert.equal(expected.transition.result.disposition, index === 4 ? "rejected" : "committed");
    const source = repository(payments, "payment-source");
    const ledger = new NativeLedger(source);
    if (command.type === "activateBook") await ledger.provision(genesis(), command);
    else await ledger.execute(command);
    assert.equal(
      (await source.transact((view) => ({ write: false, value: view.outcome(command.id) }))).value
        ?.encoded,
      expected.encoded,
    );
    oracle = { state: expected.transition.state, protocol: expected.transition.protocol };
  }
  assert.deepEqual(
    oracle.state.accountingState.settlementAllocations.map((item) =>
      item.allocatedBookValue.toString(),
    ),
    ["40/1", "60/1"],
  );
  const source = repository(payments, "payment-source");
  const tip = await source.transact((view) => ({ write: false, value: view.head }));
  const copy = await verifyNativeLedgerCopy(
    source,
    repository(paymentCopy, "payment-staging"),
    tip.head,
  );
  console.log(
    JSON.stringify({
      status: "passed",
      scope: "native partial-payment conservation",
      outcomes: commands.length,
      verifiedFacts: copy.verifiedFacts,
    }),
  );
} finally {
  payments.close();
  paymentCopy.close();
}

// A payment may arrive before an invoice and be applied in later commands.
// Compare every retained outcome to the kernel, then independently assert the
// literal amounts, single payment identity and absence of duplicate journals.
const deferredDb = new Database(":memory:");
const deferredCopy = new Database(":memory:");
try {
  const payment = unallocatedPayment("prepayment", 1n);
  const first = openItemRecognition("invoice-a", 2n);
  const second = openItemRecognition("invoice-b", 3n);
  const commands = [
    activation(),
    payment,
    first,
    second,
    applyExistingPayment(payment, "apply-40", 4n, [
      { openItemId: first.request.value.id, amount: 40n },
    ]),
    applyExistingPayment(payment, "apply-60", 5n, [
      { openItemId: second.request.value.id, amount: 60n },
    ]),
    applyExistingPayment(payment, "over-apply", 6n, [
      { openItemId: second.request.value.id, amount: 1n },
    ]),
  ];
  let oracle = genesis();
  for (const [index, command] of commands.entries()) {
    const expected = evaluateOutcomePayload(oracle, command);
    assert.equal(expected.transition.result.disposition, index === 6 ? "rejected" : "committed");
    const source = repository(deferredDb, "deferred-source");
    const ledger = new NativeLedger(source);
    if (command.type === "activateBook") await ledger.provision(genesis(), command);
    else await ledger.execute(command);
    assert.equal(
      (await source.transact((view) => ({ write: false, value: view.outcome(command.id) }))).value
        ?.encoded,
      expected.encoded,
    );
    if (index > 0) {
      const retry = await new NativeLedger(repository(deferredDb, "deferred-source")).execute(
        command,
      );
      assert.equal(retry.value.result.disposition, "replayed");
      assert.equal(retry.value.outcomeSequence, String(index + 1));
    }
    oracle = { state: expected.transition.state, protocol: expected.transition.protocol };
  }
  assert.equal(oracle.state.accountingState.settlements.length, 1);
  assert.equal(oracle.state.latestPostingSequence, 3n);
  assert.equal(oracle.state.bookRevision, 6n);
  assert.deepEqual(
    oracle.state.accountingState.settlementAllocations.map((edge) => [
      edge.allocatedSettlementBookValue?.toString(),
      edge.appliedAt,
    ]),
    [
      ["40/1", "2026-01-21T14:00:00Z"],
      ["60/1", "2026-01-21T14:00:00Z"],
    ],
  );
  const source = repository(deferredDb, "deferred-source");
  const totals = await source.transact((view) => ({
    write: false,
    value: view.facts([
      { collection: "settlementAllocatedTotals", key: payment.request.settlement.id },
    ])[0],
  }));
  assert.ok(totals.value);
  assert.deepEqual(JSON.parse(totals.value.encoded), {
    bookValue: "100/1",
    quantity: "100/1",
    allocations: "2",
  });
  const copy = await verifyNativeLedgerCopy(
    source,
    repository(deferredCopy, "deferred-staging"),
    totals.head,
  );
  console.log(
    JSON.stringify({
      status: "passed",
      scope: "native deferred payment conservation",
      outcomes: commands.length,
      verifiedFacts: copy.verifiedFacts,
    }),
  );
} finally {
  deferredDb.close();
  deferredCopy.close();
}

const tax = taxWorkflow();
const taxDb = new Database(":memory:");
const taxCopy = new Database(":memory:");
try {
  const source = repository(taxDb, "tax-source");
  const ledger = new NativeLedger(source);
  let state = tax.initial;
  const commands = [
    activation(),
    tax.command,
    sealCommand({ ...tax.command, id: commandId("duplicate-tax"), expectedBookRevision: 2n }),
  ];
  for (const [index, command] of commands.entries()) {
    const expected = evaluateOutcomePayload(state, command);
    assert.equal(expected.transition.result.disposition, index === 2 ? "rejected" : "committed");
    if (index === 0) await ledger.provision(tax.initial, command);
    else await new NativeLedger(repository(taxDb, "tax-source")).execute(command);
    const retained = await source.transact((view) => ({
      write: false,
      value: view.outcome(command.id),
    }));
    assert.equal(retained.value?.encoded, expected.encoded);
    assert.equal(retained.head.sequence, String(index + 1));
    state = { state: expected.transition.state, protocol: expected.transition.protocol };
  }
  assert.equal(state.state.accountingState.taxDeterminations.length, 1);
  assert.deepEqual(
    state.state.journals[0]?.journal.postings.map((posting) =>
      posting.bookValue.amount.toRational().toString(),
    ),
    ["155/1", "31/2", "-341/2"],
  );
  const head = await source.transact((view) => ({ write: false, value: view.head }));
  const verified = await verifyNativeLedgerCopy(
    source,
    repository(taxCopy, "tax-staging"),
    head.head,
  );
  console.log(
    JSON.stringify({
      status: "passed",
      scope: "native tax workflow",
      outcomes: commands.length,
      verifiedFacts: verified.verifiedFacts,
    }),
  );
} finally {
  taxDb.close();
  taxCopy.close();
}

{
  const scenario = currencyRecoveryWorkflow();
  const database = new Database(":memory:"),
    staging = new Database(":memory:");
  try {
    const source = repository(database, "fx-source");
    let oracle = scenario.initial;
    for (const [index, command] of scenario.commands.entries()) {
      const expected = evaluateOutcomePayload(oracle, command);
      assert.equal(
        expected.transition.result.disposition,
        index === 5 || index === 7 ? "rejected" : "committed",
      );
      const ledger = new NativeLedger(repository(database, "fx-source"));
      if (command.type === "activateBook") await ledger.provision(scenario.initial, command);
      else await ledger.execute(command);
      const retained = await source.transact((view) => ({
        write: false,
        value: view.outcome(command.id),
      }));
      assert.equal(retained.value?.encoded, expected.encoded);
      oracle = { state: expected.transition.state, protocol: expected.transition.protocol };
    }
    assert.equal(oracle.state.accountingState.remeasurementResults.length, 2);
    assert.equal(oracle.state.accountingState.remeasurementReversals.length, 2);
    const tip = await source.transact((view) => ({ write: false, value: view.head }));
    const copy = await verifyNativeLedgerCopy(source, repository(staging, "fx-staging"), tip.head);
    console.log(
      JSON.stringify({
        status: "passed",
        scope: "native FX and next-day reversal recovery",
        outcomes: scenario.commands.length,
        verifiedFacts: copy.verifiedFacts,
      }),
    );
  } finally {
    database.close();
    staging.close();
  }
}

for (const ownership of [ExactRational.of(1n, 1n), ExactRational.of(4n, 5n)]) {
  const scenario = consolidationWorkflow(ownership);
  const database = new Database(":memory:"),
    staging = new Database(":memory:");
  try {
    const source = repository(database, "consolidation-source");
    let oracle = scenario.initial;
    for (const command of scenario.commands) {
      const expected = evaluateOutcomePayload(oracle, command);
      assert.equal(expected.transition.result.disposition, "committed");
      const ledger = new NativeLedger(repository(database, "consolidation-source"));
      if (command.type === "activateBook") await ledger.provision(scenario.initial, command);
      else await ledger.execute(command);
      const retained = await source.transact((view) => ({
        write: false,
        value: view.outcome(command.id),
      }));
      assert.equal(retained.value?.encoded, expected.encoded);
      oracle = { state: expected.transition.state, protocol: expected.transition.protocol };
    }
    const cash = oracle.state.journals
      .flatMap((row) => row.journal.postings)
      .filter((row) => row.accountId === CASH)
      .reduce((total, row) => total.add(row.bookValue.amount.toRational()), ExactRational.zero());
    assert.equal(cash.toString(), "50/1");
    const tip = await source.transact((view) => ({ write: false, value: view.head }));
    const copy = await verifyNativeLedgerCopy(
      source,
      repository(staging, "consolidation-staging"),
      tip.head,
    );
    console.log(
      JSON.stringify({
        status: "passed",
        scope: "native consolidation",
        ownership: ownership.toString(),
        outcomes: 2,
        verifiedFacts: copy.verifiedFacts,
      }),
    );
  } finally {
    database.close();
    staging.close();
  }
}

for (const free of [false, true]) {
  const scenario = await nativeInventoryWorkflow();
  const commands = free
    ? [scenario.commands[0], ...freeInventoryCycle(scenario.commands, "free", 1n)]
    : scenario.commands;
  const database = new Database(":memory:"),
    staging = new Database(":memory:");
  try {
    const source = repository(database, "inventory-source");
    let oracle = scenario.initial;
    for (const command of commands) {
      assert.ok(command);
      const expected = evaluateOutcomePayload(oracle, command);
      assert.equal(expected.transition.result.disposition, "committed");
      const ledger = new NativeLedger(repository(database, "inventory-source"));
      if (command.type === "activateBook") await ledger.provision(scenario.initial, command);
      else await ledger.execute(command);
      const retained = await source.transact((view) => ({
        write: false,
        value: view.outcome(command.id),
      }));
      assert.equal(retained.value?.encoded, expected.encoded);
      oracle = { state: expected.transition.state, protocol: expected.transition.protocol };
    }
    assert.deepEqual(
      oracle.state.lotHoldings.map((holding) => holding.remainingQuantity.toString()),
      ["0/1", "0/1", "0/1"],
    );
    assert.equal(oracle.state.journals.length, free ? 0 : 2);
    const tip = await source.transact((view) => ({ write: false, value: view.head }));
    const copy = await verifyNativeLedgerCopy(
      source,
      repository(staging, "inventory-staging"),
      tip.head,
    );
    console.log(
      JSON.stringify({
        status: "passed",
        scope: "native owned acquisition and issue",
        quantityOnly: free,
        outcomes: commands.length,
        verifiedFacts: copy.verifiedFacts,
      }),
    );
  } finally {
    database.close();
    staging.close();
  }
}

for (const version of ["1.0.0", "1.1.0"] as const) {
  const scenario = allocationAndTaxWorkflow(version);
  const database = new Database(":memory:"),
    staging = new Database(":memory:");
  try {
    const source = repository(database, "allocation-source");
    let oracle = scenario.initial;
    const commands = [...scenario.commands, workflowTerminationCommand(scenario)];
    for (const command of commands) {
      const expected = evaluateOutcomePayload(oracle, command);
      assert.equal(expected.transition.result.disposition, "committed");
      const ledger = new NativeLedger(repository(database, "allocation-source"));
      if (command.type === "activateBook") await ledger.provision(scenario.initial, command);
      else await ledger.execute(command);
      const retained = await source.transact((view) => ({
        write: false,
        value: view.outcome(command.id),
      }));
      assert.equal(retained.value?.encoded, expected.encoded);
      oracle = { state: expected.transition.state, protocol: expected.transition.protocol };
    }
    assert.equal(oracle.state.accountingState.allocationSchedules.length, 2);
    assert.equal(oracle.state.accountingState.allocationRecognitions.length, 3);
    assert.equal(oracle.state.accountingState.allocationScheduleRevisions.length, 2);
    if (version === "1.1.0") {
      const total = oracle.state.journals
        .flatMap((booked) => booked.journal.postings)
        .filter((posting) => posting.accountId === scenario.accounts.prepaid)
        .reduce(
          (sum, posting) => sum.add(posting.bookValue.amount.toRational()),
          ExactRational.zero(),
        );
      assert.equal(total.toString(), "0/1", "Source carrying account must be completely cleared");
    }
    const tip = await source.transact((view) => ({ write: false, value: view.head }));
    const copy = await verifyNativeLedgerCopy(
      source,
      repository(staging, "allocation-staging"),
      tip.head,
    );
    console.log(
      JSON.stringify({
        status: "passed",
        scope: "native allocation lifecycle",
        version,
        outcomes: commands.length,
        verifiedFacts: copy.verifiedFacts,
      }),
    );
  } finally {
    database.close();
    staging.close();
  }
}
