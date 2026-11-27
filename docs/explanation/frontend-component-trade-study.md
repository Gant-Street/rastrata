# Frontend component foundation trade study

Date: 2026-09-21. Status: accepted by the owner for the new application scaffold.
Implementation: `apps/web`, using Solid, Ark UI, code-based TanStack Router,
Tailwind, and Bun for the runtime, package manager, development server and build.
No Vite, SSR framework, or existing experimental scaffold is included.

**Recommend Solid + Ark UI for Rastrata's efficiency-oriented greenfield frontend.**
React + React Aria remains the stronger alternative when integrated keyboard
table/collection behavior matters more than browser payload. The earlier blanket
preference for React Aria was too strong: accessible selectors and date pickers
are not exclusive to React.

This study supersedes the component-based recommendation in the
[framework study](frontend-framework-trade-study.md), not its historical browser
measurements. It does not claim that a smaller JavaScript bundle makes a complete
accounting application better, or that these probes certify accessibility.

## What we actually tested

Five isolated implementations of the same screen: a keyboard-opened dialog,
searchable 100-account combobox, one disabled account, a native text input for an
exact decimal string, and a close button. Same CSS and account data; no icons,
animations, router, server rendering, remote data, or financial calculation.
Supported public component subpaths were used, following the React performance
review guidance; production mode and minification were explicit.

The [evidence record](../reference/reviews/frontend-components-2026-09-21.json)
contains executable source, dependency lockfile, hashes, individual outcomes,
automated accessibility findings, failed pilots, and scoring formulas. No
production dependency or application code changed during the study. The subsequent
scaffold is a separate implementation; see the
[development guide](../how-to/develop-repository.md#run-the-frontend).

Environment: Apple M5, macOS ARM64, Bun 1.4.0, headless Chrome 153.0.8010.53,
Playwright 1.63.0, axe-core 4.13.0. React/React DOM 19.3.0; Solid 1.9.15 with
Babel 7.29.7 and babel-preset-solid 1.9.15 before Bun's browser bundle.

Three trials in each of en-US/LTR and ar-EG/RTL: **30 final runs**. Ten assertion
groups cover named dialog opening, focus entry, repeated forward/backward Tab
containment, named combobox filtering, canonical selected ID, disabled-option
exclusion, empty-search recovery, popup-before-dialog Escape, preservation of
`9007199254740993.123456789`, and dialog Escape/focus restoration.

These are ten groups implementing the protocol's fourteen checklist entries,
including two accessibility scans per run. English labels and ASCII account
names remain unchanged in RTL: this checks operation under locale/direction
configuration, not Arabic translation, bidirectional text, or locale-aware search
quality. Preserving a decimal string proves no financial parsing or arithmetic.

## Measured results

Payload is the **entire common-screen JavaScript including its framework**, gzip
level 9; KiB means 1,024 bytes. Dates, tables and virtualization are not included
in these bundles. Do not subtract the previous study's unrelated native-table
bundle to estimate the component library's incremental size.

| Candidate/version | Minified bytes | Gzip bytes / KiB | Complete runs | Fixture nonblank lines |
| --- | ---: | ---: | ---: | ---: |
| React Aria 1.21.1 | 431,711 | 132,761 / 129.6 | 6/6 | 25 |
| Base UI 1.8.0 on React | 392,815 | 128,552 / 125.5 | 6/6 | 23 |
| Ark UI 5.39.2 on React | 360,692 | 112,916 / 110.3 | 6/6 | 22 |
| Ark UI 5.39.2 on Solid | 168,540 | 53,623 / 52.4 | 6/6 | 21 |
| Kobalte 0.13.14 on Solid | 124,182 | 40,916 / 40.0 | 4/6 | 19 |

Ark/Solid shipped **59.6% less compressed JavaScript than React Aria** for this
screen. This is evidence about transfer size, not a measured reduction in OKE
CPU, ledger cost, memory, user-visible latency, or maintenance hours. Bundling
another screen, calendars or a production grid can change the comparison.

All 60 final axe scans reported zero violations for the selected WCAG 2 A/AA and
2.1 A/AA tags. They also returned **78 incomplete rule occurrences** across
`aria-hidden-focus` and `aria-valid-attr-value`, retained in the evidence. Zero
reported violations is not zero accessibility defects. Kobalte's scans occurred
before its failing later interactions; they do not excuse those failures.

Keyboard-open-to-visible-dialog observations ranged from 3.3 to 20.0 ms across
all candidates. They include automation overhead, use only six samples per
candidate, fixed candidate order, and no throttling. They are not INP, paint or
CPU benchmarks and receive no latency-based ranking.

### Composition findings, including corrections

- **React Aria:** the first executable pilot completed the nested popup flow
  without a custom event handler. Declarative item filtering and modal/popup
  integration were sufficient for this fixture.
- **Base UI:** a plain external HTML label produced an axe finding when the
  popup opened. Using the library's `Field.Root`/`Field.Label` composition removed
  it. Early focus assertions also needed to await asynchronous focus relocation;
  that harness correction was applied equally to every candidate. This is not
  evidence that Base UI cannot trap focus. See its [form guidance](https://base-ui.com/react/handbook/forms).
- **Ark, both frameworks:** portaling the combobox outside the modal left the
  popup inaccessible to role queries in the pilot. Keeping its positioner and
  content inside the dialog resolved the tested flow. Filtering uses an explicit
  collection/filter hookup. No custom keyboard handler was necessary. Production
  modal clipping/scroll behavior still needs testing. See the [combobox anatomy](https://ark-ui.com/docs/components/combobox).
- **Kobalte:** nested portal placement also needed correction. Escape sometimes
  closed both popup and modal. An attempted `preventDefault` guard passed the
  single-trial pilot but failed two runs in the first full campaign. A direct
  event-handler attempt still finished only 4/6 runs: one empty-search recovery
  timeout and one premature modal dismissal. These are unresolved **fixture
  integration failures**, not a proven upstream root cause. It receives no overall
  numeric rank; the failures and both attempted fixes are preserved.

Line counts above describe compact research fixtures, excluding shared data and
runner code. They are not production wrapper sizes or estimated implementation
effort. No library should be selected merely because its example is shorter.

## Documented coverage, separate from measured behavior

The eight categories below were listed before running the probe. A check means
the library documents the capability or an integration, not that we have
verified every interaction. A dash means additional application work or another
library is needed in the versions reviewed.

| Capability | React Aria | Base UI | Ark React/Solid | Kobalte |
| --- | :---: | :---: | :---: | :---: |
| Modal dialog | Yes | Yes | Yes | Yes |
| Searchable combobox | Yes | Yes | Yes | Yes |
| Date and date-range selection | Yes | — | Yes | — |
| Form validation/error association | Yes | Yes | Yes | Yes |
| Menus and tabs | Yes | Yes | Yes | Yes |
| Tooltip and popover | Yes | Yes | Yes | Yes |
| Keyboard-navigable data table/grid primitive | Yes | — | — | — |
| Documented virtualized collection integration | Yes | Yes | Yes | Yes |
| **Documented categories** | **8/8** | **6/8** | **7/8** | **6/8** |

React Aria's [Table](https://react-aria.adobe.com/Table) provides directional
navigation, selection and sorting; its [Virtualizer](https://react-aria.adobe.com/Virtualizer)
integrates with tables and lists. That is a concrete advantage. It is not a
complete accounting spreadsheet: journal validation, clipboard semantics,
transactional save and product-specific editing remain ours.

Ark documents [single/range date selection, bounds, unavailable dates, locale and
non-Gregorian calendars](https://ark-ui.com/docs/components/date-picker). React
Aria documents [calendar-system handling and date validation](https://react-aria.adobe.com/Calendar).
We did not execute calendar, timezone or date-range edge cases in this study.
Ark's calendar `Table` is not a general-purpose accounting data grid.

[Base UI's component inventory and virtualized combobox](https://base-ui.com/react/components/combobox)
and [Kobalte's inventory/combobox API](https://kobalte.dev/docs/core/components/combobox)
support the corresponding entries above. Neither inventory supplies the same
date-picker-plus-data-table foundation as React Aria. A native date input or
third-party calendar is possible; its integration is not counted as built in.

All five offer locale/direction mechanisms. React Aria additionally publishes a
[screen-reader/browser test matrix and translated internal messages](https://react-aria.adobe.com/quality).
That is useful upstream evidence, not our certification or proof the other
libraries fail those environments. Ark has a [locale provider](https://ark-ui.com/docs/utilities/locale)
and configurable translations; Base UI documents [direction configuration](https://base-ui.com/react/utils/direction-provider).
The score below does not pretend our two-locale probe ranks localization quality.

React Aria's installed package is Apache-2.0; the other four are MIT. These are
permissive licenses, not guarantees of future maintenance. No download counts,
GitHub stars, guessed hiring costs or unverified longevity scores are used.

### Other candidates screened

**Radix:** its [Primitives inventory](https://www.radix-ui.com/primitives/docs/overview/introduction)
does not provide the common workload's searchable combobox or a calendar.
Combining Radix with another library is viable, but would be a different,
multi-library stack. No fabricated Radix payload or failure score is supplied.

**Vue/Reka and Svelte/Bits:** both remain credible alternatives with
[Reka combobox](https://reka-ui.com/docs/components/combobox),
[Reka calendar](https://reka-ui.com/docs/components/calendar),
[Bits combobox](https://www.bits-ui.com/docs/components/combobox), and
[Bits date picker](https://www.bits-ui.com/docs/components/date-picker).
They were documentation-screened, not executed here. Ark also documents those
framework adapters. Nothing in this study establishes React/Solid superiority
over a measured Vue/Reka or Svelte/Bits screen.

## Preference matrix and sensitivity

Weights, candidate list, workload, coverage categories and payload bins were
declared before the pilot. The remaining ordinal formulas were defined during
analysis: this is an **exploratory decision model**, not a preregistered scientific
result. All exact inputs and formulas are in the evidence.

Scores: behavior = five times complete-run fraction; coverage = five times
documented-category fraction; payload = 5/4/3/2/1 at <=60/90/120/180/>180 KiB;
composition = five minus bespoke behavior responsibilities in this fixture;
internationalization = equal baseline five for locale/direction support;
framework optionality = five for Ark's documented four-framework family, one for
single-framework libraries. Incomplete candidates cannot win an overall rank.
Optionality is a preference, not a claim that framework migration is free.

| Criterion | Weight | React Aria | Base UI | Ark React | Ark Solid |
| --- | ---: | ---: | ---: | ---: | ---: |
| Tested common behavior | 30% | 5 | 5 | 5 | 5 |
| Documented workflow coverage | 25% | 5 | 3.75 | 4.375 | 4.375 |
| Measured total browser payload | 15% | 2 | 2 | 3 | 5 |
| Fixture composition responsibilities | 10% | 5 | 5 | 4 | 4 |
| Locale/direction baseline | 10% | 5 | 5 | 5 | 5 |
| Framework optionality | 10% | 1 | 1 | 5 | 5 |
| **Weighted preference / 5** | **100%** | **4.15** | **3.84** | **4.44** | **4.74** |

These numbers are neither quality percentages nor probabilities. Several axes
are coarse proxies; counting a date picker and menu as equal categories is a
product preference, not an accounting requirement decomposition.

| Changed priorities, remaining weights normalized | React Aria | Base UI | Ark React | Ark Solid |
| --- | ---: | ---: | ---: | ---: |
| No credit for framework optionality | 4.50 | 4.15 | 4.38 | **4.72** |
| Ignore both payload and framework optionality | **5.00** | 4.58 | 4.66 | 4.66 |
| All six criteria equally weighted | 3.83 | 3.63 | 4.40 | **4.73** |

The decision is therefore understandable without a score: **Ark/Solid gives up
an integrated keyboard data-table primitive and needs Solid's compiler step, in
return for a substantially smaller tested screen and a shared component family.**
React Aria is preferable if avoiding that table-interaction integration is worth
more to us. If React is already fixed and framework optionality has no value,
React Aria narrowly beats Ark/React in this model. Base UI's composition is good,
but this screen shows little payload advantage over React Aria while leaving
more coverage gaps.

## What this changes for Rastrata

Remove the previous unsupported extra component point for React. With equal
component scores, the earlier framework matrix ties React and Solid at 4.35;
its raw timing/bundle measurements do not change. This study makes the smaller
Solid option credible instead of dismissing it on ecosystem grounds.

Given the owner's efficiency priorities and small, unmerged scaffold, recommend
**Solid + Ark UI**, a client-rendered application, Tailwind, and Bun with the
explicit Solid compiler integration already exercised here. Keep app-specific
wrappers thin; do not create a universal React/Solid abstraction or install a
second general-purpose primitive library preemptively. Backend authorization and
accounting acceptance remain unchanged.

The tradeoff must stay visible: a general-purpose keyboard/editable accounting
grid is not supplied by Ark. Start with semantic native tables and ordinary
inputs where sufficient; add grid interaction only where the workflow requires
it. If we want sophisticated grid behavior from the first component foundation,
choose React Aria instead, without pretending its payload is smaller.

Before shipping the first actual workflow, test that workflow's date/range
handling, validation announcements, keyboard table editing, focus through
virtualization, mouse/touch interactions, IME, and representative screen readers
and browsers. Those are bounded design-system acceptance tests, not a reason for
another open-ended framework research project. This study did not measure them,
run strict TypeScript checks on the research fixtures, or conduct visual QA.

Do not cherry-pick the React scaffold unchanged on the strength of the older
recommendation. Its production-mode fix, workspace boundary tests and build
discipline are reusable; component/router entrypoints depend on the owner's
framework decision. No application, kernel or ledger code was changed here.

## Reproduction evidence

The JSON contains the final runner's ten source files with SHA-256 hashes,
plus an analysis script and prior-run source overrides. Extract the final
`sources` entries into a fresh temporary directory, verify hashes, run `bun ci`
with Bun 1.4.0, then `bun run run.ts`. The runner uses the recorded macOS Chrome
path and writes `report.json`; adjust that path on other hosts and record the
change. A nonzero exit is expected if an unresolved fixture failure recurs.
Do not rerun until green and discard failures.

Earlier runs are reproducible by replacing final source entries with the relevant
`priorRuns[].sourceOverrides`. The separate analysis script documents score
calculation; to reproduce the historical analysis it expects the final and four
prior report filenames. Successful raw trials do not make untested browser or
assistive-technology combinations pass.
