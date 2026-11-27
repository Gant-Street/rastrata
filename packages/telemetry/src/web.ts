/** The beacon: the one small message a browser may send about how a page felt, and the rules that
 * make it safe to accept from a browser. This file is shared by the web app (which builds the message)
 * and the API (which checks it), and imports nothing, so it adds a few hundred bytes to a page.
 *
 * Why a beacon to the API and not OTLP from the browser to the collector, or Faro: a browser is not
 * trusted. An OTLP endpoint a browser can reach lets any visitor mint metric series without limit
 * against a plan that allows 10,000, and a third-party agent would put page addresses, user agents
 * and network addresses into somebody else's log store. This message has a fixed shape, closed sets
 * and numbers in a fixed range; the API drops anything else, records only the catalog's metrics with
 * the book's size bucket (which it knows, the browser does not), and keeps no address, no page, no
 * identifier. See docs/reference/telemetry.md, "Real users".
 *
 *   {"v":1,
 *    "vitals":{"lcp":1830,"inp":96,"ttfb":120,"cls":0.03},     // milliseconds, cls a score
 *    "actions":[{"a":"accept","ms":180,"o":"ok"}]}              // a click to its confirmation
 */

export const BEACON_PATH = "/telemetry/web";
/** The most a beacon may weigh, in bytes. The API refuses a larger one without reading it. */
export const BEACON_MAX_BYTES = 2048;
export const BEACON_MAX_ACTIONS = 8;
/** Longer than this is not a measurement of a page, it is a tab left open overnight. */
export const BEACON_MAX_MS = 120_000;
export const BEACON_MAX_CLS = 100;

export const BEACON_ACTIONS = ["accept", "post", "save", "other"] as const;
export const BEACON_OUTCOMES = ["ok", "client_error", "server_error", "other"] as const;
export const BEACON_VITALS = ["lcp", "inp", "ttfb", "cls"] as const;

export type BeaconAction = (typeof BEACON_ACTIONS)[number];
export type BeaconOutcome = (typeof BEACON_OUTCOMES)[number];
export type BeaconVital = (typeof BEACON_VITALS)[number];

export interface BeaconActionTiming {
  readonly a: BeaconAction;
  /** From the click to the screen showing the result, in milliseconds. */
  readonly ms: number;
  readonly o: BeaconOutcome;
}

export interface Beacon {
  readonly v: 1;
  readonly vitals?: { readonly [K in BeaconVital]?: number };
  readonly actions?: readonly BeaconActionTiming[];
}

export type ParsedBeacon =
  | { readonly ok: true; readonly beacon: Beacon }
  | { readonly ok: false; readonly reason: string };

const refuse = (reason: string): ParsedBeacon => ({ ok: false, reason });
const isNumber = (value: unknown, high: number): value is number =>
  typeof value === "number" && Number.isFinite(value) && value >= 0 && value <= high;
const onlyKeys = (value: object, allowed: readonly string[]) =>
  Object.keys(value).every((key) => allowed.includes(key));
const plain = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

/** Check a beacon's text. Strict: a key that is not listed, a value outside its set or its range, a
 * message with nothing in it, or one that is too big, is refused whole, and the reason is a fixed
 * phrase that does not repeat what was sent. */
export function parseBeacon(text: string): ParsedBeacon {
  if (text.length > BEACON_MAX_BYTES) return refuse("too large");
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch {
    return refuse("not JSON");
  }
  if (!plain(value) || !onlyKeys(value, ["v", "vitals", "actions"])) return refuse("unknown field");
  if (value.v !== 1) return refuse("unsupported version");
  const vitals: { -readonly [K in BeaconVital]?: number } = {};
  if (value.vitals !== undefined) {
    if (!plain(value.vitals) || !onlyKeys(value.vitals, BEACON_VITALS))
      return refuse("unknown vital");
    for (const name of BEACON_VITALS) {
      const measured = value.vitals[name];
      if (measured === undefined) continue;
      if (!isNumber(measured, name === "cls" ? BEACON_MAX_CLS : BEACON_MAX_MS))
        return refuse("vital out of range");
      vitals[name] = measured;
    }
  }
  const actions: BeaconActionTiming[] = [];
  if (value.actions !== undefined) {
    if (!Array.isArray(value.actions) || value.actions.length > BEACON_MAX_ACTIONS)
      return refuse("too many actions");
    for (const item of value.actions) {
      if (!plain(item) || !onlyKeys(item, ["a", "ms", "o"])) return refuse("unknown action field");
      if (!BEACON_ACTIONS.includes(item.a as BeaconAction)) return refuse("unknown action");
      if (!BEACON_OUTCOMES.includes(item.o as BeaconOutcome)) return refuse("unknown outcome");
      if (!isNumber(item.ms, BEACON_MAX_MS)) return refuse("action time out of range");
      actions.push({ a: item.a as BeaconAction, ms: item.ms, o: item.o as BeaconOutcome });
    }
  }
  if (Object.keys(vitals).length === 0 && actions.length === 0) return refuse("empty");
  return {
    ok: true,
    beacon: {
      v: 1,
      ...(Object.keys(vitals).length ? { vitals } : {}),
      ...(actions.length ? { actions } : {}),
    },
  };
}
