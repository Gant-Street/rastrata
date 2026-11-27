// The application on a book that a host keeps in a log (the hosted book log in packages/booklog): what
// a host needs from the application and nothing that depends on the host. The host owns the SQLite
// connection and puts every request in one transaction on it, so the service is opened on that
// connection (and never closes it), the slices make their tables when the book opens, and the reads
// that write something replicated are told apart by who made them.
import type { Database } from "bun:sqlite";
import type { ApplicationAccess } from "../agent/principal.ts";
import { isKeyName } from "../agent/member.ts";
import { AGENT_KEY_ID, constantTimeEqual, parseAuthorization } from "../agent/token.ts";
import { ApplicationHttp } from "../http.ts";
import { createLegacyBookHandler } from "../legacy-http.ts";
import { APPLICATION_API_VERSION, BUSINESS_PERMISSIONS, operationCatalog } from "../schema.ts";
import type { VerifiedView } from "../service.ts";
import { LocalBookService, type LocalOpenOptions } from "./open.ts";

export { createExportGate, type ExportGate } from "./hosted-exports.ts";
export { LedgerReplayError, type VerifiedView } from "../service.ts";

/** Tables the application can rebuild from the book, which the log therefore does not carry. */
export const APPLICATION_DERIVED = ["app_read_snapshots"] as const;

/** The highest schema version of this build of the application, stamped on every entry of a book's
 * log. Bumped when a release changes the book's tables in a way a process running the previous
 * release cannot read; a process older than an entry refuses it, so a rolling deploy must expand
 * before it contracts.
 *
 * 1: the tables as the first hosted release had them.
 * 2: the table `app_operation_locators` and the column `app_ingest_items.post_error_code` (ingest
 *    migration 6): a process that has not got migration 6 refuses to open the Inbox of such a book.
 * 3: the table `members` (the members slice: who is in the book and as what): a process that has not got it
 *    cannot replay a member being added.
 * 4: the table `book_retirement` (the members slice: the book is being deleted and lets no member in): a process that has not
 *    got it cannot replay a book being retired.
 * 5: the tables `changes_commits` and `changes_reviews` (the changes slice: who asked for each command, and a person saying
 *    they have looked at the changes), `entries_moves` (the entries slice: the transactions a change of account has taken
 *    in hand), `payee_events` (the payees slice: the history of each payee, written with a 1099 vendor's) and the column
 *    `chart_tag_log.principal` (who set a tag): a process that has not got them cannot replay a command that records its
 *    maker, a change of account, a payee being saved or an account being tagged.
 * 6: the tables `banks_accounts` and `banks_held` (the banks slice: the accounts a bank connection has brought and where each is booked): a process that has not got
 *    them cannot replay an account being booked.
 * 7: the table `book_access` (the members slice: the book is read-only, because its workspace has no subscription): a process that has not got it cannot replay a book being made
 *    read-only. */
export const APPLICATION_SCHEMA = 7;

/** The header with which the process that serves the book tells the application who is calling, when it has checked that itself (a
 * member's signed token, the control plane's key). The application believes it only with the process's secret in it, a random value
 * that process made when it started and no caller has; without the secret the request is refused, and the header goes no further. */
export const PRINCIPAL_HEADER = "x-rastrata-principal";

export type VouchedPrincipal =
  | { readonly kind: "member"; readonly userId: string }
  | {
      /** An agent key of this person: the token that was checked carried the key's identifier, the scopes it was given, its name, and the end of the key (`expires`, seconds since the epoch). */
      readonly kind: "agent";
      readonly userId: string;
      readonly keyId: string;
      readonly scopes: readonly string[];
      readonly name: string;
      readonly expires: number;
    }
  | { readonly kind: "service"; readonly name: string };

/** The value of `PRINCIPAL_HEADER` for a caller the process has checked. Its parts are separated by dots, which no identifier, permission or number in it contains; a key's name, which
 * can, goes as base64url. */
export const vouch = (secret: string, who: VouchedPrincipal): string =>
  who.kind === "agent"
    ? `${secret}.agent.${who.userId}.${who.keyId}.${who.scopes.join("+")}.${who.expires}.${Buffer.from(who.name, "utf8").toString("base64url")}`
    : `${secret}.${who.kind}.${who.kind === "member" ? who.userId : who.name}`;

const READS: ReadonlySet<string> = new Set(
  operationCatalog.filter((operation) => !operation.writes).map((operation) => operation.name),
);

/** A request made with an agent token, whether or not the token turns out to be good. The
 * application writes an audit row for each, reads included. */
export function isAgentRequest(request: Request): boolean {
  try {
    // An agent key the process has vouched for has no Authorization header left: the vouching says what it was.
    if (request.headers.get(PRINCIPAL_HEADER)?.split(".")[1] === "agent") return true;
    return parseAuthorization(request.headers.get("authorization")).kind === "token";
  } catch {
    return false;
  }
}

/** The hosted policy for a read that has to be logged: the audit row of an agent's request is durable
 * before the answer (an audit that can lose its last seconds loses the seconds around an incident,
 * and agent traffic is small); everything else, which is the owner's own reads, is logged soon and
 * never makes a person wait for the tail. */
export const agentReadsLogFirst = (request: Request): "log-first" | undefined =>
  isAgentRequest(request) ? "log-first" : undefined;

/** Whether a request to the application may change the book: a write operation, an upload, or
 * anything else that is not a read. (A read that writes anyway is logged too.) */
export function changesBook(request: Request): boolean {
  if (request.method === "GET" || request.method === "HEAD") return false;
  const path = new URL(request.url).pathname;
  const operation = /^\/v1\/([A-Za-z0-9.]+)$/.exec(path)?.[1];
  if (operation === undefined) return true;
  return !READS.has(operation);
}

export interface HostedServiceOptions {
  /** Passed to the service; `database`, `snapshots` and `prepareSlices` are set below, and `safety`
   * is off unless named. */
  readonly local?: Omit<LocalOpenOptions, "database" | "snapshots" | "prepareSlices">;
  /** Called with every service made, before it serves: point its clock and ports where a test wants. */
  readonly wire?: (service: LocalBookService) => void | Promise<void>;
  /** Make the tables of every slice now, as part of opening (the default), so that a read never
   * creates one. */
  readonly prepareSlices?: boolean;
  /** The service's own snapshot of its verified state (`app_read_snapshots`). Off by default: the
   * book's snapshot is the file in the object store, and a cold read with this on makes the one
   * attempt to encode a state past the kernel's cap (an experiment turns it on to price that). */
  readonly snapshots?: boolean;
  /** Locks the owner: requests must present this key (or an agent token). Left out, a request with
   * no credentials is the owner, the loopback development mode. */
  readonly ownerKey?: string;
  /** The process's secret for `PRINCIPAL_HEADER`. Without it the header is refused whenever it comes. */
  readonly principalSecret?: string;
  /** The verified state of the service this one replaces (`HostedService.carry`), when the database has moved on under it because the log was caught up. The first read then applies only the outcomes
   * after it; a head that is not on the ledger's chain is refused by the ledger and the read starts from the first entry. */
  readonly carry?: CarriedState | null;
  /** Answer from the stored revisions and check the whole ledger behind the first answer, a write waiting for the check (`HostedService.beforeWrite`): a book is read in a fifth of the time and nothing
   * is any less checked than when every read waited for the check. A pod sets it for `RASTRATA_REPLAY=full`. */
  readonly verifyBehind?: boolean;
}

/** What a service hands to the one that replaces it when the log is caught up: its verified view, and the check of the ledger that may still be going on behind it. */
export interface CarriedState {
  readonly view: VerifiedView | null;
  readonly verifying: Promise<void> | null;
}

export interface HostedService {
  readonly service: LocalBookService;
  readonly http: ApplicationHttp;
  /** `/v1/*` through the application's HTTP boundary, `/api/*` (the browser's older routes) through
   * its legacy handler after the same access check. With `as`, the caller is one the runtime has already
   * authenticated (a member it checked a signed token of, or the control plane): the credentials of the
   * request are not looked at. */
  fetch(request: Request, as?: ApplicationAccess): Promise<Response>;
  /** What a member of this book may do, from the book's member table; null when they are not in it. */
  memberAccess(userId: string): ApplicationAccess | null;
  /** What the control plane may do in this book, as itself. */
  serviceAccess(name: string): ApplicationAccess;
  /** The verified state of the book as far as this service has read it, for the service that replaces it when the log is caught up (`HostedServiceOptions.carry`); null before its first read. */
  carry(): CarriedState | null;
  /** The check of the ledger that goes on behind this service's answers (see `ApplicationService.verification`). */
  verification(): Promise<void> | null;
  /** Waits until the ledger has been checked, which a write does before it runs. */
  beforeWrite(): Promise<void>;
  /** Release what the service holds; the connection stays the host's. */
  close(): void;
}

/** The service and the HTTP boundary in front of it, on the connection the host handed in. `path` is
 * only where the service looks for its private files (a Stripe key, a bank feed credential). */
export async function openHostedService(
  db: Database,
  path: string,
  options: HostedServiceOptions = {},
): Promise<HostedService> {
  const service = await LocalBookService.open(path, {
    safety: false,
    ...options.local,
    prepareSlices: options.prepareSlices ?? true,
    snapshots: options.snapshots ?? false,
    database: db,
    ...(options.carry?.view ? { view: options.carry.view } : {}),
    ...(options.carry?.verifying ? { verifying: options.carry.verifying } : {}),
    ...(options.verifyBehind ? { verifyBehind: true } : {}),
  });
  try {
    await options.wire?.(service);
  } catch (error) {
    service.close();
    throw error;
  }
  const http = new ApplicationHttp(
    service,
    {
      bookId: service.bookId,
      permissions: BUSINESS_PERMISSIONS,
    },
    {
      ...(options.ownerKey ? { ownerKey: options.ownerKey } : {}),
      ...(options.local?.now ? { clock: options.local.now } : {}),
    },
  );
  const legacy = createLegacyBookHandler(service);
  const refusal = (status: number, code: string, message: string): Response =>
    Response.json(
      {
        version: APPLICATION_API_VERSION,
        bookId: service.bookId,
        ok: false,
        error: { code, message, retryable: false, details: [] },
      },
      { status, headers: { "cache-control": "no-store", "x-content-type-options": "nosniff" } },
    );
  /** The access a vouched caller has in this book: `undefined` when the vouching is not the process's (a wrong secret, a
   * shape that is not one), `null` when the person is not in the book (any more). */
  const vouched = (claim: string): ApplicationAccess | null | undefined => {
    const secret = options.principalSecret;
    const [given, kind, id, ...rest] = claim.split(".");
    if (!secret || !given || !constantTimeEqual(given, secret) || !id) return undefined;
    if (kind === "member" && rest.length === 0) return http.memberAccess(id);
    if (kind === "service" && rest.length === 0) return http.serviceAccess(id);
    if (kind === "agent" && rest.length === 4) {
      const [keyId, scopes, expires, named] = rest as [string, string, string, string];
      const ends = Number(expires);
      const name = /^[A-Za-z0-9_-]{1,400}$/.test(named)
        ? Buffer.from(named, "base64url").toString("utf8")
        : null;
      if (!AGENT_KEY_ID.test(keyId) || !Number.isFinite(ends) || !isKeyName(name)) return undefined;
      return http.agentAccess(id, {
        keyId,
        scopes: scopes.split("+"),
        name,
        expiresAt: new Date(ends * 1000).toISOString(),
      });
    }
    return undefined;
  };
  return {
    service,
    http,
    async fetch(request, as) {
      let call = request;
      let access = as;
      if (request.headers.has(PRINCIPAL_HEADER)) {
        const claim = request.headers.get(PRINCIPAL_HEADER) ?? "";
        const headers = new Headers(request.headers);
        headers.delete(PRINCIPAL_HEADER);
        call = new Request(request, { headers });
        const found = vouched(claim);
        if (found === undefined)
          return refusal(401, "token_invalid", "The credentials were not accepted");
        if (found === null)
          // A book that is being deleted lets nobody in, and says that and not that the person is not a member.
          return http.retired()
            ? refusal(410, "book_retired", "This workspace is being deleted")
            : refusal(403, "not_a_member", "You are not a member of this workspace");
        access = found;
      }
      if (new URL(call.url).pathname.startsWith("/api/")) {
        const refused = await http.guardLegacy(call, access);
        return refused ?? legacy(call);
      }
      return http.fetch(call, access);
    },
    carry: () => {
      const view = service.verifiedView();
      const verifying = service.verification();
      return view === null && verifying === null ? null : { view, verifying };
    },
    verification: () => service.verification(),
    beforeWrite: () => service.ensureVerified(),
    memberAccess: (userId) => http.memberAccess(userId),
    serviceAccess: (name) => http.serviceAccess(name),
    close: () => service.close(),
  };
}
