import { expect, test } from "bun:test";
import {
  ExactRational, commandId, openItemId, settlementId, settlementAllocationId,
  createCanonicalPostingReference, canonicalPostingReferenceId, effectKey,
  sealCommand, executeBookCommand, validateBookState, type BookCommand,
  recognizeOpenItem, applyAccountingEffect, prepareBookIntent, prepareBookCommitRecords, hashBookState,
} from "../src/index.ts";
import { freshState, journal, resolved, IDS } from "./fixtures.ts";
import { accountingDerivation } from "./accounting-fixtures.ts";
import { activationCommand } from "./protocol-fixtures.ts";

/** Regression for the audited legacy source-authority gap: previously both
 * commands committed and validateBookState accepted their inconsistent books. */
test("open-item aliases cannot claim the same canonical control posting more than once", () => {
  const initial = freshState();
  let current = executeBookCommand(initial.state, initial.protocol, activationCommand());
  const source = journal("original-receivable");
  const reference = createCanonicalPostingReference(canonicalPostingReferenceId("receivable-source"), IDS.book,
    source.id, source.postings[0]!, effectKey("recognize-first:journal:0"));
  for (const [index, posting] of [source, journal("unrelated-reversal", "2026-01-15", "ordinary", true)].entries()) {
    const command = sealCommand({
      ...activationCommand(), id: commandId(index === 0 ? "recognize-first" : "recognize-alias"),
      type: "recognizeOpenItem" as const, expectedBookRevision: current.state.bookRevision,
      resolved: resolved(posting), request: { value: {
        id: openItemId(`open-${index}`), bookId: IDS.book, kind: "receivable" as const,
        scope: { externalPartyId: "customer", controlAccountId: IDS.cash },
        recognitionSource: index === 0 ? reference : createCanonicalPostingReference(canonicalPostingReferenceId("alias-reference"), IDS.book,
          source.id, source.postings[0]!, effectKey("recognize-first:journal:0")), recognizedOn: source.accountingDate,
        denominationCommodityId: IDS.usd, denomination: ExactRational.of(100n, 1n),
        bookValue: ExactRational.of(100n, 1n), derivation: accountingDerivation,
      } },
    });
    if (index === 1) {
      // Reconstruct the old accepted shape with genuine canonical hash/record
      // constructors. A bad checksum must not be the reason recovery refuses it.
      const journalOnly = executeBookCommand(current.state, current.protocol, sealCommand({
        ...activationCommand(), id: command.id, type: "postJournal", expectedBookRevision: current.state.bookRevision,
        resolved: command.resolved,
      }));
      expect(journalOnly.result.disposition).toBe("committed");
      const calculated = recognizeOpenItem(current.state.accountingState, command.request);
      if (calculated.disposition !== "draft" || journalOnly.intent === undefined) throw new Error("Invalid historical fixture");
      const intent = prepareBookIntent(current.state, command, [...journalOnly.intent.effects, ...calculated.draft.effects],
        journalOnly.state.latestPostingSequence).intent;
      const records = prepareBookCommitRecords({ bookId: IDS.book, bookRevision: current.state.bookRevision,
        previousRevision: current.state.revisions.at(-1)! }, intent);
      const body = { ...journalOnly.state,
        accountingState: applyAccountingEffect(current.state.accountingState, calculated.draft.effects[0]!),
        revisions: [...current.state.revisions, records.revision] };
      const unsafe = { ...body, contentHash: hashBookState(body) };
      expect(hashBookState(unsafe)).toEqual(unsafe.contentHash);
      expect(validateBookState(unsafe).some((diagnostic) => diagnostic.message === "Canonical control posting already has a financial source owner")).toBeTrue();
      expect(unsafe.accountingState.openItems).toHaveLength(2);
    }
    current = executeBookCommand(current.state, current.protocol, command);
    expect(current.result.disposition).toBe(index === 0 ? "committed" : "rejected");
    if (index === 1) expect(current.result.diagnostics[0]?.message).toBe("Canonical control posting already has a financial source owner");
  }
  const control = current.state.journals.flatMap((item) => item.journal.postings)
    .filter((posting) => posting.accountId === IDS.cash)
    .reduce((sum, posting) => sum.add(posting.bookValue.amount.toRational()), ExactRational.zero());
  expect(control.toString()).toBe("100/1");
  expect(current.state.accountingState.openItems.map((item) => item.bookValue.toString())).toEqual(["100/1"]);
  expect(validateBookState(current.state)).toHaveLength(0);
  const credit = journal("credit", "2026-01-15", "ordinary", true);
  const recognizedCredit = sealCommand({ ...activationCommand(), id: commandId("credit"), type: "recognizeOpenItem",
    expectedBookRevision: current.state.bookRevision, resolved: resolved(credit), request: { value: {
      id: openItemId("credit"), bookId: IDS.book, kind: "credit", scope: { externalPartyId: "customer", controlAccountId: IDS.cash },
      recognitionSource: createCanonicalPostingReference(canonicalPostingReferenceId("credit-source"), IDS.book, credit.id, credit.postings[0]!, effectKey("credit:journal:0")),
      recognizedOn: credit.accountingDate, denominationCommodityId: IDS.usd, denomination: ExactRational.of(-100n, 1n),
      bookValue: ExactRational.of(-100n, 1n), derivation: accountingDerivation } } });
  current = executeBookCommand(current.state, current.protocol, recognizedCredit);
  expect(current.result.disposition).toBe("committed");
  const before = current.state;
  const crossRole = sealCommand({ ...activationCommand(), id: commandId("cross-role"), type: "applySettlement",
    expectedBookRevision: before.bookRevision, resolved: [], request: {
      settlement: { id: settlementId("cross-role"), bookId: IDS.book, kind: "cash",
        scope: { externalPartyId: "customer", controlAccountId: IDS.cash }, settlementSource: reference,
        settledAt: source.economicAt, denominationCommodityId: IDS.usd, denomination: ExactRational.of(100n, 1n),
        bookValue: ExactRational.of(100n, 1n), derivation: accountingDerivation },
      allocations: [{ id: settlementAllocationId("cross-role"), settlementId: settlementId("cross-role"), openItemId: openItemId("credit"),
        allocatedBookValue: ExactRational.of(100n, 1n), allocatedOpenQuantity: ExactRational.of(100n, 1n),
        allocatedSettlementQuantity: ExactRational.of(100n, 1n), derivation: accountingDerivation }],
    } });
  current = executeBookCommand(current.state, current.protocol, crossRole);
  expect(current.result.disposition).toBe("rejected");
  expect(current.result.diagnostics[0]?.message).toBe("Canonical control posting already has a financial source owner");
  expect(current.state.contentHash).toEqual(before.contentHash);
});

test("settlement aliases cannot allocate one historical payment twice", () => {
  const initial = freshState();
  let current = executeBookCommand(initial.state, initial.protocol, activationCommand());
  const scope = { externalPartyId: "customer", controlAccountId: IDS.cash };
  const apply = (command: BookCommand, disposition: "committed" | "rejected" = "committed") => {
    current = executeBookCommand(current.state, current.protocol, command);
    expect(current.result.disposition).toBe(disposition);
  };
  for (let index = 0; index < 2; index++) {
    const source = journal(`receivable-${index}`);
    const id = commandId(`recognize-${index}`);
    apply(sealCommand({ ...activationCommand(), id, type: "recognizeOpenItem", expectedBookRevision: current.state.bookRevision,
      resolved: resolved(source), request: { value: { id: openItemId(`open-${index}`), bookId: IDS.book,
        kind: "receivable", scope, recognizedOn: source.accountingDate,
        recognitionSource: createCanonicalPostingReference(canonicalPostingReferenceId(`source-${index}`), IDS.book, source.id, source.postings[0]!, effectKey(`${id}:journal:0`)),
        denominationCommodityId: IDS.usd, denomination: ExactRational.of(100n, 1n), bookValue: ExactRational.of(100n, 1n), derivation: accountingDerivation } } }));
  }
  const payment = journal("payment", "2026-01-15", "ordinary", true);
  const reference = createCanonicalPostingReference(canonicalPostingReferenceId("payment-source"), IDS.book,
    payment.id, payment.postings[0]!, effectKey("pay-0:journal:0"));
  for (let index = 0; index < 2; index++) {
    const id = settlementId(`settlement-${index}`);
    apply(sealCommand({ ...activationCommand(), id: commandId(`pay-${index}`), type: "applySettlement",
      expectedBookRevision: current.state.bookRevision, resolved: index === 0 ? [resolved(payment)] : [],
      request: { settlement: { id, bookId: IDS.book, kind: "cash", scope,
        settlementSource: index === 0 ? reference : createCanonicalPostingReference(canonicalPostingReferenceId("alias-payment-reference"), IDS.book,
          payment.id, payment.postings[0]!, effectKey("pay-0:journal:0")),
        settledAt: payment.economicAt, denominationCommodityId: IDS.usd, denomination: ExactRational.of(100n, 1n),
        bookValue: ExactRational.of(100n, 1n), derivation: accountingDerivation },
      allocations: [{ id: settlementAllocationId(`edge-${index}`), settlementId: id, openItemId: openItemId(`open-${index}`),
        allocatedBookValue: ExactRational.of(100n, 1n), allocatedOpenQuantity: ExactRational.of(100n, 1n),
        allocatedSettlementQuantity: ExactRational.of(100n, 1n), derivation: accountingDerivation }] } }), index === 0 ? "committed" : "rejected");
  }
  expect(current.state.journals).toHaveLength(3);
  expect(current.state.accountingState.settlementAllocations.reduce((sum, item) => sum.add(item.allocatedSettlementBookValue!), ExactRational.zero()).toString()).toBe("100/1");
  expect(current.result.diagnostics[0]?.message).toBe("Canonical control posting already has a financial source owner");
  expect(validateBookState(current.state)).toHaveLength(0);
  const before = current.state;
  const claim = sealCommand({ ...activationCommand(), id: commandId("claim-payment-as-credit"), type: "recognizeOpenItem",
    expectedBookRevision: current.state.bookRevision, resolved: resolved(journal("unrelated-credit")), request: { value: {
      id: openItemId("reused-payment"), bookId: IDS.book, kind: "credit", scope,
      recognitionSource: reference, recognizedOn: payment.accountingDate, denominationCommodityId: IDS.usd,
      denomination: ExactRational.of(-100n, 1n), bookValue: ExactRational.of(-100n, 1n), derivation: accountingDerivation,
    } } });
  current = executeBookCommand(current.state, current.protocol, claim);
  expect(current.result.disposition).toBe("rejected");
  expect(current.result.diagnostics[0]?.message).toBe("Canonical control posting already has a financial source owner");
  expect(current.state.contentHash).toEqual(before.contentHash);

  // Open item recognition referencing a source posting from an earlier-booked journal
  const priorInvoice = journal("prior-open-invoice", "2026-01-15", "ordinary", true);
  current = executeBookCommand(current.state, current.protocol, sealCommand({
    ...activationCommand(),
    id: commandId("post-prior-open-invoice"),
    type: "postJournal",
    expectedBookRevision: current.state.bookRevision,
    resolved: resolved(priorInvoice),
  }));
  expect(current.result.disposition).toBe("committed");

  const priorRef = createCanonicalPostingReference(
    canonicalPostingReferenceId("prior-invoice-source-ref"),
    IDS.book,
    priorInvoice.id,
    priorInvoice.postings[0]!,
    effectKey("post-prior-open-invoice:journal:0"),
  );
  const recognizePriorCommand = sealCommand({
    ...activationCommand(),
    id: commandId("recognize-prior-open-item"),
    type: "recognizeOpenItem",
    expectedBookRevision: current.state.bookRevision,
    resolved: resolved(journal("unrelated-for-prior")),
    request: {
      value: {
        id: openItemId("prior-open-item"),
        bookId: IDS.book,
        kind: "receivable",
        scope,
        recognitionSource: priorRef,
        recognizedOn: priorInvoice.accountingDate,
        denominationCommodityId: IDS.usd,
        denomination: ExactRational.of(100n, 1n),
        bookValue: ExactRational.of(100n, 1n),
        derivation: accountingDerivation,
      },
    },
  });
  const recognizedPrior = executeBookCommand(current.state, current.protocol, recognizePriorCommand);
  expect(recognizedPrior.result.disposition).toBe("committed");
  expect(recognizedPrior.state.accountingState.openItems.some((item) => item.id === openItemId("prior-open-item"))).toBeTrue();
});
