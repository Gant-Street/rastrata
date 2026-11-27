// What the benches share: a chart the size of a real book's, and configuration revisions like the ones
// an account edit or a calendar extension makes. The four-account toy book hides what a command costs per
// account and per revision, so measure a realistic one too: `ACCOUNTS=100 REVISIONS=10`.
import { commandId, instant, localDate, sealCommand } from "@rastrata/kernel";
import type { LocalBookService } from "../src/local.ts";
import { BULK_BOOK } from "../test/support/bulk-book.ts";

/** A starting chart of `count` accounts, like the books people actually keep. */
export const chart = (count: number) => ({
  ...BULK_BOOK,
  accounts: [
    ...BULK_BOOK.accounts,
    ...Array.from({ length: Math.max(0, count - BULK_BOOK.accounts.length) }, (_, index) => ({
      code: String(6000 + index),
      name: `Operating expense ${index}`,
      role: "expense" as const,
    })),
  ],
});

/** Add `count` configuration revisions (as an account edit or a calendar extension does) before any journal. */
export async function reconfigure(book: LocalBookService, count: number) {
  // biome-ignore lint/suspicious/noExplicitAny: bench reaches the service's signing members
  const internals = book as any;
  for (let index = 0; index < count; index += 1) {
    const state = (await book.readAggregate()).aggregate.state;
    const policy = state.policies[0];
    if (!policy) throw new Error("The book has no policies");
    const now = new Date().toISOString();
    const receipt = await book.ledger.execute(
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
