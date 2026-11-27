# Rastrata UI workshop

Draft components and visual experiments, not an approved design system.
The web application has not adopted these components or tokens yet.

The [prior-art study and proposed completion checklist](../../docs/reference/storybook-completion-study.md)
defines the first-edition scope, required states, and review criteria.

From the repository root:

```sh
bun run storybook        # http://localhost:6006
bun run build:storybook  # packages/ui/dist/storybook
bun run test:ui          # static build + Chromium, Firefox and WebKit checks
```

Start with **Start here → Workshop → Review** for the catalog, then review
**Foundations → Typography, color & density** and **Foundations → System rules**. Use the
Controls panel to change text size and density. The Compact story changes
spacing only, keeping typography and colors identical. Changes in Controls are local experiments; they do
not edit the source or approve a design decision. Include the story name and
control values when giving feedback.

The component stories show button and text-field states. Docs describes their
props; Actions records button clicks; Accessibility offers manual axe checks.
The dialog story exercises Ark directly, including focus and Escape behavior.
Every example uses fictional data and no backend requests. Do not put credentials
or customer data in stories.

### Connected accounting review

- **Forms → Account hierarchy / Unavailable account**: grouped path search,
  duplicate leaf names, disabled group/archived choices, and explicit replacement.
- **Register → Review**: combine date, account and status filters; remove applied
  filters; inspect any entry without losing the register's page or selection.
  Account links open account context within the inspector and restore focus on return.
- Open a **Draft** entry to edit its reference, save, discard or cancel leaving.
  **Register → Draft save recovery** rejects the first simulated save and accepts a retry.
  Posted entries are read-only. Draft lines and all monetary values remain fixed fixtures.

Saves update in-memory fixture data and history only. Reloading clears them. The
browser-leave warning is best-effort (browser restrictions apply); app routing,
server persistence, authorization and posting are not implemented by these stories.

## Ownership

Reuse Ark's Solid primitives for controls, TanStack Table for interactive register
behavior, and native HTML where it already suffices. Rastrata supplies styling and
thin compositions, not a parallel widget library. Consult [Ark's reference index](https://ark-ui.com/llms.txt) and
check examples against the pinned package version. Custom primitives require a
documented gap; see the completion study's reuse policy.

- `src/`: draft reusable components and provisional CSS variables, explicitly exported.
- `brand/`: the logo's master files, generated from `src/brand` by `bun scripts/generate-brand-assets.ts`.
- `stories/`: examples, review layouts and documentation, never exported to applications.
- `.storybook/`: workshop-only configuration.
- `tests/`: Playwright checks against the static workshop.

Bun remains the package manager and runs the Storybook CLI. The community
`storybook-solidjs-vite` adapter uses Vite internally, isolated to this package's
development dependencies. The application's Bun build is unchanged. Storybook's
own documentation/manager dependencies are not application dependencies.
Telemetry is disabled, the dev server binds to loopback, and Vite environment-file
loading is disabled. The workshop has no public environment configuration.

Production UI source has strict TypeScript checking, including declarations.
The separate workshop TypeScript project skips third-party declaration checking
(including the already-known Ark declaration issue); it still checks all our
stories and configuration. Storybook's adapter owns its documentation extractor;
the repository's TypeScript version is unchanged.

## Verification and review limits

Root `bun run check` includes UI typechecking and tests. Install browser binaries
using `bun run --cwd apps/web test:browser:install` on a fresh checkout.
Tests render every story, verify live Controls, field associations and exact string
preservation, keyboard dialog behavior, and narrow-screen layout. Explicit axe
scans avoid racing the addon over the same iframe; the addon's panel runs manually.
Automated accessibility checks are not screen-reader certification. Nothing is
silently approved.

Run browser tests in one process per checkout (the UI suite reserves port 6007).
Generated output stays under ignored `dist/`. Storybook's large documentation and
testing chunks are workshop tooling, not the customer-facing application bundle.

We will record approved foundations in reader-facing documentation once reviewed.
For now, typography, palette, density and component shapes are deliberately open.

## Working catalog

The workshop contains 49 named stories. All sections are drafts for visual
review, not owner-approved production components.

| Section | What to try |
| --- | --- |
| Foundations | Source-defined colors, type hierarchy, spacing, density, Lucide icons, focus, motion and copy conventions. |
| Forms | Ark choices, currency select, searchable accounts, calendars/ranges, password reveal, plain text and exact-string amount entry. Includes loading, failed, disabled, long-content and RTL fixtures. |
| Feedback | Status, notices, progress, validation recovery, pending/rejected/confirmed/unknown posting outcomes and permission denial. |
| Overlays | Menu, tooltip, popover, nested account selector in a dialog, and safe-first discard confirmation. |
| Navigation | Book switcher, breadcrumbs, section navigation, keyboard tabs and pagination. |
| Register | Search, sort, page selection, pagination, comfortable/compact density, loading, refresh, empty and failed states. |
| Journal and report | Editable row composition, balanced/unbalanced supplied fixtures, posting review, read-only history and expandable trial-balance hierarchy. |

Ark examples are thin compositions, not independently implemented widgets. Reusable
styling is in `src/styles.css`, and the components below are the exported API (see
[Components](#components)). Shared example helpers in `stories/` are deliberately not
exported to the application. Accounting fixtures do not implement money
arithmetic. Editing journal values invalidates supplied totals and disables preview
posting until reload; draft feedback means local preview state only.

The register uses pinned `@tanstack/solid-table@9.2.4`: its row models handle
filtering, sorting and pagination; its selection API uses stable entry IDs, not
row positions. Ark checkboxes and pagination controls bind directly to that state
(Ark pages are one-based; TanStack page indexes are zero-based). Only ID/reference
are searchable; monetary display strings are not converted to numbers or used as
lexical monetary sort keys. No generic table wrapper or parallel state engine is
introduced. See the [Solid guide](https://tanstack.com/table/latest/docs/framework/solid/quick-start).

Client-side row models are appropriate here because stories supply the entire
fixture. Production backend integration must delegate filtering, ordering and
pagination together to the server using TanStack's manual modes, and map the
actual cursor/count contract without inventing page totals. It must not sort a
single fetched page as though it were the whole ledger. That integration is not
implemented by this workshop. Static report/overview tables reuse the native
`rt-table` / `rt-table-scroll` presentation without an unnecessary table engine.

Icons use `lucide-solid@0.577.0` through public per-icon entrypoints. Version 1.47.0
was tested but its declarations referenced unpublished `@lucide/shared/types`,
failing our strict source check. The compatible pin avoids a patch or weakened
typecheck. No icon generator or bespoke SVG set was introduced.

Browser tests exercise every story and critical interactive/open states in three
engines. Two Chromium screenshot baselines cover the register and narrow forms;
update them only after inspecting the difference, using the pinned browser/font:

```sh
bun run build:storybook
cd packages/ui
bun --bun node_modules/@playwright/test/cli.js test tests/visual.spec.ts --project=chromium --update-snapshots
```

Those baselines capture the agent-reviewed draft, not owner approval. Their small
pixel tolerance accommodates rendering differences; verify the first Linux CI
run before treating cross-OS rendering as established. Manual screen-reader
validation and owner design approval remain open. The RTL story checks direction
with English fixture text; it is not a translated product or full locale certification.

## Components

Everything an application needs is exported from `@rastrata/ui`. Ark owns behavior
(focus, dismissal, keyboard, stacking); these components own styling, copy and wiring.

| Area | Components |
| --- | --- |
| Actions | `Button` (variants, sizes, `icon`, `iconOnly`, `pending`), `buttonAttrs()` to style any Ark trigger the same way |
| Fields | `TextField`, `TextArea`, `PasswordField`, `SelectField`, `CheckField`, `CalendarField` (`min`/`max`), `AccountPicker`, `HelpTip` |
| Feedback | `Notice`, `Status`, `Progress`, `ErrorSummary`, `FieldError` |
| Overlays | `Dialog` (center or side sheet, `alertdialog`), `Tooltip`, `HelpTip` |
| Navigation | `Tabs`, `Breadcrumbs`, `Pager` |
| Accounting | `JournalRegister`, `EntryInspector` |
| Localisation | `UiProvider`, `useUi`, `defaultMessages`, `mergeMessages`, `directionOf` |

**Controlled by default.** `value` / `dateValues` follow what you pass, including a later
reset or options that arrive late. Nothing is preselected: `CalendarField` starts empty
(`defaultDateValues` and `focusedDate` are opt-in), and `JournalRegister` opens its date filter
on the month of the newest entry.

**Language and direction.** Wrap the application in `UiProvider locale="…"`. It sets `lang`,
`dir` and Ark's locale (without it Ark forces left-to-right inside popups and dialogs), and it
accepts partial `messages` overrides, so every string the components own can be translated
without forking. Data values (references, account names, dates, amounts) are isolated with
`<bdi>` so Arabic, Latin and digits never reorder each other; arrows and edges flip with the
page. Interface copy ships in English only; no translation is claimed.

**Keyboard accelerators** (off with `shortcuts={false}`, and never active while typing or inside
a dialog): `/` focuses register search; `Ctrl/Cmd+S` saves a draft in the inspector.

### The ten usability heuristics

The [Nielsen Norman Group heuristics](https://www.nngroup.com/articles/ten-usability-heuristics/)
are the review lens for these components. Where the interface acts on one, it is tested.

| Heuristic | What the components do |
| --- | --- |
| Visibility of system status | `Button` `pending` (busy, same position, no layout shift); the register announces "Showing 1 to 4 of 6 entries. Page 1 of 2." to screen readers on every filter, sort or page change; save status is always visible and never claims a result it does not know |
| Match with the real world | Plain-language copy in one catalogue (`messages.ts`); date hints follow the locale's real order |
| User control and freedom | Revert to saved; Esc closes the nearest layer first; every filter has a visible remove; leaving with unsaved work asks, with the safe choice focused |
| Consistency and standards | One `Button` and one set of field components; `buttonAttrs()` for Ark triggers; one error pattern; `/` for search |
| Error prevention | Pending buttons ignore clicks (no double submit); `min`/`max` dates; archived and group accounts explain why they cannot be chosen; unknown save outcomes block a blind retry |
| Recognition over recall | The selected account's path stays visible; applied filters are chips; selection counts say how many are off-screen |
| Flexibility and efficiency | Keyboard accelerators above, hidden until needed |
| Aesthetic and minimalist design | Confirmation is quiet; only exceptions (review, error) use color and weight |
| Recognize, diagnose, recover | `FieldError` (icon, "Error:" prefix and text, never colour alone); `ErrorSummary` takes focus and links to each field; validation waits until the field is left |
| Help and documentation | `HelpTip` explains in context, works on touch and keyboard, and holds real instructions (a tooltip never does) |

## Color code 02 proposal

Five master colors, chosen from three graphic-design systems. The source supplies
the exact shade; our interpretation supplies its place in Rastrata. This replaces
the earlier invented paper/ink palette rather than attaching new stories to it.

| Master | Published value | Source and reason for choosing it |
| --- | --- | --- |
| White | `#FFFFFF` | [SBB color tokens](https://digital.sbb.ch/en/design-system/lyne/design-tokens/color/): the open field of clear public information. |
| Black | `#000000` | [SBB color tokens](https://digital.sbb.ch/en/design-system/lyne/design-tokens/color/): figures with the conviction of a printed timetable. |
| Penguin orange | `#FF6600` | [Penguin Random House UK](https://www.linkedin.com/posts/penguin-random-house-uk_ff6600-brand-brandheritage-activity-7386706318688043008-i5sa): quality made accessible, as Penguin did with affordable books. |
| NASA blue | `#0B3D91` | [Archived NASA Web Design System](https://nasa.github.io/nasawds-site/components/colors/), `color-primary-darker`: ambition supported by careful engineering. |
| Railway red | `#EB0000` | [SBB color tokens](https://digital.sbb.ch/en/design-system/lyne/design-tokens/color/): a consequential interruption in black and white. |

These are published digital specifications, not measurements of historical paint,
Apollo hardware, or the ink on a 1935 Penguin paperback. The emotional associations
are our design judgments, not claims made by those organizations. No endorsement
is implied and no logos are reproduced. Penguin's [company history](https://www.penguin.co.uk/about/company-timeline)
documents the affordable-book premise. The method takes inspiration from the
[published companion to Tom Sachs's COLOR](https://tomsachsarchive.org/posts/2016-08-11-bdc-color/):
choose particular colors for particular reasons and make the specification repeatable.

Inter, 2px control corners, journal rules and double-ruled totals remain.
The journal demonstrates three fictional balanced entries. Its figures are display
strings, not a second accounting implementation. The entry form only updates local
preview state; it does not persist or call a backend.

Color roles and interaction states live in `src/styles.css`. Each master has one job.
Black is figures and primary actions. Orange is rationed to "needs a human": review,
pending changes and decisions, always with black text. NASA blue is "where you are":
links, focus, selection and sort. Red is consequence only: errors, with a warning icon
so hue is never the only cue. White is the page. Green and amber are removed:
reconciliation uses a word and a checkmark, not automatic green. Normal amounts and
negative figures remain neutral. Orange is not used for text on a light page or behind
white text. Light divider lines are decorative, not control boundaries.

Supporting tones are explicit sRGB mixtures of the five masters, not additional
historical claims: in the light theme muted text is 64% black / 36% white; borders
88% / 12%; dividers 16% / 84%; selection 10% NASA blue / 90% white. Interaction
mixtures are specified beside these tokens. The source colors are fixed in this
study's Controls.

## Themes

Light is the default and the reference for visual baselines. Dark is a full peer theme
built from the same tokens through `light-dark()`: neutrals swap through `--rt-ink` and
`--rt-paper`, and NASA blue and railway red lighten as mixtures of the masters so they
stay legible on a dark page (a plain NASA blue is only 1.9:1 on near-black). Use
`--rt-black` and `--rt-white` only for text on a fixed master field, such as black on
orange. Apps opt in with `data-theme="dark"` on the root element, or `data-theme="system"`
to follow the operating system; without it the stylesheet stays light. In Storybook use
the toolbar, the page's own "Dark theme" switch, or `?globals=theme:dark`. Every story is
scanned with axe in both themes, and the palette contrast checks run in both.

Inter is bundled locally through pinned `@fontsource-variable/inter`, with weight and
optical-size axes and on-demand Unicode subsets. No font CDN is used. Its OFL license
and copyright notice ship in `public/licenses/inter.txt` and the static Storybook
output. Applications adopting the UI stylesheet must also distribute that notice.
Browser checks verify actual font loading, equal-width tabular digits, license
delivery, exact master colors, resolved-palette contrast pairs and local form
feedback. These checks do not replace human review.

Figures, small capital labels and the endings of accounts are set in JetBrains Mono, bundled the same way
through pinned `@fontsource-variable/jetbrains-mono`; its OFL license ships in
`public/licenses/jetbrains-mono.txt` and is served beside Inter's.
