/** A recorded start date and a posted opening entry, for a seeded test book. The screens that only exist in a
 * book that has them (Close the books' months before the books began, the posted Opening balances page, the
 * opening entry in Transactions, Home's setup list) are never opened against a book without them, so the
 * ux-guards ratchet seeds this to hold them to the same rules as every other screen.
 *
 * It is what a person does on the Opening balances page, through the same operations: record the start
 * date, plan the one entry, post exactly that plan. */
type Call = (name: string, input: unknown, operationId?: string) => Promise<unknown>;

const START_DATE = "2026-03-01";

export async function recordStartAndOpening(
  call: Call,
  accounts: {
    readonly checking: string;
    readonly savings: string;
    readonly card: string;
    /** The equity account that carries the difference. */
    readonly capital: string;
  },
): Promise<void> {
  await call(
    "cutover.set",
    { cutoverDate: START_DATE, accountIds: [accounts.checking] },
    crypto.randomUUID(),
  );
  let planned: { plan: { planId: string; planHash: string } };
  try {
    planned = (await call(
      "opening.plan",
      {
        cutoverDate: START_DATE,
        offsetAccountId: accounts.capital,
        balances: [
          { accountId: accounts.checking, balance: "2500.00" },
          { accountId: accounts.savings, balance: "1000.00" },
          { accountId: accounts.card, balance: "300.00" },
        ],
      },
      crypto.randomUUID(),
    )) as { plan: { planId: string; planHash: string } };
  } catch (error) {
    // A second run against the same book (a retried test) finds the entry already posted, which is what it wanted.
    if (/opening_invalid/.test(String(error)) && /already posted/.test(String(error))) return;
    throw error;
  }
  await call("operations.commit", {
    planId: planned.plan.planId,
    planHash: planned.plan.planHash,
  });
}
