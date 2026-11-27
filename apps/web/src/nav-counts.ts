import { type Accessor, createEffect, createSignal, on, onCleanup, onMount } from "solid-js";
import { type BrowserApplicationClient, WRITE_EVENT } from "./application-client";
import type { NavRoute } from "./nav";

/** The live numbers beside tabs (what is waiting for review), by the path of the tab. A route offers one
 * with `nav.count`. They are read when the book is known to exist, again a moment after each page opens,
 * after each write, and when the window is used again, so the figure is a little behind at worst and
 * never wrong for long. A read that fails leaves the last number; there is no number before the first.
 * Nothing is read while there is no book, so a service without one sees no request it has to refuse. */
export function createNavCounts(options: {
  client: BrowserApplicationClient;
  routes: readonly NavRoute[];
  /** True once there is a book to ask. */
  ready: Accessor<boolean>;
  /** Changes when the page does. */
  page: Accessor<string>;
}): Accessor<Readonly<Record<string, number | undefined>>> {
  const [counts, setCounts] = createSignal<Readonly<Record<string, number | undefined>>>({});
  const counted = options.routes.filter((route) => route.nav.count !== undefined);
  let controller: AbortController | null = null;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let asked = false;

  const read = () => {
    if (counted.length === 0) return;
    asked = true;
    controller?.abort();
    const mine = new AbortController();
    controller = mine;
    for (const route of counted) {
      void route.nav.count?.(options.client, mine.signal).then(
        (number) => {
          if (!mine.signal.aborted) setCounts((known) => ({ ...known, [route.path]: number }));
        },
        () => {
          // Keep the last number: a figure that could not be read is not zero.
        },
      );
    }
  };
  const soon = () => {
    clearTimeout(timer);
    timer = setTimeout(read, 300);
  };

  createEffect(
    on([options.ready, options.page], ([ready]) => {
      if (!ready) return;
      if (asked) soon();
      else read();
    }),
  );
  onMount(() => {
    const again = () => {
      if (options.ready()) soon();
    };
    window.addEventListener(WRITE_EVENT, again);
    window.addEventListener("focus", again);
    onCleanup(() => {
      window.removeEventListener(WRITE_EVENT, again);
      window.removeEventListener("focus", again);
    });
  });
  onCleanup(() => {
    clearTimeout(timer);
    controller?.abort();
  });
  return counts;
}
