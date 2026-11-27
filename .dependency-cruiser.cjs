const { existsSync, readdirSync, readFileSync } = require("node:fs");
const escapePattern = (value) => value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
const workspaces = ["apps", "packages"].flatMap((base) =>
  existsSync(base)
    ? readdirSync(base).flatMap((name) => {
        const root = `${base}/${name}`;
        const manifest = `${root}/package.json`;
        return existsSync(manifest)
          ? [{ root, ...JSON.parse(readFileSync(manifest, "utf8")) }]
          : [];
      })
    : [],
);
// Explicit entry points only. Conditional exports are supported; wildcard exports
// deliberately require a policy change instead of opening all package internals.
function entries(value) {
  if (typeof value === "string") {
    if (!value.startsWith("./") || value.includes("*") || value.includes("..", 2)) {
      throw new Error(`Unsupported package export: ${value}`);
    }
    return [value.slice(2)];
  }
  return value && typeof value === "object" ? Object.values(value).flatMap(entries) : [];
}
const workspacePath = "^(apps|packages)/";
const visited = new Set();
function visit(pkg, ancestors = []) {
  if (ancestors.includes(pkg.name))
    throw new Error(`Workspace dependency cycle: ${[...ancestors, pkg.name].join(" -> ")}`);
  if (visited.has(pkg.name)) return;
  const dependencies = {
    ...pkg.dependencies,
    ...pkg.devDependencies,
    ...pkg.peerDependencies,
    ...pkg.optionalDependencies,
  };
  for (const other of workspaces.filter((item) => dependencies[item.name])) {
    if (!dependencies[other.name].startsWith("workspace:"))
      throw new Error(`Use workspace: for ${pkg.name} -> ${other.name}`);
    visit(other, [...ancestors, pkg.name]);
  }
  visited.add(pkg.name);
}
if (new Set(workspaces.map((pkg) => pkg.name)).size !== workspaces.length)
  throw new Error("Duplicate workspace names");
for (const pkg of workspaces) visit(pkg);
module.exports = {
  forbidden: [
    {
      name: "ui-browser-boundary",
      severity: "error",
      from: { path: "^packages/ui/src/" },
      to: { path: "^packages/(kernel|ledger)/|^packages/ui/(stories|tests|\\.storybook)/" },
    },
    {
      name: "ui-no-runtime-or-development-dependencies",
      severity: "error",
      from: { path: "^packages/ui/src/" },
      to: { dependencyTypes: ["core", "npm-dev"] },
    },
    {
      // agent/member.ts is pure (standard globals only) and says what each role may do; the page reads it to
      // offer a person only what is theirs to do. The service decides every request for itself.
      name: "web-browser-boundary",
      severity: "error",
      from: { path: "^apps/web/src/" },
      to: {
        path: "^(packages/(kernel|ledger)/|packages/application/src/(?!contracts\\.ts$|client-contracts\\.gen\\.ts$|money\\.ts$|reconcile/engine\\.ts$|shadow/opening\\.ts$|agent/member\\.ts$|rules/(browser|validate|allocation|narration|text|types)\\.ts$)|apps/web/(tooling|tests)/|cloudflare:|bun:)|(^|/)node_modules/(@babel/|bun-plugin-tailwind/)|^node:",
      },
    },
    {
      name: "web-no-runtime-builtins",
      severity: "error",
      from: { path: "^apps/web/src/" },
      to: { dependencyTypes: ["core"] },
    },
    {
      name: "web-no-development-dependencies",
      severity: "error",
      from: { path: "^apps/web/src/" },
      to: { dependencyTypes: ["npm-dev"] },
    },
    {
      name: "application-portable-service",
      severity: "error",
      from: {
        path: "^packages/application/src/((service|reports|contracts|storage|index|money|schema-kit|ingest-types|account-tags)\\.ts|reconcile/engine\\.ts|bankfeed/.*\\.ts|rules/.*\\.ts|safety/.*\\.ts|slices/.*\\.ts)$",
      },
      to: {
        path: "^(bun:|cloudflare:|node:fs|node:path)|^packages/application/src/(local\\.ts|local/)|^apps/",
      },
    },
    {
      name: "mcp-application-client-boundary",
      severity: "error",
      from: { path: "^apps/mcp/src/" },
      to: {
        path: "^packages/(kernel|ledger)/|^packages/application/src/(?!schema\\.ts$|client-contracts\\.gen\\.ts$|agent/local\\.ts$)|^apps/(?!mcp/)",
      },
    },
    {
      name: "site-browser-boundary",
      severity: "error",
      from: { path: "^apps/marketing/src/" },
      to: { path: "^packages/(kernel|ledger|ui)/|^apps/marketing/(tooling|tests)/" },
    },
    {
      name: "site-no-runtime-or-development-dependencies",
      severity: "error",
      from: { path: "^apps/marketing/src/" },
      to: { dependencyTypes: ["core", "npm-dev"] },
    },
    // Cloudflare supplies this exact built-in at runtime, not through npm.
    // Keep it confined to the platform adapters (the ledger service and the book tail Worker, and the
    // recorded spike the tail Worker was made from) and reject misspelled modules. The recorded
    // Better Auth experiment has its own package.json and lockfile, and its dependencies are installed
    // only when someone reruns it (see its README), so its imports may not resolve.
    // The tools that make the home page's recording (apps/marketing/shots/film) are the same: their own package.json
    // and lockfile, installed only when the film is made again.
    {
      name: "no-unresolved",
      severity: "error",
      from: {
        pathNot: "^(packages/booklog/experiments/x2-better-auth-d1/|apps/marketing/shots/film/)",
      },
      to: { couldNotResolve: true, pathNot: "^cloudflare:workers$" },
    },
    {
      name: "cloudflare-runtime-boundary",
      severity: "error",
      from: {
        pathNot: "^(apps/(ledger-service|tail-worker)/|packages/booklog/experiments/x1-do-tail/)",
      },
      to: { path: "^cloudflare:workers$" },
    },
    {
      name: "no-undeclared-external-dependencies",
      severity: "error",
      from: { path: workspacePath, pathNot: "^apps/marketing/shots/film/" },
      to: { dependencyTypes: ["npm-no-pkg", "npm-unknown"] },
    },
    // The film tools are not a workspace: they install their own terminal emulator, so that bun.lock stays as it is, and they run the
    // Playwright that the marketing app beside them declares. That one package and what their own package.json declares, and nothing else.
    {
      name: "film-tools-undeclared-dependencies",
      severity: "error",
      from: { path: "^apps/marketing/shots/film/" },
      to: { dependencyTypes: ["npm-no-pkg", "npm-unknown"], pathNot: "/@playwright(\\+|/)test" },
    },
    {
      name: "no-cross-package-cycles",
      severity: "error",
      from: { path: "^(apps|packages)/([^/]+)/" },
      to: { circular: true, pathNot: "^$1/$2/" },
    },
    {
      name: "kernel-isolation",
      severity: "error",
      from: { path: "^packages/kernel/src/" },
      to: { pathNot: ["^packages/kernel/src/", "^(node:)?crypto$"] },
    },
    {
      name: "native-accounting-storage-boundary",
      severity: "error",
      from: {
        path: "^packages/ledger/src/native-(ledger|allocation|currency|inventory|money|settlement|ledger-repository)\\.ts$",
      },
      to: { path: "^packages/ledger/src/(sqlite|indexed-sqlite)|^apps/" },
    },
    {
      name: "kernel-crypto-boundary",
      severity: "error",
      from: { path: "^packages/kernel/src/", pathNot: "^packages/kernel/src/canonical\\.ts$" },
      to: { path: "^(node:)?crypto$" },
    },
    {
      name: "no-app-imports",
      severity: "error",
      from: { path: "^(apps|packages)/([^/]+)/" },
      to: { path: "^apps/", pathNot: "^$1/$2/" },
    },
    {
      name: "no-research-imports",
      severity: "error",
      from: { path: workspacePath },
      to: { path: "^(references|docs|scripts)/|^packages/[^/]+/spec/research/" },
    },
    {
      name: "no-production-test-imports",
      severity: "error",
      from: { path: "^(apps|packages)/[^/]+/src/" },
      to: { path: "/(test|tests|slow|__tests__|spec|scripts)/|\\.(test|spec)\\.[cm]?[jt]sx?$" },
    },
    ...workspaces.flatMap((pkg) => {
      const own = `^${escapePattern(pkg.root)}/`;
      const publicFiles = entries(pkg.exports).map(
        (entry) => `^${escapePattern(`${pkg.root}/${entry}`)}$`,
      );
      const dependencies = {
        ...pkg.dependencies,
        ...pkg.devDependencies,
        ...pkg.peerDependencies,
        ...pkg.optionalDependencies,
      };
      const allowed = workspaces
        .filter((other) => other.root === pkg.root || dependencies[other.name])
        .map((other) => `^${escapePattern(other.root)}/`);
      return [
        {
          name: `public-api-${pkg.name}`,
          severity: "error",
          from: { path: workspacePath, pathNot: own },
          to: { path: own, pathNot: publicFiles.length ? publicFiles : "(?!)" },
        },
        {
          name: `declared-workspaces-${pkg.name}`,
          severity: "error",
          from: { path: own },
          to: { path: workspacePath, pathNot: allowed },
        },
      ];
    }),
  ],
  options: {
    exclude: { path: "(^|/)(dist|coverage|\\.turbo|\\.wrangler|\\.astro)/" },
    parser: "swc",
    doNotFollow: { path: "node_modules|^references/" },
    tsPreCompilationDeps: true,
    enhancedResolveOptions: {
      exportsFields: ["exports"],
      conditionNames: ["types", "import", "default"],
    },
    reporterOptions: { dot: { collapsePattern: "^(apps|packages)/[^/]+" } },
  },
};
