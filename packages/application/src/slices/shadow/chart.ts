import type { AccountList, PeriodList } from "../../client-contracts.gen.ts";
import type { OpeningAccount, OpeningRole } from "../../shadow/opening.ts";
import type { SliceContext } from "../types.ts";
import { callOperation } from "./operations.ts";

/** An account of the chart as the shadow lane needs it: what the opening entry checks, plus the
 * tags that say what the account is for. */
export interface ChartAccount extends OpeningAccount {
  readonly roleKey: string | null;
  readonly cashFlowClass: string | null;
}

export interface Chart {
  readonly currency: string;
  readonly accounts: readonly ChartAccount[];
}

/** The chart in force today, read through `accounts.list` like any other client. */
export async function readChart(context: SliceContext): Promise<Chart> {
  const list = await callOperation<AccountList>(context, "accounts.list");
  return {
    currency: list.currency,
    accounts: list.accounts.map((account) => ({
      id: account.id,
      code: account.code,
      name: account.name,
      role: account.role as OpeningRole,
      openedOn: account.openedOn,
      closedOn: account.closedOn,
      roleKey: account.tags?.roleKey ?? null,
      cashFlowClass: account.tags?.cashFlowClass ?? null,
    })),
  };
}

/** The fiscal calendar and its periods, read through `periods.list`. */
export function readPeriods(context: SliceContext): Promise<PeriodList> {
  return callOperation<PeriodList>(context, "periods.list");
}
