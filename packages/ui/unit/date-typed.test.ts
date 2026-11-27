import { describe, expect, test } from "bun:test";
import { readTypedDate } from "../src/date-typed";

const now = { year: 2026, month: 11, day: 18 };
const read = (text: string) => {
  const day = readTypedDate(text, now);
  return day
    ? `${String(day.year).padStart(4, "0")}-${String(day.month).padStart(2, "0")}-${String(day.day).padStart(2, "0")}`
    : null;
};

describe("a date as a person types it", () => {
  test("every way the application writes a date is read back", () => {
    expect(read("Oct 4, 2026")).toBe("2026-10-04");
    expect(read("10/04/2026")).toBe("2026-10-04");
    expect(read("2026-10-04")).toBe("2026-10-04");
  });

  test("the ways people shorten a date", () => {
    expect(read("10/4/26")).toBe("2026-10-04");
    expect(read("10/4")).toBe("2026-10-04");
    expect(read("10-4-2026")).toBe("2026-10-04");
    expect(read("10.4.26")).toBe("2026-10-04");
    expect(read("10 4 2026")).toBe("2026-10-04");
    expect(read("  oct 4  ")).toBe("2026-10-04");
    expect(read("October 4 2026")).toBe("2026-10-04");
    expect(read("Oct. 4, 26")).toBe("2026-10-04");
    expect(read("4 Oct 2026")).toBe("2026-10-04");
  });

  test("digits alone, as a phone's number pad types them", () => {
    expect(read("10042026")).toBe("2026-10-04");
    expect(read("100426")).toBe("2026-10-04");
    expect(read("1004")).toBe("2026-10-04");
  });

  test("the stored form without its dashes, when it is not a date month first", () => {
    expect(read("20261004")).toBe("2026-10-04");
    expect(read("19991231")).toBe("1999-12-31");
    // Month first wins where both read: 12/01/2011, not the year 1201.
    expect(read("12012011")).toBe("2011-12-01");
    expect(read("20261340")).toBeNull();
  });

  test("a year in two digits is this century unless that is far ahead", () => {
    expect(read("1/2/46")).toBe("2046-01-02");
    expect(read("1/2/47")).toBe("1947-01-02");
    expect(read("1/2/99")).toBe("1999-01-02");
    expect(read("1/2/00")).toBe("2000-01-02");
  });

  test("a day that does not exist, and what is not a date, are nothing", () => {
    expect(read("2/30/2026")).toBeNull();
    expect(read("2/29/2026")).toBeNull();
    expect(read("2/29/2028")).toBe("2028-02-29");
    expect(read("13/1/2026")).toBeNull();
    expect(read("2026-02-30")).toBeNull();
    expect(read("Octember 4")).toBeNull();
    expect(read("soon")).toBeNull();
    expect(read("")).toBeNull();
    expect(read("1")).toBeNull();
    expect(read("123")).toBeNull();
  });
});
