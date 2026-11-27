# The design language

For anyone adding to the application, the design workshop or the public site. This explains
why Rastrata looks the way it does, so new work extends the system instead of drifting from it.
The exact tokens and components are in the [UI package guide](../../packages/ui/README.md).

## One anchor

Every surface is derived from one resolved idea: **the ruled ledger**. A heavy rule above, hairlines
between lines, a double rule under the total, and a figure that states what the page exists to
state. If a new screen has no equivalent of the total (the thing it is *for*), find it and make it
the biggest thing on the page.

The anchor came first and the rest followed from it, which is the lesson worth keeping from
[how Railcode built its site](https://railcode.dev/blog/vibe-coded-website): pick one detail,
resolve it completely, then let it decide the palette, the transitions and the footer. We also
explored three hero directions side by side before choosing (a condensed-type poster, the ledger
as the hero, and a wall of color). The ledger won because it is specific to what the product does;
the wall of color survived as a section.

## Five colors, each with a job

| Color | Job | Use it for | Never |
| --- | --- | --- | --- |
| Black (ink) | Figures and actions | Text, rules, primary buttons, totals | Decoration |
| Orange | Needs a human | Review, pending changes, a decision (the posting review, the dialog bar) | Hover states, accents, text on a light page (2.9:1) |
| Blue | Where you are | Links, focus, selection, the active tab, sort | Body text on a dark page (use the lightened mixture) |
| Red | Consequence | Errors and things that cannot be undone | Anything that is merely important |
| White (paper) | The page | Surfaces; in dark, a near-black paper | Pure black as the dark page (it smears figures) |

The one exception is the public site, where orange is a brand surface rather than an interface
color: the homepage's first screen, and the closing band that ends every page. It never appears
inside the product as decoration. The logo is never orange: it is ink or paper (black on orange), and orange
appears only as the field behind it, in the favicon and the app icon.

Color is never the only carrier of meaning. Every status has words; every error has an icon and
an "Error:" prefix; selection has a checkbox as well as a tint. The product has no green and no
amber, deliberately: "reconciled" is a word and a check mark, not a traffic light.

## Type

Words are **Inter**, set tight (negative tracking grows as the size grows) with heavy weights for
headings. Labels are a small monospace in capitals with wide tracking, like a label-maker tape.
Figures are tabular and lining everywhere. On the public site, display figures are **Archivo**, a
condensed grotesque, like a printed timetable; the product keeps Inter so a dense table stays calm.

## The logo

The logo is the word *rastrata*, lowercase, drawn in whole cells, the way the books are kept in whole
cents. It is one shape in one color: ink on paper and paper on ink in the product (it takes the text
color, so it follows the theme), black on the homepage's orange. It is never recolored.

**One unit.** A stroke is three cells. The gap inside a letter and the space between letters are two
(one after the *r*, which is open below its arm). The x-height is thirteen cells and the *t* rises four
more, so the word is 80 cells wide and 17 tall, five times as wide as it is tall. Every edge lies on a
cell boundary: nothing is drawn by eye, so nothing is argued by eye. The pixel face is drawn on the same
cell, so the logo and the whimsy are made of one thing.

**Forms.**

- **Wordmark**, the name. The default.
- **Plate**, the name between the ledger's rules: a heavy rule above (one stroke thick), a double rule below
  (a cell each), three cells of air. It signs a page, such as a statement or a card. Below 20 px tall it
  drops the rules.
- **Stacked**, *rast* over *rata*. Both rows are 39 cells wide, so the name is a block, for places that are
  square.
- **Corner**, the *r*'s stem and arm squared up, for places too small for the word.
- **Tile**, the corner on a square sixteen cells across, for a favicon or an app icon. At 16, 32, 48 and 64 px
  a cell is a whole number of pixels, so nothing blurs. Orange is the default; ink and paper exist for the
  surfaces that need them.

**Rules.**

- Lowercase in the logo, always. In a sentence the name is "Rastrata".
- One color, and never orange. The logo is ink or paper, or black on orange. Do not outline it, shadow it,
  stretch it, tilt it, or set it on a color it cannot be read on.
- Six cells (two strokes) clear on every side.
- No smaller than 17 px tall, where a cell is one pixel. Whole multiples of 17 (17, 34, 51) keep every edge
  on a pixel.
- The face is not the logo. It is a character that appears when the books balance, and only then.

**Where it lives.** The geometry is `packages/ui/src/brand/logo-geometry.ts`, and `Logo` draws it in the
application and the workshop. The master files (black and white SVGs, the tiles) are in `packages/ui/brand/`;
the public site and the web application cannot import the package for a favicon, so each carries its own
copy of what it needs (the site's wordmark is the component `apps/marketing/src/components/Logo.astro`).
`bun scripts/generate-brand-assets.ts` writes all of them, and a unit test fails when one has drifted. Review it in the workshop under **Foundations → Logo**.

## Figures and dates

One formatter (`packages/ui/src/format.ts`) sets every figure and date, so a number reads the same on
every screen. Money is grouped in threes with two decimals and a real minus sign (`−1,234.50`, never a
hyphen or parentheses), in tabular figures that never wrap, right-aligned in a table. A date is
written the way a person writes it, `Oct 4, 2026` (the year-month-day form, `2026-10-04`, stays in the
value, the exports, the command line, the API and every tooltip); an instant is on the viewer's own clock,
`Oct 4, 2026, 1:01 PM`; a whole month is a name (`September 2026`). A test fails when a screen formats its
own.

## Rules, not boxes

Structure comes from rules and space, not from nested rounded cards. A section is a heavy rule
and a title. A card (used rarely, for the one thing that needs lifting) is a 1.5px ink border with
a hard offset shadow, like a card on a bench. There is no blur, no radius and no gradient.

## Light, dark and system

Light is the default for the workshop; the application follows the system unless the person
chooses, and remembers the choice; the public site follows the system and has no switch because a
switch would need JavaScript. Neutrals are `ink` and `paper` and swap; the five masters do not.
Blue and red lighten in dark as *mixtures* of the masters, never as a sixth color.

## The public site

The site speaks the same language, written independently of the application (it cannot import the
design system): ink on paper, hard rules, flat color with a job, no radius, blur or gradient. It adds a
poster voice, and uses it sparingly.

- **Two voices.** Statements are set in Archivo, a condensed grotesque, in capitals: the tagline, the
  three words under it, the three lines, the closing line, the page titles. Everything that is explained
  is Inter, sentence case, in the product's weights. Labels are a monospace in capitals, and the pixel
  details are Silkscreen, the pixel face of the logo's cells.
- **Orange opens and closes the page.** The first screen and the closing band are black type on the
  orange of the logo's tile and the social cards; they keep their own palette on every theme. Between
  them the page is paper and ink.
- **The product in a frame.** Every picture of the application sits in a frame with a hard shadow and
  nothing around it: no bar, no address (the pictures were taken from the application running on the maker's
  computer, and a host drawn in would say where they were not taken) and no tag (the founder, 2026-10-17:
  "don't add this around the video"). The picture keeps its palette on every theme, like a photograph.
  Nothing on the site is drawn to look like the product.
- **The footer is the logo and its links.** No disclaimer under them: the terms already say what the service
  is not (section 7) (the founder, 2026-10-18: "There's no reason for that disclaimer in the footer. We already
  have terms/privacy."). A line of fine print has to be argued for in `tests/site.spec.ts` before it comes back.
- **The comparison is one table in ink and rules.** Heavy rules between its groups, light rules between its rows,
  small capitals in the monospace for the groups and the column heads, and Rastrata's column in orange from its head
  down (a tint under the rows). A cell says its state in a word, with a pixel mark drawn on the tick's grid (a tick,
  a cross, half a box, a plus) and shown at a whole number of pixels so that it stays sharp; colour and marks are
  never all there is. It is as wide as the recording, and it is the page's only table.
- **Whimsy that sits on a fact**, as everywhere: the double rule under "boring" is the double rule an
  accountant draws under a total, and the footer ends on a total of 0.00. If a flourish cannot be tied to
  such a fact, and understood at a glance, cut it. (A pixel face that "appears when the books balance"
  was cut on 2026-10-16: it explained nothing, and the founder asked what it was.)
- **Motion.** One thing moves: the recording in the home page's frame, a silent loop of about twenty-five seconds with no
  player around it (the founder's direction, 2026-10-17), with no words over it: the AI on the left and the books on the right, which the headline names. It starts by itself, plays over and over, and sits in its
  frame and never over the page; a visitor whose system asks for less motion is sent no file and sees one picture
  of it. Nothing else moves: no animation, no motion on scroll, nothing that plays over the page. (An earlier film
  that covered the whole screen was judged nauseating and removed on 2026-10-09.)
- **Restraint.** The site says one thing, once ([the rule](../reference/marketing-site-v1-plan.md#the-rule-one-thing-said-once)).
  The design is the same on a phone and on a desk because there is so little of it.

The plan, the claims ledger and the quality bars are in
[the public site](../reference/marketing-site-v1-plan.md).

## Things that look fine and are wrong

- A hover color of orange. Hover is ink; orange means a person must look.
- A tint made with `color-mix()` from a theme variable. The web app's CSS pipeline collapses it to
  black (see [Shared color tints](../how-to/develop-repository.md#shared-color-tints-and-the-web-apps-css-pipeline)).
- Checking only Storybook. The application and the site are built by different pipelines; test the
  resolved values where they ship.
- A claim the product cannot support. The site says only what
  [the claims ledger](../reference/marketing-site-v1-plan.md#claims-ledger) can back, and labels every picture
  of the application as the sample book. Change the words before the product's behaviour stops matching.

## How to add a screen

1. Name the figure the screen exists to state, and make it the largest thing on the page.
2. Build from the shared components and tokens. If one is missing, add it to the UI package,
   with a story, before using it twice.
3. Give every color a job from the table above, and a non-color cue to go with it.
4. Check light, dark, a 390px phone and the keyboard. The browser suites scan every real page
   with axe in both themes; add the new page to the sweep.
5. Read it aloud as a bookkeeper would. If a label needs explaining, the label is wrong.
