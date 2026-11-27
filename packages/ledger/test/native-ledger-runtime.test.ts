import { expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Miniflare } from "miniflare";
import { consolidationWorkflow } from "./commercial-workflow.ts";
import { nativeInventoryWorkflow } from "./native-inventory-workflow.ts";
import { ExactRational } from "@rastrata/kernel";
import { canonicalAccountingValue, canonicalEncode, executeBookCommand } from "@rastrata/kernel";
import {
  activation,
  configuration,
  correction,
  genesis,
  posting,
  closing,
  reopening,
  openItemRecognition,
  settlementPayment,
  unallocatedPayment,
  applyExistingPayment,
} from "./fixtures.ts";
import {
  taxWorkflow,
  allocationAndTaxWorkflow,
  workflowTerminationCommand,
  currencyRecoveryWorkflow,
} from "./accounting-workflows.ts";

test("native SQL ledger survives workerd restart with atomic commits, rejections and original retries", async () => {
  const bundle = await Bun.build({
    entrypoints: [join(import.meta.dir, "runtime-native-ledger-worker.ts")],
    target: "node",
    format: "esm",
    external: ["node:crypto"],
  });
  expect(bundle.success).toBeTrue();
  if (!bundle.outputs[0]) throw new Error("Missing native runtime bundle");
  const directory = mkdtempSync(join(tmpdir(), "rastrata-native-runtime-"));
  const options = {
    modules: true,
    script: await bundle.outputs[0].text(),
    compatibilityDate: "2026-07-30",
    compatibilityFlags: ["nodejs_compat"],
    durableObjects: { BOOKS: { className: "NativeLedgerObject", useSQLite: true } },
    durableObjectsPersist: directory,
    cf: false,
  };
  let runtime = new Miniflare(options);
  const call = async (path: string, body?: string) => {
    const response = await runtime.dispatchFetch(
      `http://native.test${path}`,
      body === undefined ? {} : { method: "POST", body },
    );
    if (!response.ok) throw new Error(await response.text());
    return (await response.json()) as {
      disposition: string;
      head: { sequence: string };
      outcomeSequence: string;
      original: string;
      sql: number;
      count: number;
    };
  };
  const refuse = async (path: string, reason: string, body?: string) => {
    const response = await runtime.dispatchFetch(
      `http://native.test${path}`,
      body === undefined ? {} : { method: "POST", body },
    );
    expect(response.status).toBe(500);
    expect(await response.text()).toContain(reason);
  };
  let oracle = genesis();
  const originals = new Map<string, string>();
  const original = (id: string) => {
    const value = originals.get(id);
    if (value === undefined) throw new Error(`Missing oracle receipt: ${id}`);
    return value;
  };
  const apply = (command: ReturnType<typeof posting>) => {
    const next = executeBookCommand(oracle.state, oracle.protocol, command);
    originals.set(
      command.id,
      new TextDecoder().decode(canonicalEncode(canonicalAccountingValue(next.result))),
    );
    oracle = { state: next.state, protocol: next.protocol };
  };
  try {
    await call("/provision");
    apply(activation());
    const saved = await call("/post?id=one");
    apply(posting("one"));
    expect(saved.original).toBe(original("one"));
    expect(saved.sql).toBeLessThanOrEqual(7);
    const rejected = await call("/post?id=stale&revision=0");
    apply(posting("stale", 0n));
    expect(rejected.original).toBe(original("stale"));
    expect(rejected.outcomeSequence).toBe("3");
    await refuse("/rollback?id=rollback&revision=2", "injected native rollback");
    expect((await call("/count")).count).toBe(3);
    await refuse("/lost?id=lost&revision=2", "injected native lost acknowledgement");
    apply(posting("lost", 2n));
    expect((await call("/count")).count).toBe(4);
    await runtime.dispose();
    runtime = new Miniflare(options);
    for (const [id, revision, sequence] of [
      ["one", 1, 2],
      ["stale", 0, 3],
      ["lost", 2, 4],
    ] as const) {
      const retry = await call(`/post?id=${id}&revision=${revision}`);
      expect(retry.disposition).toBe("replayed");
      expect(retry.original).toBe(original(id));
      expect(retry.outcomeSequence).toBe(String(sequence));
      expect(retry.head.sequence).toBe("4");
    }
    const concurrent = await Promise.all([
      call("/post?id=duplicate&revision=3"),
      call("/post?id=duplicate&revision=3"),
    ]);
    apply(posting("duplicate", 3n));
    expect(concurrent.map((r) => r.disposition).sort()).toEqual(["committed", "replayed"]);
    for (const result of concurrent) expect(result.original).toBe(original("duplicate"));
    expect((await call("/count")).count).toBe(5);
    // The rolled-back identity remains available after actual runtime replacement.
    expect((await call("/post?id=rollback&revision=4")).disposition).toBe("committed");
    apply(posting("rollback", 4n));
    expect((await call("/count")).count).toBe(6);
    const config = configuration(oracle.state, "next-config");
    await refuse("/configure?id=next-config&revision=5&fault=rollback", "injected native rollback");
    expect((await call("/count")).count).toBe(6);
    await refuse(
      "/configure?id=next-config&revision=5&fault=lost",
      "injected native lost acknowledgement",
    );
    apply(config);
    expect((await call("/count")).count).toBe(7);
    await runtime.dispose();
    runtime = new Miniflare(options);
    const configRetry = await call("/configure?id=next-config&revision=5");
    expect(configRetry.disposition).toBe("replayed");
    expect(configRetry.original).toBe(original("next-config"));
    const source = oracle.state.journals.find((journal) => journal.journal.id === "one");
    if (!source) throw new Error("Missing oracle source journal");
    const reverse = correction(source, "undo-one", 6n);
    await refuse(
      "/reverse?original=one&id=undo-one&revision=6&fault=rollback",
      "injected native rollback",
    );
    expect((await call("/count")).count).toBe(7);
    await refuse(
      "/reverse?original=one&id=undo-one&revision=6&fault=lost",
      "injected native lost acknowledgement",
    );
    apply(reverse);
    expect((await call("/count")).count).toBe(8);
    await runtime.dispose();
    runtime = new Miniflare(options);
    const reverseRetry = await call("/reverse?original=one&id=undo-one&revision=6");
    expect(reverseRetry.disposition).toBe("replayed");
    expect(reverseRetry.original).toBe(original("undo-one"));
    const duplicate = await call("/reverse?original=one&id=undo-twice&revision=7");
    apply(correction(source, "undo-twice", 7n));
    expect(duplicate.disposition).toBe("rejected");
    expect(duplicate.original).toBe(original("undo-twice"));
    expect(duplicate.outcomeSequence).toBe("9");
    expect(duplicate.sql).toBeLessThanOrEqual(8);
    const close = closing("runtime-close", oracle.state.bookRevision, true);
    await refuse(
      "/close?id=runtime-close&revision=7&withJournal=1&fault=rollback",
      "injected native rollback",
    );
    expect((await call("/count")).count).toBe(9);
    await refuse(
      "/close?id=runtime-close&revision=7&withJournal=1&fault=lost",
      "injected native lost acknowledgement",
    );
    apply(close);
    expect((await call("/count")).count).toBe(10);
    await runtime.dispose();
    runtime = new Miniflare(options);
    const closeRetry = await call("/close?id=runtime-close&revision=7&withJournal=1");
    expect(closeRetry.disposition).toBe("replayed");
    expect(closeRetry.original).toBe(original("runtime-close"));
    const blockedPost = await call("/post?id=period-locked&revision=8");
    apply(posting("period-locked", 8n));
    expect(blockedPost.disposition).toBe("rejected");
    expect(blockedPost.original).toBe(original("period-locked"));
    const closingJournal = oracle.state.journals.find(
      (journal) => journal.journal.id === "runtime-close-journal",
    );
    if (!closingJournal) throw new Error("Missing canonical closing journal");
    const reopen = reopening("runtime-reopen", 8n, closingJournal);
    await refuse(
      "/reopen?id=runtime-reopen&revision=8&original=runtime-close-journal&fault=rollback",
      "injected native rollback",
    );
    expect((await call("/count")).count).toBe(11);
    await refuse(
      "/reopen?id=runtime-reopen&revision=8&original=runtime-close-journal&fault=lost",
      "injected native lost acknowledgement",
    );
    apply(reopen);
    await runtime.dispose();
    runtime = new Miniflare(options);
    const reopenRetry = await call(
      "/reopen?id=runtime-reopen&revision=8&original=runtime-close-journal",
    );
    expect(reopenRetry.disposition).toBe("replayed");
    expect(reopenRetry.original).toBe(original("runtime-reopen"));
    const next = await call("/post?id=after-reopen&revision=9");
    apply(posting("after-reopen", 9n));
    expect(next.disposition).toBe("committed");
    expect(next.original).toBe(original("after-reopen"));
    expect(next.sql).toBeLessThanOrEqual(7);
    const tax = taxWorkflow();
    const taxActive = executeBookCommand(tax.initial.state, tax.initial.protocol, activation());
    const taxExpected = executeBookCommand(taxActive.state, taxActive.protocol, tax.command);
    expect(taxExpected.result.disposition).toBe("committed");
    await call("/tax/provision");
    await refuse("/tax?fault=rollback", "injected native rollback");
    expect((await call("/tax/count")).count).toBe(1);
    await refuse("/tax?fault=lost", "injected native lost acknowledgement");
    expect((await call("/tax/count")).count).toBe(2);
    await runtime.dispose();
    runtime = new Miniflare(options);
    const taxRetry = await call("/tax");
    expect(taxRetry.disposition).toBe("replayed");
    expect(taxRetry.outcomeSequence).toBe("2");
    expect(taxRetry.original).toBe(
      new TextDecoder().decode(canonicalEncode(canonicalAccountingValue(taxExpected.result))),
    );
    expect(taxRetry.sql).toBeLessThanOrEqual(8);
    const openActive = executeBookCommand(genesis().state, genesis().protocol, activation());
    const openExpected = executeBookCommand(
      openActive.state,
      openActive.protocol,
      openItemRecognition("invoice", 1n),
    );
    expect(openExpected.result.disposition).toBe("committed");
    await call("/open-item/provision");
    await refuse("/open-item?fault=rollback", "injected native rollback");
    expect((await call("/open-item/count")).count).toBe(1);
    await refuse("/open-item?fault=lost", "injected native lost acknowledgement");
    await runtime.dispose();
    runtime = new Miniflare(options);
    const openRetry = await call("/open-item");
    expect(openRetry.disposition).toBe("replayed");
    expect(openRetry.original).toBe(
      new TextDecoder().decode(canonicalEncode(canonicalAccountingValue(openExpected.result))),
    );
    const openFresh = await call("/open-item?id=second&revision=2");
    expect(openFresh.disposition).toBe("committed");
    expect(openFresh.sql).toBeLessThanOrEqual(10);
    expect((await call("/open-item/count")).count).toBe(3);
    await call("/settlement/provision");
    const invoiceCommand = openItemRecognition("invoice", 1n);
    let paymentState = executeBookCommand(openActive.state, openActive.protocol, invoiceCommand);
    for (const step of [1, 2]) {
      const command = settlementPayment(`payment-${step}`, step === 1 ? 2n : 3n, [
        { openItemId: invoiceCommand.request.value.id, amount: step === 1 ? 40n : 60n },
      ]);
      const expected = executeBookCommand(paymentState.state, paymentState.protocol, command);
      expect(expected.result.disposition).toBe("committed");
      await refuse(`/settlement?step=${step}&fault=rollback`, "injected native rollback");
      expect((await call("/settlement/count")).count).toBe(step + 1);
      await refuse(`/settlement?step=${step}&fault=lost`, "injected native lost acknowledgement");
      await runtime.dispose();
      runtime = new Miniflare(options);
      const retried = await call(`/settlement?step=${step}`);
      expect(retried.disposition).toBe("replayed");
      expect(retried.original).toBe(
        new TextDecoder().decode(canonicalEncode(canonicalAccountingValue(expected.result))),
      );
      expect(retried.outcomeSequence).toBe(String(step + 2));
      paymentState = expected;
    }
    await call("/deferred/provision");
    const advance = unallocatedPayment("prepayment", 1n);
    let deferred = openActive;
    for (const command of [
      advance,
      openItemRecognition("invoice-a", 2n),
      openItemRecognition("invoice-b", 3n),
    ]) {
      deferred = executeBookCommand(deferred.state, deferred.protocol, command);
      expect(deferred.result.disposition).toBe("committed");
    }
    for (const step of [1, 2]) {
      const command = applyExistingPayment(advance, `application-${step}`, step === 1 ? 4n : 5n, [
        {
          openItemId: openItemRecognition(step === 1 ? "invoice-a" : "invoice-b", 2n).request.value
            .id,
          amount: step === 1 ? 40n : 60n,
        },
      ]);
      const expected = executeBookCommand(deferred.state, deferred.protocol, command);
      expect(expected.result.disposition).toBe("committed");
      await refuse(`/deferred?step=${step}&fault=rollback`, "injected native rollback");
      expect((await call("/deferred/count")).count).toBe(step + 3);
      await refuse(`/deferred?step=${step}&fault=lost`, "injected native lost acknowledgement");
      await runtime.dispose();
      runtime = new Miniflare(options);
      const retried = await call(`/deferred?step=${step}`);
      expect(retried.disposition).toBe("replayed");
      expect(retried.original).toBe(
        new TextDecoder().decode(canonicalEncode(canonicalAccountingValue(expected.result))),
      );
      expect(retried.outcomeSequence).toBe(String(step + 4));
      deferred = expected;
    }
    const allocation = allocationAndTaxWorkflow("1.1.0");
    let allocationState = executeBookCommand(
      allocation.initial.state,
      allocation.initial.protocol,
      activation(),
    );
    await call("/allocation/provision");
    for (const [offset, command] of [
      ...allocation.commands.slice(1),
      workflowTerminationCommand(allocation),
    ].entries()) {
      const step = offset + 1;
      const expected = executeBookCommand(allocationState.state, allocationState.protocol, command);
      expect(expected.result.disposition).toBe("committed");
      if (
        command.type === "recognizeScheduledAllocation" ||
        command.type === "reviseAllocationSchedule"
      ) {
        await refuse(`/allocation?step=${step}&fault=rollback`, "injected native rollback");
        expect((await call("/allocation/count")).count).toBe(step);
        await refuse(`/allocation?step=${step}&fault=lost`, "injected native lost acknowledgement");
        await runtime.dispose();
        runtime = new Miniflare(options);
      }
      const result = await call(`/allocation?step=${step}`);
      expect(result.original).toBe(
        new TextDecoder().decode(canonicalEncode(canonicalAccountingValue(expected.result))),
      );
      expect(result.outcomeSequence).toBe(String(step + 1));
      allocationState = expected;
    }
    expect((await call("/allocation/count")).count).toBe(9);
    const fx = currencyRecoveryWorkflow();
    let fxState = executeBookCommand(fx.initial.state, fx.initial.protocol, activation());
    await call("/fx/provision");
    for (const [offset, command] of fx.commands.slice(1).entries()) {
      const step = offset + 1;
      const expected = executeBookCommand(fxState.state, fxState.protocol, command);
      if (command.type === "postCurrencyRemeasurement") {
        expect(expected.result.disposition).toBe("committed");
        await refuse(`/fx?step=${step}&fault=rollback`, "injected native rollback");
        expect((await call("/fx/count")).count).toBe(step);
        await refuse(`/fx?step=${step}&fault=lost`, "injected native lost acknowledgement");
        await runtime.dispose();
        runtime = new Miniflare(options);
      }
      const actual = await call(`/fx?step=${step}`);
      expect(actual.original).toBe(
        new TextDecoder().decode(canonicalEncode(canonicalAccountingValue(expected.result))),
      );
      expect(actual.outcomeSequence).toBe(String(step + 1));
      fxState = expected;
    }
    expect((await call("/fx/count")).count).toBe(10);
    const consolidation = consolidationWorkflow(ExactRational.of(4n, 5n));
    const consolidationActive = executeBookCommand(
      consolidation.initial.state,
      consolidation.initial.protocol,
      activation(),
    );
    const consolidationExpected = executeBookCommand(
      consolidationActive.state,
      consolidationActive.protocol,
      consolidation.command,
    );
    expect(consolidationExpected.result.disposition).toBe("committed");
    await call("/consolidation/provision");
    await refuse("/consolidation?fault=rollback", "injected native rollback");
    expect((await call("/consolidation/count")).count).toBe(1);
    await refuse("/consolidation?fault=lost", "injected native lost acknowledgement");
    await runtime.dispose();
    runtime = new Miniflare(options);
    const consolidationRetry = await call("/consolidation");
    expect(consolidationRetry.disposition).toBe("replayed");
    expect(consolidationRetry.original).toBe(
      new TextDecoder().decode(
        canonicalEncode(canonicalAccountingValue(consolidationExpected.result)),
      ),
    );
    expect((await call("/consolidation/count")).count).toBe(2);
    const inventoryData = await Bun.file(
      new URL("./data/owned-inventory-preparation-baseline.json", import.meta.url),
    ).text();
    const inventory = await nativeInventoryWorkflow(inventoryData);
    let inventoryExpected = inventory.initial;
    await call("/inventory/provision", inventoryData);
    for (const [index, command] of inventory.commands.entries()) {
      const next = executeBookCommand(inventoryExpected.state, inventoryExpected.protocol, command);
      expect(next.result.disposition).toBe("committed");
      if (index > 0) {
        await refuse(
          `/inventory?step=${index}&fault=rollback`,
          "injected native rollback",
          inventoryData,
        );
        expect((await call("/inventory/count")).count).toBe(index);
        await refuse(
          `/inventory?step=${index}&fault=lost`,
          "injected native lost acknowledgement",
          inventoryData,
        );
        await runtime.dispose();
        runtime = new Miniflare(options);
        const retry = await call(`/inventory?step=${index}`, inventoryData);
        expect(retry.disposition).toBe("replayed");
        expect(retry.original).toBe(
          new TextDecoder().decode(canonicalEncode(canonicalAccountingValue(next.result))),
        );
        expect((await call("/inventory/count")).count).toBe(index + 1);
      }
      inventoryExpected = { state: next.state, protocol: next.protocol };
    }
  } finally {
    await runtime.dispose();
    rmSync(directory, { recursive: true, force: true });
  }
}, 60000);
