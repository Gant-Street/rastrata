/** What is known about the SimpleFIN Bridge and what this lane decided from it. Every number has a
 * source: the protocol page, the Bridge's developer guide, or a live request made with the Bridge's
 * public demo token on 2026-10-04. `docs/reference/program/bankfeed.md` ("The protocol as verified")
 * lists each one with where it was read. Portable: no filesystem, no clock. */

export const PROVIDER = "simplefin";

/** The prefix of every provider account key: `simplefin:<the Bridge's account id, percent-encoded>`. */
export const ACCOUNT_KEY_PREFIX = "simplefin:";

/** The Bridge's own words: "you are expected to make 24 requests or fewer per day. There is a little
 * leeway above this limit ... Quotas are replenished throughout the day." Going past the warning level
 * gets the access URL disabled, so the limit is treated as a promise. */
export const BRIDGE_REQUESTS_PER_DAY = 24;

/** Rastrata stops asking before the limit, so that a retry, a person pressing "Sync" twice or an
 * agent calling it in a loop can never reach the point where the Bridge disables the access URL. */
export const REQUEST_BUDGET_PER_DAY = 20;

/** The quota is "per day" but "replenished throughout the day", so requests are counted in a rolling
 * 24 hours, not a calendar day. */
export const QUOTA_WINDOW_MS = 24 * 60 * 60 * 1000;

/** "The date range of requests to /accounts ... is limited to 90 days at a time." Beyond it a request
 * is capped (answered with a `gen.api` error saying so), which would silently lose the rest. */
export const MAX_RANGE_DAYS = 90;

/** A range over 45 days draws a `gen.api` warning ("exceeds recommended range of 45 days. In the
 * future, this may be capped"), observed live. Windows are cut to the recommendation, so no request
 * ever warns, and a future cap changes nothing. */
export const WINDOW_DAYS = 45;

/** "Overlap the date window of transactions you fetch by about 5 days to make sure you don't miss
 * transactions": a transaction the bank posts late carries an earlier date. */
export const OVERLAP_DAYS = 5;

/** The largest answer read: a 45-day window of one account is far smaller. A hostile or broken server
 * cannot fill memory with it. */
export const MAX_RESPONSE_BYTES = 8 * 1024 * 1024;

/** Bounds on what one answer may hold, so a hostile one cannot make this code do unbounded work. */
export const MAX_ACCOUNTS = 500;
export const MAX_TRANSACTIONS_PER_ACCOUNT = 50_000;

/** Longest text kept from the Bridge for display (account and bank names, messages). The raw answer
 * is archived whole; this only bounds what is stored beside it and shown. */
export const MAX_NAME = 120;
export const MAX_MESSAGE = 300;

/** Where a person signs in to the Bridge and creates a setup token. Shown in messages and used for
 * nothing else: no request is ever made to it. */
export const BRIDGE_HOME = "https://beta-bridge.simplefin.org";
