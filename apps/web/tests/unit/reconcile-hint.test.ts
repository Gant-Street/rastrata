import { expect, test } from "bun:test";
import {
  STATEMENT_BALANCE_PROVIDERS,
  statementBalanceHint,
} from "../../src/routes/reconcile/figures";

const check = (provider: string, asOf: string, reported: string, ledgerAccountId = "1000") => ({
  provider,
  ledgerAccountId,
  asOf,
  reported,
});
const checking = { id: "1000", normalSide: "debit" as const };
const card = { id: "2000", normalSide: "credit" as const };

// The reconcile form fills in the statement date and balance from an imported statement. A bank feed's
// balance is not a statement's, and must never be what a reconciliation is finished against.

test("a statement file's balance is offered, the newest one that is newer than the last reconciliation", () => {
  const checks = [
    check("csv", "2026-09-30", "1000.00"),
    check("ofx", "2026-10-31", "1200.00"),
    check("csv", "2026-08-31", "900.00"),
  ];
  expect(statementBalanceHint(checks, checking, null)).toEqual({
    date: "2026-10-31",
    balance: "1200.00",
  });
  expect(statementBalanceHint(checks, checking, "2026-10-31")).toBeUndefined();
  expect(statementBalanceHint(checks, checking, "2026-09-01")).toEqual({
    date: "2026-10-31",
    balance: "1200.00",
  });
});

test("a bank feed's balance is never offered, however new it is and whatever else is there", () => {
  const feedOnly = [check("simplefin", "2026-10-04", "4021.35")];
  expect(statementBalanceHint(feedOnly, checking, null)).toBeUndefined();
  // Newer than the statement's: the statement's is still the one offered.
  const both = [check("csv", "2026-09-30", "1000.00"), check("simplefin", "2026-10-04", "4021.35")];
  expect(statementBalanceHint(both, checking, null)).toEqual({
    date: "2026-09-30",
    balance: "1000.00",
  });
});

test("only statement providers are listed, so a provider nobody has heard of yet is not offered either", () => {
  expect([...STATEMENT_BALANCE_PROVIDERS].sort()).toEqual(["csv", "ofx", "qfx"]);
  for (const provider of ["simplefin", "stripe", "plaid", "teller", "", "CSV"])
    expect(
      statementBalanceHint([check(provider, "2026-10-04", "1.00")], checking, null),
    ).toBeUndefined();
});

test("only the chosen account's balances count, and a card's balance owed is shown the way a statement prints it", () => {
  const checks = [
    check("csv", "2026-09-30", "-250.00", "2000"),
    check("csv", "2026-09-30", "999.00", "1000"),
  ];
  expect(statementBalanceHint(checks, card, null)).toEqual({
    date: "2026-09-30",
    balance: "250.00",
  });
  expect(statementBalanceHint(checks, checking, null)).toEqual({
    date: "2026-09-30",
    balance: "999.00",
  });
  expect(statementBalanceHint(checks, { id: "3000", normalSide: "debit" }, null)).toBeUndefined();
});
