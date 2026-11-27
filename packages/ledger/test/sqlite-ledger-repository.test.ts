import { expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import {
  encodeDurableBook,
  encodeBookRow,
  decodeBookRow,
  type DurableBookAggregate,
} from "@rastrata/kernel";
import {
  SqliteLedgerRepository,
  type NativeLedgerDecision,
  type NativeLedgerTransaction,
} from "../src/sqlite-ledger-repository.ts";
import { evaluateOutcomePayload } from "../src/outcome-payload.ts";
import {
  BOOK,
  genesis,
  chartGenesis,
  activation,
  posting,
  configuration,
  correction,
  closing,
  reopening,
  openItemRecognition,
  settlementPayment,
  unallocatedPayment,
  applyExistingPayment,
  CASH,
  INCOME,
} from "./fixtures.ts";
import {
  sealCommand,
  commandId,
  fiscalPeriodId,
  identifier,
  localDate,
  type BookCommand,
  type BookCommandResult,
  createBookState,
  accountId,
  policyId,
  hashAccountingPolicyArtifact,
  ExactRational,
  ExactDecimal,
  resolveJournal,
  instant,
  journalId,
  effectKey,
  createCanonicalPostingReference,
  canonicalPostingReferenceId,
  STRUCTURAL_SOURCE_IDENTITY_PROFILE,
  openItemId,
  remeasurementResultId,
  consolidationCompilationId,
} from "@rastrata/kernel";
import type { SqliteStorage } from "../src/sqlite.ts";
import { NativeLedger } from "../src/native-ledger.ts";
import type {
  NativeLedgerRepository,
  NativeLedgerReader,
} from "../src/native-ledger-repository.ts";
import { consolidationWorkflow } from "./commercial-workflow.ts";
import { readAllocatedMonetarySource } from "../src/native-settlement.ts";
import { nativeMoney, journalMoneyScopes, moneyScopeKeys } from "../src/native-money.ts";
import { verifyNativeLedgerCopy } from "../src/native-ledger-copy.ts";
import { createHash } from "node:crypto";
import { decodeStoredNativeOutcome } from "../src/native-outcome-storage.ts";
import type { LedgerQueueLimits } from "../src/serial-ledger-queue.ts";
import {
  taxWorkflow,
  workflowValue,
  allocationAndTaxWorkflow,
  workflowTerminationCommand,
  admissionFxWorkflow,
} from "./accounting-workflows.ts";

test("native money scopes keep exact balances and never turn a missing counter into zero", async () => {
  const f = fixture();
  try {
    const ledger = new NativeLedger(f.repository);
    await ledger.provision(genesis(), activation());
    const command = posting("money-source", 1n);
    if (command.type !== "postJournal") throw new Error("Expected journal fixture");
    const scope = journalMoneyScopes([command.resolved.journal])[0];
    if (!scope) throw new Error("Expected journal scope");
    expect(
      (
        await f.repository.transact((view) => ({
          write: false,
          value: nativeMoney(view).balance(scope).toString(),
        }))
      ).value,
    ).toBe("0/1");
    const committed = await ledger.execute(command);
    expect(committed.value.result.disposition).toBe("committed");
    expect(
      (
        await f.repository.transact((view) => ({
          write: false,
          value: nativeMoney(view).balance(scope).toString(),
        }))
      ).value,
    ).toBe("100/1");
    const key = moneyScopeKeys([scope]).find((key) => key.collection === "moneyScopeBalances");
    if (!key) throw new Error("Expected balance key");
    f.db
      .query("DELETE FROM ledger_native_facts WHERE identity = ?")
      .run(JSON.stringify([key.collection, key.key]));
    await expect(new NativeLedger(f.open()).execute(posting("missing-money", 2n))).rejects.toThrow(
      "native_ledger_money_scope_incomplete",
    );
    expect(
      (
        await f.repository.transact((view) => ({
          write: false,
          value: view.outcome("missing-money"),
        }))
      ).value,
    ).toBeNull();
    const retried = await new NativeLedger(f.open()).execute(command);
    expect(retried.value.result.disposition).toBe("replayed");
    expect(retried.value.result.resultHash).toEqual(committed.value.result.resultHash);
  } finally {
    f.db.close();
  }
});

for (const field of ["configuration", "opening", "activation"])
  test(`warm decoder cache still authenticates and invalidates changed ${field} bytes`, async () => {
    const f = fixture();
    try {
      const ledger = new NativeLedger(f.repository);
      await ledger.provision(genesis(), activation());
      await ledger.execute(posting("warm"));
      const identity = JSON.stringify(["current", field]);
      const original = f.db
        .query("SELECT body,digest FROM ledger_native_facts WHERE identity=?")
        .get(identity) as { body: string; digest: string };
      const changed = "{}";
      f.db.run("UPDATE ledger_native_facts SET body=? WHERE identity=?", [changed, identity]);
      await expect(ledger.execute(posting("bad-digest", 2n))).rejects.toThrow(
        "native_ledger_fact_corrupt",
      );
      f.db.run("UPDATE ledger_native_facts SET digest=? WHERE identity=?", [
        createHash("sha256").update(changed).digest("hex"),
        identity,
      ]);
      await expect(ledger.execute(posting("bad-shape", 2n))).rejects.toThrow(
        "native_ledger_current_state_corrupt",
      );
      f.db.run("UPDATE ledger_native_facts SET body=?,digest=? WHERE identity=?", [
        original.body,
        original.digest,
        identity,
      ]);
      const recovered = await ledger.execute(posting("recovered", 2n));
      expect(recovered.value.result.disposition).toBe("committed");
      expect(recovered.head.sequence).toBe("3");
    } finally {
      f.db.close();
    }
  });

test("native books without money projection require explicit migration, not zero backfill", async () => {
  const f = fixture();
  try {
    const ledger = new NativeLedger(f.repository);
    await ledger.provision(genesis(), activation());
    const old = "native-book-commands-v1";
    f.db
      .query(
        'UPDATE ledger_native_facts SET body=?,digest=? WHERE identity=\'["current","profile"]\'',
      )
      .run(old, createHash("sha256").update(old).digest("hex"));
    await expect(
      new NativeLedger(f.open()).execute(posting("old-money-profile", 1n)),
    ).rejects.toThrow("native_ledger_profile_unsupported");
    const observed = await f.repository.transact((view) => ({
      write: false,
      value: { head: view.head, outcome: view.outcome("old-money-profile") },
    }));
    expect(observed.value.head.bookRevision).toBe("1");
    expect(observed.value.outcome).toBeNull();
  } finally {
    f.db.close();
  }
});

test("native consolidation publishes exact group and NCI postings with immutable pins, atomic recovery and copy", async () => {
  for (const share of [ExactRational.of(1n, 1n), ExactRational.of(4n, 5n)]) {
    const scenario = consolidationWorkflow(share);
    const f = fixture(),
      staging = fixture("consolidation-copy");
    let oracle = scenario.initial;
    try {
      const activationResult = evaluateOutcomePayload(oracle, activation());
      oracle = {
        state: activationResult.transition.state,
        protocol: activationResult.transition.protocol,
      };
      await new NativeLedger(f.repository).provision(scenario.initial, activation());
      f.faults.statement = "INSERT INTO ledger_native_facts";
      await expect(new NativeLedger(f.open()).execute(scenario.command)).rejects.toThrow(
        "Injected SQL failure",
      );
      expect(f.db.query("SELECT count(*) AS n FROM ledger_native_outcomes").get()).toEqual({
        n: 1,
      });
      f.faults.lostReply = true;
      await expect(new NativeLedger(f.open()).execute(scenario.command)).rejects.toThrow(
        "Lost durability confirmation",
      );
      const expected = evaluateOutcomePayload(oracle, scenario.command);
      expect(expected.transition.result.disposition).toBe("committed");
      const retry = await new NativeLedger(f.open()).execute(scenario.command);
      expect(retry.value.result.disposition).toBe("replayed");
      expect(retry.value.originalResult).toEqual(expected.transition.result);
      oracle = { state: expected.transition.state, protocol: expected.transition.protocol };
      const generated = oracle.state.journals.at(-1)?.journal;
      if (generated === undefined) throw new Error("Missing consolidation journal");
      const balances = new Map<string, ExactRational>();
      for (const posting of generated.postings)
        balances.set(
          posting.accountId,
          (balances.get(posting.accountId) ?? ExactRational.zero()).add(
            posting.bookValue.amount.toRational(),
          ),
        );
      expect(balances.get(CASH)?.toString()).toBe("50/1");
      expect(balances.get(scenario.accounts.equity)?.toString()).toBe(
        share.equals(ExactRational.of(1n, 1n)) ? "-50/1" : "-40/1",
      );
      if (!share.equals(ExactRational.of(1n, 1n)))
        expect(balances.get(scenario.accounts.nci)?.toString()).toBe("-10/1");
      for (const command of [
        sealCommand({
          ...scenario.command,
          id: commandId("duplicate-compilation"),
          expectedBookRevision: oracle.state.bookRevision,
        }),
        sealCommand({
          ...scenario.command,
          id: commandId("stale-subsidiary"),
          expectedBookRevision: oracle.state.bookRevision,
          request: {
            ...scenario.command.request,
            sources: scenario.command.request.sources.map((source) => ({
              ...source,
              expectedRevision: source.revision + 1n,
            })),
          },
        }),
      ]) {
        const expected = evaluateOutcomePayload(oracle, command);
        expect(expected.transition.result.disposition).toBe("rejected");
        const actual = await new NativeLedger(f.open()).execute(command);
        expect(actual.value.result).toEqual(expected.transition.result);
        oracle = { state: expected.transition.state, protocol: expected.transition.protocol };
      }
      // A refreshed snapshot explicitly reverses the old compilation; it must
      // not silently accumulate two full subsidiary balances in the group book.
      const original = oracle.state.journals.at(-1);
      if (original === undefined) throw new Error("Missing compilation to refresh");
      const reverse = correction(original, "refresh-compilation", oracle.state.bookRevision);
      const reversed = evaluateOutcomePayload(oracle, reverse);
      expect(reversed.transition.result.disposition).toBe("committed");
      expect((await new NativeLedger(f.open()).execute(reverse)).value.result).toEqual(
        reversed.transition.result,
      );
      oracle = { state: reversed.transition.state, protocol: reversed.transition.protocol };
      const replacement = sealCommand({
        ...scenario.command,
        id: commandId("recompile"),
        expectedBookRevision: oracle.state.bookRevision,
        request: {
          ...scenario.command.request,
          id: consolidationCompilationId("replacement-compilation"),
        },
      });
      const replaced = evaluateOutcomePayload(oracle, replacement);
      expect(replaced.transition.result.disposition).toBe("committed");
      f.reset();
      const started = performance.now();
      const fresh = await new NativeLedger(f.open()).execute(replacement);
      const milliseconds = performance.now() - started;
      expect(fresh.value.result).toEqual(replaced.transition.result);
      expect(f.faults.statements.length).toBeLessThanOrEqual(8);
      console.info(
        JSON.stringify({
          nativeConsolidationFreshLocalSample: {
            ownership: share.toString(),
            sql: f.faults.statements.length,
            milliseconds,
          },
        }),
      );
      oracle = { state: replaced.transition.state, protocol: replaced.transition.protocol };
      const cash = oracle.state.journals
        .flatMap((row) => row.journal.postings)
        .filter((row) => row.accountId === CASH)
        .reduce((total, row) => total.add(row.bookValue.amount.toRational()), ExactRational.zero());
      expect(cash.toString()).toBe("50/1");
      expect(oracle.state.accountingState.consolidationCompilations).toHaveLength(2);
      const tip = await f.repository.transact((view) => ({ write: false, value: view.head }));
      const copy = await verifyNativeLedgerCopy(f.repository, staging.repository, tip.head);
      expect(copy.sourceHead).toEqual(tip.head);
    } finally {
      f.db.close();
      staging.db.close();
    }
  }
});

test("native FX persists exact results and independently discharges overdue reversals across restart and copy", async () => {
  for (const reverseOrder of [false, true]) {
    const scenario = admissionFxWorkflow();
    const f = fixture();
    const copy = fixture("fx-copy");
    let oracle = scenario.initial;
    const samples: { type: string; sql: number; milliseconds: number }[] = [];
    try {
      const active = evaluateOutcomePayload(oracle, activation());
      oracle = { state: active.transition.state, protocol: active.transition.protocol };
      await new NativeLedger(f.repository).provision(scenario.initial, activation());
      const apply = async (command: BookCommand, disposition: "committed" | "rejected") => {
        const expected = evaluateOutcomePayload(oracle, command);
        expect(expected.transition.result.disposition).toBe(disposition);
        if (expected.encoded === null) throw new Error("Missing retained FX outcome");
        f.reset();
        const started = performance.now();
        const actual = await new NativeLedger(f.open()).execute(command);
        if (command.type === "postCurrencyRemeasurement") {
          samples.push({
            type: command.request.reversalOf === undefined ? "measurement" : "reversal",
            sql: f.faults.statements.length,
            milliseconds: performance.now() - started,
          });
          expect(f.faults.statements.length).toBeLessThanOrEqual(24);
        }
        expect(actual.value.result).toEqual(expected.transition.result);
        const retained = await f.repository.transact((view) => ({
          write: false,
          value: view.outcome(command.id),
        }));
        expect(retained.value?.encoded).toBe(expected.encoded);
        oracle = { state: expected.transition.state, protocol: expected.transition.protocol };
        return actual;
      };
      for (const command of scenario.commands.slice(1)) await apply(command, "committed");
      const nextDay = (command: BookCommand) =>
        sealCommand({
          ...command,
          issuedAt: instant("2026-01-17T18:00:00Z"),
          completedAt: instant("2026-01-17T18:00:01Z"),
          committedAt: instant("2026-01-17T18:00:02Z"),
        });
      const measurements = [scenario.firstMeasurement, scenario.secondMeasurement];
      if (reverseOrder) measurements.reverse();
      for (const [index, measurement] of measurements.entries()) {
        await apply(nextDay(posting(`blocked-${index}`, oracle.state.bookRevision)), "rejected");
        const template = scenario.reverse(measurement, oracle.state.bookRevision);
        const command = nextDay(
          sealCommand({
            ...template,
            request: {
              ...template.request,
              governedAt: instant("2026-01-17T18:00:00Z"),
              effectiveOn: localDate("2026-01-17"),
              valuationPath: {
                ...template.request.valuationPath,
                effectiveAt: instant("2026-01-17T18:00:00Z"),
              },
            },
          }),
        );
        if (index === 0) {
          if (reverseOrder) f.faults.lostReply = true;
          else f.faults.statement = "INSERT INTO ledger_native_facts";
          await expect(new NativeLedger(f.open()).execute(command)).rejects.toThrow();
          if (reverseOrder) {
            const replay = await new NativeLedger(f.open()).execute(command);
            const expected = evaluateOutcomePayload(oracle, command);
            expect(replay.value.result.disposition).toBe("replayed");
            expect(replay.value.originalResult).toEqual(expected.transition.result);
            oracle = { state: expected.transition.state, protocol: expected.transition.protocol };
            continue;
          }
          const absent = await f.repository.transact((view) => ({
            write: false,
            value: view.outcome(command.id),
          }));
          expect(absent.value).toBeNull();
        }
        await apply(command, "committed");
      }
      await apply(nextDay(posting("after-reversals", oracle.state.bookRevision)), "committed");
      const count = f.db
        .query(
          "SELECT count(*) AS n FROM ledger_native_facts WHERE json_extract(identity,'$[0]') = 'currencyPositions' AND json_extract(body,'$.active') = 1",
        )
        .get();
      expect(count).toEqual({ n: 0 });
      f.reset();
      expect(
        (await new NativeLedger(f.open()).execute(scenario.firstMeasurement)).value.result
          .disposition,
      ).toBe("replayed");
      expect(
        f.faults.statements.some((sql) => sql.includes("INDEXED BY ledger_native_currency")),
      ).toBeFalse();
      const tip = await f.repository.transact((view) => ({ write: false, value: view.head }));
      expect(
        (await verifyNativeLedgerCopy(f.repository, copy.repository, tip.head)).sourceHead,
      ).toEqual(tip.head);
      if (!reverseOrder) console.info(JSON.stringify({ nativeCurrencyFreshLocalSamples: samples }));
    } finally {
      f.db.close();
      copy.db.close();
    }
  }
});

test("native optional FX still rejects renamed-source stacking and permits a new measurement after exact reversal", async () => {
  const scenario = admissionFxWorkflow(false);
  const f = fixture();
  let oracle = scenario.initial;
  try {
    const active = evaluateOutcomePayload(oracle, activation());
    oracle = { state: active.transition.state, protocol: active.transition.protocol };
    await new NativeLedger(f.repository).provision(scenario.initial, activation());
    const apply = async (command: BookCommand, disposition: "committed" | "rejected") => {
      const expected = evaluateOutcomePayload(oracle, command);
      expect(expected.transition.result.disposition).toBe(disposition);
      const actual = await new NativeLedger(f.open()).execute(command);
      expect(actual.value.result).toEqual(expected.transition.result);
      oracle = { state: expected.transition.state, protocol: expected.transition.protocol };
    };
    for (const command of scenario.commands.slice(1)) await apply(command, "committed");
    const source = scenario.firstMeasurement.request.source;
    const journal = oracle.state.journals.find((row) => row.journal.id === source.journalId);
    const sourcePosting = journal?.journal.postings.find((row) => row.id === source.postingId);
    if (sourcePosting === undefined) throw new Error("Missing original monetary posting");
    const alias = createCanonicalPostingReference(
      canonicalPostingReferenceId("renamed-currency-source"),
      BOOK,
      source.journalId,
      sourcePosting,
      source.effectKey,
    );
    const measure = (id: string) =>
      sealCommand({
        ...scenario.firstMeasurement,
        id: commandId(id),
        expectedBookRevision: oracle.state.bookRevision,
        issuedAt: instant("2026-01-16T18:00:00Z"),
        completedAt: instant("2026-01-16T18:00:01Z"),
        committedAt: instant("2026-01-16T18:00:02Z"),
        request: {
          ...scenario.firstMeasurement.request,
          id: remeasurementResultId(id),
          source: alias,
          generatedEffectKey: effectKey(`${id}:journal:0`),
        },
      });
    await apply(measure("stacked-alias"), "rejected");
    const currencyJournal = oracle.state.journals.find(
      (row) => row.commandId === scenario.firstMeasurement.id,
    );
    if (currencyJournal === undefined) throw new Error("Missing currency result journal");
    const genericCorrection = (original: typeof currencyJournal, id: string) =>
      sealCommand({
        ...correction(original, id, oracle.state.bookRevision),
        issuedAt: instant("2026-01-16T18:00:00Z"),
        completedAt: instant("2026-01-16T18:00:01Z"),
        committedAt: instant("2026-01-16T18:00:02Z"),
      });
    await apply(genericCorrection(currencyJournal, "generic-currency-reversal"), "rejected");
    const reverse = sealCommand({
      ...scenario.reverse(scenario.firstMeasurement, 5n),
      issuedAt: instant("2026-01-16T18:00:00Z"),
      completedAt: instant("2026-01-16T18:00:01Z"),
      committedAt: instant("2026-01-16T18:00:02Z"),
    });
    await apply(reverse, "committed");
    const reversalJournal = oracle.state.journals.at(-1);
    if (reversalJournal === undefined) throw new Error("Missing currency reversal journal");
    await apply(genericCorrection(reversalJournal, "generic-reversal-of-reversal"), "rejected");
    await apply(measure("after-explicit-reversal"), "committed");
    await apply(
      sealCommand({
        ...posting("optional-next-day", oracle.state.bookRevision),
        issuedAt: instant("2026-01-17T18:00:00Z"),
        completedAt: instant("2026-01-17T18:00:01Z"),
        committedAt: instant("2026-01-17T18:00:02Z"),
      }),
      "committed",
    );
  } finally {
    f.db.close();
  }
});

test("native FX reads the exact shared invoice and payment budgets and rejects missing counters", async () => {
  const f = fixture();
  try {
    const invoice = openItemRecognition("currency-budget-invoice", 1n);
    const payment = unallocatedPayment("currency-budget-payment", 2n);
    const source = payment.request.settlement.settlementSource;
    const target = invoice.request.value.recognitionSource;
    if (source === undefined || target === undefined) throw new Error("Missing fixture source");
    await new NativeLedger(f.repository).provision(genesis(), activation());
    await new NativeLedger(f.repository).execute(invoice);
    await new NativeLedger(f.repository).execute(payment);
    await new NativeLedger(f.repository).execute(
      applyExistingPayment(payment, "currency-budget-application", 3n, [
        { openItemId: invoice.request.value.id, amount: 40n },
      ]),
    );
    await f.repository.transact((view) => {
      for (const reference of [source, target]) {
        const totals = readAllocatedMonetarySource(view, reference);
        expect(totals.bookValue.toString()).toBe("40/1");
        expect(totals.quantity.toString()).toBe("40/1");
      }
      return { write: false, value: null };
    });
    for (const [collection, id, reference] of [
      ["openItemAllocatedTotals", invoice.request.value.id, target],
      ["settlementAllocatedTotals", payment.request.settlement.id, source],
    ] as const) {
      f.db
        .query("DELETE FROM ledger_native_facts WHERE identity=?")
        .run(JSON.stringify([collection, id]));
      await expect(
        f.repository.transact((view) => ({
          write: false,
          value: readAllocatedMonetarySource(view, reference),
        })),
      ).rejects.toThrow("native_ledger_settlement_totals_incomplete");
    }
  } finally {
    f.db.close();
  }
});

test("native FX refuses missing canonical evidence without retaining an invented accounting rejection", async () => {
  for (const collection of ["remeasurementResults", "currencyPositions", "journals"] as const) {
    const scenario = admissionFxWorkflow();
    const f = fixture();
    try {
      await new NativeLedger(f.repository).provision(scenario.initial, activation());
      for (const command of scenario.commands.slice(1))
        await new NativeLedger(f.repository).execute(command);
      const id =
        collection === "journals"
          ? `${scenario.firstMeasurement.request.id}-journal`
          : scenario.firstMeasurement.request.id;
      f.db
        .query("DELETE FROM ledger_native_facts WHERE identity=?")
        .run(JSON.stringify([collection, id]));
      const command =
        collection === "remeasurementResults"
          ? sealCommand({
              ...posting("missing-due-result", 5n),
              issuedAt: instant("2026-01-17T18:00:00Z"),
              completedAt: instant("2026-01-17T18:00:01Z"),
              committedAt: instant("2026-01-17T18:00:02Z"),
            })
          : scenario.reverse(scenario.firstMeasurement, 5n);
      await expect(new NativeLedger(f.open()).execute(command)).rejects.toThrow();
      expect(f.db.query("SELECT count(*) AS n FROM ledger_native_outcomes").get()).toEqual({
        n: 5,
      });
    } finally {
      f.db.close();
    }
  }
});

test("native currency indexes select exact date and policy ranges without scanning retained inactive positions", async () => {
  const f = fixture();
  try {
    await new NativeLedger(f.repository).provision(genesis(), activation());
    await new NativeLedger(f.repository).execute(posting("index-owner", 1n));
    const key = "a".repeat(64);
    const insert = (
      id: string,
      policyId: string,
      effectiveOn: string,
      active: boolean,
      sequence = 1,
    ) => {
      const body = JSON.stringify({
        active,
        policyId,
        effectiveOn,
        sourceKey: id === "early" ? key : createHash("sha256").update(id).digest("hex"),
      });
      f.db
        .query("INSERT OR REPLACE INTO ledger_native_facts VALUES (?, ?, ?, ?, 1)")
        .run(
          JSON.stringify(["currencyPositions", id]),
          body,
          createHash("sha256").update(body).digest("hex"),
          sequence,
        );
    };
    f.db.transaction(() => {
      for (let i = 0; i < 10000; i++) insert(`inactive-${i}`, "required", "2025-01-01", false);
      insert("not-required", "optional", "2025-01-01", true);
      insert("early", "required", "2026-01-16", true);
      insert("late", "required", "2026-01-15", true, 2);
      insert("future", "required", "2026-02-01", true);
    })();
    let escaped: NativeLedgerTransaction | undefined;
    f.reset();
    const selected = await f.repository.transact((view) => {
      escaped = view;
      expect(view.firstDueCurrencyPosition(["required"], "2026-01-15")).toBeNull();
      expect(view.firstDueCurrencyPosition([], "2026-01-17")).toBeNull();
      expect(view.firstDueCurrencyPosition(["required"], "2026-01-16")?.key).toBe("late");
      expect(view.activeCurrencyPositions([key]).get(key)?.key).toBe("early");
      return { write: false, value: view.firstDueCurrencyPosition(["required"], "2026-01-17") };
    });
    expect(selected.value?.key).toBe("early");
    expect(() =>
      f.db
        .query(
          "INSERT INTO ledger_native_facts SELECT ?, body, digest, source_sequence, mutable FROM ledger_native_facts WHERE identity=?",
        )
        .run(
          JSON.stringify(["currencyPositions", "duplicate-active-source"]),
          JSON.stringify(["currencyPositions", "early"]),
        ),
    ).toThrow("UNIQUE constraint failed");
    expect(() => escaped?.firstDueCurrencyPosition(["required"], "2026-01-17")).toThrow(
      "native_ledger_transaction_closed",
    );
    const query = f.faults.statements.find((sql) =>
      sql.includes("INDEXED BY ledger_native_currency_due"),
    );
    if (query === undefined) throw new Error("Missing indexed currency query");
    const statement = f.db.prepare(`EXPLAIN QUERY PLAN ${query}`);
    const plan = statement.all(JSON.stringify(["required"]), "2026-01-17");
    statement.finalize();
    expect(JSON.stringify(plan)).toContain(
      "SEARCH ledger_native_facts USING INDEX ledger_native_currency_due",
    );
    expect(JSON.stringify(plan)).not.toContain("SCAN ledger_native_facts");
    f.db
      .query("UPDATE ledger_native_facts SET digest=? WHERE identity=?")
      .run("0".repeat(64), JSON.stringify(["currencyPositions", "early"]));
    await expect(
      f.repository.transact((view) => ({
        write: false,
        value: view.firstDueCurrencyPosition(["required"], "2026-01-17"),
      })),
    ).rejects.toThrow("native_ledger_fact_corrupt");
    insert("early", "required", "2026-01-16", true);
    f.db.exec("DROP INDEX ledger_native_currency_due");
    await expect(
      f.repository.transact((view) => ({
        write: false,
        value: view.firstDueCurrencyPosition(["required"], "2026-01-17"),
      })),
    ).rejects.toThrow();
    // Idempotent provision rebuilds additive SQL indexes; reads never fall back to a scan.
    await f.repository.provision(encodeDurableBook(genesis()));
    expect(
      (
        await f.repository.transact((view) => ({
          write: false,
          value: view.firstDueCurrencyPosition(["required"], "2026-01-17"),
        }))
      ).value?.key,
    ).toBe("early");
  } finally {
    f.db.close();
  }
});

test("native open items bind one posted source with atomic retry and reconstructed-owner parity", async () => {
  for (const profile of [undefined, STRUCTURAL_SOURCE_IDENTITY_PROFILE] as const) {
    const f = fixture();
    const copy = fixture("open-item-copy");
    try {
      const base = genesis();
      const state = base.state;
      const initial = {
        ...base,
        state: createBookState(
          state.identity,
          state.periods,
          state.admissionSnapshot,
          state.policies,
          state.quantizationPolicies,
          [],
          instant("2020-01-01T00:00:00Z"),
          profile,
        ),
      };
      const first = openItemRecognition("invoice", 1n);
      const other = openItemRecognition("other", 2n);
      const duplicate = sealCommand({
        ...other,
        id: commandId("duplicate"),
        request: {
          value: {
            ...other.request.value,
            recognitionSource: workflowValue(first.request.value.recognitionSource),
          },
        },
      });
      let oracle = initial;
      for (const command of [activation(), first, duplicate, other]) {
        const expected = evaluateOutcomePayload(oracle, command);
        expect(expected.transition.result.disposition).toBe(
          command === duplicate ? "rejected" : "committed",
        );
        if (command === first) {
          for (const prefix of [
            "INSERT INTO ledger_native_outcomes",
            "INSERT INTO ledger_native_facts",
            "UPDATE ledger_native_book",
          ]) {
            f.faults.statement = prefix;
            await expect(new NativeLedger(f.open()).execute(command)).rejects.toThrow(
              "Injected SQL failure",
            );
            expect(
              f.db
                .query(
                  "SELECT count(*) AS n FROM ledger_native_facts WHERE json_extract(identity, '$[0]') IN ('openItems', 'financialSourceOwners')",
                )
                .get(),
            ).toEqual({ n: 0 });
          }
          f.reset();
          f.faults.lostReply = true;
          await expect(new NativeLedger(f.open()).execute(command)).rejects.toThrow(
            "Lost durability confirmation",
          );
          expect(f.faults.statements.length).toBeLessThanOrEqual(10);
        }
        const actual =
          command.type === "activateBook"
            ? await new NativeLedger(f.open()).provision(initial, command)
            : (await new NativeLedger(f.open()).execute(command)).value;
        if (command !== first) expect(actual.result).toEqual(expected.transition.result);
        else {
          expect(actual.result.disposition).toBe("replayed");
          expect(
            f.db
              .query(
                "SELECT count(*) AS n FROM ledger_native_facts WHERE json_extract(identity, '$[0]') IN ('openItems', 'financialSourceOwners')",
              )
              .get(),
          ).toEqual({ n: 2 });
        }
        oracle = { state: expected.transition.state, protocol: expected.transition.protocol };
        if (command.type !== "activateBook")
          expect((await new NativeLedger(f.open()).execute(command)).value.result).toEqual(
            evaluateOutcomePayload(oracle, command).transition.result,
          );
      }
      expect(
        oracle.state.accountingState.openItems.map((item) => item.bookValue.toString()),
      ).toEqual(["100/1", "100/1"]);
      const tip = await f.repository.transact((view) => ({ write: false, value: view.head }));
      expect(
        (await verifyNativeLedgerCopy(f.repository, copy.repository, tip.head)).sourceHead.sequence,
      ).toBe("4");
    } finally {
      f.db.close();
      copy.db.close();
    }
  }
});

test("native open-item save work stays bounded after history and source-owner corruption fails closed", async () => {
  const f = fixture();
  try {
    await new NativeLedger(f.open()).provision(genesis(), activation());
    const counts: number[] = [];
    let revision = 1n;
    for (const history of [0, 1000]) {
      for (let index = 0; index < history; index++)
        await new NativeLedger(f.open()).execute(posting(`history-${index}`, revision++));
      f.reset();
      const result = await new NativeLedger(f.open()).execute(
        openItemRecognition(`invoice-${history}`, revision++),
      );
      expect(result.value.result.disposition).toBe("committed");
      expect(f.faults.transactions).toBe(1);
      expect(
        f.faults.statements.every((statement) => !statement.includes("ORDER BY source_sequence")),
      ).toBeTrue();
      counts.push(f.faults.statements.length);
    }
    expect(counts[0]).toBe(counts[1]);
    expect(counts[0]).toBeLessThanOrEqual(10);
    const before = await f.repository.transact((view) => ({ write: false, value: view.head }));
    const source = workflowValue(
      openItemRecognition("invoice-0", 1n).request.value.recognitionSource,
    );
    const candidate = openItemRecognition("claim-dangling-source", revision);
    const claim = sealCommand({
      ...candidate,
      request: { value: { ...candidate.request.value, recognitionSource: source } },
    });
    // Narrow, in-memory fault injection: a source index pointing at a missing
    // canonical owner is corruption, never permission to claim its amount.
    f.db
      .query("DELETE FROM ledger_native_facts WHERE identity = ?")
      .run(JSON.stringify(["openItems", "invoice-0"]));
    await expect(new NativeLedger(f.open()).execute(claim)).rejects.toThrow(
      "native_ledger_required_fact_missing",
    );
    const after = await f.repository.transact((view) => ({
      write: false,
      value: view.outcome(claim.id),
    }));
    expect(after.head).toEqual(before.head);
    expect(after.value).toBeNull();
  } finally {
    f.db.close();
  }
});

test("unallocated native payments retain one owner and exact remaining budgets across later applications", async () => {
  const f = fixture();
  const copy = fixture("unallocated-copy");
  try {
    const initial = genesis();
    let oracle = initial;
    const payment = unallocatedPayment("prepayment", 1n);
    const first = applyExistingPayment(payment, "apply-first", 4n, [
      { openItemId: openItemId("invoice-a"), amount: 40n },
    ]);
    const second = applyExistingPayment(payment, "apply-second", 5n, [
      { openItemId: openItemId("invoice-b"), amount: 60n },
    ]);
    const over = applyExistingPayment(payment, "apply-over", 6n, [
      { openItemId: openItemId("invoice-b"), amount: 1n },
    ]);
    const close = sealCommand({
      ...closing("application-close", 6n),
      issuedAt: second.issuedAt,
      completedAt: second.completedAt,
      committedAt: second.committedAt,
    });
    for (const command of [
      activation(),
      payment,
      openItemRecognition("invoice-a", 2n),
      openItemRecognition("invoice-b", 3n),
      first,
      second,
      over,
      close,
    ]) {
      const expected = evaluateOutcomePayload(oracle, command);
      expect(expected.transition.result.disposition).toBe(
        command === over ? "rejected" : "committed",
      );
      if (command === first) {
        for (const prefix of [
          "INSERT INTO ledger_native_outcomes",
          "INSERT INTO ledger_native_facts",
          "UPDATE ledger_native_book",
        ]) {
          f.faults.statement = prefix;
          await expect(new NativeLedger(f.open()).execute(command)).rejects.toThrow(
            "Injected SQL failure",
          );
          expect(
            f.db
              .query("SELECT body FROM ledger_native_facts WHERE identity = ?")
              .get(JSON.stringify(["settlementAllocatedTotals", "prepayment"])),
          ).toEqual({
            body: JSON.stringify({ bookValue: "0/1", quantity: "0/1", allocations: "0" }),
          });
        }
        f.faults.lostReply = true;
        await expect(new NativeLedger(f.open()).execute(command)).rejects.toThrow(
          "Lost durability confirmation",
        );
      }
      const actual =
        command.type === "activateBook"
          ? await new NativeLedger(f.open()).provision(initial, command)
          : (await new NativeLedger(f.open()).execute(command)).value;
      if (command === first) expect(actual.result.disposition).toBe("replayed");
      else expect(actual.result).toEqual(expected.transition.result);
      const retained = await f.repository.transact((view) => ({
        write: false,
        value: view.outcome(command.id),
      }));
      expect(retained.value?.encoded ?? null).toBe(expected.encoded);
      oracle = { state: expected.transition.state, protocol: expected.transition.protocol };
    }
    expect(oracle.state.accountingState.settlements).toHaveLength(1);
    expect(oracle.state.latestPostingSequence).toBe(3n);
    expect(
      oracle.state.accountingState.settlementAllocations.map((item) =>
        item.allocatedSettlementBookValue?.toString(),
      ),
    ).toEqual(["40/1", "60/1"]);
    expect(
      f.db
        .query("SELECT body FROM ledger_native_facts WHERE identity = ?")
        .get(JSON.stringify(["settlementAllocatedTotals", "prepayment"])),
    ).toEqual({
      body: JSON.stringify({ bookValue: "100/1", quantity: "100/1", allocations: "2" }),
    });
    expect(
      f.db
        .query("SELECT body FROM ledger_native_facts WHERE identity = ?")
        .get(JSON.stringify(["current", "latestAccountingDate"])),
    ).toEqual({ body: JSON.stringify("2026-01-21") });
    const configured = configuration(oracle.state, "retroactive-configuration");
    if (configured.type !== "replaceConfiguration")
      throw new Error("Invalid configuration fixture");
    const retroactive = sealCommand({
      ...configured,
      effectiveOn: localDate("2026-01-21"),
      issuedAt: instant("2026-01-22T14:00:00Z"),
      completedAt: instant("2026-01-22T14:00:00Z"),
      committedAt: instant("2026-01-22T14:00:00Z"),
    });
    const rejected = evaluateOutcomePayload(oracle, retroactive);
    expect(rejected.transition.result.disposition).toBe("rejected");
    expect(rejected.transition.result.diagnostics[0]?.path).toBe("command.effectiveOn");
    expect((await new NativeLedger(f.open()).execute(retroactive)).value.result).toEqual(
      rejected.transition.result,
    );
    const tip = await f.repository.transact((view) => ({ write: false, value: view.head }));
    expect(
      (await verifyNativeLedgerCopy(f.repository, copy.repository, tip.head)).sourceHead.sequence,
    ).toBe("9");
  } finally {
    f.db.close();
    copy.db.close();
  }
});

test("native legacy settlement cannot bypass a closed period through a preposted payment", async () => {
  const f = fixture();
  const copy = fixture("preposted-copy");
  try {
    const initial = genesis();
    let oracle = initial;
    const ledger = new NativeLedger(f.open());
    const payment = settlementPayment("payment", 2n, [
      { openItemId: openItemId("invoice"), amount: 100n },
    ]);
    const supplied = payment.resolved[0];
    if (supplied === undefined) throw new Error("Missing payment journal");
    const source = sealCommand({
      ...posting("payment", 2n),
      type: "postJournal" as const,
      id: payment.id,
      expectedBookRevision: 2n,
      issuedAt: payment.issuedAt,
      completedAt: payment.completedAt,
      committedAt: payment.committedAt,
      resolved: supplied,
    });
    for (const command of [
      activation(),
      openItemRecognition("invoice", 1n),
      source,
      closing("closed", 3n),
    ]) {
      const expected = evaluateOutcomePayload(oracle, command);
      expect(expected.transition.result.disposition).toBe("committed");
      const actual =
        command.type === "activateBook"
          ? await ledger.provision(initial, command)
          : (await ledger.execute(command)).value;
      expect(actual.result).toEqual(expected.transition.result);
      oracle = { state: expected.transition.state, protocol: expected.transition.protocol };
    }
    const at = instant("2026-01-21T14:00:00Z");
    const claim = sealCommand({
      ...payment,
      id: commandId("claim"),
      expectedBookRevision: 4n,
      issuedAt: at,
      completedAt: at,
      committedAt: at,
      resolved: [],
    });
    const rejection = evaluateOutcomePayload(oracle, claim);
    expect(rejection.transition.result.disposition).toBe("rejected");
    expect(rejection.transition.result.diagnostics[0]?.code).toBe("fiscal_period_admission");
    expect(rejection.transition.state).toEqual(oracle.state);
    const before = await f.repository.transact((view) => ({ write: false, value: view.head }));
    f.faults.statement = "INSERT INTO ledger_native_outcomes";
    await expect(new NativeLedger(f.open()).execute(claim)).rejects.toThrow("Injected SQL failure");
    const rolledBack = await f.repository.transact((view) => ({
      write: false,
      value: view.outcome(claim.id),
    }));
    expect(rolledBack.head).toEqual(before.head);
    expect(rolledBack.value).toBeNull();
    f.faults.lostReply = true;
    await expect(new NativeLedger(f.open()).execute(claim)).rejects.toThrow(
      "Lost durability confirmation",
    );
    const after = await f.repository.transact((view) => ({
      write: false,
      value: view.outcome(claim.id),
    }));
    expect(after.value).not.toBeNull();
    expect(after.value?.payload.originalResult).toEqual({
      ...rejection.transition.result,
      disposition: "rejected",
    });
    expect((await new NativeLedger(f.open()).execute(claim)).value.result).toEqual({
      ...rejection.transition.result,
      disposition: "replayed",
    });
    const reopened = sealCommand({
      ...reopening("reopen", 4n),
      issuedAt: at,
      completedAt: at,
      committedAt: at,
    });
    expect((await ledger.execute(reopened)).value.result.disposition).toBe("committed");
    const fresh = sealCommand({
      ...claim,
      id: commandId("claim-after-reopen"),
      expectedBookRevision: 5n,
    });
    expect((await ledger.execute(fresh)).value.result.disposition).toBe("committed");
    expect((await new NativeLedger(f.open()).execute(claim)).value.result).toEqual({
      ...rejection.transition.result,
      disposition: "replayed",
    });
    // Exact retry after a later close still returns the original committed result.
    expect(
      (
        await ledger.execute(
          sealCommand({
            ...closing("reclose", 6n),
            issuedAt: at,
            completedAt: at,
            committedAt: at,
          }),
        )
      ).value.result.disposition,
    ).toBe("committed");
    expect((await new NativeLedger(f.open()).execute(fresh)).value.result.disposition).toBe(
      "replayed",
    );
    const tip = await f.repository.transact((view) => ({ write: false, value: view.head }));
    expect(
      (await verifyNativeLedgerCopy(f.repository, copy.repository, tip.head)).sourceHead.sequence,
    ).toBe("8");
  } finally {
    f.db.close();
    copy.db.close();
  }
});

test("competing deferred applications cannot spend one payment across different invoices", async () => {
  const f = fixture();
  try {
    const ledger = new NativeLedger(f.open());
    const payment = unallocatedPayment("one-payment", 1n);
    await ledger.provision(genesis(), activation());
    await ledger.execute(payment);
    await ledger.execute(openItemRecognition("invoice-a", 2n));
    await ledger.execute(openItemRecognition("invoice-b", 3n));
    const commands = ["invoice-a", "invoice-b"].map((id) =>
      applyExistingPayment(payment, `apply-${id}`, 4n, [
        { openItemId: openItemId(id), amount: 60n },
      ]),
    );
    const results = await Promise.all(commands.map((command) => ledger.execute(command)));
    expect(results.map((result) => result.value.result.disposition).sort()).toEqual([
      "committed",
      "rejected",
    ]);
    const loser = results.findIndex((result) => result.value.result.disposition === "rejected");
    expect(results[loser]?.value.result.diagnostics[0]?.code).toBe("stale_book_revision");
    const original = commands[loser];
    if (original === undefined) throw new Error("Missing rejected application");
    const retried = sealCommand({
      ...original,
      id: commandId("fresh-application"),
      expectedBookRevision: 5n,
    });
    const result = await new NativeLedger(f.open()).execute(retried);
    expect(result.value.result.disposition).toBe("rejected");
    expect(result.value.result.diagnostics[0]?.code).toBe("settlement_allocation_violation");
    const observed = await f.repository.transact((view) => ({
      write: false,
      value: view.facts([
        { collection: "settlementAllocatedTotals", key: payment.request.settlement.id },
      ])[0],
    }));
    if (observed.value == null) throw new Error("Missing payment totals");
    expect(JSON.parse(observed.value.encoded)).toEqual({
      bookValue: "60/1",
      quantity: "60/1",
      allocations: "1",
    });
  } finally {
    f.db.close();
  }
});

test("missing deferred payment totals or ownership cannot be interpreted as an unused balance", async () => {
  for (const collection of ["settlementAllocatedTotals", "financialSourceOwners"]) {
    const f = fixture();
    try {
      const ledger = new NativeLedger(f.open());
      const payment = unallocatedPayment("payment", 1n);
      await ledger.provision(genesis(), activation());
      await ledger.execute(payment);
      await ledger.execute(openItemRecognition("invoice", 2n));
      const before = await f.repository.transact((view) => ({ write: false, value: view.head }));
      // Delete only the targeted test database's derived evidence. The immutable
      // payment and outcome remain, so absence must not create a fresh budget.
      f.db
        .query("DELETE FROM ledger_native_facts WHERE json_extract(identity, '$[0]') = ?")
        .run(collection);
      const command = applyExistingPayment(payment, "application", 3n, [
        { openItemId: openItemId("invoice"), amount: 40n },
      ]);
      await expect(new NativeLedger(f.open()).execute(command)).rejects.toThrow(
        collection === "settlementAllocatedTotals"
          ? "native_ledger_settlement_totals_incomplete"
          : "native_ledger_required_fact_missing",
      );
      const after = await f.repository.transact((view) => ({
        write: false,
        value: view.outcome(command.id),
      }));
      expect(after.head).toEqual(before.head);
      expect(after.value).toBeNull();
    } finally {
      f.db.close();
    }
  }
});

test("deferred payment allocation work stays bounded after a thousand prior applications", async () => {
  const samples: { priorApplications: number; statements: number; milliseconds: number }[] = [];
  for (const priorApplications of [0, 1000]) {
    const f = fixture();
    try {
      const ledger = new NativeLedger(f.open());
      const payment = unallocatedPayment("large-payment", 1n, 2000n);
      await ledger.provision(genesis(), activation());
      await ledger.execute(payment);
      for (let index = 0; index < 11; index++)
        await ledger.execute(openItemRecognition(`invoice-${index}`, BigInt(index + 2)));
      const edges = (index: number) => [
        { openItemId: openItemId(`invoice-${index % 11}`), amount: 1n },
      ];
      for (let index = 0; index < priorApplications; index++)
        expect(
          (
            await ledger.execute(
              applyExistingPayment(payment, `prior-${index}`, BigInt(index + 13), edges(index)),
            )
          ).value.result.disposition,
        ).toBe("committed");
      f.reset();
      const start = performance.now();
      const result = await new NativeLedger(f.open()).execute(
        applyExistingPayment(payment, "measured", BigInt(priorApplications + 13), edges(0)),
      );
      const milliseconds = performance.now() - start;
      expect(result.value.result.disposition).toBe("committed");
      expect(f.faults.transactions).toBe(1);
      expect(
        f.faults.statements.some((sql) => sql.includes("ORDER BY source_sequence")),
      ).toBeFalse();
      expect(f.faults.statements.length).toBeLessThanOrEqual(16);
      samples.push({ priorApplications, statements: f.faults.statements.length, milliseconds });
      const observed = await f.repository.transact((view) => ({
        write: false,
        value: view.facts([
          { collection: "settlementAllocatedTotals", key: payment.request.settlement.id },
        ])[0],
      }));
      if (observed.value == null) throw new Error("Missing payment totals");
      expect(JSON.parse(observed.value.encoded)).toEqual({
        bookValue: `${priorApplications + 1}/1`,
        quantity: `${priorApplications + 1}/1`,
        allocations: String(priorApplications + 1),
      });
    } finally {
      f.db.close();
    }
  }
  expect(samples[0]?.statements).toBe(samples[1]?.statements);
  console.log(
    JSON.stringify({ scope: "local deferred payment samples, not deployed percentiles", samples }),
  );
});

test("native settlements conserve partial payments atomically across retries, restarts and close", async () => {
  const f = fixture();
  const copy = fixture("settlement-copy");
  try {
    const initial = genesis();
    let oracle = initial;
    const invoice = openItemId("invoice");
    const first = settlementPayment("first-payment", 2n, [{ openItemId: invoice, amount: 40n }]);
    const second = settlementPayment("second-payment", 3n, [{ openItemId: invoice, amount: 60n }]);
    const over = settlementPayment("over-payment", 4n, [{ openItemId: invoice, amount: 1n }]);
    for (const command of [
      activation(),
      openItemRecognition("invoice", 1n),
      first,
      second,
      over,
      closing("paid-close", 4n),
    ]) {
      const expected = evaluateOutcomePayload(oracle, command);
      expect(expected.transition.result.disposition).toBe(
        command === over ? "rejected" : "committed",
      );
      if (command === first) {
        for (const prefix of [
          "INSERT INTO ledger_native_outcomes",
          "INSERT INTO ledger_native_facts",
          "UPDATE ledger_native_book",
        ]) {
          f.faults.statement = prefix;
          await expect(new NativeLedger(f.open()).execute(command)).rejects.toThrow(
            "Injected SQL failure",
          );
          expect(
            f.db
              .query("SELECT body FROM ledger_native_facts WHERE identity = ?")
              .get(JSON.stringify(["openItemAllocatedTotals", invoice])),
          ).toEqual({
            body: JSON.stringify({ bookValue: "0/1", quantity: "0/1", allocations: "0" }),
          });
        }
        f.faults.lostReply = true;
        await expect(new NativeLedger(f.open()).execute(command)).rejects.toThrow(
          "Lost durability confirmation",
        );
      }
      const actual =
        command.type === "activateBook"
          ? await new NativeLedger(f.open()).provision(initial, command)
          : (await new NativeLedger(f.open()).execute(command)).value;
      if (command === first) expect(actual.result.disposition).toBe("replayed");
      else expect(actual.result).toEqual(expected.transition.result);
      const stored = await f.repository.transact((view) => ({
        write: false,
        value: view.outcome(command.id),
      }));
      expect(stored.value?.encoded ?? null).toBe(expected.encoded);
      oracle = { state: expected.transition.state, protocol: expected.transition.protocol };
      if (command.type !== "activateBook")
        expect((await new NativeLedger(f.open()).execute(command)).value.result).toEqual(
          evaluateOutcomePayload(oracle, command).transition.result,
        );
    }
    expect(
      oracle.state.accountingState.settlementAllocations.map((item) =>
        item.allocatedBookValue.toString(),
      ),
    ).toEqual(["40/1", "60/1"]);
    expect(
      f.db
        .query("SELECT body FROM ledger_native_facts WHERE identity = ?")
        .get(JSON.stringify(["openItemAllocatedTotals", invoice])),
    ).toEqual({
      body: JSON.stringify({ bookValue: "100/1", quantity: "100/1", allocations: "2" }),
    });
    const tip = await f.repository.transact((view) => ({ write: false, value: view.head }));
    expect(
      (await verifyNativeLedgerCopy(f.repository, copy.repository, tip.head)).sourceHead.sequence,
    ).toBe("6");
  } finally {
    f.db.close();
    copy.db.close();
  }
});

test("native settlement source aliases cannot create another payment or open-item budget", async () => {
  const f = fixture();
  try {
    const ledger = new NativeLedger(f.open());
    let oracle = genesis();
    const payment = settlementPayment("payment", 3n, [
      { openItemId: openItemId("invoice-a"), amount: 100n },
    ]);
    const source = workflowValue(payment.request.settlement.settlementSource);
    const nextPayment = settlementPayment("alias-payment", 4n, [
      { openItemId: openItemId("invoice-b"), amount: 100n },
    ]);
    const duplicate = sealCommand({
      ...nextPayment,
      resolved: [],
      request: {
        ...nextPayment.request,
        settlement: { ...nextPayment.request.settlement, settlementSource: source },
      },
    });
    const nextOpen = openItemRecognition("alias-open", 4n);
    const crossRole = sealCommand({
      ...nextOpen,
      request: { value: { ...nextOpen.request.value, recognitionSource: source } },
    });
    for (const command of [
      activation(),
      openItemRecognition("invoice-a", 1n),
      openItemRecognition("invoice-b", 2n),
      payment,
      duplicate,
      crossRole,
    ]) {
      const expected = evaluateOutcomePayload(oracle, command);
      const reject = command === duplicate || command === crossRole;
      expect(expected.transition.result.disposition).toBe(reject ? "rejected" : "committed");
      if (reject)
        expect(expected.transition.result.diagnostics[0]?.message).toBe(
          "Canonical control posting already has a financial source owner",
        );
      const actual =
        command.type === "activateBook"
          ? await ledger.provision(genesis(), command)
          : (await new NativeLedger(f.open()).execute(command)).value;
      expect(actual.result).toEqual(expected.transition.result);
      oracle = { state: expected.transition.state, protocol: expected.transition.protocol };
    }
    expect(oracle.state.accountingState.settlements).toHaveLength(1);
    expect(oracle.state.accountingState.openItems).toHaveLength(2);
    expect(
      f.db
        .query("SELECT body FROM ledger_native_facts WHERE identity = ?")
        .get(JSON.stringify(["openItemAllocatedTotals", "invoice-b"])),
    ).toEqual({ body: JSON.stringify({ bookValue: "0/1", quantity: "0/1", allocations: "0" }) });
  } finally {
    f.db.close();
  }
});

test("native payment source and counter reads are batched independently of retained history", async () => {
  const samples: { items: number; history: number; statements: number; milliseconds: number }[] =
    [];
  for (const [items, history] of [
    [1, 0],
    [10, 0],
    [100, 0],
    [10, 1000],
  ] as const) {
    const f = fixture();
    try {
      const ledger = new NativeLedger(f.open());
      await ledger.provision(genesis(), activation());
      let revision = 1n;
      for (let index = 0; index < history; index++)
        await ledger.execute(posting(`history-${index}`, revision++));
      const allocations: { openItemId: ReturnType<typeof openItemId>; amount: bigint }[] = [];
      for (let index = 0; index < items; index++) {
        const id = `invoice-${index}`;
        await ledger.execute(openItemRecognition(id, revision++));
        allocations.push({ openItemId: openItemId(id), amount: 100n });
      }
      const command = settlementPayment("batch-payment", revision, allocations);
      f.reset();
      const start = performance.now();
      const result = await new NativeLedger(f.open()).execute(command);
      const milliseconds = performance.now() - start;
      expect(result.value.result.disposition).toBe("committed");
      expect(f.faults.transactions).toBe(1);
      expect(
        f.faults.statements.every((statement) => !statement.includes("ORDER BY source_sequence")),
      ).toBeTrue();
      expect(f.faults.statements.length).toBeLessThanOrEqual(
        10 + Math.ceil((1 + 3 * items) / 32) + Math.ceil((3 * items + 3) / 32),
      );
      samples.push({ items, history, statements: f.faults.statements.length, milliseconds });
      const stored = await f.repository.transact((view) => ({
        write: false,
        value: view.facts(
          allocations.map((item) => ({
            collection: "openItemAllocatedTotals",
            key: item.openItemId,
          })),
        ),
      }));
      expect(stored.value.map((fact) => fact?.encoded)).toEqual(
        allocations.map(() =>
          JSON.stringify({ bookValue: "100/1", quantity: "100/1", allocations: "1" }),
        ),
      );
    } finally {
      f.db.close();
    }
  }
  expect(samples[1]?.statements).toBe(samples[3]?.statements);
  console.log(
    JSON.stringify({ scope: "local fresh settlement samples, not deployed percentiles", samples }),
  );
});

test("competing payments serialize revision checks and cannot consume the same remaining balance", async () => {
  const f = fixture();
  try {
    const ledger = new NativeLedger(f.repository);
    await ledger.provision(genesis(), activation());
    await ledger.execute(openItemRecognition("invoice", 1n));
    const target = [{ openItemId: openItemId("invoice"), amount: 60n }];
    const results = await Promise.all([
      ledger.execute(settlementPayment("left", 2n, target)),
      ledger.execute(settlementPayment("right", 2n, target)),
    ]);
    expect(results.map((result) => result.value.result.disposition).sort()).toEqual([
      "committed",
      "rejected",
    ]);
    expect(
      results.find((result) => result.value.result.disposition === "rejected")?.value.result
        .diagnostics[0]?.code,
    ).toBe("stale_book_revision");
    const retried = await new NativeLedger(f.open()).execute(
      settlementPayment("refreshed", 3n, target),
    );
    expect(retried.value.result.disposition).toBe("rejected");
    expect(retried.value.result.diagnostics[0]?.code).toBe("settlement_allocation_violation");
    expect(
      f.db
        .query("SELECT body FROM ledger_native_facts WHERE identity = ?")
        .get(JSON.stringify(["openItemAllocatedTotals", "invoice"])),
    ).toEqual({ body: JSON.stringify({ bookValue: "60/1", quantity: "60/1", allocations: "1" }) });
  } finally {
    f.db.close();
  }
});

test("missing native payment totals fail closed without retaining a rejection", async () => {
  const f = fixture();
  try {
    const ledger = new NativeLedger(f.open());
    await ledger.provision(genesis(), activation());
    await ledger.execute(openItemRecognition("invoice", 1n));
    await ledger.execute(
      settlementPayment("partial", 2n, [{ openItemId: openItemId("invoice"), amount: 40n }]),
    );
    const before = await f.repository.transact((view) => ({ write: false, value: view.head }));
    f.db
      .query("DELETE FROM ledger_native_facts WHERE identity = ?")
      .run(JSON.stringify(["openItemAllocatedTotals", "invoice"]));
    const next = settlementPayment("remaining", 3n, [
      { openItemId: openItemId("invoice"), amount: 60n },
    ]);
    await expect(new NativeLedger(f.open()).execute(next)).rejects.toThrow(
      "native_ledger_settlement_totals_incomplete",
    );
    const after = await f.repository.transact((view) => ({
      write: false,
      value: view.outcome(next.id),
    }));
    expect(after.head).toEqual(before.head);
    expect(after.value).toBeNull();
  } finally {
    f.db.close();
  }
});

test("native payment publication preserves three-journal order through close and staging replay", async () => {
  const f = fixture();
  const copy = fixture("multi-payment-copy");
  try {
    const ledger = new NativeLedger(f.open());
    const initial = genesis();
    await ledger.provision(initial, activation());
    await ledger.execute(openItemRecognition("invoice", 1n));
    const payment = settlementPayment("m-payment", 2n, [
      { openItemId: openItemId("invoice"), amount: 100n },
    ]);
    const extra1 = posting("z-extra", 2n),
      extra2 = posting("a-extra", 2n);
    if (extra1.type !== "postJournal" || extra2.type !== "postJournal")
      throw new Error("Invalid journal fixtures");
    const command = sealCommand({
      ...payment,
      resolved: [...payment.resolved, extra1.resolved, extra2.resolved],
    });
    expect((await ledger.execute(command)).value.result.disposition).toBe("committed");
    expect(
      (await new NativeLedger(f.open()).execute(closing("payment-close", 3n))).value.result
        .disposition,
    ).toBe("committed");
    const tip = await f.repository.transact((view) => ({ write: false, value: view.head }));
    expect(
      (await verifyNativeLedgerCopy(f.repository, copy.repository, tip.head)).sourceHead.sequence,
    ).toBe("4");
  } finally {
    f.db.close();
    copy.db.close();
  }
});

test("native allocation lifecycle retains exact legacy and cumulative receipts and restart projections", async () => {
  for (const version of ["1.0.0", "1.1.0"] as const) {
    const f = fixture();
    const copy = fixture("allocation-copy");
    try {
      const scenario = allocationAndTaxWorkflow(version);
      let oracle = scenario.initial;
      for (const command of [...scenario.commands, workflowTerminationCommand(scenario)]) {
        const expected = evaluateOutcomePayload(oracle, command);
        expect(expected.transition.result.disposition).toBe("committed");
        const ledger = new NativeLedger(f.open());
        const actual =
          command.type === "activateBook"
            ? await ledger.provision(scenario.initial, command)
            : (await ledger.execute(command)).value;
        expect(actual.result).toEqual(expected.transition.result);
        oracle = { state: expected.transition.state, protocol: expected.transition.protocol };
        if (command.type !== "activateBook") {
          const replay = evaluateOutcomePayload(oracle, command);
          expect((await new NativeLedger(f.open()).execute(command)).value.result).toEqual(
            replay.transition.result,
          );
        }
      }
      expect(oracle.state.accountingState.allocationSchedules).toHaveLength(2);
      expect(oracle.state.accountingState.allocationRecognitions).toHaveLength(3);
      expect(oracle.state.accountingState.allocationScheduleRevisions).toHaveLength(2);
      const tip = await f.repository.transact((view) => ({ write: false, value: view.head }));
      const verified = await verifyNativeLedgerCopy(f.repository, copy.repository, tip.head);
      expect(verified.sourceHead.sequence).toBe("9");
    } finally {
      f.db.close();
      copy.db.close();
    }
  }
});

test("native FX resolves raw source tuples through later aliases, exact reversal and owner restart", async () => {
  for (const profile of [undefined, STRUCTURAL_SOURCE_IDENTITY_PROFILE] as const) {
    const f = fixture();
    const scenario = admissionFxWorkflow();
    const state = scenario.initial.state;
    const initial = {
      ...scenario.initial,
      state: createBookState(
        state.identity,
        state.periods,
        state.admissionSnapshot,
        state.policies,
        state.quantizationPolicies,
        state.accountingPolicySnapshot.policies,
        instant("2020-01-01T00:00:00Z"),
        profile,
      ),
    };
    let oracle = initial;
    const apply = async (command: BookCommand, disposition: "committed" | "rejected") => {
      const expected = evaluateOutcomePayload(oracle, command);
      expect(expected.transition.result.disposition).toBe(disposition);
      const actual = await new NativeLedger(f.open()).execute(command);
      expect(actual.value.result).toEqual(expected.transition.result);
      const retained = await f
        .open()
        .transact((view) => ({ write: false, value: view.outcome(command.id) }));
      if (expected.encoded === null) throw new Error("Expected a retained source-family outcome");
      expect(retained.value?.encoded).toBe(expected.encoded);
      oracle = { state: expected.transition.state, protocol: expected.transition.protocol };
      return actual;
    };
    try {
      await new NativeLedger(f.repository).provision(initial, activation());
      const active = evaluateOutcomePayload(initial, activation());
      oracle = { state: active.transition.state, protocol: active.transition.protocol };
      const first = workflowValue(scenario.commands[1]),
        second = workflowValue(scenario.commands[2]);
      if (first.type !== "postJournal" || second.type !== "postJournal")
        throw new Error("Expected FX journals");
      const source = sealCommand({
        ...first,
        id: commandId("alias:save"),
        resolved: {
          ...first.resolved,
          journal: { ...first.resolved.journal, id: journalId("fx-source") },
        },
      });
      const shadow = sealCommand({
        ...second,
        id: commandId("save"),
        resolved: {
          ...second.resolved,
          journal: { ...second.resolved.journal, id: journalId("fx-source:alias") },
        },
      });
      await apply(source, "committed");
      await apply(shadow, "committed");
      expect(`${source.resolved.journal.id}:${source.id}:journal:0`).toBe(
        `${shadow.resolved.journal.id}:${shadow.id}:journal:0`,
      );
      const measurement = sealCommand({
        ...scenario.firstMeasurement,
        request: {
          ...scenario.firstMeasurement.request,
          source: createCanonicalPostingReference(
            canonicalPostingReferenceId("retained-fx-source"),
            BOOK,
            source.resolved.journal.id,
            workflowValue(source.resolved.journal.postings[0]),
            effectKey(`${source.id}:journal:0`),
          ),
        },
      });
      for (const [index, invalidSource] of [
        createCanonicalPostingReference(
          canonicalPostingReferenceId("wrong-fx-account"),
          BOOK,
          source.resolved.journal.id,
          { ...workflowValue(source.resolved.journal.postings[0]), accountId: INCOME },
          effectKey(`${source.id}:journal:0`),
        ),
        createCanonicalPostingReference(
          canonicalPostingReferenceId("wrong-fx-effect"),
          BOOK,
          source.resolved.journal.id,
          workflowValue(source.resolved.journal.postings[0]),
          effectKey("save:journal:0"),
        ),
      ].entries()) {
        const invalid = sealCommand({
          ...measurement,
          id: commandId(`invalid-fx-source-${index}`),
          request: { ...measurement.request, source: invalidSource },
        });
        const rejected = await apply(invalid, "rejected");
        expect(
          rejected.value.result.diagnostics.some(
            (diagnostic) => diagnostic.code === "unresolved_accounting_input",
          ),
        ).toBeTrue();
        expect(oracle.state.bookRevision).toBe(3n);
      }
      const measured = await apply(measurement, profile === undefined ? "rejected" : "committed");
      if (profile !== undefined) {
        expect(
          oracle.state.journals.at(-1)?.journal.postings.map((p) => p.bookValue.amount.toString()),
        ).toEqual(["50.00", "-50.00"]);
        await apply(scenario.reverse(measurement, 4n), "committed");
        expect(
          oracle.state.journals.at(-1)?.journal.postings.map((p) => p.bookValue.amount.toString()),
        ).toEqual(["-50.00", "50.00"]);
      }
      const retried = await new NativeLedger(f.open()).execute(measurement);
      expect(retried.value.originalResult).toEqual(measured.value.result);
      expect(retried.value.outcomeSequence).toBe(measured.value.outcomeSequence);
      expect(
        f.faults.statements.some((sql) => sql.includes("ORDER BY f.source_sequence")),
      ).toBeFalse();
    } finally {
      f.db.close();
    }
  }
});

test("native settlement resolves retained invoice and payment tuples independently of delimiter aliases", async () => {
  for (const profile of [undefined, STRUCTURAL_SOURCE_IDENTITY_PROFILE] as const) {
    const f = fixture(),
      base = genesis(),
      state = base.state;
    const initial = {
      ...base,
      state: createBookState(
        state.identity,
        state.periods,
        state.admissionSnapshot,
        state.policies,
        state.quantizationPolicies,
        state.accountingPolicySnapshot.policies,
        instant("2020-01-01T00:00:00Z"),
        profile,
      ),
    };
    let oracle = initial;
    const apply = async (command: BookCommand, disposition: "committed" | "rejected") => {
      const expected = evaluateOutcomePayload(oracle, command);
      expect(expected.transition.result.disposition).toBe(disposition);
      const actual = await new NativeLedger(f.open()).execute(command);
      expect(actual.value.result).toEqual(expected.transition.result);
      const retained = await f
        .open()
        .transact((view) => ({ write: false, value: view.outcome(command.id) }));
      if (expected.encoded === null) throw new Error("Expected a retained source-family outcome");
      expect(retained.value?.encoded).toBe(expected.encoded);
      oracle = { state: expected.transition.state, protocol: expected.transition.protocol };
      return actual;
    };
    try {
      await new NativeLedger(f.repository).provision(initial, activation());
      const active = evaluateOutcomePayload(initial, activation());
      oracle = { state: active.transition.state, protocol: active.transition.protocol };
      const template = openItemRecognition("invoice", 1n);
      const invoice = sealCommand({
        ...template,
        id: commandId("a:b"),
        request: {
          value: {
            ...template.request.value,
            recognitionSource: createCanonicalPostingReference(
              canonicalPostingReferenceId("invoice-source"),
              BOOK,
              template.resolved.journal.id,
              workflowValue(template.resolved.journal.postings[0]),
              effectKey("a:b:journal:0"),
            ),
          },
        },
      });
      const shadowTemplate = posting("invoice:a", 2n);
      const invoiceShadow = sealCommand({ ...shadowTemplate, id: commandId("b") });
      await apply(invoice, "committed");
      await apply(invoiceShadow, "committed");
      const payment = settlementPayment("payment", 3n, [
        { openItemId: invoice.request.value.id, amount: 100n },
      ]);
      const paymentJournal = workflowValue(payment.resolved[0]);
      const paymentPosting = posting("unused", 3n);
      if (paymentPosting.type !== "postJournal") throw new Error("Expected journal fixture");
      const postedPayment = sealCommand({
        ...paymentPosting,
        id: commandId("c:d"),
        resolved: paymentJournal,
      });
      await apply(postedPayment, "committed");
      await apply(sealCommand({ ...posting("payment:c", 4n), id: commandId("d") }), "committed");
      expect(oracle.state.journals.map((row) => `${row.journal.id}:${row.effectKey}`)).toEqual([
        "invoice:a:b:journal:0",
        "invoice:a:b:journal:0",
        "payment:c:d:journal:0",
        "payment:c:d:journal:0",
      ]);
      const settled = sealCommand({
        ...payment,
        expectedBookRevision: 5n,
        resolved: [],
        request: {
          ...payment.request,
          settlement: {
            ...payment.request.settlement,
            settlementSource: createCanonicalPostingReference(
              canonicalPostingReferenceId("payment-source"),
              BOOK,
              paymentJournal.journal.id,
              workflowValue(paymentJournal.journal.postings[0]),
              effectKey("c:d:journal:0"),
            ),
          },
        },
      });
      const result = await apply(settled, profile === undefined ? "rejected" : "committed");
      expect(oracle.state.journals).toHaveLength(4);
      expect(
        oracle.state.accountingState.settlementAllocations.map((allocation) =>
          allocation.allocatedBookValue.toString(),
        ),
      ).toEqual(profile === undefined ? [] : ["100/1"]);
      const retried = await new NativeLedger(f.open()).execute(settled);
      expect(retried.value.originalResult).toEqual(result.value.result);
      expect(retried.value.outcomeSequence).toBe(result.value.outcomeSequence);
      expect(
        f.faults.statements.some((sql) => sql.includes("ORDER BY f.source_sequence")),
      ).toBeFalse();
    } finally {
      f.db.close();
    }
  }
});

test("native source lookup preserves the legacy delimiter winner and the structural opt-in", async () => {
  for (const profile of [undefined, STRUCTURAL_SOURCE_IDENTITY_PROFILE] as const) {
    const f = fixture(),
      copy = fixture("source-identity-copy");
    try {
      const scenario = allocationAndTaxWorkflow();
      const state = scenario.initial.state;
      const initial = {
        ...scenario.initial,
        state: createBookState(
          state.identity,
          state.periods,
          state.admissionSnapshot,
          state.policies,
          state.quantizationPolicies,
          state.accountingPolicySnapshot.policies,
          instant("2020-01-01T00:00:00Z"),
          profile,
        ),
      };
      const source = workflowValue(scenario.commands[1]);
      const create = workflowValue(scenario.commands[2]);
      if (source.type !== "postJournal" || create.type !== "createAllocationSchedule")
        throw new Error("Invalid source fixture");
      const first = sealCommand({
        ...source,
        id: commandId("save"),
        resolved: {
          ...source.resolved,
          journal: { ...source.resolved.journal, id: journalId("workflow-source:alias") },
        },
      });
      const second = sealCommand({
        ...source,
        id: commandId("alias:save"),
        expectedBookRevision: 2n,
        resolved: {
          ...source.resolved,
          journal: {
            ...source.resolved.journal,
            postings: source.resolved.journal.postings.map((posting) => ({
              ...posting,
              id: identifier<"Posting">(`alias-${posting.id}`),
            })),
          },
        },
      });
      const schedule = sealCommand({
        ...create,
        expectedBookRevision: 3n,
        request: {
          ...create.request,
          source: createCanonicalPostingReference(
            canonicalPostingReferenceId("alias-source"),
            BOOK,
            first.resolved.journal.id,
            workflowValue(first.resolved.journal.postings[0]),
            effectKey("save:journal:0"),
          ),
        },
      });
      const originalPosting = workflowValue(first.resolved.journal.postings[0]);
      const invalidSources = [
        createCanonicalPostingReference(
          canonicalPostingReferenceId("wrong-account"),
          BOOK,
          first.resolved.journal.id,
          { ...originalPosting, accountId: INCOME },
          effectKey("save:journal:0"),
        ),
        createCanonicalPostingReference(
          canonicalPostingReferenceId("wrong-units"),
          BOOK,
          first.resolved.journal.id,
          {
            ...originalPosting,
            units: {
              ...originalPosting.units,
              canonicalNumber: originalPosting.units.canonicalNumber.add(ExactRational.of(1n, 1n)),
            },
          },
          effectKey("save:journal:0"),
        ),
        createCanonicalPostingReference(
          canonicalPostingReferenceId("wrong-effect"),
          BOOK,
          first.resolved.journal.id,
          originalPosting,
          effectKey("alias:save:journal:0"),
        ),
      ];
      const commands = [
        activation(),
        first,
        second,
        ...invalidSources.map((source, index) =>
          sealCommand({
            ...schedule,
            id: commandId(`invalid-allocation-source-${index}`),
            request: { ...schedule.request, source },
          }),
        ),
        schedule,
      ];
      let oracle = initial;
      const ledger = new NativeLedger(f.repository);
      const receipts = new Map<string, { result: BookCommandResult; sequence: string }>();
      for (const command of commands) {
        const expected = evaluateOutcomePayload(oracle, command);
        const actual =
          command.type === "activateBook"
            ? await ledger.provision(initial, command)
            : (await ledger.execute(command)).value;
        expect(actual.result).toEqual(expected.transition.result);
        const stored = await f.repository.transact((view) => ({
          write: false,
          value: view.outcome(command.id),
        }));
        if (stored.value === null || expected.encoded === null || actual.outcomeSequence === null)
          throw new Error("Source-identity command must retain an exact outcome");
        expect(stored.value.encoded).toBe(expected.encoded);
        receipts.set(command.id, { result: actual.result, sequence: actual.outcomeSequence });
        if (command.id.startsWith("invalid-allocation-source-")) {
          expect(actual.result.disposition).toBe("rejected");
          expect(
            actual.result.diagnostics.some(
              (diagnostic) => diagnostic.code === "unresolved_accounting_input",
            ),
          ).toBeTrue();
          expect(expected.transition.state.bookRevision).toBe(3n);
        }
        oracle = { state: expected.transition.state, protocol: expected.transition.protocol };
      }
      expect(oracle.state.accountingState.allocationSchedules).toHaveLength(
        profile === undefined ? 0 : 1,
      );
      expect(oracle.protocol.retainedResults.at(-1)?.outcome).toBe(
        profile === undefined ? "rejected" : "committed",
      );
      const before = f.db
        .query("SELECT command_id, body FROM ledger_native_outcomes ORDER BY sequence")
        .all();
      const tip = await f.repository.transact((view) => ({ write: false, value: view.head }));
      expect((await verifyNativeLedgerCopy(f.open(), copy.open(), tip.head)).sourceHead).toEqual(
        tip.head,
      );
      for (const command of commands.filter((value) => value.type !== "activateBook")) {
        const original = receipts.get(command.id);
        if (original === undefined) throw new Error("Missing original source-identity receipt");
        for (const owner of [f, copy]) {
          const retried = await new NativeLedger(owner.open()).execute(command);
          expect(retried.value.result.disposition).toBe("replayed");
          expect(retried.value.originalResult).toEqual(original.result);
          expect(retried.value.outcomeSequence).toBe(original.sequence);
        }
      }
      expect(
        f.db.query("SELECT command_id, body FROM ledger_native_outcomes ORDER BY sequence").all(),
      ).toEqual(before);
      expect(
        copy.db
          .query("SELECT command_id, body FROM ledger_native_outcomes ORDER BY sequence")
          .all(),
      ).toEqual(before);
      expect(
        f.faults.statements.some((sql) => sql.includes("ORDER BY f.source_sequence")),
      ).toBeFalse();
    } finally {
      f.db.close();
      copy.db.close();
    }
  }
});

test("native disposal publishes both journals atomically and closes in posting order, not journal ID order", async () => {
  for (const fault of [
    "INSERT INTO ledger_native_outcomes",
    "INSERT INTO ledger_native_facts",
    "UPDATE ledger_native_book",
  ]) {
    const f = fixture();
    const copy = fixture("disposal-copy");
    try {
      const scenario = allocationAndTaxWorkflow("1.1.0");
      const ledger = new NativeLedger(f.repository);
      let oracle = scenario.initial;
      for (const command of scenario.commands) {
        const expected = evaluateOutcomePayload(oracle, command);
        expect(expected.transition.result.disposition).toBe("committed");
        if (command.type === "activateBook") await ledger.provision(scenario.initial, command);
        else
          expect((await ledger.execute(command)).value.result).toEqual(expected.transition.result);
        oracle = { state: expected.transition.state, protocol: expected.transition.protocol };
      }
      const termination = workflowTerminationCommand(scenario);
      const completionTemplate = posting("aaa-completion");
      if (completionTemplate.type !== "postJournal") throw new Error("Expected journal fixture");
      const template = completionTemplate.resolved.journal;
      const journal = {
        ...template,
        accountingDate: localDate("2026-03-31"),
        postings: template.postings.map((posting, index) => ({
          ...posting,
          accountId: index === 0 ? CASH : scenario.accounts.expense,
          units: {
            ...posting.units,
            canonicalNumber: ExactRational.of(index === 0 ? 10n : -10n, 1n),
          },
          bookValue: {
            ...posting.bookValue,
            amount: ExactDecimal.parse(index === 0 ? "10" : "-10"),
          },
        })),
      };
      const resolved = resolveJournal(
        journal,
        oracle.state.policies,
        oracle.state.identity.ownerId,
        workflowValue(oracle.state.quantizationPolicies[0]),
        journal.postings.map((posting) => posting.bookValue.amount.toRational()),
      );
      if (!("journal" in resolved)) throw new Error("Invalid completion fixture");
      const disposal = sealCommand({
        ...termination,
        request: { ...termination.request, kind: "disposal" as const },
        disposalJournal: resolved,
      });
      const expected = evaluateOutcomePayload(oracle, disposal);
      expect(expected.transition.result.disposition).toBe("committed");
      expect(
        expected.transition.state.journals
          .slice(-2)
          .map((booked) =>
            booked.journal.postings.map((posting) => posting.bookValue.amount.toString()),
          ),
      ).toEqual([
        ["10.00", "-10.00"],
        ["10", "-10"],
      ]);
      f.faults.statement = fault;
      await expect(ledger.execute(disposal)).rejects.toThrow("Injected SQL failure");
      const missing = await f.repository.transact((view) => ({
        write: false,
        value: view.facts([
          { collection: "journals", key: "workflow-crash-terminal-journal" },
          { collection: "journals", key: "aaa-completion" },
          { collection: "allocationScheduleRevisions", key: termination.request.id },
        ]),
      }));
      expect(missing.value).toEqual([null, null, null]);
      expect(missing.head.sequence).toBe("8");
      f.faults.lostReply = true;
      await expect(ledger.execute(disposal)).rejects.toThrow("Lost durability confirmation");
      const replay = await new NativeLedger(f.open()).execute(disposal);
      expect(replay.value.originalResult).toEqual(expected.transition.result);
      expect(replay.head.sequence).toBe("9");
      oracle = { state: expected.transition.state, protocol: expected.transition.protocol };
      const close = sealCommand({
        ...closing("after-disposal", oracle.state.bookRevision),
        periodId: fiscalPeriodId("march"),
        issuedAt: instant("2026-04-01T00:00:00Z"),
        completedAt: instant("2026-04-01T00:00:01Z"),
        committedAt: instant("2026-04-01T00:00:02Z"),
      });
      expect((await ledger.execute(close)).value.result).toEqual(
        evaluateOutcomePayload(oracle, close).transition.result,
      );
      const tip = await f.repository.transact((view) => ({ write: false, value: view.head }));
      expect(
        (await verifyNativeLedgerCopy(f.repository, copy.repository, tip.head)).sourceHead.sequence,
      ).toBe("10");
    } finally {
      f.db.close();
      copy.db.close();
    }
  }
});

test("native allocation revision fails closed on deleted index, recognition, lifecycle or revision history", async () => {
  for (const collection of [
    "allocationOrdinals",
    "allocationRecognitions",
    "allocationHistory",
    "allocationScheduleRevisions",
  ]) {
    const f = fixture();
    try {
      const scenario = allocationAndTaxWorkflow("1.1.0");
      const ledger = new NativeLedger(f.repository);
      const count = collection === "allocationScheduleRevisions" ? 5 : 4;
      for (const command of scenario.commands.slice(0, count)) {
        if (command.type === "activateBook") await ledger.provision(scenario.initial, command);
        else await ledger.execute(command);
      }
      f.db
        .query("DELETE FROM ledger_native_facts WHERE json_extract(identity, '$[0]') = ?")
        .run(collection);
      const template = workflowValue(scenario.commands[4]);
      const command = sealCommand({
        ...template,
        id: commandId("after-corruption"),
        expectedBookRevision: BigInt(count),
      });
      await expect(ledger.execute(command)).rejects.toThrow(
        "native_ledger_allocation_history_incomplete",
      );
      const after = await f.repository.transact((view) => ({
        write: false,
        value: view.outcome(command.id),
      }));
      expect(after.value).toBeNull();
      expect(after.head.sequence).toBe(count.toString());
    } finally {
      f.db.close();
    }
  }
});

test("native allocation recognition uses bounded point reads independent of retained book history", async () => {
  const samples: { installments: number; history: number; sql: number; milliseconds: number }[] =
    [];
  for (const [installments, history, amount] of [
    [1, 0, "100.00"],
    [120, 0, "0.83"],
    [1200, 0, "0.08"],
    [120, 1000, "0.83"],
  ] as const) {
    const f = fixture();
    try {
      const scenario = allocationAndTaxWorkflow("1.1.0");
      const ledger = new NativeLedger(f.repository);
      await ledger.provision(scenario.initial, activation());
      await ledger.execute(workflowValue(scenario.commands[1]));
      for (let i = 0; i < history; i++) {
        const result = await ledger.execute(posting(`unrelated-${i}`, BigInt(i + 2)));
        expect(result.value.result.disposition).toBe("committed");
      }
      const template = workflowValue(scenario.commands[2]);
      if (template.type !== "createAllocationSchedule") throw new Error("Expected schedule");
      const schedule = sealCommand({
        ...template,
        expectedBookRevision: BigInt(history + 2),
        request: {
          ...template.request,
          endsOn: localDate(
            installments === 1 ? "2026-01-31" : `${2025 + installments / 12}-12-31`,
          ),
        },
      });
      expect((await ledger.execute(schedule)).value.result.disposition).toBe("committed");
      const recognition = sealCommand({
        ...workflowValue(scenario.commands[3]),
        expectedBookRevision: BigInt(history + 3),
      });
      f.faults.statements.length = 0;
      const start = performance.now();
      const result = await new NativeLedger(f.open()).execute(recognition);
      const milliseconds = performance.now() - start;
      expect(result.value.result.disposition).toBe("committed");
      expect(f.faults.statements.length).toBeLessThanOrEqual(14);
      expect(
        f.faults.statements.some((sql) => sql.includes("ORDER BY f.source_sequence")),
      ).toBeFalse();
      samples.push({ installments, history, sql: f.faults.statements.length, milliseconds });
      const rows = await f.repository.transact((view) => ({
        write: false,
        value: view.facts([{ collection: "journals", key: "workflow-recognition-journal" }]),
      }));
      const decoded = decodeBookRow(
        "state.journals",
        workflowValue(rows.value[0] ?? undefined).encoded,
      );
      expect(decoded.disposition).toBe("decoded");
      if (decoded.disposition === "decoded")
        expect(
          decoded.row.journal.postings.map((posting) => posting.bookValue.amount.toString()),
        ).toEqual([amount, `-${amount}`]);
    } finally {
      f.db.close();
    }
  }
  expect(workflowValue(samples[1]).sql).toBe(workflowValue(samples[3]).sql);
  console.info(JSON.stringify({ nativeAllocationRecognitionSamples: samples }));
});

test("native allocation duplicate ordinals, global IDs and incomplete prior recognition lists match canonical rejections", async () => {
  const f = fixture();
  try {
    const scenario = allocationAndTaxWorkflow("1.1.0");
    const ledger = new NativeLedger(f.repository);
    let oracle = scenario.initial;
    for (const command of scenario.commands.slice(0, 4)) {
      const expected = evaluateOutcomePayload(oracle, command);
      if (command.type === "activateBook") await ledger.provision(scenario.initial, command);
      else await ledger.execute(command);
      oracle = { state: expected.transition.state, protocol: expected.transition.protocol };
    }
    const recognition = workflowValue(scenario.commands[3]),
      revision = workflowValue(scenario.commands[4]),
      schedule = workflowValue(scenario.commands[2]);
    if (
      recognition.type !== "recognizeScheduledAllocation" ||
      revision.type !== "reviseAllocationSchedule" ||
      schedule.type !== "createAllocationSchedule"
    )
      throw new Error("Expected allocation fixtures");
    for (const command of [
      sealCommand({
        ...recognition,
        id: commandId("same-ordinal"),
        expectedBookRevision: 4n,
        request: {
          ...recognition.request,
          id: identifier<"AllocationRecognition">("another-recognition"),
        },
      }),
      sealCommand({
        ...recognition,
        id: commandId("same-global-id"),
        expectedBookRevision: 4n,
        request: { ...recognition.request, ordinal: 2n },
      }),
      sealCommand({
        ...revision,
        id: commandId("omitted-prior"),
        request: { ...revision.request, priorRecognitionIds: [] },
      }),
      sealCommand({ ...schedule, id: commandId("duplicate-schedule"), expectedBookRevision: 4n }),
    ]) {
      const expected = evaluateOutcomePayload(oracle, command);
      expect(expected.transition.result.disposition).toBe("rejected");
      expect((await ledger.execute(command)).value.result).toEqual(expected.transition.result);
      oracle = { state: expected.transition.state, protocol: expected.transition.protocol };
      expect((await new NativeLedger(f.open()).execute(command)).value.originalResult).toEqual(
        expected.transition.result,
      );
    }
  } finally {
    f.db.close();
  }
});

const scope = {
  tenantId: "native-test",
  bookId: BOOK,
  objectId: "native-book",
  namespaceId: "native-test",
  generation: "0",
};
test("large admitted chart splits only fixed current coordinates without bypassing integrity or read bounds", async () => {
  const f = fixture();
  try {
    const initial = chartGenesis(1000);
    const ledger = new NativeLedger(f.repository);
    await ledger.provision(initial, activation());
    const rows = f.db
      .query("SELECT identity,body FROM ledger_native_facts WHERE identity LIKE '[\"current\",%'")
      .all() as { identity: string; body: string }[];
    expect(rows).toHaveLength(7);
    expect(rows.reduce((n, row) => n + Buffer.byteLength(row.body), 0)).toBeGreaterThan(1048576);
    expect(Math.max(...rows.map((row) => Buffer.byteLength(row.body)))).toBeLessThan(1048576);
    await expect(
      f.repository.transact((view) => ({
        write: false,
        value: view.facts(
          rows.map((row) => ({
            collection: "current",
            key: JSON.parse(row.identity)[1] as string,
          })),
        ),
      })),
    ).rejects.toThrow("native_ledger_read_limit");
    const identity = JSON.stringify(["current", "configuration"]);
    const original = rows.find((row) => row.identity === identity)?.body;
    if (original === undefined) throw new Error("Missing configuration");
    f.db
      .query("UPDATE ledger_native_facts SET body=? WHERE identity=?")
      .run(original.replace("Unused account 0", "Broken account 0"), identity);
    const command = posting("large-chart", 1n);
    await expect(ledger.execute(command)).rejects.toThrow("native_ledger_fact_corrupt");
    expect(f.db.query("SELECT count(*) AS n FROM ledger_native_outcomes").get()).toEqual({ n: 1 });
    f.db.query("UPDATE ledger_native_facts SET body=? WHERE identity=?").run(original, identity);
    const active = evaluateOutcomePayload(initial, activation()).transition;
    const expected = evaluateOutcomePayload(
      { state: active.state, protocol: active.protocol },
      command,
    ).transition;
    f.reset();
    expect((await ledger.execute(command)).value.result).toEqual(expected.result);
    expect(f.faults.statements).toHaveLength(14);
    const restarted = new NativeLedger(f.open());
    expect((await restarted.execute(command)).value.originalResult).toEqual(expected.result);
    const next = posting("large-chart-next", 2n);
    const nextExpected = evaluateOutcomePayload(
      { state: expected.state, protocol: expected.protocol },
      next,
    ).transition.result;
    f.reset();
    expect((await restarted.execute(next)).value.result).toEqual(nextExpected);
    expect(f.faults.statements).toHaveLength(7);
  } finally {
    f.db.close();
  }
});

test("ledger uses only the repository contract for exact commits, rejections and uncertain retries", async () => {
  const f = fixture();
  try {
    // Intentionally expose no concrete repository methods or private SQLite state.
    const port: NativeLedgerRepository = {
      scope: f.repository.scope,
      provision: (...args) => f.repository.provision(...args),
      transact: (evaluate, admit, prepare) => f.repository.transact(evaluate, admit, prepare),
    };
    let oracle = genesis();
    const initial = activation();
    const activated = evaluateOutcomePayload(oracle, initial).transition;
    expect((await new NativeLedger(port).provision(oracle, initial)).result).toEqual(
      activated.result,
    );
    oracle = { state: activated.state, protocol: activated.protocol };
    for (const [id, revision, disposition] of [
      ["port-committed", 1n, "committed"],
      ["port-rejected", 0n, "rejected"],
    ] as const) {
      const command = posting(id, revision);
      const expected = evaluateOutcomePayload(oracle, command);
      const saved = await new NativeLedger(port).execute(command);
      expect(saved.value.result.disposition).toBe(disposition);
      expect(saved.value.result).toEqual(expected.transition.result);
      const retry = await new NativeLedger(port).execute(command);
      expect(retry.value.result.disposition).toBe("replayed");
      expect(retry.value.originalResult).toEqual(expected.transition.result);
      expect(retry.value.outcomeSequence).toBe(saved.value.outcomeSequence);
      const stored = await port.transact((view) => ({ write: false, value: view.outcome(id) }));
      if (expected.encoded === null) throw new Error("Expected retained oracle outcome");
      expect(stored.value?.encoded).toBe(expected.encoded);
      oracle = { state: expected.transition.state, protocol: expected.transition.protocol };
    }
    const command = posting("port-uncertain", oracle.state.bookRevision);
    const expected = evaluateOutcomePayload(oracle, command);
    f.faults.lostReply = true;
    await expect(new NativeLedger(port).execute(command)).rejects.toThrow(
      "Lost durability confirmation",
    );
    const recovered = await new NativeLedger(port).execute(command);
    expect(recovered.value.result.disposition).toBe("replayed");
    expect(recovered.value.originalResult).toEqual(expected.transition.result);
    expect(recovered.head.sequence).toBe("4");
  } finally {
    f.db.close();
  }
});

test("repository admission is rechecked after deferred publication preparation", async () => {
  const f = fixture();
  try {
    await new NativeLedger(f.repository).provision(genesis(), activation());
    const entered = Promise.withResolvers<void>();
    const release = Promise.withResolvers<void>();
    let allowed = true;
    const ledger = new NativeLedger(f.repository, async () => {
      entered.resolve();
      await release.promise;
    });
    const pending = ledger
      .execute(posting("revoked-during-prepare"), () => {
        if (!allowed) throw new Error("revoked during preparation");
      })
      .then(
        () => null,
        (error: unknown) => error,
      );
    await entered.promise;
    allowed = false;
    release.resolve();
    expect(await pending).toEqual(new Error("revoked during preparation"));
    const current = await f.repository.transact((view) => ({
      write: false,
      value: view.outcome("revoked-during-prepare"),
    }));
    expect(current.value).toBeNull();
    expect(current.head.sequence).toBe("1");
  } finally {
    f.db.close();
  }
});

function fixture(objectId = scope.objectId, queueLimits?: LedgerQueueLimits) {
  const selectedScope = { ...scope, objectId };
  const db = new Database(":memory:");
  db.exec(
    "PRAGMA synchronous = OFF; PRAGMA journal_mode = MEMORY; PRAGMA cache_size = -64000; PRAGMA temp_store = MEMORY;",
  );
  db.exec("PRAGMA foreign_keys = ON");
  const faults = {
    statement: "",
    lostReply: false,
    failSync: false,
    fence: "0",
    pending: false,
    statements: [] as string[],
    transactions: 0,
  };
  const stmtCache = new Map<string, ReturnType<Database["query"]>>();
  const storage: SqliteStorage = {
    sql: {
      exec(sql, ...bindings) {
        faults.statements.push(sql);
        let stmt = stmtCache.get(sql);
        if (!stmt) {
          stmt = db.query(sql);
          stmtCache.set(sql, stmt);
        }
        const rows = stmt.all(
          ...bindings.map((v) => (v instanceof ArrayBuffer ? new Uint8Array(v) : v)),
        ) as Record<string, unknown>[];
        if (faults.statement && sql.startsWith(faults.statement)) {
          faults.statement = "";
          throw new Error("Injected SQL failure");
        }
        if (faults.lostReply && sql.startsWith("UPDATE ledger_native_book")) {
          faults.lostReply = false;
          faults.failSync = true;
        }
        return rows;
      },
    },
    transactionSync(operation) {
      faults.transactions++;
      return db.transaction(operation)();
    },
    async sync() {
      if (faults.failSync) {
        faults.failSync = false;
        throw new Error("Lost durability confirmation");
      }
    },
  };
  const open = () =>
    new SqliteLedgerRepository(
      storage,
      selectedScope,
      objectId,
      () => ({ fence: faults.fence, pending: faults.pending }),
      queueLimits,
    );
  const repository = open();
  const reset = () => {
    faults.statements = [];
    faults.transactions = 0;
  };
  return { db, storage, repository, faults, open, reset };
}
function prepare(before: DurableBookAggregate, command: ReturnType<typeof activation>) {
  const evaluated = evaluateOutcomePayload(before, command);
  if (evaluated.encoded === null) throw new Error("Test requires a newly retained result");
  const facts =
    evaluated.transition.intent?.effects.flatMap((effect) =>
      effect.type === "journal"
        ? [
            {
              collection: "journals",
              key: effect.booked.journal.id,
              encoded: encodeBookRow("state.journals", effect.booked),
            },
          ]
        : [],
    ) ?? [];
  const decision: NativeLedgerDecision = { encodedOutcome: evaluated.encoded, facts };
  return {
    decision,
    aggregate: { state: evaluated.transition.state, protocol: evaluated.transition.protocol },
    result: evaluated.transition.result,
  };
}
async function activate(f: ReturnType<typeof fixture>) {
  await f.repository.provision(encodeDurableBook(genesis()));
  const active = prepare(genesis(), activation());
  await f.repository.transact(() => ({
    write: true,
    decision: active.decision,
    value: active.result,
  }));
  return active.aggregate;
}

test.each([false, true])(
  "native tax commits exact generated postings, identities, periods and replayable facts (structural groups: %s)",
  async (structuralGroups) => {
    const scenario = taxWorkflow(structuralGroups);
    const f = fixture();
    const staging = fixture("tax-staging");
    let oracle = scenario.initial;
    try {
      const active = evaluateOutcomePayload(oracle, activation());
      oracle = { state: active.transition.state, protocol: active.transition.protocol };
      await new NativeLedger(f.repository).provision(scenario.initial, activation());
      const apply = async (input: BookCommand, disposition: BookCommandResult["disposition"]) => {
        const expected = evaluateOutcomePayload(oracle, input);
        expect(expected.transition.result.disposition).toBe(disposition);
        const actual = await new NativeLedger(f.open()).execute(input);
        expect(actual.value.result).toEqual(expected.transition.result);
        if (expected.encoded === null) throw new Error("Expected retained tax result");
        const stored = await f.repository.transact((view) => ({
          write: false,
          value: view.outcome(input.id),
        }));
        expect(stored.value?.encoded).toBe(expected.encoded);
        oracle = { state: expected.transition.state, protocol: expected.transition.protocol };
        return actual;
      };
      f.reset();
      await apply(scenario.command, "committed");
      expect(oracle.state.accountingState.taxDeterminations).toHaveLength(1);
      const journal = oracle.state.journals[0];
      if (journal === undefined) throw new Error("Expected generated tax journal");
      expect(
        journal.journal.postings.map((posting) => [
          posting.accountId,
          posting.bookValue.amount.toRational().toString(),
        ]),
      ).toEqual([
        [scenario.accounts.expense, "155/1"],
        [scenario.accounts.inputTax, "31/2"],
        [scenario.accounts.payable, "-341/2"],
      ]);
      const clone = (id: string, request: Partial<typeof scenario.command.request> = {}) =>
        sealCommand({
          ...scenario.command,
          id: commandId(id),
          expectedBookRevision: oracle.state.bookRevision,
          request: { ...scenario.command.request, ...request },
        });
      await apply(clone("same-tax-id"), "rejected");
      await apply(
        clone("same-journal-id", { id: identifier<"TaxDetermination">("new-tax") }),
        "rejected",
      );
      await apply(
        clone("same-posting-id", {
          id: identifier<"TaxDetermination">("new-tax"),
          sourceTransactionId: identifier<"JournalTransaction">("new-source"),
        }),
        "rejected",
      );
      await apply(
        clone("missing-policy", {
          lines: scenario.command.request.lines.map((line) => ({
            ...line,
            policyId: policyId("missing-policy"),
          })),
        }),
        "rejected",
      );
      const close = closing("tax-close", oracle.state.bookRevision);
      await apply(
        sealCommand({
          ...close,
          periodId: fiscalPeriodId("march"),
          issuedAt: scenario.command.issuedAt,
          completedAt: scenario.command.completedAt,
          committedAt: scenario.command.committedAt,
        }),
        "committed",
      );
      await apply(
        clone("closed-tax", {
          id: identifier<"TaxDetermination">("closed-tax"),
          sourceTransactionId: identifier<"JournalTransaction">("closed-tax-source"),
          lines: scenario.command.request.lines.map((line, index) => ({
            ...line,
            sourcePostingId: identifier<"Posting">(`closed-source-${index}`),
            counterpartyPostingId: identifier<"Posting">(`closed-counter-${index}`),
          })),
        }),
        "rejected",
      );
      const retry = await new NativeLedger(f.open()).execute(scenario.command);
      expect(retry.value.result.disposition).toBe("replayed");
      expect(retry.value.outcomeSequence).toBe("2");
      const source = await f.repository.transact((view) => ({ write: false, value: view.head }));
      const verified = await verifyNativeLedgerCopy(f.repository, staging.repository, source.head);
      expect(verified.sourceHead.sequence).toBe("8");
    } finally {
      f.db.close();
      staging.db.close();
    }
  },
);

test("native tax preserves exclusive/inclusive purchase, sale and credit arithmetic", async () => {
  for (const direction of ["purchase", "purchaseCredit", "sale", "saleCredit"] as const)
    for (const inclusive of [false, true]) {
      const f = fixture();
      const scenario = taxWorkflow();
      const base = scenario.initial.state;
      const policy = base.accountingPolicySnapshot.policies[0];
      const line = scenario.command.request.lines[0];
      if (policy?.kind !== "taxDetermination" || line === undefined)
        throw new Error("Expected tax fixture");
      const sale = direction === "sale" || direction === "saleCredit";
      const components = policy.components.map((component) => {
        const { contentHash: _priorHash, ...body } = component;
        const updated = {
          ...body,
          inclusion: inclusive ? ("inclusive" as const) : ("exclusive" as const),
          treatment: sale ? ("outputTax" as const) : ("inputTax" as const),
          recoverability: sale ? ("nonRecoverable" as const) : ("recoverable" as const),
          recoverableShare: ExactRational.of(sale ? 0n : 1n, 1n),
        };
        return {
          ...updated,
          contentHash: hashAccountingPolicyArtifact("TaxPolicyComponent", updated),
        };
      });
      const initial = {
        protocol: scenario.initial.protocol,
        state: createBookState(
          base.identity,
          base.periods,
          base.admissionSnapshot,
          base.policies,
          base.quantizationPolicies,
          [{ ...policy, components }],
          base.activeConfigurationSnapshot.effectiveAt,
        ),
      };
      const command = sealCommand({
        ...scenario.command,
        request: {
          ...scenario.command.request,
          direction,
          lines: [
            {
              ...line,
              amountIncludesTax: inclusive,
              statedAmount: ExactRational.of(inclusive ? 110n : 100n, 1n),
              sourceAccountId: sale ? INCOME : scenario.accounts.expense,
              payableAccountId: sale ? CASH : scenario.accounts.payable,
            },
          ],
        },
      });
      try {
        const ledger = new NativeLedger(f.repository);
        await ledger.provision(initial, activation());
        const actual = await ledger.execute(command);
        const active = evaluateOutcomePayload(initial, activation());
        const expected = evaluateOutcomePayload(
          { state: active.transition.state, protocol: active.transition.protocol },
          command,
        );
        expect(actual.value.result.disposition).toBe("committed");
        expect(actual.value.result).toEqual(expected.transition.result);
        const sign = direction === "purchase" || direction === "saleCredit" ? 1n : -1n;
        const postings = expected.transition.state.journals[0]?.journal.postings;
        expect(
          postings?.map((posting) => posting.bookValue.amount.toRational().toString()),
        ).toEqual([`${100n * sign}/1`, `${10n * sign}/1`, `${-110n * sign}/1`]);
      } finally {
        f.db.close();
      }
    }
});

test("native tax batches generated posting identities as line and posting counts grow", async () => {
  for (const count of [1, 10, 100]) {
    const f = fixture();
    const scenario = taxWorkflow();
    const base = scenario.initial.state;
    const templateAccount = base.admissionSnapshot.accounts[0];
    const templateLine = scenario.command.request.lines[0];
    if (templateAccount === undefined || templateLine === undefined)
      throw new Error("Expected tax workload fixture");
    const accounts = Array.from({ length: count }, (_, index) => ({
      ...templateAccount,
      id: accountId(`tax-expense-${index}`),
      code: `tax-expense-${index}`,
    }));
    const initial = {
      protocol: scenario.initial.protocol,
      state: createBookState(
        base.identity,
        base.periods,
        { ...base.admissionSnapshot, accounts: [...base.admissionSnapshot.accounts, ...accounts] },
        base.policies,
        base.quantizationPolicies,
        base.accountingPolicySnapshot.policies,
        base.activeConfigurationSnapshot.effectiveAt,
      ),
    };
    const command = sealCommand({
      ...scenario.command,
      request: {
        ...scenario.command.request,
        lines: accounts.map((account, index) => ({
          ...templateLine,
          lineId: `line-${index}`,
          sourceAccountId: account.id,
          sourcePostingId: identifier<"Posting">(`line-source-${index}`),
          counterpartyPostingId: identifier<"Posting">(`line-counter-${index}`),
        })),
      },
    });
    try {
      const ledger = new NativeLedger(f.repository);
      await ledger.provision(initial, activation());
      f.reset();
      const actual = await ledger.execute(command);
      expect(actual.value.result.disposition).toBe("committed");
      expect(f.faults.transactions).toBe(1);
      expect(f.faults.statements).toHaveLength(8);
      expect(
        f.faults.statements.some((statement) => statement.includes("ORDER BY f.source_sequence")),
      ).toBeFalse();
      const active = evaluateOutcomePayload(initial, activation());
      const expected = evaluateOutcomePayload(
        { state: active.transition.state, protocol: active.transition.protocol },
        command,
      );
      expect(actual.value.result).toEqual(expected.transition.result);
      expect(expected.transition.state.journals[0]?.journal.postings).toHaveLength(count + 2);
    } finally {
      f.db.close();
    }
  }
});

test("native tax rollback and lost durability replies preserve atomic generated journal and determination", async () => {
  for (const statement of [
    "INSERT INTO ledger_native_outcomes",
    "INSERT INTO ledger_native_facts",
    "UPDATE ledger_native_book",
  ]) {
    const f = fixture();
    const scenario = taxWorkflow();
    try {
      const ledger = new NativeLedger(f.repository);
      await ledger.provision(scenario.initial, activation());
      f.faults.statement = statement;
      await expect(ledger.execute(scenario.command)).rejects.toThrow("Injected SQL failure");
      const missing = await f.repository.transact((view) => ({
        write: false,
        value: view.facts([
          { collection: "taxDeterminations", key: scenario.command.request.id },
          { collection: "journals", key: scenario.command.request.sourceTransactionId },
        ]),
      }));
      expect(missing.head.sequence).toBe("1");
      expect(missing.value).toEqual([null, null]);
      f.faults.lostReply = true;
      await expect(ledger.execute(scenario.command)).rejects.toThrow(
        "Lost durability confirmation",
      );
      const retry = await new NativeLedger(f.open()).execute(scenario.command);
      expect(retry.value.result.disposition).toBe("replayed");
      expect(retry.head.sequence).toBe("2");
    } finally {
      f.db.close();
    }
  }
});

test("native queue overload and expiry leave no retained outcome and allow the same command to retry", async () => {
  const f = fixture(scope.objectId, { capacity: 2, maximumWaitMs: 20 });
  const gate = Promise.withResolvers<void>();
  try {
    const ledger = new NativeLedger(f.repository);
    await ledger.provision(genesis(), activation());
    const sync = f.storage.sync.bind(f.storage);
    let hold = true;
    f.storage.sync = async () => {
      if (hold) {
        hold = false;
        await gate.promise;
      }
      await sync();
    };
    const active = ledger.execute(posting("active", 1n));
    const expired = ledger.execute(posting("expired", 2n)).catch((error: unknown) => error);
    await expect(ledger.execute(posting("overload", 3n))).rejects.toThrow(
      "native_ledger_overloaded",
    );
    expect(await expired).toMatchObject({ message: "native_ledger_queue_timeout" });
    expect(f.db.query("SELECT count(*) AS n FROM ledger_native_outcomes").get()).toEqual({ n: 1 });
    gate.resolve();
    expect((await active).head.sequence).toBe("2");
    for (const [id, revision] of [
      ["expired", 2n],
      ["overload", 3n],
    ] as const) {
      const saved = await ledger.execute(posting(id, revision));
      expect(saved.value.result.disposition).toBe("committed");
      expect(saved.value.outcomeSequence).toBe((revision + 1n).toString());
    }
  } finally {
    gate.resolve();
    f.db.close();
  }
});

test("an uncertain active durability reply retains serialization while waiting commands expire", async () => {
  const f = fixture(scope.objectId, { capacity: 2, maximumWaitMs: 20 });
  const gate = Promise.withResolvers<void>();
  try {
    const ledger = new NativeLedger(f.repository);
    await ledger.provision(genesis(), activation());
    const sync = f.storage.sync.bind(f.storage);
    f.faults.lostReply = true;
    f.storage.sync = async () => {
      if (f.faults.failSync) await gate.promise;
      await sync();
    };
    const active = ledger.execute(posting("uncertain", 1n)).catch((error: unknown) => error);
    const waiting = ledger.execute(posting("not-started", 2n)).catch((error: unknown) => error);
    expect(await waiting).toMatchObject({ message: "native_ledger_queue_timeout" });
    // SQLite has committed, but no later evaluation ran while sync was unresolved.
    expect(f.db.query("SELECT count(*) AS n FROM ledger_native_outcomes").get()).toEqual({ n: 2 });
    gate.resolve();
    expect(await active).toMatchObject({ message: "Lost durability confirmation" });
    const retry = await ledger.execute(posting("uncertain", 1n));
    expect(retry.value.result.disposition).toBe("replayed");
    expect(retry.value.outcomeSequence).toBe("2");
    expect((await ledger.execute(posting("not-started", 2n))).value.result.disposition).toBe(
      "committed",
    );
  } finally {
    gate.resolve();
    f.db.close();
  }
});

test("queued reads recheck live book authority before observing a retained result", async () => {
  const f = fixture();
  const gate = Promise.withResolvers<void>();
  const entered = Promise.withResolvers<void>();
  try {
    const ledger = new NativeLedger(f.repository);
    await ledger.provision(genesis(), activation());
    const sync = f.storage.sync.bind(f.storage);
    let hold = true;
    f.storage.sync = async () => {
      if (hold) {
        hold = false;
        entered.resolve();
        await gate.promise;
      }
      await sync();
    };
    const active = ledger.execute(posting("revoked", 1n)).catch((error: unknown) => error);
    await entered.promise;
    let evaluated = false;
    const waiting = f.repository
      .transact((view) => {
        evaluated = true;
        return { write: false, value: view.outcome("activate") };
      })
      .catch((error: unknown) => error);
    f.faults.pending = true;
    gate.resolve();
    expect(await active).toMatchObject({ message: "native_ledger_authority_unavailable" });
    expect(await waiting).toMatchObject({ message: "native_ledger_authority_unavailable" });
    expect(evaluated).toBeFalse();
    expect(f.db.query("SELECT count(*) AS n FROM ledger_native_outcomes").get()).toEqual({ n: 1 });
    f.faults.pending = false;
    expect((await ledger.execute(posting("revoked", 1n))).value.result.disposition).toBe(
      "committed",
    );
  } finally {
    gate.resolve();
    f.db.close();
  }
});

test("native lifecycle matches kernel closing journals, dependent closes, exact reversals and staging replay", async () => {
  const f = fixture();
  const staging = fixture("period-staging");
  let oracle = genesis();
  const apply = async (
    command: BookCommand,
    disposition: BookCommandResult["disposition"] = "committed",
  ) => {
    const expected = evaluateOutcomePayload(oracle, command);
    expect(expected.transition.result.disposition).toBe(disposition);
    const ledger = new NativeLedger(f.open());
    if (command.type === "activateBook") await ledger.provision(genesis(), command);
    else await ledger.execute(command);
    const actual = await f.repository.transact((view) => ({
      write: false,
      value: view.outcome(command.id),
    }));
    if (expected.encoded === null) throw new Error("Expected retained oracle outcome");
    expect(actual.value?.encoded).toBe(expected.encoded);
    oracle = { state: expected.transition.state, protocol: expected.transition.protocol };
  };
  try {
    await apply(activation());
    await apply(posting("before-close", 1n));
    const config = configuration(oracle.state);
    if (config.type !== "replaceConfiguration") throw new Error("Expected configuration fixture");
    const january = config.periods[0];
    if (january === undefined) throw new Error("Expected January fixture");
    await apply(
      sealCommand({
        ...config,
        periods: [
          ...config.periods,
          {
            ...january,
            id: fiscalPeriodId("february"),
            sequence: 2n,
            label: "February",
            startsOn: localDate("2026-02-01"),
            endsOn: localDate("2026-02-28"),
          },
        ],
      }),
    );
    const closeJanuary = closing("january-close", oracle.state.bookRevision, true);
    await apply(closeJanuary);
    const original = oracle.state.journals.at(-1);
    if (original === undefined) throw new Error("Expected closing journal");
    await apply(
      sealCommand({
        ...closing("february-close", oracle.state.bookRevision),
        periodId: fiscalPeriodId("february"),
      }),
    );
    await apply(posting("closed-period-post", oracle.state.bookRevision), "rejected");
    await apply(reopening("missing-reversal", oracle.state.bookRevision), "rejected");
    await apply(reopening("january-reopen", oracle.state.bookRevision, original));
    expect(oracle.state.periodTransitions.at(-1)?.supersededCloseIds).toEqual([
      identifier<"ClosePackage">("january-close"),
      identifier<"ClosePackage">("february-close"),
    ]);
    expect(oracle.state.corrections.at(-1)).toMatchObject({
      originalJournalId: original.journal.id,
      correctionJournalId: "january-reopen-journal",
    });
    const statuses = await f.repository.transact((view) => ({
      write: false,
      value: view.facts([
        { collection: "periods", key: "january" },
        { collection: "periods", key: "february" },
        { collection: "closeStatuses", key: "january-close" },
        { collection: "closeStatuses", key: "february-close" },
      ]),
    }));
    expect(statuses.value.map((fact) => fact?.encoded)).toEqual([
      '{"status":"open","closeCount":"1"}',
      '{"status":"closed","closeCount":"1"}',
      "superseded",
      "superseded",
    ]);
    await apply(closing("january-reclose", oracle.state.bookRevision));
    expect(oracle.state.closePackages.at(-1)?.cycle).toBe(2n);
    f.reset();
    const retry = await new NativeLedger(f.open()).execute(closeJanuary);
    expect(retry.value.result.disposition).toBe("replayed");
    expect(
      f.faults.statements.some((sql) => sql.includes("ORDER BY f.source_sequence")),
    ).toBeFalse();
    const tip = (await f.repository.transact((view) => ({ write: false, value: view.head }))).value;
    expect(
      (await verifyNativeLedgerCopy(f.repository, staging.repository, tip)).verifiedFacts,
    ).toBeGreaterThan(25);
  } finally {
    f.db.close();
    staging.db.close();
  }
});

test("shared reopen admission retains dependent-close rejection and admits latest-first reversal", async () => {
  const f = fixture();
  let oracle = genesis();
  const ledger = new NativeLedger(f.repository);
  const apply = async (input: BookCommand) => {
    const expected = evaluateOutcomePayload(oracle, input);
    expect(expected.transition.result.disposition).toBe("committed");
    const actual =
      input.type === "activateBook"
        ? await ledger.provision(genesis(), input)
        : (await ledger.execute(input)).value;
    expect(actual.result).toEqual(expected.transition.result);
    oracle = { state: expected.transition.state, protocol: expected.transition.protocol };
  };
  try {
    await apply(activation());
    const config = configuration(oracle.state);
    if (config.type !== "replaceConfiguration" || config.periods[0] === undefined)
      throw new Error("Expected period fixture");
    await apply(
      sealCommand({
        ...config,
        periods: [
          ...config.periods,
          {
            ...config.periods[0],
            id: fiscalPeriodId("february"),
            sequence: 2n,
            label: "February",
            startsOn: localDate("2026-02-01"),
            endsOn: localDate("2026-02-28"),
          },
        ],
      }),
    );
    await apply(closing("jan-close", oracle.state.bookRevision));
    const february = closing("feb-close", oracle.state.bookRevision, true);
    if (february.closing === undefined) throw new Error("Expected closing journal fixture");
    await apply(
      sealCommand({
        ...february,
        periodId: fiscalPeriodId("february"),
        closing: {
          ...february.closing,
          journal: { ...february.closing.journal, accountingDate: localDate("2026-02-15") },
        },
      }),
    );
    const original = oracle.state.journals.at(-1);
    if (original === undefined) throw new Error("Expected retained closing journal");
    const unsafe = reopening("jan-first", oracle.state.bookRevision);
    const rejected = evaluateOutcomePayload(oracle, unsafe);
    expect(rejected.transition.result.disposition).toBe("rejected");
    expect(rejected.transition.result.diagnostics[0]?.code).toBe("invalid_correction_topology");
    expect(rejected.transition.result.diagnostics[0]?.path).toBe("command.periodId");
    expect(rejected.transition.state).toEqual(oracle.state);
    expect((await ledger.execute(unsafe)).value.result).toEqual(rejected.transition.result);
    oracle = { state: rejected.transition.state, protocol: rejected.transition.protocol };
    const after = await f.repository.transact((view) => ({
      write: false,
      value: view.outcome(unsafe.id),
    }));
    expect(after.value).not.toBeNull();
    const restarted = new NativeLedger(f.repository);
    expect((await restarted.execute(unsafe)).value.result).toEqual({
      ...rejected.transition.result,
      disposition: "replayed",
    });
    await apply(
      sealCommand({
        ...reopening("feb-first", oracle.state.bookRevision, original),
        periodId: fiscalPeriodId("february"),
      }),
    );
    await apply(reopening("jan-after-feb", oracle.state.bookRevision));
    // Repairing the book does not change the original command's durable answer.
    expect((await restarted.execute(unsafe)).value.result).toEqual({
      ...rejected.transition.result,
      disposition: "replayed",
    });
    expect(oracle.state.corrections).toHaveLength(1);
    expect(oracle.state.journals).toHaveLength(2);
    const forward = oracle.state.journals[0]?.journal.postings[0]?.bookValue.amount;
    const reverse = oracle.state.journals[1]?.journal.postings[0]?.bookValue.amount;
    if (forward === undefined || reverse === undefined)
      throw new Error("Expected closing and reversal postings");
    expect(forward.toRational().add(reverse.toRational()).isZero()).toBeTrue();
  } finally {
    f.db.close();
  }
});

test("first close atomically evolves old open-period facts and rolls back every participant", async () => {
  for (const statement of [
    "UPDATE ledger_native_facts",
    "INSERT INTO ledger_native_outcomes",
    "INSERT INTO ledger_native_facts",
    "UPDATE ledger_native_book",
  ]) {
    const f = fixture();
    try {
      const ledger = new NativeLedger(f.repository);
      await ledger.provision(genesis(), activation());
      const command = closing("fault-close", 1n, true);
      f.faults.statement = statement;
      await expect(ledger.execute(command)).rejects.toThrow("Injected SQL failure");
      const before = await f.repository.transact((view) => ({
        write: false,
        value: {
          outcome: view.outcome(command.id),
          period: view.facts([{ collection: "periods", key: "january" }])[0],
        },
      }));
      expect(before.head.sequence).toBe("1");
      expect(before.value.outcome).toBeNull();
      expect(before.value.period).toEqual({
        collection: "periods",
        key: "january",
        encoded: "open",
      });
      f.faults.lostReply = true;
      await expect(new NativeLedger(f.open()).execute(command)).rejects.toThrow(
        "Lost durability confirmation",
      );
      const retry = await new NativeLedger(f.open()).execute(command);
      expect(retry.value.result.disposition).toBe("replayed");
      expect(retry.value.outcomeSequence).toBe("2");
      const after = await f.repository.transact((view) => ({
        write: false,
        value: view.facts([{ collection: "periods", key: "january" }])[0],
      }));
      expect(after.value).toEqual({
        collection: "periods",
        key: "january",
        encoded: '{"status":"closed","closeCount":"1"}',
        mutable: true,
      });
    } finally {
      f.db.close();
    }
  }
});

test("period mutability cannot be upgraded by unrelated commands or conflicting prior state", async () => {
  for (const variant of [
    "ordinary",
    "foreign-period",
    "wrong-counter",
    "missing",
    "already-mutable",
  ] as const) {
    const f = fixture();
    try {
      await new NativeLedger(f.repository).provision(genesis(), activation());
      const active = prepare(genesis(), activation()).aggregate;
      const prepared = prepare(
        active,
        variant === "ordinary" ? posting("invalid-upgrade", 1n) : closing("invalid-upgrade", 1n),
      );
      if (variant === "missing")
        f.db.query("DELETE FROM ledger_native_facts WHERE identity=?").run('["periods","january"]');
      if (variant === "already-mutable")
        f.db
          .query("UPDATE ledger_native_facts SET mutable=1 WHERE identity=?")
          .run('["periods","january"]');
      const prior = f.db.query("SELECT * FROM ledger_native_facts ORDER BY identity").all();
      const decision: NativeLedgerDecision = {
        ...prepared.decision,
        upgradeOpenPeriod: variant === "foreign-period" ? "february" : "january",
        facts: [
          {
            collection: "periods",
            key: "january",
            mutable: true,
            encoded: JSON.stringify({
              status: "closed",
              closeCount: variant === "wrong-counter" ? "2" : "1",
            }),
          },
        ],
      };
      await expect(
        f.repository.transact(() => ({ write: true, decision, value: null })),
      ).rejects.toThrow(
        variant === "missing" || variant === "already-mutable"
          ? "native_ledger_period_upgrade_conflict"
          : "native_ledger_period_upgrade_invalid",
      );
      expect(f.db.query("SELECT * FROM ledger_native_facts ORDER BY identity").all()).toEqual(
        prior,
      );
      const after = await f.repository.transact((view) => ({
        write: false,
        value: view.outcome("invalid-upgrade"),
      }));
      expect(after.head.sequence).toBe("1");
      expect(after.value).toBeNull();
    } finally {
      f.db.close();
    }
  }
});

test("period maintenance fails closed on missing history, missing lifecycle state and escaped scan cursors", async () => {
  for (const damage of ["journal", "status", "package"]) {
    const f = fixture();
    try {
      const ledger = new NativeLedger(f.repository);
      await ledger.provision(genesis(), activation());
      await ledger.execute(posting("source", 1n));
      let input: BookCommand;
      if (damage === "journal") {
        f.db.query("DELETE FROM ledger_native_facts WHERE identity=?").run('["journals","source"]');
        input = closing("damaged-close", 2n);
      } else {
        await ledger.execute(closing("closed", 2n));
        f.db
          .query("DELETE FROM ledger_native_facts WHERE identity=?")
          .run(JSON.stringify([damage === "status" ? "closeStatuses" : "closePackages", "closed"]));
        input = reopening("damaged-reopen", 3n);
      }
      await expect(ledger.execute(input)).rejects.toThrow(
        damage === "journal"
          ? "Canonical sequence is incomplete"
          : damage === "status"
            ? "native_ledger_current_state_corrupt"
            : "native_ledger_period_history_incomplete",
      );
      const retained = await f.repository.transact((view) => ({
        write: false,
        value: view.outcome(input.id),
      }));
      expect(retained.value).toBeNull();
    } finally {
      f.db.close();
    }
  }
  const f = fixture();
  try {
    const ledger = new NativeLedger(f.repository);
    await ledger.provision(genesis(), activation());
    await ledger.execute(posting("source", 1n));
    const read = await f.repository.transact((view) => {
      const pending = view.scanFacts("journals")[Symbol.iterator]();
      const started = view.scanFacts("journals")[Symbol.iterator]();
      expect(started.next().value?.fact.key).toBe("source");
      return { write: false, value: { pending, started } };
    });
    expect(() => read.value.pending.next()).toThrow("native_ledger_transaction_closed");
    expect(() => read.value.started.next()).toThrow("native_ledger_transaction_closed");
  } finally {
    f.db.close();
  }
});

test("native publication uses one transaction and five statements with exact kernel outcome and facts", async () => {
  const f = fixture();
  try {
    const before = await activate(f);
    const sale = prepare(before, posting("sale"));
    f.reset();
    const receipt = await f.repository.transact((view) => {
      expect(view.outcome("sale")).toBeNull();
      return { write: true, decision: sale.decision, value: sale.result };
    });
    expect(f.faults.transactions).toBe(1);
    expect(f.faults.statements).toHaveLength(5);
    expect(receipt.value).toEqual(sale.result);
    expect(receipt.head.sequence).toBe("2");
    const selected = await f.open().transact((view) => ({
      write: false,
      value: {
        original: view.outcome("sale"),
        facts: view.facts([
          { collection: "journals", key: "sale" },
          { collection: "journals", key: "absent" },
        ]),
      },
    }));
    expect(selected.value.original?.encoded).toBe(sale.decision.encodedOutcome);
    expect(selected.value.facts).toEqual([sale.decision.facts[0] ?? null, null]);
    expect(selected.head).toEqual(receipt.head);
  } finally {
    f.db.close();
  }
});

test("retained rejections advance only the outcome head and survive reopening", async () => {
  const f = fixture();
  try {
    const active = await activate(f);
    const rejection = prepare(active, posting("stale", 0n));
    expect(rejection.result.disposition).toBe("rejected");
    const receipt = await f.repository.transact(() => ({
      write: true,
      decision: rejection.decision,
      value: rejection.result,
    }));
    expect(receipt.head.sequence).toBe("2");
    expect(receipt.head.bookRevision).toBe("1");
    expect(
      (await f.open().transact((view) => ({ write: false, value: view.outcome("stale") }))).value
        ?.encoded,
    ).toBe(rejection.decision.encodedOutcome);
    await expect(
      f.repository.transact(() => ({
        write: true,
        decision: {
          ...rejection.decision,
          facts: [{ collection: "balance", key: "cash", encoded: "forged" }],
        },
        value: null,
      })),
    ).rejects.toThrow("native_ledger_rejection_changes_state");
    expect(f.db.query("SELECT count(*) AS n FROM ledger_native_outcomes").get()).toEqual({ n: 2 });
  } finally {
    f.db.close();
  }
});

for (const statement of [
  "INSERT INTO ledger_native_outcomes",
  "INSERT INTO ledger_native_facts",
  "UPDATE ledger_native_book",
]) {
  test(`native publication rolls back every participant after ${statement}`, async () => {
    const f = fixture();
    try {
      const before = await activate(f);
      const sale = prepare(before, posting("rollback"));
      const head = (await f.repository.transact((view) => ({ write: false, value: view.head })))
        .head;
      f.faults.statement = statement;
      await expect(
        f.repository.transact(() => ({ write: true, decision: sale.decision, value: null })),
      ).rejects.toThrow("Injected SQL failure");
      const restored = await f.open().transact((view) => ({
        write: false,
        value: {
          outcome: view.outcome("rollback"),
          facts: view.facts([{ collection: "journals", key: "rollback" }]),
        },
      }));
      expect(restored.head).toEqual(head);
      expect(restored.value).toEqual({ outcome: null, facts: [null] });
    } finally {
      f.db.close();
    }
  });
}

test("lost acknowledgement reconciles original result without a second publication", async () => {
  const f = fixture();
  try {
    const before = await activate(f);
    const sale = prepare(before, posting("lost"));
    f.faults.lostReply = true;
    await expect(
      f.repository.transact(() => ({ write: true, decision: sale.decision, value: null })),
    ).rejects.toThrow("Lost durability confirmation");
    const retry = await f
      .open()
      .transact((view) => ({ write: false, value: view.outcome("lost") }));
    expect(retry.value?.encoded).toBe(sale.decision.encodedOutcome);
    expect(retry.head.sequence).toBe("2");
    expect(f.db.query("SELECT count(*) AS n FROM ledger_native_outcomes").get()).toEqual({ n: 2 });
  } finally {
    f.db.close();
  }
});

test("competing repository instances serialize and stale decisions cannot publish", async () => {
  const f = fixture();
  try {
    const before = await activate(f);
    const a = prepare(before, posting("a")),
      b = prepare(before, posting("b"));
    const results = await Promise.allSettled([
      f.repository.transact(() => ({ write: true, decision: a.decision, value: null })),
      f.open().transact(() => ({ write: true, decision: b.decision, value: null })),
    ]);
    expect(results.filter((result) => result.status === "fulfilled")).toHaveLength(1);
    expect(results.filter((result) => result.status === "rejected")).toHaveLength(1);
    expect(f.db.query("SELECT count(*) AS n FROM ledger_native_outcomes").get()).toEqual({ n: 2 });
  } finally {
    f.db.close();
  }
});

test("transaction capabilities expire; asynchronous callbacks and authority changes fail closed", async () => {
  const f = fixture();
  try {
    const before = await activate(f);
    const sale = prepare(before, posting("fenced"));
    let escaped: NativeLedgerTransaction | undefined;
    await f.repository.transact((view) => {
      escaped = view;
      return { write: false, value: null };
    });
    expect(() => escaped?.outcome("activate")).toThrow("native_ledger_transaction_closed");
    // Runtime control: malicious thenable is rejected before any publication.
    await expect(
      f.repository.transact((() => Promise.resolve({ write: false, value: null })) as never),
    ).rejects.toThrow("native_ledger_async_evaluation");
    await expect(
      f.repository.transact(() => {
        f.faults.fence = "1";
        return { write: true, decision: sale.decision, value: null };
      }),
    ).rejects.toThrow("native_ledger_fence_changed");
    expect(f.db.query("SELECT count(*) AS n FROM ledger_native_outcomes").get()).toEqual({ n: 1 });
    f.faults.pending = true;
    await expect(f.repository.transact(() => ({ write: false, value: null }))).rejects.toThrow(
      "native_ledger_authority_unavailable",
    );
  } finally {
    f.db.close();
  }
});

test("initialization never repairs missing tables or silently adopts another format or identity", async () => {
  const f = fixture();
  try {
    await activate(f);
    const wrong = new SqliteLedgerRepository(
      f.storage,
      { ...scope, tenantId: "wrong" },
      scope.objectId,
      () => ({ fence: "0", pending: false }),
    );
    await expect(wrong.transact(() => ({ write: false, value: null }))).rejects.toThrow(
      "native_ledger_identity_mismatch",
    );
    f.db.exec("DROP TABLE ledger_native_facts");
    await expect(f.repository.provision(encodeDurableBook(genesis()))).rejects.toThrow(
      "native_ledger_schema_incomplete",
    );
  } finally {
    f.db.close();
  }
  const legacy = fixture();
  try {
    legacy.db.exec("CREATE TABLE ledger_metadata (body TEXT)");
    await expect(legacy.repository.provision(encodeDurableBook(genesis()))).rejects.toThrow(
      "native_ledger_migration_required",
    );
  } finally {
    legacy.db.close();
  }
});

test("actual fact and outcome corruption is rejected on access", async () => {
  const f = fixture();
  try {
    const before = await activate(f);
    const sale = prepare(before, posting("corrupt"));
    await f.repository.transact(() => ({ write: true, decision: sale.decision, value: null }));
    f.db.exec("UPDATE ledger_native_facts SET body='changed'");
    await expect(
      f.repository.transact((view) => ({
        write: false,
        value: view.facts([{ collection: "journals", key: "corrupt" }]),
      })),
    ).rejects.toThrow("native_ledger_fact_corrupt");
    f.db.exec("UPDATE ledger_native_outcomes SET body='changed' WHERE sequence=2");
    await expect(
      f.repository.transact((view) => ({ write: false, value: view.outcome("corrupt") })),
    ).rejects.toThrow("native_ledger_outcome_corrupt");
  } finally {
    f.db.close();
  }
});

test("native command path agrees with the full kernel across commits, rejections, retries and restarts", async () => {
  const f = fixture();
  try {
    let ledger = new NativeLedger(f.repository);
    await ledger.provision(genesis(), activation());
    let expected = prepare(genesis(), activation()).aggregate;
    let sequence = 1;
    for (let index = 0; index < 64; index++) {
      const revision = expected.state.bookRevision;
      const command = posting(`native-${index}`, index % 5 === 0 ? 0n : revision);
      const oracle = prepare(expected, command);
      f.reset();
      const result = await ledger.execute(command);
      sequence++;
      expect(result.value.result).toEqual(oracle.result);
      expect(result.value.outcomeSequence).toBe(String(sequence));
      expect(f.faults.transactions).toBe(1);
      expect(f.faults.statements.length).toBeLessThanOrEqual(7);
      const actual = await f.repository.transact((view) => ({
        write: false,
        value: view.outcome(command.id),
      }));
      expect(actual.value?.encoded).toBe(oracle.decision.encodedOutcome);
      expected = oracle.aggregate;
      if (index % 8 === 0) ledger = new NativeLedger(f.open());
      const replay = await ledger.execute(command);
      expect(replay.value.result.disposition).toBe("replayed");
      expect(replay.value.originalResult).toEqual(oracle.result);
      expect(replay.head.sequence).toBe(String(sequence));
      expect(replay.value.outcomeSequence).toBe(String(sequence));
    }
  } finally {
    f.db.close();
  }
}, 60000);

test("native command service preserves identity conflicts and rejects unsupported scopes without outcomes", async () => {
  const f = fixture();
  try {
    const ledger = new NativeLedger(f.repository);
    await ledger.provision(genesis(), activation());
    const first = posting("identity");
    await ledger.execute(first);
    const changed = posting("identity", 1n, true, "changed content");
    const result = await ledger.execute(changed);
    expect(result.value.result.disposition).toBe("rejected");
    expect(result.value.result.diagnostics[0]?.code).toBe("command_identity_conflict");
    expect(result.value.outcomeSequence).toBeNull();
    expect(result.value.originalResult).toBeNull();
    expect(result.head.sequence).toBe("2");
    expect(() => ledger.execute(activation())).toThrow("native_ledger_profile_unsupported");
    f.db.exec('DELETE FROM ledger_native_facts WHERE identity=\'["current","configuration"]\'');
    await expect(ledger.execute(posting("missing", 2n))).rejects.toThrow(
      "native_ledger_required_fact_missing",
    );
    expect(f.db.query("SELECT count(*) AS n FROM ledger_native_outcomes").get()).toEqual({ n: 2 });
  } finally {
    f.db.close();
  }
});

test("native configuration, later posting and exact correction match full-kernel outcomes across restart", async () => {
  const f = fixture();
  try {
    let ledger = new NativeLedger(f.repository);
    await ledger.provision(genesis(), activation());
    let expected = prepare(genesis(), activation()).aggregate;
    const run = async (command: BookCommand) => {
      const oracle = prepare(expected, command);
      f.reset();
      const actual = await ledger.execute(command);
      expect(actual.value.result).toEqual(oracle.result);
      expect(f.faults.transactions).toBe(1);
      expect(f.faults.statements.length).toBeLessThanOrEqual(8);
      const saved = await f.repository.transact((view) => ({
        write: false,
        value: view.outcome(command.id)?.encoded,
      }));
      expect(saved.value).toEqual(oracle.decision.encodedOutcome);
      expected = oracle.aggregate;
      ledger = new NativeLedger(f.open());
      const retry = await ledger.execute(command);
      expect(retry.value.result.disposition).toBe("replayed");
      expect(retry.value.originalResult).toEqual(oracle.result);
      return actual.value.result;
    };
    expect((await run(posting("initial"))).disposition).toBe("committed");
    const config = configuration(expected.state);
    if (config.type !== "replaceConfiguration") throw new Error("Configuration required");
    expect(
      (
        await run(
          sealCommand({
            ...config,
            id: commandId("too-early"),
            effectiveOn: localDate("2026-01-15"),
          }),
        )
      ).disposition,
    ).toBe("rejected");
    expect((await run(config)).disposition).toBe("committed");
    expect(
      (await run(posting("after-configuration", expected.state.bookRevision))).disposition,
    ).toBe("committed");
    const original = expected.state.journals[0];
    if (!original) throw new Error("Original journal required");
    expect(
      (await run(correction(original, "reverse", expected.state.bookRevision))).disposition,
    ).toBe("committed");
    expect(
      (await run(correction(original, "duplicate-reverse", expected.state.bookRevision)))
        .diagnostics[0]?.code,
    ).toBe("invalid_correction_topology");
    expect((await run(configuration(expected.state, "next-configuration"))).disposition).toBe(
      "committed",
    );
    const wrongProfile = "native-ordinary-journal-v1";
    f.db
      .query('UPDATE ledger_native_facts SET body=? WHERE identity=\'["current","profile"]\'')
      .run(wrongProfile);
    await expect(
      ledger.execute(posting("old-profile", expected.state.bookRevision)),
    ).rejects.toThrow();
  } finally {
    f.db.close();
  }
});

test("native configuration preserves the maximum journal date and retired original periods", async () => {
  const f = fixture();
  try {
    let expected = genesis();
    const ledger = new NativeLedger(f.repository);
    await ledger.provision(expected, activation());
    expected = prepare(expected, activation()).aggregate;
    const run = async (command: BookCommand) => {
      const oracle = prepare(expected, command);
      const result = await new NativeLedger(f.open()).execute(command);
      expect(result.value.result).toEqual(oracle.result);
      expected = oracle.aggregate;
      return result.value.result;
    };
    expect((await run(posting("later", 1n))).disposition).toBe("committed");
    expect(
      (await run(posting("backdated", 2n, true, "backdated", localDate("2026-01-10")))).disposition,
    ).toBe("committed");
    const config = configuration(expected.state, "retired-calendar");
    if (config.type !== "replaceConfiguration") throw new Error("Expected configuration");
    expect(
      (
        await run(
          sealCommand({
            ...config,
            id: commandId("watermark"),
            effectiveOn: localDate("2026-01-12"),
          }),
        )
      ).disposition,
    ).toBe("rejected");
    expect(
      (
        await run(
          sealCommand({
            ...config,
            periods: config.periods.map((p) => ({
              ...p,
              id: fiscalPeriodId("replacement-january"),
            })),
          }),
        )
      ).disposition,
    ).toBe("committed");
    const original = expected.state.journals[0];
    if (!original) throw new Error("Expected original journal");
    f.reset();
    expect(
      (await run(correction(original, "retired-period-correction", expected.state.bookRevision)))
        .disposition,
    ).toBe("committed");
    // One bounded originating-outcome read proves currency lifecycle ownership.
    expect(f.faults.statements.length).toBe(9);
    f.db.query("DELETE FROM ledger_native_facts WHERE identity=?").run('["periods","january"]');
    const other = expected.state.journals[1];
    if (!other) throw new Error("Expected second journal");
    await expect(
      ledger.execute(correction(other, "missing-original-period", expected.state.bookRevision)),
    ).rejects.toThrow();
  } finally {
    f.db.close();
  }
});

test("native staged copy reexecutes configuration, corrections and rejections and compares every persisted fact", async () => {
  const source = fixture(),
    target = fixture("staging-copy");
  try {
    const ledger = new NativeLedger(source.repository);
    await ledger.provision(genesis(), activation());
    await ledger.execute(posting("copy-sale"));
    const active = prepare(genesis(), activation()).aggregate;
    const posted = prepare(active, posting("copy-sale")).aggregate;
    const journal = posted.state.journals[0];
    if (!journal) throw new Error("Expected journal");
    await ledger.execute(configuration(posted.state));
    await ledger.execute(correction(journal, "copy-reversal", 3n));
    const last = await ledger.execute(posting("copy-rejected", 0n));
    const verified = await verifyNativeLedgerCopy(source.repository, target.repository, last.head);
    expect(verified.sourceHead).toEqual(last.head);
    expect(verified.targetHead.sequence).toBe(last.head.sequence);
    expect(verified.targetHead.chainHash).not.toBe(last.head.chainHash);
    expect(verified.verifiedFacts).toBeGreaterThan(12);
    const replay = await new NativeLedger(target.open()).execute(posting("copy-rejected", 0n));
    expect(replay.value.result.disposition).toBe("replayed");
    expect(replay.value.originalResult).toEqual(last.value.result);
    await expect(
      verifyNativeLedgerCopy(source.repository, target.repository, last.head),
    ).rejects.toThrow("native_copy_target_not_empty");
  } finally {
    source.db.close();
    target.db.close();
  }
});

test("native fact pages return a byte-bounded prefix without hiding an oversized next row", async () => {
  const f = fixture();
  try {
    await new NativeLedger(f.repository).provision(genesis(), activation());
    const body = JSON.stringify("x".repeat(600_000));
    const digest = createHash("sha256").update(body).digest("hex");
    const keys = ["a", "b", "c"].map((key) => JSON.stringify(["AAProbe", key]));
    for (const key of keys)
      f.db.run("INSERT INTO ledger_native_facts VALUES (?,?,?,1,0)", [key, body, digest]);
    const first = await f.repository.factPage(null, 32);
    expect(first.facts.map((row) => row.key)).toEqual(["a"]);
    expect(first.nextIdentity).toBe(JSON.stringify(["AAProbe", "a"]));
    const second = await f.repository.factPage(first.nextIdentity, 32);
    expect(second.facts.map((row) => row.key)).toEqual(["b"]);
    expect(second.nextIdentity).toBe(JSON.stringify(["AAProbe", "b"]));
    const tooLarge = "x".repeat(1048577);
    f.db.run("UPDATE ledger_native_facts SET body=?,digest=? WHERE identity=?", [
      tooLarge,
      createHash("sha256").update(tooLarge).digest("hex"),
      keys[2] ?? "",
    ]);
    await expect(f.repository.factPage(second.nextIdentity, 32)).rejects.toThrow();
  } finally {
    f.db.close();
  }
});

test("native export rejects a missing interval and a cursor from another scope", async () => {
  const source = fixture(),
    other = fixture("other-scope");
  try {
    for (const f of [source, other]) {
      const ledger = new NativeLedger(f.repository);
      await ledger.provision(genesis(), activation());
      await ledger.execute(posting("page-one"));
      await ledger.execute(posting("page-two", 2n));
    }
    const foreign = await other.repository.outcomePage(null, 1);
    await expect(source.repository.outcomePage(foreign.through)).rejects.toThrow(
      "native_ledger_cursor_mismatch",
    );
    source.db.exec("PRAGMA foreign_keys=OFF");
    source.db.exec("DELETE FROM ledger_native_outcomes WHERE sequence=2");
    await expect(source.repository.outcomePage()).rejects.toThrow("recovery_segment_gap_detected");
    await expect(source.repository.outcomePage(null, 0)).rejects.toThrow(
      "native_ledger_read_limit",
    );
    await expect(source.repository.factPage(null, 33)).rejects.toThrow("native_ledger_read_limit");
  } finally {
    source.db.close();
    other.db.close();
  }
});

test("native export orders mixed legacy and compressed outcomes and copies a paginated book", async () => {
  const source = fixture(),
    target = fixture("paginated-copy");
  try {
    const ledger = new NativeLedger(source.repository);
    await ledger.provision(genesis(), activation());
    let revision = 1n;
    for (let i = 0; i < 40; i++) {
      const result = await ledger.execute(posting(`paged-${i}`, i % 5 === 4 ? 0n : revision));
      if (result.value.result.disposition === "committed") revision++;
    }
    const stored = source.db
      .query("SELECT sequence,body FROM ledger_native_outcomes ORDER BY sequence")
      .all() as { sequence: number; body: string }[];
    expect(stored.every((row) => row.body.startsWith("rastrata-deflate-v1:"))).toBe(true);
    for (const row of stored.filter((row) => row.sequence % 2 === 0))
      source.db.run("UPDATE ledger_native_outcomes SET body=? WHERE sequence=?", [
        decodeStoredNativeOutcome(row.body),
        row.sequence,
      ]);
    let page = await source.repository.outcomePage();
    const tip = page.observedTip;
    const sequences: string[] = [];
    while (true) {
      sequences.push(...page.outcomes.map((row) => row.head.sequence));
      expect(page.outcomes.length).toBeLessThanOrEqual(16);
      if (page.through.sequence === tip.sequence) break;
      page = await source.repository.outcomePage(page.through);
    }
    expect(sequences).toEqual(Array.from({ length: 41 }, (_, i) => String(i + 1)));
    expect((await source.repository.outcomePage(tip)).outcomes).toEqual([]);
    const copy = await verifyNativeLedgerCopy(source.repository, target.repository, tip);
    expect(copy.targetHead.sequence).toBe("41");
    expect(copy.targetHead.bookRevision).toBe("33");
    // Two touched money scopes each add a permanent identity and exact balance.
    expect(copy.verifiedFacts).toBe(108);
  } finally {
    source.db.close();
    target.db.close();
  }
});

test("compressed export caps expanded pages without losing large outcomes", async () => {
  const f = fixture(),
    target = fixture("large-page-copy");
  try {
    const ledger = new NativeLedger(f.repository);
    await ledger.provision(genesis(), activation());
    for (let i = 0; i < 16; i++)
      expect(
        (await ledger.execute(posting(`large-page-${i}`, BigInt(i + 1), true, "n".repeat(60000))))
          .value.result.disposition,
      ).toBe("committed");
    let page = await f.repository.outcomePage();
    const sequences: string[] = [];
    let pages = 0;
    while (true) {
      pages++;
      expect(
        page.outcomes.reduce((sum, item) => sum + Buffer.byteLength(item.encoded), 0),
      ).toBeLessThanOrEqual(1048576);
      sequences.push(...page.outcomes.map((item) => item.head.sequence));
      if (page.through.sequence === page.observedTip.sequence) break;
      page = await f.repository.outcomePage(page.through);
    }
    expect(pages).toBeGreaterThan(2);
    expect(sequences).toEqual(Array.from({ length: 17 }, (_, i) => String(i + 1)));
    const copy = await verifyNativeLedgerCopy(f.repository, target.repository, page.observedTip);
    expect(copy.targetHead.sequence).toBe("17");
    expect(copy.verifiedFacts).toBeGreaterThan(32);
  } finally {
    f.db.close();
    target.db.close();
  }
});

test("native copy uses bounded asynchronous export ports and independent page boundaries", async () => {
  for (const shortPages of [false, true]) {
    const source = fixture(),
      target = fixture(`async-copy-${shortPages}`);
    try {
      const ledger = new NativeLedger(source.repository);
      await ledger.provision(genesis(), activation());
      let revision = 1n;
      for (let i = 0; i < 40; i++) {
        const result = await ledger.execute(posting(`paged-${i}`, i % 5 === 4 ? 0n : revision));
        if (result.value.result.disposition === "committed") revision++;
      }
      const tip = (await source.repository.outcomePage()).observedTip;
      source.reset();
      target.reset();
      const counts = { sourceFacts: 0, targetFacts: 0, sourceOutcomes: 0 };
      const sourcePort: NativeLedgerReader = {
        scope: source.repository.scope,
        async outcomePage(after, limit, admit) {
          await Promise.resolve();
          counts.sourceOutcomes++;
          return source.repository.outcomePage(
            after,
            shortPages ? Math.min(limit ?? 16, 3) : limit,
            admit,
          );
        },
        async factPage(after, limit, admit) {
          await Promise.resolve();
          counts.sourceFacts++;
          const page = await source.repository.factPage(
            after,
            shortPages ? Math.min(limit ?? 32, 7) : limit,
            admit,
          );
          // An adapter's JS property insertion order is not accounting content.
          return {
            ...page,
            facts: page.facts.map((fact) => ({
              sourceSequence: fact.sourceSequence,
              encoded: fact.encoded,
              key: fact.key,
              collection: fact.collection,
              ...(fact.mutable === undefined ? {} : { mutable: fact.mutable }),
            })),
          };
        },
      };
      const targetPort: NativeLedgerRepository & NativeLedgerReader = {
        scope: target.repository.scope,
        provision: target.repository.provision.bind(target.repository),
        transact: target.repository.transact.bind(target.repository),
        outcomePage: target.repository.outcomePage.bind(target.repository),
        async factPage(after, limit, admit) {
          await Promise.resolve();
          counts.targetFacts++;
          return target.repository.factPage(
            after,
            shortPages ? Math.min(limit ?? 32, 19) : limit,
            admit,
          );
        },
      };
      const copy = await verifyNativeLedgerCopy(sourcePort, targetPort, tip);
      expect(copy.verifiedFacts).toBe(108);
      expect(copy.targetHead.sequence).toBe("41");
      // Before batching this same fixture required 109 fact pages per side
      // and 42 source outcome pages. Short pages remain legal, never EOF.
      expect(counts).toEqual(
        shortPages
          ? { sourceFacts: 17, targetFacts: 7, sourceOutcomes: 15 }
          : { sourceFacts: 5, targetFacts: 5, sourceOutcomes: 4 },
      );
      if (!shortPages) {
        expect(source.faults.statements).toHaveLength(25);
        expect(target.faults.statements).toHaveLength(470);
      }
    } finally {
      source.db.close();
      target.db.close();
    }
  }
});

test("native copy refuses source and staging writes made during projection comparison", async () => {
  for (const [changed, phase] of [
    ["source", "first"],
    ["target", "first"],
    ["source", "last"],
    ["target", "last"],
  ] as const) {
    const source = fixture(),
      target = fixture(`racing-${changed}`);
    try {
      await new NativeLedger(source.repository).provision(genesis(), activation());
      const selected = await source.repository.outcomePage();
      const repository = changed === "source" ? source.repository : target.repository;
      const read = repository.factPage.bind(repository);
      let raced = false;
      repository.factPage = async (...args) => {
        const page = await read(...args);
        if (!raced && (phase === "first" || page.facts.length === 0)) {
          raced = true;
          await new NativeLedger(repository).execute(posting(`raced-${changed}`));
        }
        return page;
      };
      await expect(
        verifyNativeLedgerCopy(source.repository, target.repository, selected.observedTip),
      ).rejects.toThrow(`native_copy_${changed}_changed`);
      expect(raced).toBeTrue();
    } finally {
      source.db.close();
      target.db.close();
    }
  }
});

test("native staged copy detects rehashed changed projections, extra rows and changed source tips", async () => {
  for (const damage of ["rehashed-current", "rehashed-money", "extra-row", "append"]) {
    const source = fixture(),
      target = fixture(`staging-${damage}`);
    try {
      const ledger = new NativeLedger(source.repository);
      await ledger.provision(genesis(), activation());
      const last = await ledger.execute(posting("copy-source"));
      if (damage === "rehashed-current") {
        const value = JSON.stringify("2026-01-14");
        source.db
          .query(
            'UPDATE ledger_native_facts SET body=?,digest=? WHERE identity=\'["current","latestAccountingDate"]\'',
          )
          .run(value, createHash("sha256").update(value).digest("hex"));
      } else if (damage === "rehashed-money") {
        const command = posting("copy-source");
        if (command.type !== "postJournal") throw new Error("Expected journal fixture");
        const scope = journalMoneyScopes([command.resolved.journal])[0];
        if (!scope) throw new Error("Expected money scope");
        const key = moneyScopeKeys([scope]).find((key) => key.collection === "moneyScopeBalances");
        if (!key) throw new Error("Expected balance key");
        const original = (
          await source.repository.transact((view) => ({
            write: false,
            value: view.facts([key])[0],
          }))
        ).value;
        if (!original) throw new Error("Expected balance row");
        const raw = JSON.parse(original.encoded)[0];
        const changed = JSON.stringify([raw, "999/1"]);
        source.db
          .query("UPDATE ledger_native_facts SET body=?,digest=? WHERE identity=?")
          .run(
            changed,
            createHash("sha256").update(changed).digest("hex"),
            JSON.stringify([key.collection, key.key]),
          );
      } else if (damage === "extra-row") {
        source.db
          .query("INSERT INTO ledger_native_facts VALUES (?,?,?,1,0)")
          .run(
            '["unexplained","row"]',
            "extra",
            createHash("sha256").update("extra").digest("hex"),
          );
      } else await ledger.execute(posting("new-tip", 2n));
      await expect(
        verifyNativeLedgerCopy(source.repository, target.repository, last.head),
      ).rejects.toThrow(
        damage === "append" ? "native_copy_source_changed" : "native_copy_projection_mismatch",
      );
    } finally {
      source.db.close();
      target.db.close();
    }
  }
});

test("SQL prevents replacing an immutable identity even when an internal writer supplies it", async () => {
  const f = fixture();
  try {
    const before = await activate(f);
    const first = prepare(before, posting("immutable"));
    await f.repository.transact(() => ({ write: true, decision: first.decision, value: null }));
    const next = prepare(first.aggregate, posting("other", 2n));
    const originalFact = first.decision.facts[0];
    if (!originalFact) throw new Error("Expected a journal fact");
    for (const mutable of [undefined, true] as const) {
      await expect(
        f.repository.transact(() => ({
          write: true,
          decision: {
            ...next.decision,
            facts: [
              { ...originalFact, encoded: "replacement", ...(mutable === true ? { mutable } : {}) },
            ],
          },
          value: null,
        })),
      ).rejects.toThrow();
      const original = await f.repository.transact((view) => ({
        write: false,
        value: view.facts([originalFact]),
      }));
      expect(original.value).toEqual([originalFact]);
      expect(original.head.sequence).toBe("2");
    }
    expect(f.db.query("SELECT count(*) AS n FROM ledger_native_outcomes").get()).toEqual({ n: 2 });
  } finally {
    f.db.close();
  }
});

test("the durable head cannot advertise a missing or different retained tip", async () => {
  for (const damage of [
    "UPDATE ledger_native_book SET head=json_set(head,'$.sequence','2')",
    "UPDATE ledger_native_outcomes SET head=json_set(head,'$.chainHash',printf('%064d',0))",
  ]) {
    const f = fixture();
    try {
      await activate(f);
      f.db.exec(damage);
      await expect(f.repository.transact(() => ({ write: false, value: null }))).rejects.toThrow(
        "native_ledger_head_corrupt",
      );
      expect(f.db.query("SELECT count(*) AS n FROM ledger_native_outcomes").get()).toEqual({
        n: 1,
      });
    } finally {
      f.db.close();
    }
  }
});

test("an unactivated native head must bind its exact stored genesis", async () => {
  const f = fixture();
  try {
    const encoded = encodeDurableBook(genesis());
    await f.repository.provision(encoded);
    f.db.exec("UPDATE ledger_native_book SET head=json_set(head,'$.chainHash',printf('%064d',0))");
    await expect(f.repository.provision(encoded)).rejects.toThrow("native_ledger_head_corrupt");
    expect(f.db.query("SELECT count(*) AS n FROM ledger_native_outcomes").get()).toEqual({ n: 0 });
  } finally {
    f.db.close();
  }
});

test("large native projections use bounded SQL batches and roll back all batches together", async () => {
  const f = fixture();
  try {
    const before = await activate(f);
    const candidate = prepare(before, posting("large-projection"));
    const facts = Array.from({ length: 3 }, (_, index) => ({
      collection: "largeProjection",
      key: String(index),
      encoded: "💰".repeat(150000),
    }));
    const original = f.storage.sql.exec.bind(f.storage.sql);
    let batches = 0,
      fail = true;
    f.storage.sql.exec = (sql, ...bindings) => {
      const rows = original(sql, ...bindings);
      if (sql.startsWith("INSERT INTO ledger_native_facts")) {
        batches++;
        expect(new TextEncoder().encode(String(bindings[1])).byteLength).toBeLessThanOrEqual(
          1048576,
        );
        if (fail && batches === 2) throw new Error("Second batch failed");
      }
      return rows;
    };
    const publish = () =>
      f.repository.transact(() => ({
        write: true,
        decision: { ...candidate.decision, facts },
        value: null,
      }));
    await expect(publish()).rejects.toThrow("Second batch failed");
    expect(
      f.db
        .query(
          "SELECT count(*) AS n FROM ledger_native_facts WHERE json_extract(identity,'$[0]') = 'largeProjection'",
        )
        .get(),
    ).toEqual({ n: 0 });
    expect(f.db.query("SELECT count(*) AS n FROM ledger_native_outcomes").get()).toEqual({ n: 1 });
    fail = false;
    batches = 0;
    await publish();
    expect(batches).toBe(3);
    expect(
      f.db
        .query(
          "SELECT count(*) AS n FROM ledger_native_facts WHERE json_extract(identity,'$[0]') = 'largeProjection'",
        )
        .get(),
    ).toEqual({ n: 3 });
  } finally {
    f.db.close();
  }
});

test("oversized native writes and reads fail before publishing a new outcome", async () => {
  const f = fixture();
  try {
    const before = await activate(f);
    const candidate = prepare(before, posting("bounded"));
    for (const facts of [
      [{ collection: "journals", key: "large", encoded: "x".repeat(1048577) }],
      Array.from({ length: 8 }, (_, index) => ({
        collection: "journals",
        key: String(index),
        encoded: "x".repeat(600000),
      })),
      Array.from({ length: 1001 }, (_, i) => ({
        collection: "journals",
        key: String(i),
        encoded: "x",
      })),
      [
        { collection: "journals", key: "duplicate", encoded: "x" },
        { collection: "journals", key: "duplicate", encoded: "y" },
      ],
    ]) {
      await expect(
        f.repository.transact(() => ({
          write: true,
          decision: { ...candidate.decision, facts },
          value: null,
        })),
      ).rejects.toThrow();
      expect(f.db.query("SELECT count(*) AS n FROM ledger_native_outcomes").get()).toEqual({
        n: 1,
      });
    }
    await expect(
      f.repository.transact((view) => ({
        write: false,
        value: view.facts(
          Array.from({ length: 1001 }, (_, i) => ({ collection: "journals", key: String(i) })),
        ),
      })),
    ).rejects.toThrow("native_ledger_read_limit");
  } finally {
    f.db.close();
  }
});
