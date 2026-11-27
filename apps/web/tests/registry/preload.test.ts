import { expect, test } from "bun:test";
import type { AppRoute, NewDialog } from "../../src/routes/registry-types";

// The screens are files of their own (src/routes/screen.ts) and are fetched ahead of the click (src/preload.ts): these tests read the real registry, so that a route added with its
// component written into the page's first script, which would put it back in the budget of the critical script (tests/unit/compiler.test.ts), fails here with its name.
const registry = (await import(new URL("../../src/routes/all.ts", import.meta.url).pathname)) as {
  allRoutes: readonly AppRoute[];
  allDialogs: readonly NewDialog[];
};
const preloading = (await import(
  new URL("../../src/preload.ts", import.meta.url).pathname
)) as typeof import("../../src/preload");
const { allRoutes, allDialogs } = registry;

test("every screen but Home is fetched when it is first wanted, and so is every dialog", () => {
  const written = allRoutes
    .filter((route) => route.path !== "/" && typeof route.component.preload !== "function")
    .map((route) => route.path);
  expect(written, `routes whose component is in the first script: ${written.join(", ")}`).toEqual(
    [],
  );
  expect(allRoutes.find((route) => route.path === "/")?.component.preload).toBeUndefined();
  const dialogs = allDialogs
    .filter((dialog) => typeof dialog.component.preload !== "function")
    .map((dialog) => dialog.id);
  expect(dialogs).toEqual([]);
});

test("the places are asked for first, a screen that two routes share once, and the dialogs last", () => {
  const queue = preloading.queueOfScreens();
  const of = (path: string) =>
    allRoutes.find((route) => route.path === path)?.component.preload as () => Promise<void>;
  expect(queue.slice(0, 4)).toEqual([
    of("/inbox"),
    of("/journal"),
    of("/accounts"),
    of("/reports"),
  ]);
  expect(new Set(queue).size).toBe(queue.length);
  // Every screen there is, once: the routes' and the dialogs'.
  const wanted = new Set([
    ...allRoutes.flatMap((route) => (route.component.preload ? [route.component.preload] : [])),
    ...allDialogs.flatMap((dialog) => (dialog.component.preload ? [dialog.component.preload] : [])),
  ]);
  expect(queue).toHaveLength(wanted.size);
  const dialogStart = queue.indexOf(allDialogs[0]?.component.preload as () => Promise<void>);
  for (const dialog of allDialogs)
    expect(queue.indexOf(dialog.component.preload as () => Promise<void>)).toBeGreaterThanOrEqual(
      dialogStart,
    );
});

test("a link that is pointed at asks for the screen it opens and no other, whatever the registry lists first", () => {
  const asked: string[] = [];
  const kept = allRoutes.map((route) => route.component.preload);
  allRoutes.forEach((route) => {
    route.component.preload = async () => void asked.push(route.path);
  });
  try {
    preloading.preloadAddress("/journal/new");
    preloading.preloadAddress("/journal/ent_123");
    preloading.preloadAddress("/journal/ent_123/?tab=lines");
    preloading.preloadAddress("/accounts?new=1");
    preloading.preloadAddress(`${window.location.origin}/reports#top`);
    // Not a screen of this application: nothing is asked for.
    preloading.preloadAddress("/no/such/page");
    preloading.preloadAddress("https://elsewhere.example/accounts");
    preloading.preloadAddress("http://[");
  } finally {
    allRoutes.forEach((route, index) => {
      const original = kept[index];
      if (original === undefined) delete route.component.preload;
      else route.component.preload = original;
    });
  }
  expect(asked).toEqual([
    "/journal/new",
    "/journal/$entryId",
    "/journal/$entryId",
    "/accounts",
    "/reports",
  ]);
});

test("the screens are asked for one at a time when the browser is idle, the rest go on when one cannot be had, and a connection that saves data is left alone", async () => {
  const events: string[] = [];
  const queue = ["a", "b", "c"].map((name) => async () => {
    events.push(`start ${name}`);
    await new Promise((done) => setTimeout(done, 1));
    if (name === "b") throw new Error("offline");
    events.push(`end ${name}`);
  });
  await preloading.preloadScreensWhenIdle(queue, {
    idle: (work, within) => {
      events.push(`idle within ${within}`);
      queueMicrotask(work);
    },
    saving: () => false,
    // Nothing is fetched before the page's own load is over.
    loaded: async () => void events.push("loaded"),
  });
  expect(events).toEqual([
    "loaded",
    "idle within 3000",
    "start a",
    "end a",
    "idle within 3000",
    "start b",
    "idle within 3000",
    "start c",
    "end c",
  ]);
  const left: string[] = [];
  await preloading.preloadScreensWhenIdle([async () => void left.push("asked")], {
    idle: (work) => work(),
    saving: () => true,
    loaded: async () => {},
  });
  expect(left).toEqual([]);
});
