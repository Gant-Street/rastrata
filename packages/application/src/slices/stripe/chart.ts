import { readAccountTags } from "../../account-tags.ts";
import type { ApplicationService } from "../../service.ts";
import type { ChartAccount, RoleKeyOf } from "./settings.ts";

/** What the Stripe slice reads of the chart: the accounts with their kind and closing date, their
 * balances when asked for, and the role keys the chart lane's tags give them on any date. Tags are
 * read through `readAccountTags`, never from an account's name or code. */
export interface ChartRead {
  readonly chart: readonly ChartAccount[];
  /** Signed balance by account id, as the trial balance shows it. Empty unless asked for. */
  readonly balances: ReadonlyMap<string, string>;
  readonly roleKeyOf: RoleKeyOf;
}

/** Balances need the trial balance compiled, which grows with the book; the accounts alone come from
 * the state the service already holds. */
export async function readChart(
  service: ApplicationService,
  options: { readonly balances?: boolean } = {},
): Promise<ChartRead> {
  const tags = readAccountTags(service.store);
  const roleKeyOf: RoleKeyOf = (accountId, asOf) => tags.tagsFor(accountId, asOf).roleKey;
  if (options.balances) {
    const accounts = await service.accounts();
    return {
      chart: accounts.accounts.map((a) => ({
        id: String(a.id),
        code: a.code,
        role: a.role,
        closedOn: a.closedOn,
      })),
      balances: new Map(accounts.accounts.map((a) => [String(a.id), a.balance])),
      roleKeyOf,
    };
  }
  const { aggregate } = await service.readAggregate();
  return {
    chart: aggregate.state.admissionSnapshot.accounts.map((a) => ({
      id: String(a.id),
      code: a.code,
      role: a.role,
      closedOn: a.closedOn ?? null,
    })),
    balances: new Map(),
    roleKeyOf,
  };
}

/** The role keys' revision, so proposals made with the old tags are made again when a tag changes. */
export function tagsRevision(service: ApplicationService): number {
  return readAccountTags(service.store).revision;
}
