import { BRIDGE_HOME, MAX_MESSAGE } from "./constants.ts";
import { safeText } from "./redact.ts";

/** What the Bridge says is wrong, read from either shape of its answer and made safe to show.
 *
 * Version 2 of the protocol sends `errlist`, objects with a `code`, a `msg` and optionally the
 * `conn_id` or `account_id` they are about. Version 1 sent `errors`, bare strings. The Bridge sends
 * both in one answer when it warns about the number of requests ("warning messages to appear in the
 * `errors` array"), so both are always read. The spec requires an application to show them and to
 * sanitise them: `msg` is text from outside, so it is bounded, stripped of control characters and
 * quoted as the Bridge's words, never run, never obeyed. */

export interface BridgeProblem {
  /** The protocol's code (`con.auth`, `act.failed`, `gen.auth`, ...), or null for a bare string. */
  readonly code: string | null;
  /** The Bridge's own words, made safe. */
  readonly message: string;
  readonly connId: string | null;
  readonly accountId: string | null;
}

export type ProblemKind =
  /** The Bridge rejected the access URL. */
  | "access"
  /** A bank connection needs the person's attention at the Bridge (sign in again). */
  | "connection"
  /** The Bridge could not read this account this time. Try again later. */
  | "account_failed"
  /** The list of transactions is incomplete. Try again later. */
  | "missing_data"
  /** The Bridge is warning that requests are too frequent. */
  | "rate_limit"
  /** Misuse of the API: a range that was capped, a bad parameter. */
  | "api"
  | "other";

/** How the Bridge words a warning about too many requests is not published (the developer guide says
 * only that "warning messages" will "appear in the `errors` array"), so it is matched loosely, and
 * never for a message about a date range: the Bridge's own range warning contains the word "limit". */
const RATE_WORDS =
  /too many requests|rate[- ]?limit|requests? (limit|quota)|\bquota\b|throttl|slow down|more requests than|(daily|hourly) limit|(exceed\w*|over|reached) (the |your |our )?(daily |request |rate )?(limit|quota)/i;
const RANGE_WORDS = /\b(date range|start-date|end-date|date window)\b/i;

export const looksLikeRateWarning = (message: string): boolean =>
  RATE_WORDS.test(message) && !RANGE_WORDS.test(message);

export function kindOf(problem: BridgeProblem): ProblemKind {
  const code = problem.code?.toLowerCase() ?? "";
  if (code === "gen.auth") return "access";
  if (looksLikeRateWarning(problem.message)) return "rate_limit";
  if (code === "gen.api") return "api";
  if (code === "act.missingdata") return "missing_data";
  if (code.startsWith("act.")) return "account_failed";
  if (code.startsWith("con.")) return "connection";
  if (
    code === "" &&
    /\b(sign in|log ?in|credentials|re-?authenticat|needs? attention|reconnect)\b/i.test(
      problem.message,
    )
  )
    return "connection";
  return "other";
}

/** Read the `errlist` and `errors` of an answer. Anything that is not text or an object is ignored;
 * nothing is trusted for length. */
export function readProblems(
  body: Record<string, unknown>,
  secrets: readonly string[] = [],
): BridgeProblem[] {
  const out: BridgeProblem[] = [];
  const text = (value: unknown, max = MAX_MESSAGE): string => safeText(value, { max, secrets });
  const idOf = (value: unknown): string | null => {
    const id = typeof value === "string" ? text(value, 128) : "";
    return id === "" ? null : id;
  };
  if (Array.isArray(body.errlist))
    for (const entry of body.errlist.slice(0, 50)) {
      if (entry === null || typeof entry !== "object" || Array.isArray(entry)) continue;
      const item = entry as Record<string, unknown>;
      const message = text(item.msg);
      const code = typeof item.code === "string" ? text(item.code, 40) : "";
      if (message === "" && code === "") continue;
      out.push({
        code: code === "" ? null : code,
        message,
        connId: idOf(item.conn_id),
        accountId: idOf(item.account_id),
      });
    }
  if (Array.isArray(body.errors))
    for (const entry of body.errors.slice(0, 50)) {
      const message = text(entry);
      if (message !== "") out.push({ code: null, message, connId: null, accountId: null });
    }
  return out;
}

/** The names of what a problem is about, for a sentence a person can act on. */
export interface Names {
  /** Bank (connection) names by `conn_id`. */
  readonly bank: (connId: string | null) => string | null;
  /** Account names by account id. */
  readonly account: (accountId: string | null) => string | null;
}

export interface ProblemView {
  readonly kind: ProblemKind;
  readonly code: string | null;
  /** The bank the problem is about, when it is known. */
  readonly bank: string | null;
  readonly account: string | null;
  /** What to do, in a sentence, including where. */
  readonly message: string;
  /** The Bridge's own text, quoted as data. */
  readonly said: string;
}

const where = `Sign in at ${BRIDGE_HOME}`;

/** A problem as a sentence that says which bank, what happened and where to go. The Bridge's own
 * text is kept apart in `said` and never becomes part of the instruction. */
export function describeProblem(problem: BridgeProblem, names: Names): ProblemView {
  const kind = kindOf(problem);
  const bank = names.bank(problem.connId);
  const account = names.account(problem.accountId);
  const subject =
    account && bank ? `${account} at ${bank}` : (account ?? bank ?? "A bank connection");
  const message = (() => {
    switch (kind) {
      case "connection":
        return `${bank ?? "A bank"} needs your attention at the SimpleFIN Bridge: the bank is asking for you to sign in again. ${where}, open that connection and reconnect it. Rastrata cannot do this for you and never sees your bank login. Until you do, the lines of its accounts are not updated.`;
      case "access":
        return `The SimpleFIN Bridge did not accept Rastrata's access. It may have been revoked or disabled (the Bridge disables access that makes more requests than allowed). ${where}, create a new setup token, and connect again here.`;
      case "account_failed":
        return `The Bridge could not read ${subject} this time. This usually clears by itself, and Rastrata tries again at the next sync. If it keeps happening, check that connection at the Bridge (${BRIDGE_HOME}).`;
      case "missing_data":
        return `The Bridge sent an incomplete list of transactions for ${subject}. Rastrata did not move forward from that point and reads the period again at the next sync, so nothing is skipped.`;
      case "rate_limit":
        return "The Bridge is warning that Rastrata is asking too often. Rastrata has stopped asking for 24 hours so the Bridge does not disable its access.";
      case "api":
        return "The Bridge reported a problem with how Rastrata asked. Rastrata did not move forward from that request, and will ask again at the next sync.";
      default:
        return `The Bridge reported a problem${bank ? ` with ${bank}` : ""}. Rastrata did not move forward from that request and will ask again at the next sync.`;
    }
  })();
  return { kind, code: problem.code, bank, account, message, said: problem.message };
}

/** Whether a problem means the transactions Rastrata received for an account may be incomplete, so
 * the cursor must not move past them. A problem about another account or another connection does
 * not; one about this account, this account's connection, or nothing in particular (and so
 * possibly everything) does. */
export function concerns(
  problem: BridgeProblem,
  account: { readonly id: string; readonly connId: string | null },
): boolean {
  if (problem.accountId !== null) return problem.accountId === account.id;
  if (problem.connId !== null) return account.connId === null || problem.connId === account.connId;
  return true;
}
