import { devices } from "@playwright/test";

/** The feature specs of the web app in Firefox and WebKit.
 *
 * `playwright.config.ts` runs most of the specs in Chromium only (a lane lands with one browser; the three-browser matrix is for the specs that name all three). This
 * file derives, from that config, a Firefox and a WebKit copy of every Chromium-only spec: the same spec, the same fresh book, the same stand-ins, on servers of its own
 * (every port moved up by 1000 for Firefox and 2000 for WebKit, and every database and key file named for the browser), so that three browsers never share a book. It
 * changes no spec and no server; a spec that fails here but not in Chromium is a finding about the product, or about a spec that assumed Chromium, and says so.
 *
 *   bun --bun node_modules/@playwright/test/cli.js test -c playwright.crossbrowser.config.ts --project 'inbox-*' --project 'reports-*'
 *
 * Run a few projects at a time: each starts two servers or more, and the computer is shared. The ports are the base config's (`RASTRATA_PORT_OFFSET`), moved. */

// The base config keeps only the servers the projects named on the command line need. Ask it for the Chromium projects, whose servers these copies are made from, and give the
// command line back to this run afterwards.
const given = process.argv;
process.argv = [
  ...given.filter(
    (arg, index) =>
      !arg.startsWith("--project") &&
      arg !== "-p" &&
      given[index - 1] !== "--project" &&
      given[index - 1] !== "-p",
  ),
  "--project=*-chromium",
];
const base = (await import("./playwright.config.ts")).default;
process.argv = given;

type Project = NonNullable<typeof base.projects>[number];
type Server = Exclude<NonNullable<typeof base.webServer>, unknown[]>;

const browsers = [
  { name: "firefox", device: "Desktop Firefox", shift: 1000 },
  { name: "webkit", device: "Desktop Safari", shift: 2000 },
] as const;

/** The specs whose projects already run in all three browsers in the base config: nothing to copy. */
const ALREADY_EVERYWHERE = /^(dev|production|local|chart|import|accounts|installed)-/;

/** The specs that cannot be copied: the SimpleFIN stand-in (`bankfeed`) is called by a port the spec works out for itself, so a copy would call the Chromium one, and that connection
 * is not offered by the hosted service. */
const NOT_COPIED = /^bankfeed-/;

const portOf = (value: string | undefined): number | undefined => {
  const match = value ? /:(\d+)(?:[/?]|$)/.exec(value) : null;
  return match ? Number(match[1]) : undefined;
};
const portsIn = (value: string): number[] =>
  [...value.matchAll(/:\/\/[^/:]+:(\d+)/g)].map((match) => Number(match[1]));

const features = (base.projects ?? []).filter(
  (project): project is Project & { name: string } =>
    typeof project.name === "string" &&
    project.name.endsWith("-chromium") &&
    !ALREADY_EVERYWHERE.test(project.name) &&
    !NOT_COPIED.test(project.name),
);

const servers: Server[] = [base.webServer ?? []].flat();

/** The ports of the servers a set of projects needs, found as the base config finds them: a project's address, then every address a needed server's environment names. */
function portsNeededBy(projects: readonly Project[]): Set<number> {
  const needed = new Set<number>();
  for (const project of projects) {
    const own = portOf(project.use?.baseURL);
    if (own !== undefined) needed.add(own);
    const api = (project.metadata as { api?: string } | undefined)?.api;
    const apiPort = portOf(api);
    if (apiPort !== undefined) needed.add(apiPort);
  }
  for (let changed = true; changed; ) {
    changed = false;
    for (const server of servers) {
      const own = portOf(server.url);
      if (own === undefined || !needed.has(own)) continue;
      for (const value of Object.values(server.env ?? {}))
        for (const port of portsIn(String(value)))
          if (!needed.has(port)) {
            needed.add(port);
            changed = true;
          }
    }
  }
  return needed;
}

const wanted = (() => {
  const patterns: string[] = [];
  for (let index = 0; index < given.length; index++) {
    const arg = given[index] ?? "";
    if ((arg === "--project" || arg === "-p") && given[index + 1])
      patterns.push(given[index + 1] ?? "");
    else if (arg.startsWith("--project=")) patterns.push(arg.slice("--project=".length));
  }
  return patterns.map(
    (pattern) =>
      new RegExp(`^${pattern.replace(/[.+?^${}()|[\]\\]/g, "\\$&").replace(/\*/g, ".*")}$`, "i"),
  );
})();

const projects: Project[] = [];
const servicesToStart: Server[] = [];
for (const browser of browsers) {
  const copies = features
    .map((project) => ({ ...project, name: project.name.replace(/chromium$/, browser.name) }))
    .filter(
      (project) => wanted.length === 0 || wanted.some((pattern) => pattern.test(project.name)),
    );
  const originals = features.filter((project) =>
    copies.some((copy) => copy.name === project.name.replace(/chromium$/, browser.name)),
  );
  const ports = portsNeededBy(originals);
  const moved = (text: string): string =>
    text.replace(/\d{4,5}/g, (digits) =>
      ports.has(Number(digits)) ? String(Number(digits) + browser.shift) : digits,
    );
  for (const original of originals) {
    const { name, use, metadata, ...rest } = original;
    const api = (metadata as { api?: string } | undefined)?.api;
    projects.push({
      ...rest,
      name: name.replace(/chromium$/, browser.name),
      use: {
        ...use,
        ...devices[browser.device],
        baseURL: use?.baseURL ? moved(use.baseURL) : undefined,
      },
      ...(api ? { metadata: { ...(metadata as object), api: moved(api) } } : {}),
    });
  }
  for (const server of servers) {
    const own = portOf(server.url);
    if (own === undefined || !ports.has(own)) continue;
    servicesToStart.push({
      ...server,
      url: server.url ? moved(server.url) : server.url,
      env: Object.fromEntries(
        Object.entries(server.env ?? {}).map(([key, value]) => [
          key,
          // A book or a key file is the browser's own; everything else only has its ports moved.
          value.startsWith("/")
            ? value.replace(/(\.[A-Za-z0-9]+)$/, `-${browser.name}$1`)
            : moved(value),
        ]),
      ),
    });
  }
}

export default { ...base, projects, webServer: servicesToStart } satisfies typeof base;
