# Frontend framework trade study

Date: 2026-09-21. The original recommendation was a React SPA with code-based
TanStack Router, Tailwind and Bun-first tooling. Its component-based preference
is **superseded by the [component trade study](frontend-component-trade-study.md)**,
which recommends Solid + Ark UI for the efficiency-oriented greenfield app and
retains React Aria as the integrated-table alternative. The owner subsequently
accepted Solid + Ark UI and a fresh Bun-only scaffold; the earlier worktree's
scaffold is not merged unchanged.
The measurements and original scoring below remain historical evidence.

This replaces the framework argument in the `frontend_framework_evaluation_matrix`
branch. That study confused React with TanStack Start, treated subjective scores
as measurements, and overstated disadvantages of other frameworks. The corrected
decision below includes reproducible local measurements and sensitivity analysis.

## What we are optimizing

Rastrata needs dependable keyboard-driven financial forms, accessible and
internationalized controls, responsive reports, maintainable code and inexpensive
hosting. It does not need to win a framework benchmark. The owner chose Tailwind,
Bun unless there is a demonstrated reason for another build tool, scaffold-only
scope, and deferred container/deployment decisions.

The ledger remains authoritative. Neither frontend framework selection nor client
validation changes authorization, accounting acceptance or durable acknowledgement.
The existing kernel's `canonical.ts` imports `node:crypto`; full browser kernel
execution has not been demonstrated and is not a scaffold requirement.

We compare **React, Solid, Vue and Svelte as client-rendered applications**. All
can consume the same backend contract. Next.js and TanStack Start are framework
layers, not different rendering engines; their disposition is considered
separately below. Cloudflare Durable Objects do not require any particular UI
framework, and choosing a SPA does not move the ledger into OKE.

## Measured evidence

The [evidence record](../reference/reviews/frontend-framework-2026-09-21.json)
contains every timing sample, source text, source hashes, dependency lockfile,
browser version, scoring inputs and sensitivity calculations. Experimental
dependencies were installed in an isolated temporary directory, not the
repository. No production package, kernel, ledger or remote deployment changed.

Each implementation has the same native HTML journal table, integer-cent strings,
exact BigInt total, edit/add/reverse operations and stable row identity. This is a
synthetic probe, not an implementation of accounting semantics. No router,
component library, CSS framework, fonts or network calls are in its JavaScript
payload. Production mode is explicitly enabled for every build.

Environment: Apple M5, macOS ARM64, Bun 1.4.0, headless Chrome 153.0.8010.53,
1280x900 viewport, no CPU throttling. Tested versions: React/React DOM 19.3.0,
Solid 1.9.15, Vue/compiler 3.5.43 and Svelte 5.57.1. These are evaluation pins,
not an automatic upgrade of the branch's React 19.0.0 dependency.

Three trials per framework at both 100 and 1,000 mounted rows, with rotating
framework order. Each trial has 20 fixed warmup edits and 120 measured edits:
**24 successful runs, 2,880 retained timing samples**, plus 480 warmup edits.
Percentiles below pool all 360 retained samples for each framework/row-count pair.

| Measured result | React | Solid | Vue | Svelte |
| --- | ---: | ---: | ---: | ---: |
| Minified JavaScript, bytes | 216,094 | 16,313 | 58,437 | 54,588 |
| Gzip level 9, bytes | 67,825 | 6,435 | 22,693 | 20,492 |
| 100-row edit-to-DOM p95, ms | 0.60 | 0.30 | 0.70 | 0.40 |
| 1,000-row edit-to-DOM p95, ms | 0.50 | 0.30 | 0.90 | 0.40 |
| Worst observed edit-to-DOM, ms | 0.90 | 0.40 | 2.00 | 0.50 |
| Warm build median, ms | 8.09 | 4.94 | 7.67 | 5.47 |
| Functional runs passing / attempted | 6/6 | 6/6 | 6/6 | 6/6 |

All runs checked initial balance and row count, every measured exact total,
input node identity and focus during edits, real keyboard entry, Tab movement,
zero-row append and preservation of contents/node identity after reversal.
There were no browser page errors. Clicking the reorder button moves focus to
that button; this is not evidence about focus during virtualized row recycling.

**Solid wins payload and update time in this probe. React is not the performance
winner.** React's payload is 61,390 gzip bytes larger (approximately 10.54 times
Solid's). All four satisfy the deliberately coarse local interaction-headroom
criterion. These sub-millisecond results do not establish a perceptible UX
difference or justify calling any candidate sluggish.

### Measurement limitations

- The timer starts immediately before a synthetic input event and ends when a
  MutationObserver sees the expected total. It measures event-to-DOM, **not paint,
  INP, physical keyboard latency, CPU consumption or total page readiness**.
  There is one animation-frame wait before each edit, outside the timed interval.
- Real keyboard checks are correctness checks, not the timing population.
- React uses memoized row components and a stable update callback. Solid uses
  per-row signals. Vue and Svelte use immutable array replacement. These are
  idiomatic but different state strategies, so the measurements characterize
  these implementations rather than isolate framework overhead. React Compiler
  is not enabled. Further optimization is possible for every candidate.
- The 1,000-row case is a stress probe, not a requirement to render complete
  business histories. Production reports need bounded data and, where justified,
  virtualization regardless of framework.
- This is one powerful desktop and one browser, with roughly 0.1-ms timing
  granularity. No mobile, Safari, Firefox, assistive-technology or network test
  was performed. The native inputs do not certify a future component library.
- Build medians use five warm builds after one excluded first build. They include
  the fixture compiler where needed, but not package installation or a cold
  process. They do not compare Bun to Vite or establish future build scaling.

## Historical decision matrix

Weights and performance/payload bins were written into `experiment.json` before
the measurement run. Qualitative scores were assigned after source review.
Scores are ordinal preferences: **1** material obstacle, **2** substantial work,
**3** viable with tradeoffs, **4** strong fit, **5** strongest fit under the stated
criterion. Weighted score = sum(weight × score) / 100. These are not benchmark
percentages, probabilities, or a proof that one framework is universally better.

| Criterion | Weight | React | Solid | Vue | Svelte |
| --- | ---: | ---: | ---: | ---: | ---: |
| Accessible, internationalized component foundation | 25% | 5 | 4 | 4 | 4 |
| Fit with this repository and Bun-first preference | 20% | 5 | 4 | 3 | 3 |
| Measured local interaction headroom | 20% | 5 | 5 | 5 | 5 |
| Measured baseline browser payload | 10% | 3 | 5 | 4 | 4 |
| Routing and data integration capability | 10% | 4 | 4 | 4 | 4 |
| Maintenance/replacement options | 10% | 4 | 4 | 4 | 4 |
| Static hosting portability | 5% | 5 | 5 | 5 | 5 |
| **Weighted preference / 5** | **100%** | **4.60** | **4.35** | **4.05** | **4.05** |

### Why each score is assigned

**Components — original judgment, superseded.** React Aria documents keyboard and
screen-reader behavior, internationalization, a browser/screen-reader testing
matrix, and table navigation. That is a particularly useful starting point for
financial software. React's original extra point expressed a preference, not
an audit showing competitors fail accessibility. The follow-up component study
does not support that blanket extra point: equal component scores tie React and
Solid at 4.35 in this matrix. [React Aria quality](https://react-aria.adobe.com/quality),
[table behavior](https://react-aria.adobe.com/Table).

All other candidates have credible unstyled alternatives: Solid has
[Kobalte](https://kobalte.dev/docs/core/overview/introduction), Vue has
[Reka UI](https://reka-ui.com/docs/overview/introduction), and Svelte has
[Bits UI](https://bits-ui.com/docs/introduction). [Ark UI](https://ark-ui.com/docs/overview/about)
supports all four, including [date pickers](https://ark-ui.com/docs/components/date-picker)
and [comboboxes](https://ark-ui.com/docs/components/combobox). React also has
[Radix](https://www.radix-ui.com/primitives/docs/overview/introduction).
These are documented options, not measured parity or a reason to install several
overlapping libraries. Choosing the primitive library remains design-system work.

**Tooling — local/source evidence, medium-high confidence.** React's JSX builds
directly with Bun. Solid is also TSX, but its JSX needs Solid's transform; this
probe used `babel-preset-solid` and Babel 7.29.7 before Bun. Solid does **not**
require Vite, but it is not a drop-in use of React's JSX pipeline.
[Bun bundler](https://bun.com/docs/bundler),
[Solid TypeScript configuration](https://docs.solidjs.com/configuration/typescript).

Vue SFCs and Svelte components compiled successfully with their first-party
compilers plus Bun in this probe. Their score reflects integrating those formats
into this repository's typechecking and source-boundary checks, not inability to
build them. Vue also offers render functions/JSX; evaluating that alternative
would require its own tooling assessment. [Vue rendering](https://vuejs.org/guide/extras/render-function.html),
[Svelte compiler](https://svelte.dev/docs/svelte/svelte-compiler).

Biome now supports Vue and Svelte experimentally, including full-file support
behind an opt-in. The old claim that either automatically requires replacing
Biome with ESLint/Prettier was incorrect. The repository scanner, however, only
enumerates JS/TS extensions today: it must not silently ignore SFC imports.
Both React and Solid also need the branch's small TSX parser patch and negative
boundary tests. The current patch is not a React-exclusive benefit.
[Biome language support](https://biomejs.dev/internals/language-support/).

**Interaction — measured locally, low generalization confidence.** Worst pooled
p95 across both row counts: <=2 ms earns 5; <=4 earns 4; <=8 earns 3; <=16 earns 2;
otherwise 1. Every candidate passed all functional checks and earns 5. These
thresholds express sufficient headroom for this experiment, not a production SLO.
Using relative rankings instead would favor Solid; do not hide the raw timings.

**Payload — measured for this fixture only.** Gzip <=20 KiB earns 5; <=40 earns 4;
<=80 earns 3; <=160 earns 2; otherwise 1. Svelte exceeds the first boundary by only
12 bytes. Giving it 5 instead raises its total to 4.15 without changing the
decision. The eventual application includes substantially more than this probe.

**Routing/data — equal credit, medium confidence.** React and Solid both have
TanStack Router; [Solid Query](https://tanstack.com/query/latest/docs/framework/solid/overview)
is an official adapter. [TanStack Table](https://tanstack.com/table/latest/docs/framework)
supports all four. [Vue Router](https://router.vuejs.org/guide/) and
[SvelteKit SPA routing](https://svelte.dev/docs/kit/single-page-apps) are viable
alternatives. There is no evidence here that only React can provide typed routes,
bookmarkable reports, caching, or robust command handling.
[TanStack Solid Router](https://tanstack.com/router/latest/docs/framework/solid).

**Maintenance — equal, provisional credit.** Each has documented framework and
component options. No hiring, issue-resolution-time or ten-year-survival study
was performed. We do not penalize Solid using invented maintenance forecasts or
count React's component advantage a second time. Removing this criterion entirely
does not change the default winner.

**Hosting — equal credit.** All four produced static browser assets in the probe.
None needs an SSR server for the chosen application architecture. Hosting, cache
headers, route fallback and private API routing still need implementation; no
particular container, cloud bill or globally cached delivery is assumed.

## Sensitivity: when the answer changes

| Scenario | React | Solid | Vue | Svelte | Interpretation |
| --- | ---: | ---: | ---: | ---: | --- |
| Base product priorities | 4.60 | 4.35 | 4.05 | 4.05 | React preferred |
| All seven weights equal | 4.43 | 4.43 | 4.14 | 4.14 | React/Solid tie |
| Runtime/payload first | 4.40 | 4.65 | 4.30 | 4.30 | Solid preferred |
| Equal component credit | 4.35 | 4.35 | 4.05 | 4.05 | React/Solid tie |
| Exclude maintenance; renormalize | 4.67 | 4.39 | 4.06 | 4.06 | React preferred |
| Give all tooling a 5 | 4.60 | 4.55 | 4.45 | 4.45 | Very narrow React lead |

Runtime/payload-first weights, in matrix order, are 15/10/35/25/5/5/5. Increasing
payload weight from 10% to **20%**, proportionally reducing every other base
weight, ties React and Solid. Above that, Solid wins. These are arithmetic
consequences of the explicit preferences, not confidence intervals.

**The decision is preference-sensitive.** We select React because the documented
React Aria foundation and the simplest native Bun JSX path are worth its measured
baseline payload cost for this product. We do not select it because Solid is
unsafe, incapable, unmaintained or too obscure. Solid is the strongest alternative
and would be the selection if minimizing browser payload were the dominant goal.
The existing scaffold is a convenience, not a scored sunk-cost advantage.

## FinOps interpretation

Switching this probe from React to Solid saves 61,390 gzip bytes per uncached
download: about **6.14 GB per 100,000 downloads**, or **61.39 GB per million**
(decimal GB, excluding headers). This is an illustrative transfer calculation,
not an estimate of Rastrata traffic, CDN billing or the full future application.
Caching and release frequency affect actual transferred bytes. No dollar savings
are claimed without a hosting tariff and traffic model.

All candidates avoid application-page SSR under this decision. Framework updates
run on customer devices; they do not reduce ledger CPU, SQL statements or durable
write latency. The probe measured neither device energy nor process CPU, so it
cannot establish a server-core capacity or energy saving.

## Why not Next.js or TanStack Start now?

No SSR, server-component, server-action or integrated full-stack requirement was
identified for the **scaffold**. A React SPA addresses the chosen boundary without
adding those framework lifecycles. This is a scope decision, not a fifth set of
fabricated rendering measurements.

Next.js can [export static assets](https://nextjs.org/docs/app/guides/static-exports)
and supports [native browser history updates](https://nextjs.org/docs/app/getting-started/linking-and-navigating).
It is not inherently unsuitable for accounting, nor does it force a network call
for every filter. TanStack Start is likewise not required to use TanStack Router.
Neither full-stack framework is selected now. Reconsider if a concrete requirement
needs it, not because a generic starter template includes it.

Marketing and documentation can have a different rendering strategy later. This
decision does not create those applications or select their deployment stack.

## Main-branch integration boundary

Use the follow-up component study to settle the framework choice before importing
framework-specific scaffold files. The original React extraction plan below is
conditional on choosing React; its production-build and boundary-test lessons
also apply if the scaffold is adapted for Solid:

1. Keep this corrected decision record instead of the old trade-study claims.
2. Explicitly enable production mode and test the browser output. The existing
   scaffold's production build was measured at 473,988 bytes with development
   React versus 265,262 after defining production mode. Those are a **different
   workload and dependency version** from the journal probe above.
3. Add positive TSX and negative forbidden-import tests for the scanner patch.
4. Leave unrelated commit `9820eed` out; its ledger-test formatting failure and
   broad type assertions are not needed to choose the frontend.
5. Verify the development server, refresh/deep links, build, web tests and full
   repository checks. Do not mistake `bun --hot` server reload for proven browser
   Fast Refresh. Production cache/container configuration stays deferred.

No product screens, authentication, browser kernel port, React Compiler, SSR or
deployment are required for that scaffold merge. Then build the design system
against one representative journal editor and report, with real accessibility
and browser interaction tests. None of those product requirements is certified
by the tiny native-input probe.

## Reproduce the probe

The evidence JSON embeds `react.tsx`, `solid.tsx`, `vue.vue`, `svelte.svelte`,
`run.ts`, `experiment.json`, `package.json`, and `bun.lock`, each with a SHA-256
hash. Extract those exact nine files into a fresh temporary directory, verify
their hashes, and run `bun ci` with Bun 1.4.0 followed by `bun run.ts`.
Set `CHROMIUM_PATH` to an installed Chromium/Chrome executable if it is not at the
recorded macOS default. This launches only a localhost HTTP server and headless
browser; no Cloudflare deployment, real book data or credentials are needed.

The runner writes a fresh `report.json`, preserving all 24 trial populations.
Timings will vary across machines and browsers. For a byte-identical dependency
resolution use the embedded lockfile, not a fresh latest-version install; Babel's
manifest range is resolved to 7.29.7 in that lockfile. Keep historical evidence
unchanged and record reruns separately.
