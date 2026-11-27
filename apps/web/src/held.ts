/** What the page has read of the service, kept for the rest of its life, so that a screen the person has seen is drawn from it at once and corrected when the service has been asked again
 * (docs/reference/program/performance.md, "Under 100 ms": the page holds what it shows). It is held in memory; on a service with accounts it is also kept on the device, locked (below).
 *
 * An answer is kept as the text the service sent, so that every read gets an object of its own and one screen cannot change what the next will be shown. A read of a kind that is held
 * (`holds`) is answered from here when there is an answer:
 *  - one that is under two seconds old is as good as a read, and no request is made (a screen that has ten panels asks for `periods.list` ten times);
 *  - an older one is given at once all the same, and the service is asked again behind it; when the new answer is in, whatever showed the old one reads again from what came (loader.ts), and
 *    changes only what differs;
 *  - one that is over a week old, or none, is a read that waits for the service, as it always was.
 * On a service with accounts what is held is also kept on the device, locked, and read back the next time the page opens (copy.ts): the answers are loaded when the token comes with the key,
 * and the first reads wait for that, a moment at most.
 * Any change the page makes ends all of it (`clear`): what is read after a change asks the service, and an answer that was on its way when the change was made is not kept. What cannot be
 * confirmed (the asking again fails) is dropped and is not shown again. The answers are kept apart for each workspace and book. */
import { authorizationScope } from "./ambient.ts";
import { Copy } from "./copy.ts";

/** An answer this young is given without asking again. */
export const FRESH_MS = 2_000;
/** An answer older than this is not shown at all: a session does not last longer, and no answer is shown without the service being asked again behind it. */
export const MAX_AGE_MS = 7 * 24 * 60 * 60_000;
const MAX_ENTRIES = 400;
const MAX_BYTES = 24 * 1024 * 1024;

/** The reads that are held: what the places and their screens are drawn from. Not a calculation made to order (a preview, a report to download, a test of a rule), not the state of a job,
 * not what is asked again and again for the answer to change (nothing here polls: the jobs have their own way, application-client.ts), and not a draft that is opened to be edited: what is
 * changed and posted from the page must be what the service has now. */
const HELD = new Set<string>([
  "accounts.list",
  "bankfeed.status",
  "banks.status",
  "book.get",
  "cutover.checklist",
  "inbox.summary",
  "journal.get",
  "journal.list",
  "payees.totals",
  "periods.list",
  "reconcile.status",
  "reports.calendar",
  "reports.cashFlow",
  "reports.generalLedger",
  "reports.get",
  "rules.list",
  "stripe.status",
  "taxLines.list",
]);

interface Entry {
  readonly text: string;
  readonly at: number;
  /** The service said it in this page's life. What was read back from the device has not been confirmed yet, however recent it is. */
  readonly confirmed: boolean;
}

const entries = new Map<string, Entry>();
let bytes = 0;
let epoch = 0;
let hits = 0;
let fromDevice = 0;
let clock: () => number = Date.now;
const listeners = new Set<() => void>();
/** The answers being asked for, so that a second read of the same thing waits for the first and does not ask again. */
const flying = new Map<string, Promise<unknown>>();
/** The asking again that is behind an answer that was given at once. */
const checking = new Map<string, Promise<void>>();

/** Whether a read of this operation, asked this, is held. A search is not: what it finds is asked for with each letter typed. */
export function holds(operation: string, input?: unknown): boolean {
  if (!HELD.has(operation)) return false;
  if (operation === "journal.list" && input !== null && typeof input === "object") {
    const { text, search } = input as { text?: unknown; search?: unknown };
    if ((typeof text === "string" && text !== "") || (typeof search === "string" && search !== ""))
      return false;
  }
  return true;
}

/** The same text for the same value whatever order its fields were made in. */
function canonical(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value) ?? "null";
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  const record = value as Record<string, unknown>;
  return `{${Object.keys(record)
    .sort()
    .filter((name) => record[name] !== undefined)
    .map((name) => `${JSON.stringify(name)}:${canonical(record[name])}`)
    .join(",")}}`;
}

/** What a read is held under: the workspace, the book, the operation and what it was asked. */
export const keyOf = (bookId: string, operation: string, input: unknown): string =>
  `${authorizationScope()}\n${bookId}\n${operation}\n${canonical(input)}`;

/** The answer held for `key`, and whether it is young enough to be given without asking again; null when there is none, or it is too old to show. */
export function peek(key: string): { readonly text: string; readonly fresh: boolean } | null {
  const entry = entries.get(key);
  if (!entry) return null;
  const age = clock() - entry.at;
  if (age >= MAX_AGE_MS || age < 0) {
    drop(key);
    return null;
  }
  // The most recently used goes to the back of the line, so that what is let go of first is what was used longest ago.
  entries.delete(key);
  entries.set(key, entry);
  hits += 1;
  if (!entry.confirmed) fromDevice += 1;
  return { text: entry.text, fresh: entry.confirmed && age < FRESH_MS };
}

/** Keep an answer. `since` is the `epoch` the read began in: an answer to a read that began before a change is not kept. */
export function put(key: string, text: string, since: number): void {
  if (since !== epoch) return;
  drop(key);
  const at = clock();
  entries.set(key, { text, at, confirmed: true });
  bytes += text.length;
  while (entries.size > MAX_ENTRIES || bytes > MAX_BYTES) {
    const oldest = entries.keys().next();
    if (oldest.done) break;
    drop(oldest.value);
  }
  copy?.save({ key, text, at });
}

export function drop(key: string): void {
  const entry = entries.get(key);
  if (!entry) return;
  bytes -= entry.text.length;
  entries.delete(key);
}

/** The page has changed something: nothing held is true any more, nothing on its way is kept, and the next read of anything asks the service. */
export function clear(): void {
  epoch += 1;
  entries.clear();
  flying.clear();
  checking.clear();
  bytes = 0;
  // What was kept on the device is as stale as what was held.
  void copy?.erase();
}

/** The count of changes so far, which a read notes when it begins (`put`). */
export const currentEpoch = (): number => epoch;

/** Runs `ask` for `key` unless it is already being run, and gives its answer to everyone who asked meanwhile. */
export function once<T>(key: string, ask: () => Promise<T>): Promise<T> {
  const running = flying.get(key);
  if (running) return running as Promise<T>;
  const made = ask().finally(() => {
    if (flying.get(key) === made) flying.delete(key);
  });
  flying.set(key, made);
  return made;
}

/** An answer was given from here though it was not young: keep track of the asking again behind it. */
export function givenOld(key: string, again: () => Promise<void>): void {
  if (checking.has(key)) return;
  const check = again().finally(() => {
    if (checking.get(key) === check) checking.delete(key);
  });
  checking.set(key, check);
}

/** How many answers have been given from here so far: a screen that counts before and after its reads can tell whether it was shown something that was held (loader.ts). */
export const heldGiven = (): number => hits;

/** How many answers have been given that were read back from the device and not yet confirmed by the service (load-timing.ts says whether a page opened from the copy). */
export const deviceGiven = (): number => fromDevice;

/** `listener` is told each time the asking again behind an old answer finds that the service says something else, so that whatever showed the old one can read again. Returns how to stop. */
export function onChanged(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

/** How many times the page has been told that what it held was found to be different (`announceChanged`): a screen that began from an answer, and was made after one of them, was not there to hear it. */
let announced = 0;
export const announcements = (): number => announced;

/** What the page held has been found to be different from what the service says. */
export function announceChanged(): void {
  announced += 1;
  for (const listener of [...listeners])
    try {
      listener();
    } catch {
      // A listener that throws is not the answer's problem.
    }
}

/** When none of the askings again that are behind answers is still under way (the ones begun while waiting included). Never rejects. */
export async function settled(): Promise<void> {
  for (;;) {
    const running = [...checking.values()];
    if (running.length === 0) return;
    await Promise.allSettled(running);
  }
}

// ---- the copy on the device -----------------------------------------------------------------------------

/** The build of this page: the name of the script it was loaded from, which has the hash of what it holds in it (`/assets/index-357mzf7f.js`; the page's own source in development). What a copy
 * holds is read back only by the build that made it (copy.ts). */
export const BUILD = (() => {
  try {
    const script = document.querySelector('script[type="module"][src]')?.getAttribute("src");
    return script?.split("/").pop()?.split("?")[0] || "dev";
  } catch {
    return "dev";
  }
})();

/** How long the first reads wait for the copy to be unlocked, in milliseconds, before they go on without it. */
export const COPY_WAIT_MS = 2_000;
let copy: Copy | null = null;
let waiting: { readonly promise: Promise<void>; readonly done: () => void } | null = null;
let waitingTimer: ReturnType<typeof setTimeout> | undefined;
/** The key and workspace the copy was last unlocked with: every token brings the same key, and it is read back once. */
let unlockedWith = "";
const resolved = Promise.resolve();

/** The page is on a service with accounts: what it holds is kept on the device, locked, and what was kept before is read back when the token has come with the key (`unlockCopy`). The first reads
 * wait for that, for a moment at most (`COPY_WAIT_MS`), so that they find what was kept. */
export function expectCopy(use: Copy = new Copy(undefined, BUILD)): void {
  copy = use;
  let done: () => void = () => {};
  const promise = new Promise<void>((resolve) => {
    done = resolve;
  });
  waiting = { promise, done };
  waitingTimer = setTimeout(giveUpCopy, COPY_WAIT_MS);
}

/** What the reads wait for before they ask what is held: nothing, once the copy has been unlocked or given up on. */
export const ready = (): Promise<void> => waiting?.promise ?? resolved;

function settleWaiting(): void {
  if (waitingTimer !== undefined) clearTimeout(waitingTimer);
  waitingTimer = undefined;
  const current = waiting;
  waiting = null;
  current?.done();
}

/** The key has come with the token: read back what was kept of this workspace. What a read has asked for and kept in the meantime is not replaced. */
export async function unlockCopy(rawKey: string, scope: string): Promise<void> {
  const mine = copy;
  if (mine === null) return;
  if (unlockedWith === `${scope}\n${rawKey}`) {
    settleWaiting();
    return;
  }
  const since = epoch;
  try {
    const answers = await mine.unlock(rawKey, scope);
    if (since === epoch)
      for (const answer of answers)
        if (!entries.has(answer.key) && answer.at <= clock()) {
          entries.set(answer.key, { text: answer.text, at: answer.at, confirmed: false });
          bytes += answer.text.length;
        }
    while (entries.size > MAX_ENTRIES || bytes > MAX_BYTES) {
      const oldest = entries.keys().next();
      if (oldest.done) break;
      drop(oldest.value);
    }
    unlockedWith = `${scope}\n${rawKey}`;
  } finally {
    settleWaiting();
  }
}

/** The token will not come, or no copy is to be had: go on without it. */
export function giveUpCopy(): void {
  settleWaiting();
}

/** The person has signed out or left the workspace: nothing is kept on the device, and nothing is held. */
export async function forgetCopy(): Promise<void> {
  const mine = copy;
  unlockedWith = "";
  clear();
  settleWaiting();
  await mine?.forget();
}

// ---- what a screen has read ---------------------------------------------------------------------------

/** The keys read by each read of a screen that is under way, so that a screen asked to read again (`refresh`, loader.ts) can let go of what it was given and ask. A read is attributed to every one
 * that is under way when it is made, which is more than it was for and never less. */
const runs = new Set<Set<string>>();

/** A screen begins a read: the keys read until `end` are noted in `keys`. */
export function beginRun(): { readonly keys: Set<string>; readonly end: () => void } {
  const keys = new Set<string>();
  runs.add(keys);
  return { keys, end: () => void runs.delete(keys) };
}

/** A read of `key` was made. */
export function noteRead(key: string): void {
  for (const keys of runs) keys.add(key);
}

/** Let go of these answers, so that the next read of any of them asks the service. */
export function dropMany(keys: Iterable<string>): void {
  for (const key of keys) drop(key);
}

/** For tests: nothing held, no copy, the clock the real one. */
export function reset(now: () => number = Date.now): void {
  copy = null;
  unlockedWith = "";
  settleWaiting();
  clear();
  hits = 0;
  fromDevice = 0;
  announced = 0;
  listeners.clear();
  clock = now;
}

/** Whether two values read from the service say the same: plain data, compared by what is in it (a list is equal to a list of the same things in the same order). */
export function same(a: unknown, b: unknown): boolean {
  if (Object.is(a, b)) return true;
  if (typeof a !== "object" || typeof b !== "object" || a === null || b === null) return false;
  if (Array.isArray(a) || Array.isArray(b))
    return (
      Array.isArray(a) &&
      Array.isArray(b) &&
      a.length === b.length &&
      a.every((x, i) => same(x, b[i]))
    );
  if (a instanceof Date || b instanceof Date)
    return a instanceof Date && b instanceof Date && a.getTime() === b.getTime();
  if (a instanceof Map || b instanceof Map)
    return (
      a instanceof Map &&
      b instanceof Map &&
      a.size === b.size &&
      [...a].every(([name, value]) => b.has(name) && same(value, b.get(name)))
    );
  if (a instanceof Set || b instanceof Set)
    return (
      a instanceof Set && b instanceof Set && a.size === b.size && [...a].every((x) => b.has(x))
    );
  const left = a as Record<string, unknown>;
  const right = b as Record<string, unknown>;
  const names = Object.keys(left);
  return (
    names.length === Object.keys(right).length &&
    names.every((name) => name in right && same(left[name], right[name]))
  );
}
