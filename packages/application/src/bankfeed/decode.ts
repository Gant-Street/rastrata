import { MAX_ACCOUNTS, MAX_NAME, MAX_TRANSACTIONS_PER_ACCOUNT } from "./constants.ts";
import { type BridgeProblem, readProblems } from "./problems.ts";
import { safeText } from "./redact.ts";

/** The Bridge's answer to `GET /accounts`, read without trusting it. Both shapes are understood:
 *
 *  - version 2: `errlist` (objects), `connections`, and `conn_id` on each account;
 *  - version 1: `errors` (strings) and an `org` object on each account.
 *
 * (The Bridge answers in version 1 when `version=2` is not sent, and in version 2 when it is; this
 * lane always sends it, and reads both so a change on the Bridge's side cannot silently stop the
 * feed.) Unknown fields are ignored, never executed. Each transaction is left as it came: reading
 * one is the normaliser's work, so that one unreadable transaction never costs the account. */

export interface BridgeConnection {
  readonly id: string;
  readonly name: string;
  readonly orgId: string | null;
  readonly orgName: string | null;
}

export interface BridgeAccount {
  /** The Bridge's own id for the account, as sent (1 to 128 characters). */
  readonly id: string;
  readonly name: string;
  /** As sent, bounded: an ISO 4217 code, or a custom currency written as a URL. */
  readonly currency: string;
  /** As sent; read by the normaliser, which accepts only an exact decimal string. */
  readonly balance: unknown;
  readonly balanceDate: unknown;
  readonly connId: string | null;
  readonly orgId: string | null;
  readonly orgName: string | null;
  /** The transactions as sent, or null when the answer had no list at all. */
  readonly transactions: readonly unknown[] | null;
}

export interface AccountSet {
  readonly problems: readonly BridgeProblem[];
  readonly connections: readonly BridgeConnection[];
  readonly accounts: readonly BridgeAccount[];
  /** Accounts that could not be read at all, by their position in the answer. */
  readonly rejected: readonly { readonly index: number; readonly reason: string }[];
  /** `x-api-message`: notes from the Bridge that are not errors. Untrusted text, bounded. */
  readonly messages: readonly string[];
  readonly shape: "v1" | "v2";
}

export type Decoded =
  | { readonly ok: true; readonly value: AccountSet }
  | { readonly ok: false; readonly problem: string };

const isRecord = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === "object" && !Array.isArray(value);

export function decodeAccountSet(json: unknown, secrets: readonly string[] = []): Decoded {
  if (!isRecord(json)) return { ok: false, problem: "The Bridge's answer was not a JSON object." };
  const text = (value: unknown, max: number): string => safeText(value, { max, secrets });
  const idOf = (value: unknown, max = 128): string | null =>
    typeof value === "string" && value.length >= 1 && value.length <= max ? value : null;
  const problems = readProblems(json, secrets);
  const shape: "v1" | "v2" = "errlist" in json || "connections" in json ? "v2" : "v1";

  const connections: BridgeConnection[] = [];
  if (Array.isArray(json.connections))
    for (const entry of json.connections.slice(0, MAX_ACCOUNTS)) {
      if (!isRecord(entry)) continue;
      const id = idOf(entry.conn_id);
      if (id === null) continue;
      const name = text(entry.name, MAX_NAME);
      const orgName = text(entry.org_name, MAX_NAME);
      connections.push({
        id,
        name: name === "" ? id : name,
        orgId: idOf(entry.org_id),
        orgName: orgName === "" ? null : orgName,
      });
    }
  const connection = (id: string | null) => connections.find((c) => c.id === id);

  const listed = json.accounts;
  if (listed !== undefined && !Array.isArray(listed))
    return { ok: false, problem: "The Bridge's list of accounts was not a list." };
  if ((listed?.length ?? 0) > MAX_ACCOUNTS)
    return { ok: false, problem: `The Bridge listed more than ${MAX_ACCOUNTS} accounts.` };
  if (listed === undefined && problems.length === 0)
    return { ok: false, problem: "The Bridge's answer had no list of accounts." };

  const accounts: BridgeAccount[] = [];
  const rejected: { index: number; reason: string }[] = [];
  for (const [index, entry] of (listed ?? []).entries()) {
    if (!isRecord(entry)) {
      rejected.push({ index, reason: "It is not an object." });
      continue;
    }
    const id = idOf(entry.id);
    if (id === null) {
      rejected.push({ index, reason: "It has no usable id." });
      continue;
    }
    if (typeof entry.currency !== "string" || entry.currency.length === 0) {
      rejected.push({ index, reason: "It has no currency." });
      continue;
    }
    const connId = idOf(entry.conn_id);
    const known = connection(connId);
    // Version 1 names the bank on the account itself.
    const org = isRecord(entry.org) ? entry.org : null;
    const v1Name = org ? text(org.name, MAX_NAME) || text(org.domain, MAX_NAME) : "";
    let transactions: readonly unknown[] | null = null;
    if (entry.transactions !== undefined) {
      if (!Array.isArray(entry.transactions)) {
        rejected.push({ index, reason: "Its list of transactions is not a list." });
        continue;
      }
      if (entry.transactions.length > MAX_TRANSACTIONS_PER_ACCOUNT) {
        rejected.push({ index, reason: "It lists more transactions than Rastrata will read." });
        continue;
      }
      transactions = entry.transactions;
    }
    const name = text(entry.name, MAX_NAME);
    accounts.push({
      id,
      name: name === "" ? text(id, MAX_NAME) : name,
      currency: text(entry.currency, 40),
      balance: entry.balance,
      balanceDate: entry["balance-date"],
      connId,
      orgId: known?.orgId ?? (org ? idOf(org.id) : null),
      orgName: known?.orgName ?? known?.name ?? (v1Name === "" ? null : v1Name),
      transactions,
    });
  }

  const messages: string[] = [];
  if (Array.isArray(json["x-api-message"]))
    for (const entry of json["x-api-message"].slice(0, 3)) {
      const message = text(entry, 200);
      if (message !== "") messages.push(message);
    }
  return {
    ok: true,
    value: { problems, connections, accounts, rejected, messages, shape },
  };
}

/** Ids that more than one account in an answer carries: such an account cannot be asked for by its
 * id alone, so it is shown but never linked or fetched. */
export function duplicateIds(accounts: readonly { readonly id: string }[]): ReadonlySet<string> {
  const seen = new Set<string>();
  const repeated = new Set<string>();
  for (const { id } of accounts) {
    if (seen.has(id)) repeated.add(id);
    seen.add(id);
  }
  return repeated;
}
