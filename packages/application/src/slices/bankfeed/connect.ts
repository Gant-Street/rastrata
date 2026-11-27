import { describePrincipal } from "../../agent/principal.ts";
import { BridgeError, claimSetupToken } from "../../bankfeed/client.ts";
import { describeCredential, parseAccessUrl, parseSetupToken } from "../../bankfeed/credentials.ts";
import type {
  BankfeedConnectInput,
  BankfeedConnectResult,
  BankfeedDisconnectResult,
} from "../../client-contracts.gen.ts";
import { ApplicationError } from "../../errors.ts";
import type { SliceContext } from "../types.ts";
import { accountViews, booksView, refreshListing } from "./accounts.ts";
import { recorder } from "./budget.ts";
import { bankfeedRuntime } from "./runtime.ts";
import { bankfeedStore } from "./store.ts";

/** Connect: claim the owner's setup token and keep the access URL it returns.
 *
 * A setup token can be claimed **once**, and the access URL it returns is the only copy. So the order
 * is fixed, and every step before the claim is a check that cannot waste the token:
 *
 *  1. the token's shape and host are checked (nothing is sent to anything but the Bridge);
 *  2. an existing working connection is not replaced by accident;
 *  3. the place the access URL will be kept is proven writable (`probe`);
 *  4. the token is claimed;
 *  5. the access URL is written to its private file **before anything else happens**; if that fails the
 *     message says the token is used up and a new one is needed.
 *
 * Nothing about the token or the access URL is returned, stored in the book or put in a message: the
 * answer carries the host and the accounts the Bridge lists. The operation is retained under its
 * identity like any write, so a lost reply returns the first answer instead of claiming again. */
export async function connectBankfeed(
  context: SliceContext,
  input: BankfeedConnectInput,
  operationId: string,
): Promise<BankfeedConnectResult> {
  const { service } = context;
  return service.retainAsyncRequest(operationId, "bankfeed.connect", input, async () => {
    const store = bankfeedStore(service);
    const runtime = bankfeedRuntime(service);
    const setup = service.setupState();
    if (!setup) throw new ApplicationError("book_not_configured", "Book is not configured", 409);

    // 1. The token is read and checked. The message never repeats it.
    const token = parseSetupToken(input.setupToken, runtime.policy);
    if (!token.ok)
      throw new ApplicationError(
        token.code,
        token.message,
        token.code === "bankfeed_host_refused" ? 422 : 400,
      );

    // 2. A working connection is not replaced by accident. One the Bridge has refused (disabled, revoked,
    // or not paid for) is the case this is for.
    const existing = describeCredential(runtime.credentials, runtime.policy);
    const attention = store.connection().attentionCode;
    if (existing.present && attention !== "access_denied" && attention !== "payment_required")
      throw new ApplicationError(
        "bankfeed_already_connected",
        "The bank feed is already connected. Disconnect first if you want to connect a different SimpleFIN account.",
        409,
      );

    // 3. Somewhere to keep the access URL is proven before the token is spent.
    const unwritable = runtime.credentials.probe();
    if (unwritable !== null)
      throw new ApplicationError("bankfeed_credential_unwritable", unwritable, 409);

    // 4. The claim.
    const clock = (): number => Date.parse(runtime.now());
    let accessUrl: string;
    try {
      accessUrl = (
        await claimSetupToken(input.setupToken, runtime.policy, {
          fetch: runtime.fetch,
          now: clock,
          onRequest: recorder(store),
          ...(runtime.sleep ? { sleep: runtime.sleep } : {}),
          ...(runtime.timeoutMs ? { timeoutMs: runtime.timeoutMs } : {}),
        })
      ).accessUrl;
    } catch (error) {
      if (error instanceof BridgeError)
        throw new ApplicationError(
          error.code,
          error.message,
          error.code === "bankfeed_unavailable"
            ? 502
            : error.code === "bankfeed_token_rejected"
              ? 409
              : 424,
          [],
          error.retryable,
        );
      throw error;
    }

    // 5. Kept at once, before anything else can fail.
    try {
      runtime.credentials.write(accessUrl);
    } catch {
      throw new ApplicationError(
        "bankfeed_credential_unwritable",
        "The Bridge accepted the setup token, but Rastrata could not save the access URL it returned. That token is now used up and the access URL is lost. Fix the folder's permissions, create a new setup token at the Bridge, and connect again.",
        500,
      );
    }
    const access = parseAccessUrl(accessUrl, runtime.policy);
    if (access === null)
      throw new ApplicationError(
        "bankfeed_bad_response",
        "The Bridge accepted the claim but its answer was not a usable access URL. Create a new setup token and connect again.",
        424,
      );
    store.markConnected(access.host, runtime.now(), describePrincipal(context.access.principal));

    // The accounts the Bridge lists, so the owner can choose which to read. The connection is saved
    // whether or not this works.
    let accountsError: string | null = null;
    try {
      await refreshListing(context, store, access);
    } catch (error) {
      accountsError =
        error instanceof ApplicationError
          ? error.message.slice(0, 900)
          : "The accounts could not be listed yet. Try again.";
    }
    const books = await booksView(context, setup.currency, false);
    return {
      connected: true,
      host: access.host,
      accounts: accountViews(store, books),
      accountsError,
    };
  });
}

/** Disconnect: delete the access URL file. Imported lines, links and cursors stay, so connecting again
 * with a new setup token carries on where it stopped. */
export async function disconnectBankfeed(
  context: SliceContext,
  operationId: string,
): Promise<BankfeedDisconnectResult> {
  const { service } = context;
  return service.retainAsyncRequest(operationId, "bankfeed.disconnect", {}, async () => {
    const runtime = bankfeedRuntime(service);
    const store = bankfeedStore(service);
    const had = describeCredential(runtime.credentials, runtime.policy);
    runtime.credentials.remove();
    store.markDisconnected();
    return { connected: false, removed: had.present || had.problem !== null };
  });
}
