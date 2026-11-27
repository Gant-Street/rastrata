import { expect, test } from "bun:test";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

// The installed spec (tests/browser/installed.spec.ts) opens every route of the application on the
// real compiled service, before and after a book exists, and fails on a console error, a content
// policy violation or an error page. It can only do that for the routes it lists. This test fails when
// the application has a route the spec does not open, so a screen a lane adds is never the one nobody
// tried on the installed service. A route with an id in its address ("/reconcile/$id") is covered by
// opening it with an id nobody has: what a stale bookmark is.
const source = join(import.meta.dir, "..", "..", "src");

/** The paths a source file registers: `path: "/inbox"`. */
const pathsIn = (text: string): string[] =>
  [...text.matchAll(/\bpath:\s*"(\/[^"]*)"/g)].map((match) => match[1] as string);

function applicationRoutes(): string[] {
  const files = [
    // The application's own screens (Home, Transactions, the Chart of accounts, Close the books, Reports)
    // are registered in routes/core.ts with every lane's routes; the router builds from them.
    join(source, "routes", "core.ts"),
    ...readdirSync(join(source, "routes"), { withFileTypes: true })
      .filter((entry) => entry.isDirectory())
      .map((entry) => join(source, "routes", entry.name, "index.ts"))
      .filter((file) => {
        try {
          readFileSync(file);
          return true;
        } catch {
          return false;
        }
      }),
  ];
  return [...new Set(files.flatMap((file) => pathsIn(readFileSync(file, "utf8"))))].sort();
}

/** The routes the installed spec opens. */
function openedBySpec(): string[] {
  const spec = readFileSync(join(import.meta.dir, "..", "browser", "installed.spec.ts"), "utf8");
  const block = /const ROUTES = \[([^\]]*)\]/.exec(spec)?.[1] ?? "";
  return [...block.matchAll(/"(\/[^"]*)"/g)].map((match) => match[1] as string);
}

/** Whether `opened` is how the spec opens `route`: itself, or for a route with an id an address that
 * fits it and is not another route of the application. */
function covers(route: string, opened: string, all: readonly string[]): boolean {
  if (!route.includes("$")) return opened === route;
  const pattern = new RegExp(`^${route.replace(/\$[A-Za-z]+/g, "[^/]+")}$`);
  return pattern.test(opened) && !all.includes(opened);
}

test("the application's routes are found, so this test cannot pass by finding nothing", () => {
  const routes = applicationRoutes();
  expect(routes).toContain("/");
  expect(routes).toContain("/journal/new");
  expect(routes).toContain("/reconcile/$id");
  expect(routes.length).toBeGreaterThan(15);
  expect(openedBySpec().length).toBeGreaterThan(15);
});

test("every route of the application is opened by the installed spec", () => {
  const routes = applicationRoutes();
  const opened = openedBySpec();
  const missing = routes.filter((route) => !opened.some((path) => covers(route, path, routes)));
  expect(
    missing,
    `\nAdd these routes to ROUTES in tests/browser/installed.spec.ts (a route with an id, with an id nobody has):\n${missing.join("\n")}\n`,
  ).toEqual([]);
});

test("the guard can fail: a route the spec does not open is missing", () => {
  const routes = ["/inbox", "/tax", "/reconcile/$id"];
  const opened = ["/inbox", "/reconcile/not-a-reconciliation"];
  expect(routes.filter((route) => !opened.some((path) => covers(route, path, routes)))).toEqual([
    "/tax",
  ]);
  // An address that is another route of the application does not stand in for a route with an id.
  expect(covers("/journal/$entryId", "/journal/new", ["/journal/new", "/journal/$entryId"])).toBe(
    false,
  );
});
