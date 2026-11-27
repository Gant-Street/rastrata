/** Build a large book quickly for tests. Posting through the application (draft, prepare, commit)
 * costs a full read per step; here commands go straight to the ledger, which is cheap, so a
 * thousand journals take about a second. Use it for read-model, report and performance tests, not
 * for tests of the posting workflow itself.
 *
 * It reaches the service's private signing members on purpose: this is test support. */
import {
  ExactDecimal,
  ExactRational,
  accountId,
  commandId,
  derivationId,
  evidenceId,
  hashCanonical,
  instant,
  journalId,
  localDate,
  postingId,
  resolveJournal,
  sealCommand,
  type JournalTransaction,
  type ResolvedTransaction,
} from "@rastrata/kernel";
import type { ApplicationService } from "../../src/service.ts";

export const BULK_BOOK = {
  name: "Bulk Co",
  currency: "USD",
  fiscalYear: 2026,
  periodModel: "monthly",
  accounts: [
    { code: "1000", name: "Cash", role: "asset" },
    { code: "3000", name: "Capital", role: "equity" },
    { code: "4000", name: "Sales", role: "income" },
    { code: "5000", name: "Expense", role: "expense" },
  ],
} as const;

/** One journal a bulk poster makes: a date, the account debited and credited, and the amount in
 * cents (positive). `n` is the journal's position in the book, counting from 1. */
export interface BulkEntry {
  readonly date: string;
  readonly debit: string;
  readonly credit: string;
  readonly cents: bigint;
}

/** Post `count` balanced two-line journals (cash against sales) dated through 2026, or as `entry`
 * says (a book of several years needs its own dates). Returns the ids of the journals it posted. The
 * book must already be set up, and every date must fall inside its calendar. */
export async function postBulk(
  service: ApplicationService,
  count: number,
  options: { readonly entry?: (n: number) => BulkEntry } = {},
): Promise<string[]> {
  // biome-ignore lint/suspicious/noExplicitAny: test support reaching private members
  const internals = service as any;
  const { aggregate } = await service.readAggregate();
  const base = aggregate.state;
  const currency = base.identity.functionalCommodityId;
  const quantization = base.quantizationPolicies[0];
  const policy = base.policies[0];
  if (!quantization || !policy) throw new Error("The book has no policies");
  let revision = base.bookRevision;
  const first = base.journals.length;
  const posted: string[] = [];
  for (let index = 1; index <= count; index++) {
    const n = first + index;
    const id = `bulk-${n}`;
    const entry = options.entry?.(n) ?? {
      date: `2026-${String(1 + (n % 12)).padStart(2, "0")}-${String(1 + (n % 27)).padStart(2, "0")}`,
      debit: "1000",
      credit: "4000",
      cents: 1000n + BigInt(n),
    };
    const date = entry.date;
    const postings = [
      { account: entry.debit, value: entry.cents },
      { account: entry.credit, value: -entry.cents },
    ].map((line, ordinal) => ({
      id: postingId(`${id}-${ordinal}`),
      ordinal: BigInt(ordinal),
      accountId: accountId(line.account),
      units: { canonicalNumber: ExactRational.of(line.value, 100n), commodityId: currency },
      bookValue: { amount: ExactDecimal.of(line.value, 2n), functionalCommodityId: currency },
      dimensionMemberIds: [],
    }));
    const now = new Date().toISOString();
    const resolved = resolveJournal(
      {
        id: journalId(id),
        kind: "ordinary",
        bookId: base.identity.bookId,
        functionalCommodityId: currency,
        economicAt: instant(`${date}T12:00:00Z`),
        accountingDate: localDate(date),
        recordedAt: instant(now),
        narration: `Bulk journal ${n}`,
        postings,
      },
      base.policies,
      base.identity.ownerId,
      quantization,
      postings.map((posting) => posting.bookValue.amount.toRational()),
      [],
    );
    if (Array.isArray(resolved)) throw new Error(resolved.map((item) => item.message).join("; "));
    const receipt = await service.ledger.execute(
      await internals.credential(),
      sealCommand({
        id: commandId(id),
        type: "postJournal",
        protocolVersion: policy.version,
        bookId: base.identity.bookId,
        expectedBookRevision: revision,
        actorId: internals.actor,
        issuedAt: instant(now),
        completedAt: instant(now),
        committedAt: instant(now),
        resolved: resolved as ResolvedTransaction,
      }),
    );
    if (receipt.value.result.disposition !== "committed")
      throw new Error(
        `Journal ${id} was rejected: ${JSON.stringify(receipt.value.result, (_key, value) => (typeof value === "bigint" ? value.toString() : value))}`,
      );
    revision += 1n;
    posted.push(id);
  }
  return posted;
}

/** Reverse these journals, each by a linked reversal dated the same day, straight through the ledger as
 * `postBulk` posts: the book then has the corrections a book that has been used has (they are what makes
 * the Journal screen and the reconciliation lists more than a scan of postings). Returns the reversals'
 * ids. */
export async function reverseBulk(
  service: ApplicationService,
  originalIds: readonly string[],
): Promise<string[]> {
  // biome-ignore lint/suspicious/noExplicitAny: test support reaching private members
  const internals = service as any;
  const { aggregate } = await service.readAggregate();
  const base = aggregate.state;
  const quantization = base.quantizationPolicies[0];
  const policy = base.policies[0];
  if (!quantization || !policy) throw new Error("The book has no policies");
  const byId = new Map(base.journals.map((booked) => [booked.journal.id as string, booked]));
  let revision = base.bookRevision;
  const reversals: string[] = [];
  for (const originalId of originalIds) {
    const original = byId.get(originalId);
    if (!original) throw new Error(`No journal ${originalId} to reverse`);
    const id = `reversal-${originalId}`;
    const now = new Date().toISOString();
    const journal: JournalTransaction = {
      id: journalId(id),
      kind: "reversing",
      bookId: base.identity.bookId,
      functionalCommodityId: base.identity.functionalCommodityId,
      economicAt: original.journal.economicAt,
      accountingDate: original.journal.accountingDate,
      recordedAt: instant(now),
      narration: `Reversal of No. ${original.postingSequence}: bulk`,
      postings: original.journal.postings.map((posting, ordinal) => ({
        ...posting,
        id: postingId(`${id}-${ordinal}`),
        units: { ...posting.units, canonicalNumber: posting.units.canonicalNumber.negate() },
        bookValue: { ...posting.bookValue, amount: posting.bookValue.amount.negate() },
      })),
    };
    const resolved = resolveJournal(
      journal,
      base.policies,
      base.identity.ownerId,
      quantization,
      journal.postings.map((posting) => posting.bookValue.amount.toRational()),
      [
        {
          id: derivationId(`${id}-lineage`),
          policyId: policy.id,
          policyVersion: policy.version,
          algorithmVersion: policy.version,
          inputHash: hashCanonical({ originalJournalId: originalId }),
          actorId: internals.actor,
          state: "approved" as const,
          recordedAt: instant(now),
          evidence: [
            {
              id: evidenceId(`${id}-evidence`),
              sourceSystem: "bulk-review",
              sourceRecordId: originalId,
              observedAt: instant(now),
              contentHash: original.canonicalHash,
            },
          ],
        },
      ],
    );
    if (Array.isArray(resolved)) throw new Error(resolved.map((item) => item.message).join("; "));
    const receipt = await service.ledger.execute(
      await internals.credential(),
      sealCommand({
        id: commandId(id),
        type: "correctJournal",
        protocolVersion: policy.version,
        bookId: base.identity.bookId,
        expectedBookRevision: revision,
        actorId: internals.actor,
        issuedAt: instant(now),
        completedAt: instant(now),
        committedAt: instant(now),
        correctionKind: "reversal",
        originalJournalId: original.journal.id,
        resolved: resolved as ResolvedTransaction,
      }),
    );
    if (receipt.value.result.disposition !== "committed")
      throw new Error(`Reversal ${id} was rejected: ${JSON.stringify(receipt.value.result)}`);
    revision += 1n;
    reversals.push(id);
  }
  return reversals;
}
