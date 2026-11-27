import { afterEach, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  CHAIN_HEAD_STATE_COMMITMENT_PROFILE,
  commandId,
  decodeDurableBook,
  encodeDurableBook,
  hashBookState,
  instant,
  localDate,
  sealCommand,
  validateBookState,
  type DurableBookAggregate,
} from "@rastrata/kernel";
import { LocalBookService } from "../src/local.ts";
import { BULK_BOOK, postBulk } from "./support/bulk-book.ts";
import { budgetsApply, expectWithin } from "./support/budget.ts";
import { setupLegacyBook } from "./support/legacy-book.ts";

const cleanup: (() => void)[] = [];
afterEach(() => {
  for (const work of cleanup.splice(0).reverse()) work();
});

function directory() {
  const path = mkdtempSync(join(tmpdir(), "rastrata-state-commitment-"));
  cleanup.push(() => rmSync(path, { recursive: true, force: true }));
  return path;
}

async function open(path: string) {
  const service = await LocalBookService.open(path);
  let closed = false;
  cleanup.push(() => {
    if (!closed) service.close();
    closed = true;
  });
  return service;
}

/** Set up a book the way an older build did, by swapping the genesis the service built. */
async function openLegacyBook(path: string) {
  const service = await open(path);
  await setupLegacyBook(service);
  return service;
}

/** A starting chart of `count` accounts, like the books people actually keep. */
function chartOf(count: number) {
  return {
    ...BULK_BOOK,
    accounts: [
      ...BULK_BOOK.accounts,
      ...Array.from({ length: count - BULK_BOOK.accounts.length }, (_, index) => ({
        code: String(6000 + index),
        name: `Operating expense ${index}`,
        role: "expense" as const,
      })),
    ],
  };
}

/** Add `count` configuration revisions (an account edit, a calendar extension) before any journal. */
async function reconfigure(service: LocalBookService, count: number) {
  // biome-ignore lint/suspicious/noExplicitAny: test support reaching the service's signing members
  const internals = service as any;
  for (let index = 0; index < count; index += 1) {
    const state = (await service.readAggregate()).aggregate.state;
    const policy = state.policies[0];
    if (!policy) throw new Error("The book has no policies");
    const now = new Date().toISOString();
    const receipt = await service.ledger.execute(
      await internals.credential(),
      sealCommand({
        id: commandId(`reconfigure-${index}`),
        type: "replaceConfiguration",
        protocolVersion: policy.version,
        bookId: state.identity.bookId,
        expectedBookRevision: state.bookRevision,
        expectedConfigurationRevision: state.configurationRevision,
        actorId: internals.actor,
        issuedAt: instant(now),
        completedAt: instant(now),
        committedAt: instant(now),
        effectiveOn: localDate("2026-01-01"),
        periods: state.periods,
        admissionSnapshot: state.admissionSnapshot,
        policies: state.policies,
        quantizationPolicies: state.quantizationPolicies,
        accountingPolicies: state.accountingPolicySnapshot.policies,
      }),
    );
    if (receipt.value.result.disposition !== "committed") throw new Error("Configuration rejected");
  }
}

test("setup creates every new book with the chain-head state commitment and legacy source identities", async () => {
  const service = await open(join(directory(), "book.sqlite"));
  await service.setup(BULK_BOOK);
  await postBulk(service, 25);
  const { aggregate } = await service.readAggregate();
  const configuration = aggregate.state.activeConfigurationSnapshot;
  expect(configuration.stateCommitmentProfile).toBe(CHAIN_HEAD_STATE_COMMITMENT_PROFILE);
  expect(
    aggregate.state.configurationSnapshots.map((snapshot) => snapshot.stateCommitmentProfile),
  ).toEqual([CHAIN_HEAD_STATE_COMMITMENT_PROFILE]);
  // Source identities are untouched: the application's books still use the original resolver.
  expect(configuration.executionProfile).toBeUndefined();
  expect(hashBookState(aggregate.state)).toEqual(aggregate.state.contentHash);
  expect(validateBookState(aggregate.state)).toEqual([]);
  const encoded = encodeDurableBook(aggregate);
  expect(encoded).toContain(CHAIN_HEAD_STATE_COMMITMENT_PROFILE);
  const decoded = decodeDurableBook(encoded);
  expect(decoded.disposition).toBe("decoded");
  // The independent second evaluation every read performs agrees with what the native path wrote.
  const full = await service.readAggregate(undefined, { verify: "full" });
  expect(encodeDurableBook(full.aggregate)).toBe(encoded);
});

test("a book made before the commitment existed keeps working beside the new ones", async () => {
  const root = directory();
  const legacy = await openLegacyBook(join(root, "legacy.sqlite"));
  const current = await open(join(root, "current.sqlite"));
  await current.setup(BULK_BOOK);
  await postBulk(legacy, 30);
  await postBulk(current, 30);
  const older = (await legacy.readAggregate()).aggregate;
  const newer = (await current.readAggregate()).aggregate;
  expect(older.state.activeConfigurationSnapshot.stateCommitmentProfile).toBeUndefined();
  expect(newer.state.activeConfigurationSnapshot.stateCommitmentProfile).toBe(
    CHAIN_HEAD_STATE_COMMITMENT_PROFILE,
  );
  // The preimage is the only difference the books can see: the same journals, in the same order.
  const figures = (aggregate: DurableBookAggregate) =>
    aggregate.state.journals.map((booked) => [
      booked.journal.id,
      booked.postingSequence,
      booked.journal.postings.map((posting) => posting.bookValue.amount.toString()),
    ]);
  expect(figures(newer)).toEqual(figures(older));
  expect(newer.state.contentHash).not.toEqual(older.state.contentHash);
  // The older book is still verified by a full replay, restarts from its snapshot and decodes.
  expect(
    encodeDurableBook((await legacy.readAggregate(undefined, { verify: "full" })).aggregate),
  ).toBe(encodeDurableBook(older));
  expect(decodeDurableBook(encodeDurableBook(older)).disposition).toBe("decoded");
  await postBulk(legacy, 5);
  expect((await legacy.readAggregate()).aggregate.state.journals.length).toBe(35);
});

test("verifying a book is linear in its size: a thousand journals replay in a few seconds", async () => {
  const service = await open(join(directory(), "book.sqlite"));
  await service.setup(BULK_BOOK);
  await postBulk(service, 1_000);
  const verifiedBefore = service.readStats.verified;
  const started = performance.now();
  const { aggregate } = await service.readAggregate(undefined, { verify: "full" });
  const elapsed = performance.now() - started;
  expect(aggregate.state.journals.length).toBe(1_000);
  // Every outcome is re-executed by the kernel: the activation and the thousand journals.
  expect(service.readStats.verified - verifiedBefore).toBe(1_001);
  // Before the commitment this replay took about 22 seconds, because every command hashed the
  // whole state three times. A quiet machine does it in under two.
  expectWithin("full replay of 1,000 journals", elapsed, 8_000);
}, 180_000);

test("a realistic chart and many configuration revisions cost a replay no more than a toy book does", async () => {
  const toy = await open(join(directory(), "toy.sqlite"));
  await toy.setup(BULK_BOOK);
  await postBulk(toy, 300);
  const real = await open(join(directory(), "real.sqlite"));
  await real.setup(chartOf(100));
  await reconfigure(real, 10);
  await postBulk(real, 300);
  const replay = async (service: LocalBookService) => {
    const started = performance.now();
    await service.readAggregate(undefined, { verify: "full" });
    return performance.now() - started;
  };
  // Warm both, then compare. Before admission reused its verification of the configuration, every
  // command rehashed the chart once for each of the eleven snapshots, twice over: about six times
  // the toy book's cost.
  await replay(toy);
  await replay(real);
  const [toyMs, realMs] = [await replay(toy), await replay(real)];
  const state = (await real.readAggregate()).aggregate.state;
  expect(state.configurationSnapshots.length).toBe(11);
  expect(state.admissionSnapshot.accounts.length).toBe(100);
  if (budgetsApply()) expect(realMs / toyMs).toBeLessThan(2.5);
  else
    console.info(
      `realistic replay ${Math.round(realMs)} ms against ${Math.round(toyMs)} ms; ratio not asserted, the machine is busy`,
    );
}, 180_000);
