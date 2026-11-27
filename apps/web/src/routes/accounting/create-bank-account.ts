/** Make a bank, card or loan account the way the New account drawer does (a prepared plan, its commit, then the
 * account's tags), for a flow that brings transactions in and finds no account to put them in: a bank that was
 * connected, a statement that was chosen. The account is named as the bank or the file names it and opens on the
 * day the chart suggests. A plan with a warning is committed too (a warning is something to read, not a refusal),
 * and the warnings are handed back for the page to say. */
import type { ApplicationOutputs } from "@rastrata/application/client-contracts";
import {
  newAccountRequest,
  newAccountTags,
  type NewAccountValues,
  suggestCode,
} from "@rastrata/ui";
import type { BrowserApplicationClient } from "../../application-client";

type AccountList = ApplicationOutputs["accounts.list"];
export type ChartAccountRow = AccountList["accounts"][number];

/** What the account is to the person: a bank account (an asset the cash flow calls cash), a card (an operating
 * liability) or a loan (a financing liability: a line of credit, a mortgage). */
export type NewBankAccountKind = "bank" | "card" | "loan";

export interface NewBankAccount {
  readonly name: string;
  readonly kind: NewBankAccountKind;
}

export interface MadeBankAccount {
  readonly account: ChartAccountRow;
  readonly warnings: readonly string[];
}

const FAILED = "The account could not be made.";

export async function createBankAccount(
  client: BrowserApplicationClient,
  chart: AccountList,
  input: NewBankAccount,
  workflow: string,
): Promise<MadeBankAccount> {
  const kind: NewAccountValues["kind"] = input.kind === "loan" ? "liability" : input.kind;
  const values: NewAccountValues = {
    name: input.name.trim(),
    kind,
    code: suggestCode(chart.accounts, kind),
    parentId: "",
    effectiveOn: chart.suggestedEffectiveOn,
    cashFlowClass: input.kind === "loan" ? "financing" : "",
    taxLine: "",
    roleKey: "",
  };
  const plan = await client.write(
    "accounts.prepareCreate",
    newAccountRequest(values),
    `${workflow}:prepare`,
  );
  if (!plan.valid) throw new Error(plan.diagnostics.join(" ") || FAILED);
  const receipt = await client.write(
    "operations.commit",
    { planId: plan.planId, planHash: plan.planHash },
    `${workflow}:commit`,
  );
  if (receipt.disposition !== "committed") throw new Error(receipt.diagnostics.join(" ") || FAILED);
  const list = await client.read("accounts.list", {}, { fresh: true });
  const code = values.code.toLowerCase();
  const account = list.accounts.find((row) => row.code.toLowerCase() === code);
  if (!account) throw new Error("The account was made, but it could not be found in the chart.");
  const tags = newAccountTags(values);
  if (Object.keys(tags).length > 0)
    await client.write(
      "accounts.setTags",
      { accountId: account.id, effectiveOn: values.effectiveOn, tags },
      `${workflow}:tags`,
    );
  return { account, warnings: (plan.warnings ?? []).map((warning) => warning.message) };
}
