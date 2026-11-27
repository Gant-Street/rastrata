/** The typeface files that some text needs, before it is drawn. The faces of the scripts that are not Latin (Latin extended, Vietnamese, Cyrillic, Greek) are files the browser fetches the first
 * time a character in their range is shown (fonts-lazy.ts), and a character that is shown before its file has come is drawn in another face and changes when it does. The text of the header and the
 * footer, a business named "Dvořák" or "Phở", is known before the page is drawn, and the header is to be whole in the first draw (the founder's ruling against anything that pops in): so the page
 * asks for the files that text needs and waits for them, for a moment at most, before it draws. Text in the Latin face that is in the style sheet, which is nearly all of it, needs no wait. */
const FAMILIES = ['"Inter Variable"', '"JetBrains Mono Variable"'];
// The ranges of the Latin face that is in the style sheet (fonts.css): Basic Latin, Latin-1, general punctuation and a few signs.
const IN_THE_STYLE_SHEET: readonly (readonly [number, number])[] = [
  [0x0000, 0x00ff],
  [0x0131, 0x0131],
  [0x0152, 0x0153],
  [0x02bb, 0x02bc],
  [0x02c6, 0x02c6],
  [0x02da, 0x02da],
  [0x02dc, 0x02dc],
  [0x0304, 0x0304],
  [0x0308, 0x0308],
  [0x0329, 0x0329],
  [0x2000, 0x206f],
  [0x20ac, 0x20ac],
  [0x2122, 0x2122],
  [0x2191, 0x2191],
  [0x2193, 0x2193],
  [0x2212, 0x2212],
  [0x2215, 0x2215],
  [0xfeff, 0xfeff],
  [0xfffd, 0xfffd],
];

/** Whether every character of `text` is in the Latin face that is in the style sheet. */
const needsNoFile = (text: string): boolean => {
  for (const character of text) {
    const code = character.codePointAt(0) ?? 0;
    if (!IN_THE_STYLE_SHEET.some(([from, to]) => code >= from && code <= to)) return false;
  }
  return true;
};

/** Have the files for `text` in the page's typefaces, waiting at most `within` milliseconds. Never rejects, and never waits for text that needs nothing. */
export function fontsFor(text: string, within = 300): Promise<void> {
  if (needsNoFile(text) || typeof document === "undefined" || !document.fonts?.load)
    return Promise.resolve();
  const loaded = Promise.all(
    FAMILIES.map((family) => document.fonts.load(`1em ${family}`, text).catch(() => [])),
  ).then(() => undefined);
  return new Promise<void>((resolve) => {
    const timer = setTimeout(resolve, within);
    void loaded.then(() => {
      clearTimeout(timer);
      resolve();
    });
  });
}
