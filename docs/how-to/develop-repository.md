# Develop the repository

## Install and check

Install Bun from `.bun-version` and Go from `.go-version`, then run from the repository root:

```sh
bun ci
bun run --cwd apps/web test:browser:install
bun run check
```

No reference checkout, cloud account, or database is needed for ordinary checks.
Ledger integration tests start a local Workers runtime with temporary SQLite
storage; they require the platform-supported workerd binary installed by Miniflare.
`bun run test` runs workspace tests and tooling tests; `bun run typecheck` checks
each package and repository tooling; `bun run lint` runs Biome and dependency
boundary checks. `bun run check` also checks formatting and runs the existing model,
coverage, semantic trace gates, and frontend browser checks. Browser installation
downloads Chromium, Firefox, and WebKit; on Linux the install command also installs
their OS dependencies and may require administrator access.
Terminal checks include Go formatting/vet/race tests, generated TypeScript/Go
contract drift, and real keyboard/terminal-lifecycle checks using Python 3's
standard library. See the [terminal guide](../../apps/terminal/README.md) for
building and running the native client against the independently started API.
`bun run check:spec` now includes the ledger's bounded design checks and their
negative controls. `bun run check:syside` validates both first-party models, and
the release command includes ledger semantic validation before kernel release gates.
Root `syside.toml` makes the kernel import visible from the ledger model in editors.

### Format and lint

```sh
bun run format       # apply formatting
bun run format:check # check formatting without writing
bun run lint         # Biome recommended rules, then dependency boundaries
```

Biome is pinned in the root development dependencies and configured in `biome.json`.
It covers repository tooling, configuration, and new apps/packages. The frozen
kernel source/tests/soak, specifications, review records, research
references, mutation-equivalence catalog, and generated Bun lockfile are excluded.
This adoption does not claim the frozen kernel is Biome-clean; reformatting its
source would invalidate line-based mutation evidence and needs a separate review.

Two legacy scripts (coverage and mutation checks) retain their existing non-null
assertions through file-specific overrides. The mutation script also disables
the Turbo environment-declaration rule: it runs directly in Bun, outside Turbo.
Neither exception applies to new application or library code. Warnings fail lint;
formatting is enforced by the existing CI `bun run check` step. Dependency-cruiser
remains responsible for architectural boundaries.

Turborepo coordinates package scripts. All configured tasks currently have
`cache: false`; no remote cache is configured. Do not enable caching until a test
proves that source, dependency, model, fixture, toolchain, and configuration changes
invalidate it and that declared outputs restore correctly. No caching performance
claim is made at this stage.

The kernel owns its test scripts, but they explicitly set the working directory
to the repository root because frozen fixtures resolve paths there. Fast and slow
suites use distinct explicit directories. This preserves the existing test corpus
without silently running the decade soak during ordinary package tests.

### Dependencies

Every package is pinned to an exact version in its workspace manifest (`bun outdated --filter '*'` lists what is
behind), and on 2026-11-03 every one of them was moved to its latest release at once, with Go, the Actions and the
container images. What that move settled, for the next one:

- `typescript` stays at the last 6.x in `apps/marketing`: `@astrojs/check` accepts 5 and 6 only. Everything else is on 7.
- `miniflare` is the latest stable 4.x; Wrangler carries its own Miniflare 5 beta, and the two coexist.
- `@babel/core` is 8 and ships its own types (`@types/babel__core` went). `babel-preset-solid` still declares Babel 7
  as its peer and runs on 8; it is typed as a `PresetTarget` in `apps/web/tooling/vendor.d.ts`.
- `lucide-solid` 1.x: `trash-2` became `trash` (the same drawing; the old `trash` went in 1.41).
- OpenTelemetry 3.0 (with `otlp-transformer` 0.300) allows no deep imports; the telemetry package only ever used
  the package roots.
- Better Auth 1.7.16 requires the passkey holder check itself when it is asked for, and refuses first:
  [passkeys](../reference/program/hosting/passkeys.md).
- Biome 2.6: `useMathMinMax` is off (dates and money are strings here, and the rule reads every `a < b ? a : b` as
  numbers), `useDomNodeTextContent` is off (the tests and the copy audit read the visible text on purpose), and the
  Markdown formatter is off (it would rewrite the emphasis marks of every page, and the legal pages are generated
  from theirs). From this version Biome formats YAML and the markup of `.astro` files.
- dependency-cruiser 18.7 has both fixes the repository used to patch into 18.2 (above), so `patches/` is gone; its
  command is `bin/dependency-cruiser.mjs` now.
- Bun's types: a process's `signalCode` is `NodeJS.Signals | number | null`.
- Ark 5.40 (Zag 1.47): a combobox announces its result count through a live region of its own (`role="status"`,
  empty until it speaks), so a test that looks for "the status" filters to one that says something
  (`getByRole("status").filter({ hasText: /\S/ })`); a menu whose trigger carries the host's id tells Ark through
  `ids` (`row-menu.tsx`), or the list is placed off-screen; and axe 4.14 turns its label-in-name rule on, which
  reads the second line of an account option (where it sits) as part of the visible label, so the one check that
  runs axe with a picker open leaves that rule out (`catalog.spec.ts`, with the reasoning).
- TanStack's router-core 1.171 keeps its hot-reload hook in a cycle of imports; fine in a browser, but Bun's
  hot-reload runtime loads such a module as null and the app does not start. The browser suites therefore get the
  bundle as it ships (`RASTRATA_WEB_HMR=0`, `apps/web/tooling/dev.ts`); `bun run dev:web` keeps hot reloading.
- Go is in `.go-version` (1.27.3), `scripts/tool-env.ts` names where this computer keeps it, every workflow reads
  the file, and the modules are at their latest. The Actions are at their latest releases, pinned by commit. The Playwright pin is shared with CI and moves with the dependency upgrades.

## Run the frontend

From the repository root:

```sh
bun run dev:web        # http://localhost:4000
bun run build          # static assets in apps/web/dist
bun run --cwd apps/web preview # http://localhost:4001
bun run test:browser    # build, then development and production browser checks
```

Use `PORT=4100 bun run dev:web` to override the development port. Both servers
bind only to loopback and are local tools, not production application servers.
Production hosting needs to serve generated assets and fall back to `index.html`
for document routes, without rewriting missing assets or API calls to HTML.

`apps/web/src` owns browser code; `apps/web/tooling` owns the Bun build/server
integration; `apps/web/tests` owns its checks. Routes are declared in code: each lane
registers its routes, "+ New" actions and Search sources in `apps/web/src/routes/<lane>/index.ts`
(see `registry-types.ts`), and every route says which section and tab it belongs to. The
interaction fixture that used to be the `/checks` route (an Ark combobox inside a dialog) is a
Storybook story with a keyboard test (`packages/ui/tests/nested-controls.spec.ts`).
The accounting API and ledger connection are enabled only by the explicit local
mode described below. The shared UI package owns the register and controls;
application routes own the first-book workflows. Authentication is deferred.

The small Bun plugin runs Solid's official Babel compiler on TSX; Bun handles
the browser bundle and native development refresh/error overlay. Tailwind uses
its Bun plugin. There is no Vite, separate Node runtime, custom watcher, or claim
of state-preserving Solid Fast Refresh. Browser builds disable environment
inlining; no browser configuration or secrets are currently required. Keep future
public configuration explicit, never copy server environment variables wholesale.

Browser source cannot import the kernel, ledger, server tooling, runtime builtins,
or development dependencies. Real TSX positive/negative controls enforce these
boundaries. Browser and tooling TypeScript environments are separate. Two current
compatibility constraints are intentionally narrow:

- TanStack Solid Router is pinned to 1.169.0. In this scaffold, 1.170.36's
  `load-client`/`router` circular initialization failed under Bun's native development
  hot reload. Upgrade only after the development and production browser tests pass.
- Only the browser TypeScript project uses `skipLibCheck`: Ark UI 5.39.2's published
  declarations fail TypeScript 7 checks (including combobox `id` inheritance and
  value references to exported types). Our application source remains strictly
  checked. Remove this exception when upstream declarations pass; do not widen it
  to application code or the separate tooling project.

The browser suite covers direct URLs, navigation/reload, unknown routes, missing
assets/API paths, named controls, keyboard dialog/combobox interaction, focus
containment/restoration, and disabled options in Chromium, Firefox, and WebKit.
A separate Chromium test edits an isolated source copy to verify TSX/CSS refresh,
compiler-error visibility/recovery, and the route-error fallback. On macOS,
WebKit's all-controls navigation uses Option-Tab, following
[Safari's keyboard convention](https://support.apple.com/en-az/guide/safari/cpsh003/mac).
These are scaffold checks, not screen-reader or full product accessibility
certification. The design system still needs those reviews.

The build prints raw and gzip-9 sizes for every artifact. Initial local baseline
(Bun 1.4.0, 2026-09-21): JavaScript 257,420 bytes / 81,828 gzip bytes;
CSS 9,692 / 2,769; HTML 500 / 303. This includes the router and Ark interaction
fixture; it is not comparable to a framework-only payload. Sizes are a starting
measurement, not a performance SLA. Build/test artifacts remain gitignored.

## Run the public site

`apps/marketing` uses Astro for an independent static public site. It owns its layouts, components and
CSS, with no Solid, Ark, Tailwind or `@rastrata/ui` dependency, and it runs no script of its own (its only
`<script>` is structured data). Fontsource supplies the fonts. Pictures are imported from
`src/assets` and made into WebP at build time by Astro's image pipeline (which needs `sharp`, a
dependency of this workspace). What the pages say, and the evidence for each claim, is in
[the public site](../reference/marketing-site-v1-plan.md); how its recording and cards are made, and how to
make them again, is in [`apps/marketing/shots/README.md`](../../apps/marketing/shots/README.md). The
generated recording and cards are committed, so builds and tests never make any.

```sh
bun run dev:marketing                           # http://localhost:4321
bun run --cwd apps/marketing build              # apps/marketing/dist
bun run --cwd apps/marketing preview            # http://localhost:4322
bun run --cwd apps/marketing typecheck
bun run test:marketing
bun run --cwd apps/marketing shots              # make the social cards again
```

Both local servers bind to loopback. Astro 7 can background itself when launched
by an agent; `bun --bun astro dev stop` and `bun --bun astro preview stop`, run
from `apps/marketing`, stop those background servers. Browser tests use `--ignore-lock`
to keep their own servers in the foreground on ports 4323 and 4324 (plus the offset, see below).

The logo's files are generated from the design system (`packages/ui/src/brand`): after changing the
geometry, run `bun scripts/generate-brand-assets.ts`, which writes the master files, the site's wordmark
component and favicons, and the web application's tab icon (`--check` verifies them, and `bun run test:ui`
fails when one has drifted). The social cards are rendered with the same wordmark by
`bun apps/marketing/shots/cards.ts`; they are rasters, so they are not part of the check.

Build settings are public and explicit; Vite dotenv loading and public environment prefixes are disabled.
`SITE_ORIGIN` sets the site's HTTP(S) origin (canonical and social-card addresses, `sitemap.xml`, the
`Sitemap:` line of `robots.txt`); `SITE_CONTACT_EMAIL` an address for the footer and two pages;
`apps/marketing/release.json` (or the file `SITE_RELEASE_FILE` names) the published packages the install
page offers (the whole application, the command line, or both). A build with `SITE_ORIGIN` and no release
succeeds and leaves the install page out; a release is checked field by field, so the site cannot go out
with a download button that goes nowhere. Without these settings the canonical URLs, cards, sitemap and
contact are omitted and the install page says no release is configured. Turbo passes the named variables through, including
when tests build the site. Deploying it is in [Deploy the public site](deploy-the-public-site.md).

```sh
SITE_ORIGIN=https://rastrata.example bun run --cwd apps/marketing build
```

Hosting must serve each generated document (including directory indexes) and use `404.html` for missing
documents, with HTTP 404 status. Missing assets and API paths must also return 404. Configure the host for
static multi-page output; an SPA fallback to `index.html` would hide missing routes. The scaffold does not
require an SSR adapter. `public/_headers` carries the response headers (a strict content security policy,
caching of the hashed files); the build copies the Inter, Archivo and Silkscreen licenses to
`dist/licenses/`.

### Shared color tints and the web app's CSS pipeline

The web app builds CSS through Tailwind, which runs Lightning CSS. Lightning CSS collapses a
`color-mix()` that takes a custom property to its first color, so `color-mix(in srgb,
var(--rt-black) 64%, var(--rt-white))` becomes plain black. It does the same to
`light-dark(color-mix(...))`. Storybook (Vite) does not, which is how this went unnoticed.
The shared tokens in `packages/ui/src/base.css` therefore use **literal** colors inside
`color-mix()` and write the dark theme as explicit overrides instead of `light-dark()`.
Keep it that way: a mix that depends on a theme token (`--rt-paper`, `--rt-ink`) or
`currentColor` will not survive. `apps/web/tests/browser/smoke.spec.ts` reads the resolved
tints through the real dev and production builds in both themes and fails if they collapse.

### Public site checks and compatibility

Root `bun run check` includes the site typecheck and, through workspace `test`, its
production build and browser suite. CI collects site traces/screenshots on failure.
The suite verifies, for every page: that it works without JavaScript, that the one button opens the service
and that the footer reaches the legal pages; a unique title, description and one `h1`; a first screen that
holds the headline and shows the top of the recording's window at common window sizes; that every picture has a
description and a size; that the comparison table is one table that says in words what each product supports and on
what day it was checked, and that every row of it has its evidence in `docs/reference/site-comparison.md`, which agrees
with each cell; that the page runs no script of its own, loads its fonts and nothing from another
origin, and stays light on a first visit (documents and styles under 90 kB, fonts under 200 kB, pictures under
200 kB, before compression, the recording counted apart); that mobile layouts at 390 and
360 px do not overflow; that a keyboard reaches the content and sees where it is; missing routes (which must
answer 404 and not the home page); an axe scan in both colour schemes; that the recording is a loop with no
player (it starts by itself, is muted, repeats, has no controls, no caption track, no bar and no words over, around or under it,
has a poster and a description), plays by itself and goes round again, and is not sent to a visitor who asks for less motion; and that the home
page stays short (under forty words, one way in, one recording, no menu). Artifact checks verify the static
documents and their structured data, that the one recording the page names is the file in the build, named by its
contents, under thirty seconds and under 4 MB, ready to stream and as large as the page says, the Worker that
answers a range of it (`worker.spec.ts`: every way a browser asks), that no islands are emitted, `robots.txt`, `sitemap.xml` and
`_headers`, every social card's size, that every link goes somewhere that exists, and that nothing says it is
unfinished. A separate test
builds the site again with an origin and with each kind of release (the command line, the whole application,
both, neither) to check what only a deployment shows, and that a release that does not add up is refused.
Production runs in Chromium, Firefox, and WebKit; development runs in Chromium. Generated `.astro`
metadata stays gitignored.

The source and tooling TypeScript checks explicitly use the repository's TypeScript 7.
The pinned `@astrojs/check` rejects TypeScript 7, so `apps/marketing` pins TypeScript 6.0.3
solely for `astro check`, which validates Astro templates and props. Do not remove
this separate check until the replacement supports Astro and has been verified.

`tsconfig.json` and `tsconfig.config.json` use `skipLibCheck` for Astro’s published
client/config declarations, including references to optional-driver types. Source,
config, and tests remain strict; `tsconfig.tooling.json` checks declarations too.

Biome's full HTML/Astro parser is enabled at the root, with template formatting
and linting enabled specifically for site Astro files. Repository tooling tests
prove that Astro lint errors and formatting errors fail the checks.

Dependency-cruiser checks site TypeScript, including restrictions on runtime builtins,
development dependencies, server packages, and application UI imports. The
repository boundary gate also inventories every Astro file. Its companion checker
uses the official Astro compiler and SWC to inspect frontmatter and template
expressions. Astro imports may reference local site source. Runtime loaders and raw
HTML injection fail the gate. Client scripts, when needed, must reference a local
checked `.ts` file through a plain `<script src="…"></script>`; inline scripts and
external script URLs are rejected. Adding other Astro source
locations or import mechanisms requires an explicit boundary-policy change and a
negative-control test. This checker does not participate in rendering or builds.

## Keep component ownership clear

The design workshop lives in `packages/ui`. Run `bun run storybook` and open
`http://localhost:6006`; begin with **Foundations → Typography, color & density**.
It contains provisional review stories, not approved product styling. See the
[UI workshop guide](../../packages/ui/README.md) for Controls, review workflow,
static builds and verification. Storybook uses the community Solid/Vite adapter. The accounting application keeps
its Bun bundler; the public site uses Astro's Vite pipeline.
Root workspace tests include its static build and browser tests. Neither its
stories nor its tool dependencies are exported to the application.

Each package owns its implementation, tests, executable specifications, and
verification scripts. For the kernel these live in `packages/kernel/{src,test,slow,spec,scripts}`.
Root commands delegate accounting checks to the kernel package; root `scripts/`
contains only workspace boundary checks and repository tooling tests.

Keep cross-system architecture in the documentation and component-specific formal
contracts with their package. Do not duplicate requirements between them. Research
experiments belong alongside the specification they validate; upstream checkouts
stay in `references/`. Historical review evidence lives in `docs/reference/reviews/`.
Do not create empty apps or packages for hypothetical future components.

## Add an application or library

Create a workspace only when there is implementation to put in it:

1. Use `apps/<name>` for deployment entry points or `packages/<name>` for libraries.
2. Give it a unique `@rastrata/<name>` name, `private: true`, and its own manifest.
3. Declare internal dependencies with `workspace:*`; declare external dependencies
   in the consuming package, even if another package has already installed them.
4. Define explicit `exports` for libraries. Do not export test fixtures or use
   wildcard exports to bypass internal boundaries.
5. Extend `tsconfig.base.json` and explicitly choose that package's environment
   types/libraries. Use separate test configuration for Bun. Canonical hashing uses
   native `node:crypto`, supported by Bun and Workers with Node compatibility.
   Ledger integration checks compare canonical bytes and hashes across those runtimes.
   Ledger test configuration skips third-party declaration checking because the
   pinned Miniflare declarations have unresolved internal imports; production
   configuration does not. Both configurations strictly check our own TypeScript.
6. Supply package-owned `typecheck` and `test` scripts. Add a build task only when
   an actual build exists, with explicit dependency ordering and output ownership.
7. Run root checks and the package's scripts directly from its directory.

Dependency checks discover `apps/*` and `packages/*`, reject manifest cycles,
cross-package import cycles, imports into private files, undeclared workspace and
external dependencies, imports of applications, research imports, and production
imports of tests, specifications, or verification scripts. Kernel production code
may import only its own source, except that `canonical.ts` may import native
`node:crypto` for hashing. Positive and negative controls enforce this exception.
Package exports constrain access but do not authorize a new business dependency;
review each dependency change against the system model.

SWC parses TypeScript for dependency-cruiser because its TypeScript-compiler API
integration does not yet support our pinned TypeScript 7. Until 18.7 the repository
carried a patch for it (Bun unwraps SWC's CommonJS default to the class, and `.tsx`
files need the parser's `tsx` option); both are in the tool itself since
dependency-cruiser 18.7 (its issue 1092), and `patches/` is gone. `scripts/repository.test.ts` exercises the
real parser, resolver, and fail-closed CLI with positive/negative controls. The
gate also verifies every workspace source file was scanned. The tool's TypeScript-API warning
does not describe the selected SWC parser. SWC does not distinguish all type-only
cycles, so intra-package cycle enforcement is not claimed; the frozen kernel has
legitimate type-only cycles.

## Use optional research references

```sh
git submodule update --init
```

To fetch only one reference:

```sh
git submodule update --init -- references/bigcapital
```

These commands restore recorded commits; do not use `--remote` for normal setup.
For a deliberate update, first preserve any reference-local changes, fetch and
inspect a chosen upstream revision, then update its gitlink and source-register
entry together with the relevant research evidence. Do not include reference source
in application build or deployment inputs.

## Run release verification

```sh
bun run check:release
```

Run from a clean implementation checkpoint. This remains sequential: coverage,
SysIDE controls, the decade soak, mutation self-tests, then full mutation analysis.
The existing coverage and mutation reports use root `coverage/`; do not start two
report-producing release commands concurrently in the same checkout. Use separate
worktrees for concurrent investigations. See [kernel validation](validate-kernel.md).

The ordinary GitHub Actions workflow uses a hosted runner without submodules. The
manual release workflow is restricted to `main` and a self-hosted runner labeled
`syside`, with the `kernel-release` environment. Before enabling it, an owner must
provision an isolated trusted runner with licensed SysIDE and Playwright's Linux
browser libraries (if using Linux), configure environment
approval/protection, and verify the workflow there. It must not run pull-request
code on that runner. Missing tooling is a failure, not a skipped successful check.
Adding workflow files does not provision GitHub runners, approval rules, or branch
protection. The [development ledger deployment](deploy-development-ledger.md) has
an explicit remote smoke command; it is not part of ordinary checks or CI and
does not constitute the complete production-ledger release suite.

## Keep changes reviewable

Keep accounting changes separate from tooling, reference updates, and documentation.
Do not change accounting semantics during structural migrations. Historical audit
records remain historical; record new verification against the commit actually
tested. Reader documentation stays in the existing Diátaxis folders, with research
experiments in `packages/kernel/spec/research/` and release evidence in
`docs/reference/reviews/`.

### Local core book development

The first core application workflow is available only in explicit loopback development mode:

```sh
bun run dev:api
# In a second terminal:
RASTRATA_API_URL=http://127.0.0.1:4010 bun run dev:web
```

The independent application service stores the book in `apps/web/.local/book.sqlite` by default; set
`RASTRATA_LOCAL_DB` to an absolute SQLite path on the API process to use a separate local book.
Stop an older local web server before starting the standalone API; only the API
process owns the book. The frontend proxies requests and no longer opens SQLite.
The browser gets no ledger credentials. The server uses a fixed local actor and
issues short-lived capabilities to the existing authorized ledger service.
Book setup, drafts, journal postings, account configuration, linked reversals,
period transitions, and reports are durable across process restarts. The browser
uses only display and command APIs; it never receives ledger outcomes or service
credentials. Follow the [first-book tutorial](../tutorials/first-book.md) for a
complete example. This remains an initial local implementation under the
[core web goal](../reference/core-web-app-goal.md), with auth, production hosting,
and large-book read-model work deferred.
Do not expose this development server beyond loopback or use this mode for
production books.

## Build the installed service and the package

```sh
bun run build:service   # dist/rastrata-service: one executable with the web app inside
bun run package         # dist/rastrata-VERSION-OS-ARCH.tar.gz and its .sha256
bun apps/api/tooling/check-launchd.ts   # on a Mac: the real launchd, a throwaway name and home
```

`bun run package` needs Go (it builds the command line tool) and builds for this computer;
`--target linux-amd64` builds the Linux package (Bun fetches the other system's runtime once). The
release is `version` in the root `package.json`. How to install, update and remove the result is in
[Install Rastrata](install-rastrata.md); the engineering record is
[the install lane](../reference/program/install.md). Keep install tooling under `apps/api/tooling`;
`scripts/` is for tooling that spans the repository.
