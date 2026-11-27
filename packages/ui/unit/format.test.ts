import { describe, expect, test } from "bun:test";
import {
  centsToMoney,
  DATE_FORMATS,
  dateFormat,
  dateInputOrder,
  daysBetween,
  daysInMonth,
  firstOfMonth,
  formatAge,
  formatBytes,
  formatCount,
  formatDate,
  formatDateRange,
  formatDuration,
  formatInstant,
  formatMoney,
  formatMoneyAbsolute,
  formatFiguresInText,
  formatMonth,
  formatMonthShort,
  formatPercent,
  formatShare,
  formatTime,
  formatWeekdayDate,
  inAppWords,
  isDate,
  isInstant,
  isNegativeMoney,
  isNegativeShare,
  isZeroMoney,
  localToday,
  MINUS_SIGN,
  monthName,
  moneyDifference,
  moneySum,
  moneyToCents,
  onDateFormatChange,
  parseDate,
  parseMoney,
  parseShare,
  setDateFormat,
  transactionsIn,
} from "../src/format";

describe("money", () => {
  test("digits are grouped in threes and there are always two decimals", () => {
    expect(formatMoney("0.00")).toBe("0.00");
    expect(formatMoney("5.07")).toBe("5.07");
    expect(formatMoney("999.99")).toBe("999.99");
    expect(formatMoney("1000.00")).toBe("1,000.00");
    expect(formatMoney("1190.00")).toBe("1,190.00");
    expect(formatMoney("36314.18")).toBe("36,314.18");
    expect(formatMoney("1234567.89")).toBe("1,234,567.89");
  });

  test("a negative figure has a real minus sign, never a hyphen or parentheses", () => {
    expect(MINUS_SIGN).toBe("−");
    expect(formatMoney("-0.01")).toBe("−0.01");
    expect(formatMoney("-12000.00")).toBe("−12,000.00");
    expect(formatMoney("-1234567.89")).toBe("−1,234,567.89");
    for (const value of ["-0.01", "-1.00", "-1500.00", "-999999.99"]) {
      expect(formatMoney(value)).not.toContain("-");
      expect(formatMoney(value)).not.toContain("(");
    }
  });

  test("zero is never negative, however it was written", () => {
    expect(formatMoney("-0.00")).toBe("0.00");
    expect(isNegativeMoney("-0.00")).toBe(false);
    expect(isNegativeMoney("0.00")).toBe(false);
    expect(isNegativeMoney("-0.01")).toBe(true);
    expect(isNegativeMoney("12.00")).toBe(false);
    expect(isZeroMoney("0.00")).toBe(true);
    expect(isZeroMoney("-0.00")).toBe(true);
    expect(isZeroMoney("0.01")).toBe(false);
    expect(isZeroMoney("")).toBe(false);
  });

  test("a figure past fifteen digits is shown exactly, never rounded through a number", () => {
    expect(formatMoney("1000000000000000.01")).toBe("1,000,000,000,000,000.01");
    expect(formatMoney("9007199254740993.99")).toBe("9,007,199,254,740,993.99");
    expect(formatMoney("-12345678901234567890.12")).toBe("−12,345,678,901,234,567,890.12");
    // The number nearest 9007199254740993 is 9007199254740992: a float would have lost the last digit.
    expect(Number("9007199254740993")).toBe(9007199254740992);
  });

  test("the locale decides the separators, and a malformed locale falls back to US English", () => {
    expect(formatMoney("1234567.89", "de-DE")).toBe("1.234.567,89");
    expect(formatMoney("1234.50", "en-GB")).toBe("1,234.50");
    expect(formatMoney("-1234.05", "de-DE")).toBe("−1.234,05");
    expect(formatMoney("1234.50", "not a locale")).toBe("1,234.50");
  });

  test("text that is not a wire amount is returned as it is, never guessed", () => {
    for (const text of [
      "",
      "abc",
      "12",
      "12.3",
      "12.345",
      "1,000.00",
      "+5.00",
      "--1.00",
      "01.00",
      "—",
      "12.",
    ])
      expect(formatMoney(text), JSON.stringify(text)).toBe(text);
    expect(parseMoney("12.3")).toBeNull();
    expect(parseMoney("-7.10")).toEqual({ negative: true, whole: "7", cents: "10" });
    expect(parseMoney("-0.00")).toEqual({ negative: false, whole: "0", cents: "00" });
  });

  test("the figure without its sign is for a column that already says which way the money went", () => {
    expect(formatMoneyAbsolute("-1150.00")).toBe("1,150.00");
    expect(formatMoneyAbsolute("1150.00")).toBe("1,150.00");
    expect(formatMoneyAbsolute("nope")).toBe("nope");
  });

  test("the amounts in a sentence the service wrote are shown like every other figure", () => {
    expect(
      formatFiguresInText("Income 52412.00, expenses 13008.99, net income 39403.01 USD."),
    ).toBe("Income 52,412.00, expenses 13,008.99, net income 39,403.01 USD.");
    expect(formatFiguresInText("Debits are 1250.00 and credits are -1200.50 USD.")).toBe(
      `Debits are 1,250.00 and credits are ${MINUS_SIGN}1,200.50 USD.`,
    );
    // A full stop after an amount ends the sentence; it is not a decimal point.
    expect(formatFiguresInText("The difference is 12500.00.")).toBe("The difference is 12,500.00.");
    expect(formatFiguresInText("It holds 0.00 (debits less credits)")).toBe(
      "It holds 0.00 (debits less credits)",
    );
    expect(formatFiguresInText("Imported as 2026-01-05 -10.00, now 2026-01-06 -10.00")).toBe(
      `Imported as Jan 5, 2026 ${MINUS_SIGN}10.00, now Jan 6, 2026 ${MINUS_SIGN}10.00`,
    );
  });

  test("an instant in a sentence the service wrote is shown as every other instant is, on the viewer's clock", () => {
    inZone("UTC", () => {
      expect(
        formatFiguresInText(
          "Stripe's balance was last compared at 2026-10-04T18:57:24.887Z. Sync again.",
        ),
      ).toBe("Stripe's balance was last compared at Oct 4, 2026, 6:57 PM. Sync again.");
      expect(formatFiguresInText("From 2026-01-05T09:30:00Z to 2026-01-05T10:00:00+00:00")).toBe(
        "From Jan 5, 2026, 9:30 AM to Jan 5, 2026, 10:00 AM",
      );
      // An instant, a date and an amount in one sentence; a made-up instant is left as it is.
      expect(formatFiguresInText("On 2026-10-04 it held 1250.00 at 2026-10-04T07:50:12Z")).toBe(
        "On Oct 4, 2026 it held 1,250.00 at Oct 4, 2026, 7:50 AM",
      );
      expect(formatFiguresInText("id 2026-10-04T99:99:99Z")).toBe("id 2026-10-04T99:99:99Z");
    });
    // The same sentence on a clock in Denver (UTC-6 in October).
    inZone("America/Denver", () => {
      expect(formatFiguresInText("compared at 2026-10-05T03:30:00Z")).toBe(
        "compared at Oct 4, 2026, 9:30 PM",
      );
    });
  });

  test("a calendar day in a sentence the service wrote is shown as every other date is", () => {
    expect(formatFiguresInText("Fiscal year 2026-10-04 to 2027-09-30")).toBe(
      "Fiscal year Oct 4, 2026 to Sep 30, 2027",
    );
    expect(formatFiguresInText("The oldest is dated 2026-11-05.")).toBe(
      "The oldest is dated Nov 5, 2026.",
    );
    expect(formatFiguresInText("(2026-01-01 to 2026-01-31)")).toBe("(Jan 1, 2026 to Jan 31, 2026)");
    // Only a real calendar day is a date, and a name or an id that holds one is not a date.
    for (const text of [
      "Not a day: 2026-02-30 and 2026-13-01",
      "A file profit-loss-2025-10-01-to-2026-06-15.csv",
      "An id ingest-stripe-2026-10-04 and period-2026-10",
      "A journal source_2026-10-04",
      "Already written: Oct 4, 2026",
    ])
      expect(formatFiguresInText(text)).toBe(text);
  });

  test("only a complete amount in a sentence is touched: versions, ids and grouped figures are not", () => {
    for (const text of [
      "Version 1.2.50.00 of the file",
      "Read from txn_1Fixture00001250.00",
      "Already grouped: 12,500.00 and −3.50",
      "Three places is not an amount: 12.505",
      "A hash 0123456789abcdef0123456789abcdef and a number 12500 with no decimals",
      "net-50.00 is part of a word",
    ])
      expect(formatFiguresInText(text)).toBe(text);
  });

  test("showing a figure and reading it back loses nothing", () => {
    let cents = 1n;
    for (let step = 0; step < 60; step++) {
      for (const value of [cents, -cents]) {
        const wire = centsToMoney(value);
        const shown = formatMoney(wire);
        expect(shown.replace(MINUS_SIGN, "-").replaceAll(",", ""), wire).toBe(wire);
      }
      cents = cents * 3n + 7n;
    }
  });

  test("cents round trip, with zero never negative", () => {
    for (const value of [
      "0.00",
      "0.01",
      "-0.01",
      "12.34",
      "-12.34",
      "1000000000000000.01",
      "-9007199254740993.99",
    ])
      expect(centsToMoney(moneyToCents(value)), value).toBe(value);
    expect(centsToMoney(0n)).toBe("0.00");
    expect(() => moneyToCents("12.3")).toThrow(TypeError);
    expect(() => moneyToCents("")).toThrow(TypeError);
  });

  test("a difference and a sum are exact at any size", () => {
    expect(moneyDifference("6800.00", ["80.00", "6720.00"])).toBe("0.00");
    expect(moneyDifference("100.00", ["33.33", "33.33", "33.33"])).toBe("0.01");
    expect(moneyDifference("0.10", ["0.20"])).toBe("-0.10");
    expect(moneyDifference("0.30", ["0.10", "0.20"])).toBe("0.00");
    expect(moneyDifference("5.00", [])).toBe("5.00");
    expect(moneySum(["0.10", "0.20"])).toBe("0.30");
    expect(moneySum([])).toBe("0.00");
    expect(moneySum(["9007199254740992.00", "1.00"])).toBe("9007199254740993.00");
  });
});

describe("a share of income", () => {
  test("is a percentage with one decimal, grouped like an amount, and never turned into a number", () => {
    expect(formatShare("30.2")).toBe("30.2%");
    expect(formatShare("100.0")).toBe("100.0%");
    expect(formatShare("0.0")).toBe("0.0%");
    expect(formatShare("1294.0")).toBe("1,294.0%");
    expect(formatShare("12345678901234567890123.4")).toBe("12,345,678,901,234,567,890,123.4%");
  });

  test("a negative share has a real minus sign, and nothing that rounds to zero has a sign", () => {
    expect(formatShare("-29.4")).toBe(`${MINUS_SIGN}29.4%`);
    expect(formatShare("-1294.5")).toBe(`${MINUS_SIGN}1,294.5%`);
    expect(formatShare("-0.0")).toBe("0.0%");
    expect(isNegativeShare("-29.4")).toBe(true);
    expect(isNegativeShare("-0.0")).toBe(false);
    expect(isNegativeShare("0.0")).toBe(false);
    expect(isNegativeShare("30.2")).toBe(false);
    expect(isNegativeShare("")).toBe(false);
    expect(formatShare("-29.4")).not.toContain("-");
  });

  test("follows the locale's separators and falls back to US English for a locale that is no locale", () => {
    expect(formatShare("1294.5", "de-DE")).toBe("1.294,5%");
    expect(formatShare("-29.4", "de-DE")).toBe(`${MINUS_SIGN}29,4%`);
    expect(formatShare("30.2", "not a locale")).toBe("30.2%");
  });

  test("writes every digit in the locale's own digits, as an amount does", () => {
    const digits = new Intl.NumberFormat("ar", { useGrouping: false });
    const point = new Intl.NumberFormat("ar")
      .formatToParts(1.1)
      .find((part) => part.type === "decimal");
    expect(formatShare("30.2", "ar")).toBe(
      `${digits.format(30)}${point?.value}${digits.format(2)}%`,
    );
    // The cents of an amount are written the same way, so a share and an amount agree on their digits.
    expect(formatMoney("30.20", "ar")).toBe(
      `${digits.format(30)}${point?.value}${digits.format(20)}`,
    );
  });

  test("text that is not a share is returned as it came", () => {
    for (const text of ["", "—", "30", "30.25", "30,2", "+30.2", "30.2%", "abc", "1e3", " 30.2"]) {
      expect(parseShare(text), text).toBeNull();
      expect(formatShare(text), text).toBe(text);
    }
    expect(parseShare("-29.4")).toEqual({ negative: true, whole: "29", tenth: "4" });
    expect(parseShare("007.0")).toBeNull();
  });
});

describe("the date format a person chose", () => {
  test("three formats are written from one date, and each can be asked for by name", () => {
    expect(DATE_FORMATS).toEqual(["medium", "numeric", "iso"]);
    expect(formatDate("2026-03-20", { format: "medium" })).toBe("Mar 20, 2026");
    expect(formatDate("2026-03-20", { format: "numeric" })).toBe("03/20/2026");
    expect(formatDate("2026-03-20", { format: "iso" })).toBe("2026-03-20");
    expect(formatDate("2026-10-04", { format: "numeric" })).toBe("10/04/2026");
    const noon = "2026-03-20T12:00:00Z";
    expect(formatInstant(noon, { timeZone: "UTC", format: "numeric" })).toBe(
      "03/20/2026, 12:00 PM",
    );
    expect(formatInstant(noon, { timeZone: "UTC", format: "iso" })).toBe("2026-03-20, 12:00 PM");
    expect(formatDate("2026-10-05T03:30:00Z", { timeZone: "America/Denver", format: "iso" })).toBe(
      "2026-10-04",
    );
    expect(formatWeekdayDate("2026-10-04", { format: "numeric" })).toBe("Sunday, 10/04/2026");
    // A range outside the medium form is written in full, and a single day is that day.
    expect(formatDateRange("2026-01-01", "2026-10-04", { format: "numeric" })).toBe(
      "01/01/2026 to 10/04/2026",
    );
    expect(formatDateRange("2026-01-01", "2026-10-04", { format: "iso" })).toBe(
      "2026-01-01 to 2026-10-04",
    );
    expect(formatDateRange("2026-06-30", "2026-06-30", { format: "iso" })).toBe("2026-06-30");
    expect(formatDateRange("nope", "2026-06-30", { format: "iso" })).toBe("nope to 2026-06-30");
  });

  test("the book's choice reaches every date the formatter writes, and the default is the medium form", () => {
    expect(dateFormat()).toBe("medium");
    try {
      setDateFormat("iso");
      expect(dateFormat()).toBe("iso");
      expect(formatDate("2026-03-20")).toBe("2026-03-20");
      expect(formatDateRange("2026-01-01", "2026-10-04")).toBe("2026-01-01 to 2026-10-04");
      expect(formatWeekdayDate("2026-10-04")).toBe("Sunday, 2026-10-04");
      inZone("UTC", () => {
        expect(formatInstant("2026-03-20T12:00:00Z")).toBe("2026-03-20, 12:00 PM");
        expect(formatDate("2026-03-20T23:30:00Z")).toBe("2026-03-20");
      });
      setDateFormat("numeric");
      expect(formatDate("2026-03-20")).toBe("03/20/2026");
      inZone("UTC", () => {
        expect(formatFiguresInText("posted 2026-03-20 at 2026-03-20T12:00:00Z")).toBe(
          "posted 03/20/2026 at 03/20/2026, 12:00 PM",
        );
      });
      // A format named for one call wins over the book's, so a form can show an example of each.
      expect(formatDate("2026-03-20", { format: "medium" })).toBe("Mar 20, 2026");
      // The stored form and the month on its own are not dates a person chose a format for.
      expect(formatMonth("2026-09")).toBe("September 2026");
      expect(formatDate(formatDate("2026-03-20", { format: "medium" }))).toBe("Mar 20, 2026");
    } finally {
      setDateFormat("medium");
    }
    expect(formatDate("2026-03-20")).toBe("Mar 20, 2026");
  });

  test("a component is told once when the format changes, and stops when it says so", () => {
    const told: string[] = [];
    const stop = onDateFormatChange(() => told.push(dateFormat()));
    try {
      setDateFormat("iso");
      setDateFormat("iso");
      setDateFormat("numeric");
      expect(told).toEqual(["iso", "numeric"]);
      stop();
      setDateFormat("medium");
      expect(told).toEqual(["iso", "numeric"]);
    } finally {
      stop();
      setDateFormat("medium");
    }
  });

  test("a format that is not one of the three is ignored", () => {
    try {
      setDateFormat("long" as never);
      expect(dateFormat()).toBe("medium");
      setDateFormat("iso");
      setDateFormat("" as never);
      expect(dateFormat()).toBe("iso");
    } finally {
      setDateFormat("medium");
    }
  });
});

describe("counts, percentages, sizes and durations", () => {
  test("a count has thousands separators", () => {
    expect(formatCount(0)).toBe("0");
    expect(formatCount(999)).toBe("999");
    expect(formatCount(1000)).toBe("1,000");
    expect(formatCount(1234567)).toBe("1,234,567");
    expect(formatCount(1234567, "de-DE")).toBe("1.234.567");
  });

  test("a percentage keeps at most one decimal", () => {
    expect(formatPercent(20)).toBe("20%");
    expect(formatPercent(92.3)).toBe("92.3%");
    expect(formatPercent(33.333)).toBe("33.3%");
  });

  test("a size is in the units a person reads", () => {
    expect(formatBytes(1)).toBe("1 byte");
    expect(formatBytes(820)).toBe("820 bytes");
    expect(formatBytes(14540)).toBe("14.2 KiB");
    expect(formatBytes(3 * 1024 * 1024)).toBe("3.0 MiB");
    expect(formatBytes(1536 * 1024 * 1024)).toBe("1.5 GiB");
  });

  test("a duration is short and exact enough to trust", () => {
    expect(formatDuration(380)).toBe("380 ms");
    expect(formatDuration(41_000)).toBe("41 s");
    expect(formatDuration(125_000)).toBe("2 min 5 s");
    expect(formatDuration(120_000)).toBe("2 min");
    expect(formatDuration(3_780_000)).toBe("1 h 3 min");
    expect(formatDuration(7_200_000)).toBe("2 h");
    expect(formatDuration(-5)).toBe("0 ms");
  });
});

/** Run `body` with the process on a clock in `zone`, which is the viewer's zone for a formatter that is
 * not told one. Bun reads TZ again when it is set. */
function inZone(zone: string, body: () => void): void {
  const before = process.env.TZ;
  process.env.TZ = zone;
  try {
    body();
  } finally {
    if (before === undefined) delete process.env.TZ;
    else process.env.TZ = before;
  }
}

describe("dates", () => {
  test("a date is written the way a person writes it: month name, day without a zero, year", () => {
    expect(formatDate("2026-10-04")).toBe("Oct 4, 2026");
    expect(formatDate("2026-03-20")).toBe("Mar 20, 2026");
    expect(formatDate("2024-02-29")).toBe("Feb 29, 2024");
    expect(formatDate("2026-01-01")).toBe("Jan 1, 2026");
    expect(formatDate("2026-12-31")).toBe("Dec 31, 2026");
    expect(formatDate("0999-06-09")).toBe("Jun 9, 0999");
  });

  test("every month has its short English name, whatever the runtime's own locale says", () => {
    expect(
      Array.from({ length: 12 }, (_, month) =>
        formatDate(`2026-${String(month + 1).padStart(2, "0")}-15`),
      ),
    ).toEqual([
      "Jan 15, 2026",
      "Feb 15, 2026",
      "Mar 15, 2026",
      "Apr 15, 2026",
      "May 15, 2026",
      "Jun 15, 2026",
      "Jul 15, 2026",
      "Aug 15, 2026",
      "Sep 15, 2026",
      "Oct 15, 2026",
      "Nov 15, 2026",
      "Dec 15, 2026",
    ]);
  });

  test("only real calendar days are dates", () => {
    expect(isDate("2026-02-29")).toBe(false);
    expect(isDate("2024-02-29")).toBe(true);
    expect(isDate("2026-13-01")).toBe(false);
    expect(isDate("2026-4-1")).toBe(false);
    expect(isDate("")).toBe(false);
    expect(isInstant("2026-10-04T13:01:00Z")).toBe(true);
    expect(isInstant("2026-10-04T13:01:00+02:00")).toBe(true);
    expect(isInstant("2026-10-04")).toBe(false);
    expect(isInstant("2026-10-04T99:99:99Z")).toBe(false);
    expect(isInstant("never")).toBe(false);
    expect(parseDate("2026-10-04")).toEqual({ year: 2026, month: 10, day: 4 });
    expect(daysInMonth(2024, 2)).toBe(29);
    expect(daysInMonth(1900, 2)).toBe(28);
    expect(daysInMonth(2000, 2)).toBe(29);
    expect(daysInMonth(2026, 4)).toBe(30);
    expect(daysInMonth(2026, 12)).toBe(31);
  });

  test("a date that is already written for a person, or is not a date, is left alone", () => {
    expect(formatDate(formatDate("2026-10-04"))).toBe("Oct 4, 2026");
    expect(formatDate("yesterday")).toBe("yesterday");
    expect(formatDate("")).toBe("");
    expect(formatDate("2026-02-30")).toBe("2026-02-30");
    expect(formatDate("2026-10-04 and more")).toBe("2026-10-04 and more");
  });

  test("an instant shows the day it falls on, on the viewer's clock", () => {
    expect(formatDate("2026-10-04T13:01:00Z", { timeZone: "UTC" })).toBe("Oct 4, 2026");
    expect(formatDate("2026-10-04T23:30:00-05:00", { timeZone: "UTC" })).toBe("Oct 5, 2026");
    // Half past nine in the evening in Denver is already the next day in UTC: the viewer's day is
    // the one they lived.
    expect(formatDate("2026-10-05T03:30:00Z", { timeZone: "America/Denver" })).toBe("Oct 4, 2026");
    expect(formatDate("2026-10-04T20:00:00Z", { timeZone: "Asia/Tokyo" })).toBe("Oct 5, 2026");
    inZone("America/Denver", () => {
      expect(formatDate("2026-10-05T03:30:00Z")).toBe("Oct 4, 2026");
    });
    inZone("UTC", () => {
      expect(formatDate("2026-10-05T03:30:00Z")).toBe("Oct 5, 2026");
    });
  });

  test("an instant is shown with its time, twelve hours, on the viewer's clock", () => {
    const utc = { timeZone: "UTC" };
    expect(formatInstant("2026-10-04T13:01:00Z", utc)).toBe("Oct 4, 2026, 1:01 PM");
    expect(formatInstant("2026-03-20T12:00:00.000Z", utc)).toBe("Mar 20, 2026, 12:00 PM");
    expect(formatInstant("2026-03-20T00:05:00Z", utc)).toBe("Mar 20, 2026, 12:05 AM");
    expect(formatInstant("2026-03-20T23:59:59Z", utc)).toBe("Mar 20, 2026, 11:59 PM");
    expect(formatInstant("2026-10-04T13:01:00+02:00", utc)).toBe("Oct 4, 2026, 11:01 AM");
    expect(formatInstant("2026-10-04", utc)).toBe("Oct 4, 2026");
    expect(formatInstant("never", utc)).toBe("never");
  });

  test("the same instant reads as the evening it was on a clock in another zone", () => {
    const instant = "2026-10-05T03:30:00Z";
    expect(formatInstant(instant, { timeZone: "UTC" })).toBe("Oct 5, 2026, 3:30 AM");
    expect(formatInstant(instant, { timeZone: "America/Denver" })).toBe("Oct 4, 2026, 9:30 PM");
    expect(formatInstant(instant, { timeZone: "America/New_York" })).toBe("Oct 4, 2026, 11:30 PM");
    expect(formatInstant(instant, { timeZone: "Asia/Kolkata" })).toBe("Oct 5, 2026, 9:00 AM");
    // With no zone named, the viewer's own is read; a zone nobody knows is the viewer's too.
    inZone("America/Denver", () => {
      expect(formatInstant(instant)).toBe("Oct 4, 2026, 9:30 PM");
      expect(formatInstant(instant, { timeZone: "Not/AZone" })).toBe("Oct 4, 2026, 9:30 PM");
    });
    inZone("Asia/Kolkata", () => {
      expect(formatInstant(instant)).toBe("Oct 5, 2026, 9:00 AM");
    });
  });

  test("a clock that changes in spring and autumn is followed, not assumed", () => {
    // Denver is UTC-7 in winter and UTC-6 in summer: the same wall time on both sides of the change.
    expect(formatInstant("2026-03-08T08:59:00Z", { timeZone: "America/Denver" })).toBe(
      "Mar 8, 2026, 1:59 AM",
    );
    expect(formatInstant("2026-03-08T09:00:00Z", { timeZone: "America/Denver" })).toBe(
      "Mar 8, 2026, 3:00 AM",
    );
  });

  test("a range names the year once inside a year, both across years, and a single day is that day", () => {
    expect(formatDateRange("2026-01-01", "2026-10-04")).toBe("Jan 1 to Oct 4, 2026");
    expect(formatDateRange("2026-03-01", "2026-03-31")).toBe("Mar 1 to Mar 31, 2026");
    expect(formatDateRange("2025-10-01", "2026-09-30")).toBe("Oct 1, 2025 to Sep 30, 2026");
    expect(formatDateRange("2026-06-30", "2026-06-30")).toBe("Jun 30, 2026");
    expect(formatDateRange("nope", "2026-06-30")).toBe("nope to Jun 30, 2026");
    expect(formatDateRange("2026-06-30", "nope")).toBe("Jun 30, 2026 to nope");
  });

  test("the date with its weekday is for the one line that says what day it is", () => {
    expect(formatWeekdayDate("2026-10-04")).toBe("Sunday, Oct 4, 2026");
    expect(formatWeekdayDate("2026-03-20")).toBe("Friday, Mar 20, 2026");
    expect(formatWeekdayDate("2024-02-29")).toBe("Thursday, Feb 29, 2024");
    expect(formatWeekdayDate("nope")).toBe("nope");
  });

  test("how long ago is read from the instant passed in, and never goes negative", () => {
    const now = new Date("2026-03-20T12:00:00.000Z");
    expect(formatAge("2026-03-20T11:59:30.000Z", now)).toBe("just now");
    expect(formatAge("2026-03-20T11:55:00.000Z", now)).toBe("5 minutes ago");
    expect(formatAge("2026-03-20T11:59:00.000Z", now)).toBe("1 minute ago");
    expect(formatAge("2026-03-20T11:00:00.000Z", now)).toBe("1 hour ago");
    expect(formatAge("2026-03-20T07:00:00.000Z", now)).toBe("5 hours ago");
    expect(formatAge("2026-03-19T06:00:00.000Z", now)).toBe("30 hours ago");
    expect(formatAge("2026-03-18T12:00:01.000Z", now)).toBe("47 hours ago");
    expect(formatAge("2026-03-18T12:00:00.000Z", now)).toBe("2 days ago");
    expect(formatAge("2026-03-20T12:05:00.000Z", now)).toBe("just now");
    expect(formatAge("not a date", now)).toBe("not a date");
  });

  test("days between two dates is exact across months, leap days and years", () => {
    expect(daysBetween("2026-10-01", "2026-10-04")).toBe(3);
    expect(daysBetween("2026-10-04", "2026-10-01")).toBe(-3);
    expect(daysBetween("2024-02-28", "2024-03-01")).toBe(2);
    expect(daysBetween("2025-12-31", "2026-01-01")).toBe(1);
    expect(daysBetween("2026-10-04", "2026-10-04")).toBe(0);
    expect(daysBetween("nope", "2026-10-04")).toBeNaN();
  });

  test("a month on its own is a name, and a day is always a date", () => {
    expect(monthName(1)).toBe("January");
    expect(monthName(9)).toBe("September");
    expect(formatMonth("2026-09")).toBe("September 2026");
    expect(formatMonth("2026-09-15")).toBe("September 2026");
    expect(formatMonth("2026-13")).toBe("2026-13");
    expect(formatMonth("September")).toBe("September");
    expect(firstOfMonth("2026-10-17")).toBe("2026-10-01");
    expect(firstOfMonth("nope")).toBe("nope");
  });

  test("a month in a column heading is the short name and the year", () => {
    expect(formatMonthShort("2026-09")).toBe("Sep 2026");
    expect(formatMonthShort("2026-01-31")).toBe("Jan 2026");
    // It follows the locale: March is "März" or "Mär" in German, never the English "Mar".
    expect(formatMonthShort("2026-03", "de-DE")).toMatch(/^Mär.* 2026$/);
    expect(formatMonthShort("2026-13")).toBe("2026-13");
    expect(formatMonthShort("Sept")).toBe("Sept");
  });

  test("today is read from the clock that is passed in, in the viewer's own zone", () => {
    expect(localToday(new Date(2026, 9, 4, 23, 59))).toBe("2026-10-04");
    expect(localToday(new Date(2026, 0, 1, 0, 0))).toBe("2026-01-01");
    expect(localToday(new Date(2026, 11, 31, 12, 0))).toBe("2026-12-31");
  });

  test("the time of day is twelve hours with AM or PM, on the clock passed in", () => {
    expect(formatTime(new Date(2026, 9, 4, 9, 5))).toBe("9:05 AM");
    expect(formatTime(new Date(2026, 9, 4, 0, 0))).toBe("12:00 AM");
    expect(formatTime(new Date(2026, 9, 4, 12, 0))).toBe("12:00 PM");
    expect(formatTime(new Date(2026, 9, 4, 23, 59, 59))).toBe("11:59 PM");
    expect(formatTime(new Date(2026, 9, 4, 13, 41))).toBe("1:41 PM");
    expect(formatTime(new Date("2026-10-04T15:05:00Z"), { timeZone: "America/Denver" })).toBe(
      "9:05 AM",
    );
  });

  test("the date field's hint says the order its locale writes a date in", () => {
    expect(dateInputOrder("en-US")).toBe("Month/day/year");
    expect(dateInputOrder("en-GB")).toBe("Day/month/year");
    expect(dateInputOrder("not a locale")).toBe("Month/day/year");
  });
});

describe("the service's sentences in the application's own words", () => {
  test("the Inbox is said in plain words and never by its tab's name, the cutover is the start date and the bank feed is the bank connection", () => {
    expect(inAppWords("The Inbox could not be read, so it is not known.")).toBe(
      "The review list could not be read, so it is not known.",
    );
    expect(inAppWords("Refresh the Inbox.")).toBe("Refresh the review list.");
    expect(inAppWords("Nothing is waiting in the Inbox.")).toBe("Nothing is waiting for review.");
    expect(inAppWords("3 lines are still waiting in the Inbox.")).toBe(
      "3 lines are waiting for review.",
    );
    expect(inAppWords("Held for you to categorise in the Inbox.")).toBe(
      "Held for you to categorise in the review list.",
    );
    expect(inAppWords("One Inbox entry, waiting for Stripe.")).toBe(
      "One entry for review, waiting for Stripe.",
    );
    expect(inAppWords("The Inbox's start dates must be the same day.")).toBe(
      "The review list's start dates must be the same day.",
    );
    // No sentence the service writes comes out naming the tab.
    for (const said of [
      "The Inbox could not be read",
      "Lines already imported stay in the Inbox and in the books.",
      "A line with the same date, amount and description is already in the Inbox.",
      "Inbox",
    ])
      expect(inAppWords(said)).not.toContain("For review");
    expect(inAppWords("The cutover date is fixed, so the cutover cannot move.")).toBe(
      "The start date is fixed, so the start date cannot move.",
    );
    expect(inAppWords("Cutover date: 2026-03-20")).toBe("Start date: 2026-03-20");
    expect(inAppWords("Connect the bank feed first. Bank feed lines wait.")).toBe(
      "Connect the bank connection first. Bank connection lines wait.",
    );
  });

  test("what a refusal says for a script is left out on a screen: the person has the button", () => {
    expect(
      formatFiguresInText(
        'Reopen March 2026 first (periods.prepare with operation "reopen"), post, then close it again.',
      ),
    ).toBe("Reopen March 2026 first, post, then close it again.");
    // What a service of before 2026-11-22 wrote, which named a screen too.
    expect(
      formatFiguresInText(
        'Reopen March 2026 first (Reopen on the Periods screen, or periods.prepare with operation "reopen"), post.',
      ),
    ).toBe("Reopen March 2026 first, post.");
  });

  test("a line of the Inbox is a transaction, and a sentence keeps its capital", () => {
    expect(inAppWords("12 Inbox lines dated through 2026-10-31 still need a decision.")).toBe(
      "12 transactions for review dated through 2026-10-31 still need a decision.",
    );
    expect(inAppWords("1 Inbox line is waiting. Inbox lines dated later are not counted.")).toBe(
      "1 transaction for review is waiting. Transactions for review dated later are not counted.",
    );
    expect(inAppWords("That Inbox item does not exist. An Inbox item changed.")).toBe(
      "That transaction does not exist. A transaction changed.",
    );
    expect(inAppWords("11 lines queued in the Inbox for review. Nothing was posted.")).toBe(
      "11 lines queued for review. Nothing was posted.",
    );
  });

  test("a command, an option and an operation name keep the service's word", () => {
    expect(
      inAppWords(
        "Record 2026-03-20 first (rastrata cutover set --date 2026-03-20): the Inbox's start dates must agree.",
      ),
    ).toBe(
      "Record 2026-03-20 first (rastrata cutover set --date 2026-03-20): the review list's start dates must agree.",
    );
    expect(
      inAppWords("Change the cutover date with inbox.configureSource if that is intended."),
    ).toBe("Change the start date with inbox.configureSource if that is intended.");
    expect(inAppWords("Run `rastrata inbox list` to see the Inbox.")).toBe(
      "Run `rastrata inbox list` to see the review list.",
    );
  });

  test("a word the application already says, and an identifier that holds one, are left alone", () => {
    for (const text of [
      "For review has more transactions than one pass reads.",
      "The start date is fixed.",
      "journals_before_cutover and an_inbox_item",
      "Nothing to change here.",
    ])
      expect(inAppWords(text)).toBe(text);
  });

  test("a sentence about a bank's transactions says transaction for line, and keeps a command and a line break", () => {
    expect(transactionsIn("11 lines queued in the Inbox for review. Nothing was posted.")).toBe(
      "11 transactions queued for review. Nothing was posted.",
    );
    expect(transactionsIn("Another account of yours has a line for exactly 250.00.")).toBe(
      "Another account of yours has a transaction for exactly 250.00.",
    );
    expect(
      transactionsIn("Most lines are positive, but this is a credit card. Line 3 is odd."),
    ).toBe("Most transactions are positive, but this is a credit card. Transaction 3 is odd.");
    expect(transactionsIn("Run `rastrata inbox list` for the lines; use a line break.")).toBe(
      "Run `rastrata inbox list` for the transactions; use a line break.",
    );
    // Not every sentence is about a bank: inAppWords leaves "line" alone.
    expect(inAppWords("The entry has two lines.")).toBe("The entry has two lines.");
  });

  test("formatFiguresInText says both: its words and its figures", () => {
    expect(
      formatFiguresInText(
        "12 Inbox lines dated through 2026-10-31 hold 12500.00 before the cutover.",
      ),
    ).toBe(
      "12 transactions for review dated through Oct 31, 2026 hold 12,500.00 before the start date.",
    );
  });
});
