import { type Accessor, batch, createComputed, createSignal, onCleanup, untrack } from "solid-js";
import { announcements, beginRun, dropMany, heldGiven, onChanged, same, settled } from "./held";

/** A read of the service held in plain signals. The screens use this instead of `createResource`
 * because a resource that is read while it loads suspends the router's boundary, which detaches the
 * page and drops focus: the control a person just used would lose it every time the data is read
 * again. Here a read never suspends. The last good value stays while the next is fetched, `loading`
 * says a fetch is under way, and `error` says the last one failed (and is cleared by the next). A
 * result that arrives after a newer read was asked for, or after the screen is gone, is ignored. */
export type Loader<T> = {
  /** The last value read, or undefined before the first one arrives. */
  readonly value: Accessor<T | undefined>;
  readonly loading: Accessor<boolean>;
  readonly error: Accessor<unknown>;
  /** Read again, with the same key for a keyed loader. What the page holds of the service (held.ts) is as good as a read when it is under two seconds old. */
  readonly reload: () => Promise<void>;
  /** Read again from the service: a person's own "read again", which must not be answered from what the page holds. */
  readonly refresh: () => Promise<void>;
  /** Replace the value with one already known, such as the reply to a write. */
  readonly set: (value: T) => void;
};

function createState<T>(loadingAtFirst: boolean, shownHeld = false) {
  const [value, setValue] = createSignal<T | undefined>(undefined);
  const [loading, setLoading] = createSignal(loadingAtFirst);
  const [error, setError] = createSignal<unknown>(undefined);
  let latest = 0;
  let gone = false;
  // Whether what is shown was given from what the page holds of the service (held.ts), and what to read again if that turns out to be different.
  let held = shownHeld;
  let reading: (() => Promise<T>) | null = null;
  /** What the last read of this loader (and whatever else was being read with it) read of what the page holds. */
  let lastKeys: ReadonlySet<string> = new Set();
  let confirming = false;
  let again = false;
  const stopListening = onChanged(() => {
    if (held && !gone) void confirm();
  });
  onCleanup(() => {
    gone = true;
    stopListening();
  });
  const wanted = (mine: number) => !gone && mine === latest;
  /** What the page held was found to differ from what the service says: read again, from what came, and change what is shown only if it is different. A change that is told of while this is
   * under way makes one more pass, so that what is shown is never older than the last thing told. */
  async function confirm(): Promise<void> {
    if (confirming) {
      again = true;
      return;
    }
    confirming = true;
    try {
      do {
        again = false;
        const mine = latest;
        // Every asking again that is under way is waited for, so that one read again has them all.
        await settled();
        const fetcher = reading;
        if (!wanted(mine) || fetcher === null) return;
        try {
          const next = await fetcher();
          if (wanted(mine) && !same(next, value()))
            batch(() => {
              setValue(() => next);
              setError(() => undefined);
            });
        } catch (cause) {
          if (wanted(mine)) setError(() => cause);
        }
      } while (again && !gone);
    } finally {
      confirming = false;
    }
  }
  return {
    value,
    loading,
    error,
    async run(fetcher: () => Promise<T>): Promise<void> {
      const mine = ++latest;
      reading = fetcher;
      setLoading(true);
      const before = heldGiven();
      const told = announcements();
      const run = beginRun();
      try {
        const next = await fetcher();
        if (wanted(mine)) {
          held = heldGiven() !== before || held;
          batch(() => {
            setValue(() => next);
            setError(() => undefined);
            setLoading(false);
          });
          // What was given was found to be different while this was under way, before this was known to have been given from what the page holds, and nobody was told: read again.
          if (held && announcements() !== told) void confirm();
        }
      } catch (cause) {
        if (wanted(mine))
          batch(() => {
            setError(() => cause);
            setLoading(false);
          });
      } finally {
        run.end();
        lastKeys = run.keys;
      }
    },
    /** What this loader read of what the page holds, to be let go of when it is asked to read again from the service. */
    forget(): void {
      dropMany(lastKeys);
    },
    /** What to read again, for a value that was given and not read here. */
    use(fetcher: () => Promise<T>): void {
      reading = fetcher;
    },
    /** A value that was given, and read before the page drew itself, may be one that the asking again behind it has since found to be different, before this screen existed to be told: if the page
     * has been told anything of the kind, read again from what it holds now (no request when that is young) and change what is shown only if it differs. */
    catchUp(): void {
      if (held && announcements() > 0) void confirm();
    },
    /** Stop waiting for whatever is under way; the value stays. */
    cancel(): void {
      latest += 1;
      setLoading(false);
    },
    set(next: T): void {
      latest += 1;
      batch(() => {
        setValue(() => next);
        setError(() => undefined);
        setLoading(false);
      });
    },
  };
}

/** Reads once when it is created, and again on `reload`. Given `initial` (a value already read, such as one the
 * page read before it drew itself: opening.ts), it starts with that value and reads only on `reload`. */
export function createLoader<T>(fetcher: () => Promise<T>, initial?: T): Loader<T> {
  // A value the page read before it drew itself (opening.ts) may have been given from what the page holds: it is read again if that is found to be different.
  const state = createState<T>(initial === undefined, initial !== undefined);
  const reload = () => state.run(fetcher);
  const refresh = () => {
    state.forget();
    return state.run(fetcher);
  };
  if (initial === undefined) void reload();
  else {
    state.use(fetcher);
    state.set(initial);
    state.catchUp();
  }
  return {
    value: state.value,
    loading: state.loading,
    error: state.error,
    reload,
    refresh,
    set: (next) => state.set(next),
  };
}

/** Reads whenever `key()` changes, and not at all while it is undefined (nothing can be asked yet).
 * A key that is a new object with the same content reads again, so make the key with a memo that says
 * when two keys are the same. `loading` turns on in the same update that changes the key, so there is
 * no moment when the old answer looks like the answer to the new question. */
export function createKeyedLoader<K, T>(
  key: Accessor<K | undefined>,
  fetcher: (key: K) => Promise<T>,
): Loader<T> {
  const state = createState<T>(false);
  let asked: K | undefined;
  createComputed(() => {
    const next = key();
    untrack(() => {
      asked = next;
      if (next === undefined) state.cancel();
      else void state.run(() => fetcher(next));
    });
  });
  return {
    value: state.value,
    loading: state.loading,
    error: state.error,
    reload: () => {
      const again = asked;
      return again === undefined ? Promise.resolve() : state.run(() => fetcher(again));
    },
    refresh: () => {
      const again = asked;
      if (again === undefined) return Promise.resolve();
      state.forget();
      return state.run(() => fetcher(again));
    },
    set: (next) => state.set(next),
  };
}
