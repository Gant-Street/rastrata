import { describe, expect, test } from "bun:test";
import { directionOf } from "../src/direction";
import { defaultMessages, mergeMessages } from "../src/messages";

describe("directionOf", () => {
  test("knows right-to-left languages, with or without a region", () => {
    for (const locale of ["ar", "ar-EG", "he-IL", "fa", "ur-PK"])
      expect(directionOf(locale)).toBe("rtl");
  });
  test("treats everything else as left-to-right, including bad input", () => {
    for (const locale of ["en-US", "de", "ja-JP", "pt-BR", "not a locale"])
      expect(directionOf(locale)).toBe("ltr");
  });
});

describe("mergeMessages", () => {
  test("a partial translation falls back to English key by key", () => {
    const merged = mergeMessages({
      pager: { next: "Suivant" },
      register: { newEntry: "Nouvelle écriture" },
    });
    expect(merged.pager.next).toBe("Suivant");
    expect(merged.pager.previous).toBe(defaultMessages.pager.previous);
    expect(merged.register.newEntry).toBe("Nouvelle écriture");
    expect(merged.register.searchLabel).toBe(defaultMessages.register.searchLabel);
  });
  test("function messages can be replaced and still receive their arguments", () => {
    const merged = mergeMessages({ pager: { position: (page, pages) => `${page}/${pages}` } });
    expect(merged.pager.position(2, 5)).toBe("2/5");
  });
  test("overrides never mutate the defaults", () => {
    mergeMessages({ pager: { next: "Next page, please" } });
    expect(defaultMessages.pager.next).toBe("Next page");
  });
});

describe("date format hint", () => {
  test("follows the order the locale writes dates", () => {
    expect(defaultMessages.date.format("en-US")).toStartWith("Month/day/year");
    expect(defaultMessages.date.format("de-DE")).toStartWith("Day.month.year");
    expect(defaultMessages.date.format("ja-JP")).toStartWith("Year/month/day");
  });
  test("always says dates carry no time zone", () => {
    expect(defaultMessages.date.format("en-US")).toContain("no time zone conversion");
  });
});
