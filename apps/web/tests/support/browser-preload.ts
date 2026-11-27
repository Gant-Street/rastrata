// Lets a unit test load the application's real route registry, which imports every screen. The screens are
// Solid components, so they need the same compiler the application is built with, the browser build of
// Solid, and a window that has just enough in it for modules to load (nothing here renders a screen).
// Used only by the registry tests: `bun test --conditions browser --preload ./tests/support/browser-preload.ts`.
import { plugin } from "bun";
import solid from "../../tooling/solid-plugin";

plugin(solid);

const loose = globalThis as unknown as Record<string, unknown>;
loose.document = {
  addEventListener() {},
  removeEventListener() {},
  createElement() {
    return {};
  },
};
loose.window = globalThis;
