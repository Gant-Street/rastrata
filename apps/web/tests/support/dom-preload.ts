// The screens' tests (tests/dom): a page of happy-dom for every file, with the application's own style sheet, the
// Solid compiler the application is built with, and the page emptied after each test. Run with the browser build of
// Solid: `bun test --conditions browser --preload ./tests/support/dom-preload.ts tests/dom`.
import { readFileSync } from "node:fs";
import { GlobalRegistrator } from "@happy-dom/global-registrator";

// A viewer's clock and language, fixed, as the Playwright configs fix them (support/shown.ts says why).
process.env.TZ = "UTC";

GlobalRegistrator.register({ url: "http://127.0.0.1:4000/", width: 1280, height: 800 });

// The style sheet, so that what CSS hides is hidden and text reads as it is laid out (tooling/dom-css.ts). The
// browser's own rule for `hidden` comes first, and nothing animates: happy-dom runs no animation, and a dialog that
// waited for its closing animation would never close.
const { DOM_CSS, buildDomCss, domCssIsCurrent } = await import("../../tooling/dom-css");
if (!domCssIsCurrent()) await buildDomCss();
const sheet = document.createElement("style");
sheet.id = "rt-dom-css";
sheet.textContent = [
  "[hidden]:not([hidden=until-found]){display:none}",
  process.env.DOM_NO_CSS ? "" : readFileSync(DOM_CSS, "utf8"),
  "*,*::before,*::after{animation:none!important;animation-name:none!important;transition:none!important}",
].join("\n");
document.head.append(sheet);

// Nothing has a size or a place here, so everything is on the screen: an element watched for being in view is in
// view from the moment it is watched (a list that hangs from a box shows while the box is on the screen).
class InView {
  constructor(private readonly callback: IntersectionObserverCallback) {}
  readonly root = null;
  readonly rootMargin = "0px";
  readonly thresholds = [0];
  observe(target: Element) {
    const box = {
      x: 0,
      y: 0,
      width: 0,
      height: 0,
      top: 0,
      left: 0,
      right: 0,
      bottom: 0,
      toJSON() {},
    } as DOMRectReadOnly;
    queueMicrotask(() =>
      this.callback(
        [
          {
            target,
            isIntersecting: true,
            intersectionRatio: 1,
            boundingClientRect: box,
            intersectionRect: box,
            rootBounds: null,
            time: performance.now(),
          },
        ],
        this as unknown as IntersectionObserver,
      ),
    );
  }
  unobserve() {}
  disconnect() {}
  takeRecords() {
    return [];
  }
}
Object.defineProperty(window, "IntersectionObserver", {
  configurable: true,
  writable: true,
  value: InView,
});
Object.defineProperty(globalThis, "IntersectionObserver", {
  configurable: true,
  writable: true,
  value: InView,
});
// And a box an element hangs a list from has a size inside the window, so the popover positioning (floating-ui, under
// Ark) does not take it for scrolled away and hide what hangs from it. Sizes are never measured by these tests.
const SOME_BOX = { x: 8, y: 8, width: 200, height: 32, top: 8, left: 8, right: 208, bottom: 40 };
// The page's root measures the window, as a browser's does: the positioning reads the space it may use from it.
for (const [key, size] of [
  ["clientWidth", () => window.innerWidth],
  ["clientHeight", () => window.innerHeight],
] as const) {
  const own =
    Object.getOwnPropertyDescriptor(Element.prototype, key) ??
    Object.getOwnPropertyDescriptor(HTMLElement.prototype, key);
  Object.defineProperty(HTMLElement.prototype, key, {
    configurable: true,
    get(this: HTMLElement) {
      return this === this.ownerDocument?.documentElement ? size() : (own?.get?.call(this) ?? 0);
    },
  });
}
Element.prototype.getClientRects = function (this: Element) {
  const rects = this.isConnected ? [this.getBoundingClientRect()] : [];
  return Object.assign(rects, {
    item: (index: number) => rects[index] ?? null,
  }) as unknown as DOMRectList;
};
Element.prototype.getBoundingClientRect = function (this: Element) {
  return this.isConnected
    ? ({ ...SOME_BOX, toJSON: () => SOME_BOX } as DOMRect)
    : ({
        x: 0,
        y: 0,
        width: 0,
        height: 0,
        top: 0,
        left: 0,
        right: 0,
        bottom: 0,
        toJSON: () => ({}),
      } as DOMRect);
};

// Web Locks, which the application uses so that two tabs never send the same write twice: one process, one queue per
// name, as a browser keeps them.
// happy-dom has the property and no lock manager behind it (it is null).
if (!navigator.locks) {
  const held = new Map<string, Promise<unknown>>();
  const locks = {
    async request(name: string, second: unknown, third?: unknown) {
      const callback = (typeof second === "function" ? second : third) as (
        lock: unknown,
      ) => unknown;
      const options = (typeof second === "function" ? {} : second) as { ifAvailable?: boolean };
      const before = held.get(name);
      if (before && options.ifAvailable) return callback(null);
      let release: () => void = () => {};
      const mine = new Promise<void>((done) => {
        release = done;
      });
      const chained = (before ?? Promise.resolve()).then(() => mine);
      held.set(name, chained);
      await before;
      try {
        return await callback({ name, mode: "exclusive" });
      } finally {
        release();
        if (held.get(name) === chained) held.delete(name);
      }
    },
    async query() {
      return { held: [...held.keys()].map((name) => ({ name, mode: "exclusive" })), pending: [] };
    },
  };
  Object.defineProperty(navigator, "locks", { value: locks, configurable: true });
}

// The application's own code in generations, one for each page load (dom-generations.ts), then the Solid compiler
// for the tests' own files.
const { plugin } = await import("bun");
const { generations } = await import("./dom-generations");
plugin(generations);
const { solidPlugin } = await import("../../tooling/solid-plugin");
plugin(solidPlugin(false));

const { afterEach } = await import("bun:test");
const { cleanup } = await import("@solidjs/testing-library");
afterEach(() => {
  cleanup();
  window.localStorage.clear();
  window.sessionStorage.clear();
});
