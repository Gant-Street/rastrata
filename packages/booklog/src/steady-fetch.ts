/** How a pod calls its two stores over HTTP (the tail and the bucket's gateway), so that a connection that has gone
 * dead while nothing was asked of it does not cost a person their page.
 *
 * What happened (2026-11-22, the founder's first visit of the day): the pods had asked their stores for nothing in
 * eight hours. The first call of the open that the visit began did not answer and was given up on after the three
 * seconds a call to the tail is allowed, and so was the first call of the check made behind the book's first answer:
 * each of the two took almost exactly 3,000 ms longer than it does (3.4 s for an open of 22 entries, 3,583 ms for a
 * check that took 603 ms on the other pod ten minutes later), the page took about ten seconds, and one of its reads
 * failed. The log of the pods said nothing of it, because nothing was written down about a call that was slow, so
 * which call it was is an inference from those two figures and not a record.
 *
 * So, here:
 *
 * - A call that can be made twice without harm (a read, a lease asked for or renewed: the tail gives the same holder
 *   the same lease) is given a short time for its answer to begin, and is then sent again at once on a connection of
 *   its own. A dead connection costs that short time, once, and not the whole time of a call and a failure.
 * - A call made after the stores were asked for nothing for a while goes on a connection of its own from the start:
 *   whatever is kept from before is not trusted with it.
 * - The stores are asked a question that costs nothing (`warm`) a few times a minute, so that the name, the route
 *   and a connection are in use when a person comes, and a connection that has died is found by a question nobody
 *   waits for.
 * - A call that was slow, was sent again or failed is written down in one line: what it was, and how long it took.
 *
 * A write to the log is never sent twice from here: what became of one that did not answer is found by the
 * protocol that owns it (runtime.ts). */

export interface SteadyCall {
  /** What is asked, for the log: "tail acquire", "bucket get". Never a key, a token or a book's content. */
  readonly what: string;
  /** Whether sending it a second time is the same as sending it once. */
  readonly repeatable: boolean;
  /** The whole time the call may take, its answer's body included, in milliseconds. */
  readonly timeoutMs: number;
}

export interface SteadyFetchOptions {
  readonly fetch?: (url: string, init: RequestInit) => Promise<Response>;
  /** How long a call that can be repeated waits for its answer to begin before it is sent again (default 1,000 ms;
   * a call to either store answers in 30 to 120 ms). */
  readonly firstTryMs?: number;
  /** After this long with no answer from the stores, a call goes on a connection of its own (default 30,000 ms). */
  readonly quietMs?: number;
  /** A call that took this long is written down (default 750 ms). */
  readonly slowMs?: number;
  readonly now?: () => number;
  readonly log?: (line: string) => void;
}

export interface SteadyStats {
  /** Calls made, calls that were sent a second time, and calls that failed altogether. */
  readonly calls: number;
  readonly repeated: number;
  readonly failed: number;
  /** Calls that went on a connection of their own because the stores had been quiet. */
  readonly afterQuiet: number;
  /** The slowest call since the process began, in milliseconds, and what it was. */
  readonly slowestMs: number;
  readonly slowest: string | null;
}

export interface SteadyFetch {
  (url: string, init: RequestInit, call: SteadyCall): Promise<Response>;
  stats(): SteadyStats;
}

/** The most lines a minute this writes: a store that is down is said, and not said three hundred times. */
const LINES_A_MINUTE = 20;

const timedOut = (): DOMException => new DOMException("The operation timed out.", "TimeoutError");

export function steadyFetch(options: SteadyFetchOptions = {}): SteadyFetch {
  const send = options.fetch ?? ((url: string, init: RequestInit) => fetch(url, init));
  const firstTryMs = options.firstTryMs ?? 1000;
  const quietMs = options.quietMs ?? 30_000;
  const slowMs = options.slowMs ?? 750;
  const now = options.now ?? (() => performance.now());
  const log = options.log ?? (() => {});
  const stats = {
    calls: 0,
    repeated: 0,
    failed: 0,
    afterQuiet: 0,
    slowestMs: 0,
    slowest: null as string | null,
  };
  let lastAnswer: number | null = null;
  let minute = 0;
  let lines = 0;
  let unsaid = 0;
  const say = (line: string): void => {
    const at = Math.floor(now() / 60_000);
    if (at !== minute) {
      if (unsaid > 0) log(`store: ${unsaid} more slow or failed calls in that minute`);
      minute = at;
      lines = 0;
      unsaid = 0;
    }
    if (lines >= LINES_A_MINUTE) {
      unsaid += 1;
      return;
    }
    lines += 1;
    log(line);
  };

  /** One try. The answer must begin within `beginWithin`; the whole call, body included, within `whole`. */
  const attempt = async (
    url: string,
    init: RequestInit,
    beginWithin: number,
    whole: number,
    own: boolean,
  ): Promise<Response> => {
    const begin = new AbortController();
    const timer = setTimeout(() => begin.abort(timedOut()), beginWithin);
    try {
      return await send(url, {
        ...init,
        signal: AbortSignal.any([begin.signal, AbortSignal.timeout(whole)]),
        // A connection of its own: not one that was kept from an earlier call, and not kept for a later one.
        ...(own ? { keepalive: false } : {}),
      });
    } finally {
      clearTimeout(timer);
    }
  };

  const call = async (url: string, init: RequestInit, asked: SteadyCall): Promise<Response> => {
    stats.calls += 1;
    const began = now();
    const quiet = lastAnswer === null ? false : began - lastAnswer > quietMs;
    if (quiet) stats.afterQuiet += 1;
    const done = (response: Response, again: boolean): Response => {
      const took = now() - began;
      lastAnswer = now();
      if (took > stats.slowestMs) {
        stats.slowestMs = Math.round(took);
        stats.slowest = asked.what;
      }
      if (again)
        say(
          `store: ${asked.what} did not answer in ${Math.round(Math.min(firstTryMs, asked.timeoutMs))} ms and was sent again on a new connection, answered in ${Math.round(took)} ms in all`,
        );
      else if (took >= slowMs) say(`store: ${asked.what} answered in ${Math.round(took)} ms`);
      return response;
    };
    const first = asked.repeatable ? Math.min(firstTryMs, asked.timeoutMs) : asked.timeoutMs;
    try {
      return done(await attempt(url, init, first, asked.timeoutMs, quiet), false);
    } catch (error) {
      if (!asked.repeatable) {
        stats.failed += 1;
        say(`store: ${asked.what} failed after ${Math.round(now() - began)} ms (${kindOf(error)})`);
        throw error;
      }
    }
    stats.repeated += 1;
    const left = Math.max(1, asked.timeoutMs - (now() - began));
    try {
      return done(await attempt(url, init, left, left, true), true);
    } catch (error) {
      stats.failed += 1;
      say(
        `store: ${asked.what} failed twice, after ${Math.round(now() - began)} ms (${kindOf(error)})`,
      );
      throw error;
    }
  };
  return Object.assign(call, { stats: (): SteadyStats => ({ ...stats }) });
}

/** What kind of failure it was, in a word: never the message, which can name an address. */
function kindOf(error: unknown): string {
  const named = error as { name?: unknown; code?: unknown } | null;
  if (named?.name === "TimeoutError" || named?.name === "AbortError") return "no answer in time";
  return String(named?.code ?? named?.name ?? "error").slice(0, 40);
}

export interface WarmerOptions {
  readonly steady: SteadyFetch;
  /** The addresses to ask: the `/health` of each store's service, which costs it nothing and is answered to anyone. */
  readonly urls: readonly string[];
  /** How often, in milliseconds (default 20,000). */
  readonly everyMs?: number;
}

/** Ask the stores a question that costs nothing, now and every few seconds until stopped. Never throws, and does
 * not keep the process alive. Returns the way to stop it. */
export function keepWarm(options: WarmerOptions): () => void {
  const urls = [...new Set(options.urls)];
  if (urls.length === 0) return () => {};
  const ask = (): void => {
    for (const url of urls)
      void options
        .steady(
          url,
          { method: "GET", redirect: "error" },
          { what: "warm", repeatable: true, timeoutMs: 5000 },
        )
        .then((response) => response.body?.cancel())
        .catch(() => {});
  };
  const timer = setInterval(ask, Math.max(1000, options.everyMs ?? 20_000));
  (timer as { unref?: () => void }).unref?.();
  return () => clearInterval(timer);
}
