/** Recording a payee: its name, the words that identify it, a default account, a note, retired or not.
 *
 * Every write is retained by operation identity (the same identity with the same input returns the
 * first answer and repeats nothing), a change names the version it changes, and a refusal leaves
 * nothing behind. A payee's history is append-only, with who and when.
 *
 * A payee that is also a 1099 vendor keeps its name and words in step with the vendor: a change here
 * is recorded as a new version of the vendor in the same transaction, so the 1099 list and this list
 * cannot disagree. Naming a payee changes which row of the report its transactions are in; it posts
 * nothing and no payee can change a posting. */
import { describePrincipal } from "../../agent/principal.ts";
import type { PayeeSaved } from "../../client-contracts.gen.ts";
import { ApplicationError } from "../../errors.ts";
import { deriveId } from "../../ingest/hash.ts";
import { sanitizeText } from "../../ingest/text.ts";
import { PAYEE_KEY_MAX, PAYEE_KEY_MIN, payeeKey } from "../../payees/match.ts";
import type { ApplicationService } from "../../service.ts";
import { appendEvent, readTaxState, taxRuntime, type VendorBody } from "../tax/store.ts";
import type { SliceContext } from "../types.ts";
import { payeeWire } from "./read.ts";
import {
  type Payee,
  type PayeeBody,
  type PayeeState,
  appendPayee,
  payeesRuntime,
  readPayeeState,
} from "./store.ts";

export const MAX_WORDS = 20;

function refuse(code: string, message: string, status = 400, path?: string): never {
  throw new ApplicationError(code, message, status, path ? [{ path, message }] : []);
}

/** A name as it is kept and shown: control and direction characters removed, one line, bounded. */
export function cleanName(value: unknown): string {
  const name = typeof value === "string" ? sanitizeText(value, 120) : "";
  if (name.length < 1) refuse("invalid_input", "A payee needs a name.", 400, "input.name");
  return name;
}

/** The keys a list of words reduces to. Each is the words of what was typed, joined by single spaces;
 * a key shorter than three characters would match half the book and is refused. */
export function cleanWords(value: unknown, path = "input.words"): string[] {
  if (!Array.isArray(value)) return [];
  if (value.length > MAX_WORDS)
    refuse("invalid_input", `A payee has at most ${MAX_WORDS} sets of words.`, 400, path);
  const keys: string[] = [];
  for (const raw of value) {
    const key = payeeKey(typeof raw === "string" ? raw : "").slice(0, PAYEE_KEY_MAX);
    if (key.length < PAYEE_KEY_MIN)
      refuse(
        "invalid_input",
        `The words need at least ${PAYEE_KEY_MIN} letters or digits: "${sanitizeText(String(raw), 40)}" is too short and would match too many transactions.`,
        400,
        path,
      );
    if (!keys.includes(key)) keys.push(key);
  }
  return keys;
}

/** The payee, other than `owner`, whose name is `name` (case ignored), if any. */
export const holderOfName = (state: PayeeState, name: string, owner: string | null) =>
  state.payees.find(
    (payee) => payee.id !== owner && payee.name.toLowerCase() === name.toLowerCase(),
  );

/** The payee, other than `owner`, that already has this key, if any. */
export const holderOfKey = (state: PayeeState, key: string, owner: string | null) =>
  state.payees.find((payee) => payee.id !== owner && payee.words.includes(key));

const sameWords = (a: readonly string[], b: readonly string[]) =>
  a.length === b.length && a.every((word, index) => word === b[index]);

const bodyOf = (payee: Payee): PayeeBody => ({
  name: payee.name,
  words: payee.words,
  defaultAccountId: payee.defaultAccountId,
  note: payee.note,
  retired: payee.retired,
});

async function assertAccount(service: ApplicationService, accountId: string): Promise<void> {
  const { aggregate } = await service.readAggregate();
  if (!aggregate.state.admissionSnapshot.accounts.some((account) => account.id === accountId))
    refuse(
      "account_not_found",
      `No account has the id ${accountId}. Use accounts.list to find an account's id.`,
      404,
      "input.defaultAccountId",
    );
}

export async function savePayee(
  context: SliceContext,
  input: Record<string, unknown>,
  operationId: string,
): Promise<PayeeSaved> {
  const service = context.service;
  const runtime = payeesRuntime(service);
  const tax = taxRuntime(service);
  const principal = describePrincipal(context.access.principal);
  // The account is read from the book before the write, which is then synchronous.
  if (typeof input.defaultAccountId === "string")
    await assertAccount(service, input.defaultAccountId);
  return service.retainRequest(operationId, "payees.save", input, () => {
    const state = readPayeeState(runtime.store);
    const id = typeof input.payeeId === "string" ? input.payeeId : null;
    const current = id === null ? undefined : state.payees.find((payee) => payee.id === id);
    if (id !== null && !current)
      return refuse("payee_not_found", "No payee has that id. List them with payees.list.", 404);
    if (current && input.expectedVersion !== current.version)
      return refuse(
        "payee_version_conflict",
        `${current.name} changed since you read it (it is at version ${current.version}). Read it again and apply your change to that.`,
        409,
        "input.expectedVersion",
      );
    if (!current && input.name === undefined)
      return refuse("invalid_input", "A new payee needs a name.", 400, "input.name");
    const base: PayeeBody = current
      ? bodyOf(current)
      : { name: "", words: [], defaultAccountId: null, note: "", retired: false };
    const name = input.name === undefined ? base.name : cleanName(input.name);
    if (holderOfName(state, name, id))
      refuse("payee_name_in_use", `A payee named ${name} already exists.`, 409, "input.name");
    const words = input.words === undefined ? base.words : cleanWords(input.words);
    for (const key of words) {
      const holder = holderOfKey(state, key, id);
      if (holder)
        refuse(
          "payee_key_in_use",
          `"${key}" already belongs to ${holder.name}. A set of words names one payee.`,
          409,
          "input.words",
        );
    }
    const body: PayeeBody = {
      name,
      words,
      defaultAccountId:
        input.defaultAccountId === undefined
          ? base.defaultAccountId
          : (input.defaultAccountId as string | null),
      note: input.note === undefined ? base.note : sanitizeText(String(input.note), 500),
      retired: input.retired === undefined ? base.retired : input.retired === true,
    };
    if (current && JSON.stringify(body) === JSON.stringify(bodyOf(current)))
      return {
        payee: payeeWire(current, new Set(readTaxState(tax.store).vendors.map((v) => v.id))),
        changed: false,
        payeesRevision: String(state.revision),
        payeesHash: state.hash,
      };
    const subject = current ? current.id : deriveId("pay_", [operationId]);
    appendPayee(runtime, { payee: subject, body, principal, operationId, via: "payees.save" });
    // A payee that is a 1099 vendor is the vendor's name and words too: record the vendor's next
    // version with them, so the 1099 list says what this list says.
    const taxState = readTaxState(tax.store);
    const vendor = taxState.vendors.find((entry) => entry.id === subject);
    if (vendor && (vendor.name !== body.name || !sameWords(vendor.payeeKeys, body.words))) {
      const next: VendorBody = {
        name: body.name,
        payeeKeys: body.words,
        reporting: vendor.reporting,
        reason: vendor.reason,
        w9: vendor.w9,
        w9On: vendor.w9On,
        classification: vendor.classification,
        paidBy: vendor.paidBy,
        notes: vendor.notes,
      };
      appendEvent(tax, { kind: "vendor", subject, body: next, principal, operationId });
    }
    const after = readPayeeState(runtime.store);
    const saved = after.payees.find((payee) => payee.id === subject) as Payee;
    return {
      payee: payeeWire(saved, new Set(readTaxState(tax.store).vendors.map((v) => v.id))),
      changed: true,
      payeesRevision: String(after.revision),
      payeesHash: after.hash,
    };
  });
}
