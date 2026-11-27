// The whole application on the test's page, as main.tsx mounts it: the providers and the router, at `path`. Each call
// is a page load from nothing: a new generation of the application's code (support/dom-generations.ts), so nothing a
// module held is carried over, as a browser carries nothing over a load.
import { resolve } from "node:path";
import { render } from "@solidjs/testing-library";
import { RouterProvider } from "@tanstack/solid-router";
import { nextGeneration, versioned } from "../../support/dom-generations";

const SOURCE = resolve(import.meta.dir, "../../../src");
const ROUTER = resolve(SOURCE, "router.tsx");
const BOOT = resolve(SOURCE, "boot.ts");
const SETTINGS = resolve(SOURCE, "book-settings.ts");
const UI = Bun.resolveSync("@rastrata/ui", import.meta.dir);

export async function openApp(path = "/") {
  window.history.replaceState(null, "", path);
  const at = nextGeneration();
  const [{ router }, ui, boot, settings] = await Promise.all([
    import(versioned(ROUTER, at)) as Promise<typeof import("../../../src/router")>,
    import(versioned(UI, at)) as Promise<typeof import("@rastrata/ui")>,
    import(versioned(BOOT, at)) as Promise<typeof import("../../../src/boot")>,
    import(versioned(SETTINGS, at)) as Promise<typeof import("../../../src/book-settings")>,
  ]);
  // As main.tsx starts the page: whose workspace is open first, then the book's own settings, then the screens.
  const started = await boot.bootAccounts();
  if (started.redirecting) throw new Error(`the page is on its way elsewhere from ${path}`);
  void settings.readBookSettings();
  // The router of a new generation reads the address it starts on, query and all, as a page load's does.
  await router.load();
  const view = render(() => (
    <ui.UiProvider locale="en-US">
      <ui.ToastProvider>
        <RouterProvider router={router} />
      </ui.ToastProvider>
    </ui.UiProvider>
  ));
  return { router, ...view };
}

/** Wait `ms` milliseconds of the page's own time. */
export const pause = (ms: number) => new Promise((done) => setTimeout(done, ms));
