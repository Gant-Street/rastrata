export type Direction = "ltr" | "rtl";

const rtlLanguages = new Set(["ar", "he", "fa", "ur", "ps", "sd", "ug", "yi", "dv", "ckb"]);

/** Text direction for a BCP 47 locale. Uses the platform when it knows, else a language list. */
export function directionOf(locale: string): Direction {
  try {
    const parsed = new Intl.Locale(locale) as Intl.Locale & {
      getTextInfo?: () => { direction: Direction };
      textInfo?: { direction: Direction };
    };
    const info = parsed.getTextInfo?.() ?? parsed.textInfo;
    if (info?.direction) return info.direction;
    return rtlLanguages.has(parsed.language) ? "rtl" : "ltr";
  } catch {
    return rtlLanguages.has(locale.split("-")[0]?.toLowerCase() ?? "") ? "rtl" : "ltr";
  }
}
