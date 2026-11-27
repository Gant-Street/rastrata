/** What the page reads before it draws itself, so that it is drawn once and whole: the book (its name is in the
 * header, and whether it is set up decides which page Home is), who is signed in and their place in the workspace
 * (the footer), what the service says of itself, and where the workspace stands with its subscription (the banner
 * under the header). Without it the header was drawn first and each of these arrived in its own time: the name of
 * the business came half a second late and pushed the navigation sideways, the footer wrote itself in two steps,
 * and Home showed a placeholder, then its title, then another placeholder (the founder, 2026-11-19: "I notice that
 * my business name pops in on load. I don't want any pop in in the app. It's not professional.").
 *
 * The reads are started as early as they can be asked (boot.ts) and main.tsx waits for them before the first
 * draw, but not for long: a service that is slow to answer gets the page drawn without them, and each then
 * arrives as it used to. Each read is used once, by the first loader that asks for it, in place of that loader's
 * own first request, so nothing is asked twice. It is the page's opening and not a cache: after the first change
 * of page, or the first write, a loader that is made asks the service itself. */

/** How long the first draw waits for the opening reads, in milliseconds. */
export const OPENING_WAIT_MS = 2_500;

interface Read<T> {
  readonly promise: Promise<T>;
  /** The answer, once it has come. */
  settled?: { readonly value: T };
}

const reads = new Map<string, Read<unknown>>();
let over = false;

/** Begin a read of the opening. Called once for each name, before the page is drawn. */
export function beginOpening<T>(name: string, fetcher: () => Promise<T>): void {
  if (over || reads.has(name)) return;
  const read: Read<T> = { promise: fetcher() };
  read.promise.then(
    (value) => {
      read.settled = { value };
    },
    () => {
      // The loader that takes the read is told of the failure, as it would be of its own.
    },
  );
  reads.set(name, read as Read<unknown>);
}

/** The opening reads have all answered (or failed), or the wait is over. Never rejects. The reads named in `without`
 * are not waited for: a page that already knows what it will draw without one (a workspace whose books are still to
 * be set up draws the setup, whatever the book says of its name) is not held back by it. */
export async function openingRead(
  waitMs: number = OPENING_WAIT_MS,
  without: readonly string[] = [],
): Promise<void> {
  const all = Promise.allSettled(
    [...reads].filter(([name]) => !without.includes(name)).map(([, read]) => read.promise),
  );
  let timer: ReturnType<typeof setTimeout> | undefined;
  const wait = new Promise<void>((done) => {
    timer = setTimeout(done, waitMs);
  });
  await Promise.race([all, wait]);
  clearTimeout(timer);
}

/** What a loader starts from: the value the opening read brought (`initial`, when it has answered), and the fetcher
 * to use, which gives the opening's read the first time it is called and the loader's own after that. A read is
 * given to one loader of each `use`. */
export function fromOpening<T>(
  name: string,
  fetcher: () => Promise<T>,
  use = "shell",
): { readonly initial: T | undefined; readonly fetcher: () => Promise<T> } {
  const key = `${name}\n${use}`;
  const read = over || taken.has(key) ? undefined : (reads.get(name) as Read<T> | undefined);
  if (!read) return { initial: undefined, fetcher };
  taken.add(key);
  if (read.settled) return { initial: read.settled.value, fetcher };
  let first = true;
  return {
    initial: undefined,
    fetcher: () => {
      if (!first) return fetcher();
      first = false;
      return read.promise;
    },
  };
}
const taken = new Set<string>();

/** The text of what the opening reads brought, for finding the typefaces it needs before it is drawn (packages/ui/src/fonts-ready.ts). */
export function openedText(): string {
  return [...reads.values()]
    .map((read) => (read.settled ? JSON.stringify(read.settled.value) : ""))
    .join("\n");
}

/** The opening is over: the page has changed, or something was written, and what was read before the first draw
 * may no longer be so. */
export function endOpening(): void {
  over = true;
  reads.clear();
}

/** For tests: as a page that has read nothing. */
export function resetOpening(): void {
  over = false;
  reads.clear();
  taken.clear();
}
