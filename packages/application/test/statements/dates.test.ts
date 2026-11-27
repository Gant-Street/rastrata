import { expect, test } from "bun:test";
import {
  analyzeDateOrder,
  formatDate,
  isRealDate,
  parseDate,
  parseOfxDate,
  type DateOrder,
} from "../../src/statements/dates.ts";
import { random } from "./helpers.ts";

const read = (text: string, order: DateOrder) => {
  const parts = parseDate(text, order);
  return parts ? formatDate(parts) : null;
};

test("one date reads differently in each order, and only real dates read at all", () => {
  expect(read("03/04/2026", "mdy")).toBe("2026-03-04");
  expect(read("03/04/2026", "dmy")).toBe("2026-04-03");
  expect(read("2026-03-04", "ymd")).toBe("2026-03-04");
  expect(read("2026/03/04", "ymd")).toBe("2026-03-04");
  expect(read("13/05/2026", "mdy")).toBeNull();
  expect(read("13/05/2026", "dmy")).toBe("2026-05-13");
  expect(read("02/30/2026", "mdy")).toBeNull();
  expect(read("02/29/2024", "mdy")).toBe("2024-02-29");
  expect(read("02/29/2023", "mdy")).toBeNull();
  expect(read("02/29/1900", "mdy")).toBeNull();
  expect(read("02/29/2000", "mdy")).toBe("2000-02-29");
  expect(read("00/10/2026", "mdy")).toBeNull();
  expect(read("10/00/2026", "mdy")).toBeNull();
  expect(read("31/04/2026", "dmy")).toBeNull();
});

test("short years, separators, month names and trailing times", () => {
  expect(read("3/4/26", "mdy")).toBe("2026-03-04");
  expect(read("3.4.26", "dmy")).toBe("2026-04-03");
  expect(read("01/05/99", "mdy")).toBe("1999-01-05");
  expect(read("Mar 4, 2026", "mdy")).toBe("2026-03-04");
  expect(read("March 4, 2026", "dmy")).toBe("2026-03-04");
  expect(read("4 March 2026", "mdy")).toBe("2026-03-04");
  expect(read("4-Mar-2026", "mdy")).toBe("2026-03-04");
  expect(read("2026-Mar-04", "mdy")).toBe("2026-03-04");
  expect(read("2026-03-04 10:15:00", "ymd")).toBe("2026-03-04");
  expect(read("2026-03-04T10:15:00Z", "ymd")).toBe("2026-03-04");
  expect(read("03/04/2026 10:15 AM", "mdy")).toBe("2026-03-04");
  expect(read(" 03/04/2026 ", "mdy")).toBe("2026-03-04");
});

test("text that is not a date is not read as one", () => {
  for (const text of [
    "",
    "x",
    "2026",
    "03/04",
    "03/04/26/1",
    "1/1/1",
    "99/99/9999",
    "Mar 4",
    "20261301",
    "1969-12-31",
    "2101-01-01",
    "13-13-2026",
    "0000-00-00",
    "2026-3-4-5",
  ])
    expect(read(text, "mdy"), text).toBeNull();
  expect(read("x".repeat(300), "mdy")).toBeNull();
});

test("a date is never moved by a time zone: the day the bank wrote is the day kept", () => {
  expect(parseOfxDate("20260102000000[-8:PST]")).toBe("2026-01-02");
  expect(parseOfxDate("20260102235959[5:EST]")).toBe("2026-01-02");
  expect(parseOfxDate("20260102120000.000[-5:EST]")).toBe("2026-01-02");
  expect(parseOfxDate("20260102120000[0:GMT]")).toBe("2026-01-02");
  expect(parseOfxDate("20260102")).toBe("2026-01-02");
  expect(parseOfxDate(" 20260102 ")).toBe("2026-01-02");
  expect(parseOfxDate("20260230")).toBeNull();
  expect(parseOfxDate("2026-01-02")).toBeNull();
  expect(parseOfxDate("")).toBeNull();
  expect(parseOfxDate("2026010")).toBeNull();
});

test("the order of a column is settled from every value, and refused when the data cannot say", () => {
  const order = (values: string[]) => analyzeDateOrder(values);
  expect(order(["03/04/2026", "03/25/2026"]).order).toBe("mdy");
  expect(order(["03/04/2026", "25/03/2026"]).order).toBe("dmy");
  expect(order(["2026-03-04", "2026-03-25"]).order).toBe("ymd");
  const ambiguous = order(["03/04/2026", "05/06/2026", "11/12/2026"]);
  expect(ambiguous.order).toBeNull();
  expect(ambiguous.ambiguous).toBe(true);
  const conflicting = order(["03/25/2026", "25/03/2026"]);
  expect(conflicting.order).toBeNull();
  expect(conflicting.conflicting).toBe(true);
  expect(order(["2026-03-04", "03/25/2026"]).conflicting).toBe(true);
  expect(order(["Mar 4, 2026", "4 Apr 2026"]).order).not.toBeNull();
  expect(order(["Mar 4, 2026", "4 Apr 2026"]).ambiguous).toBe(false);
  expect(order([]).order).toBeNull();
  expect(order(["", "  "]).readable).toBe(0);
  expect(order(["garbage", "more"]).readable).toBe(0);
  // One unambiguous date decides the whole column, for the values around it too.
  expect(order(["01/02/2026", "03/04/2026", "01/31/2026"]).order).toBe("mdy");
});

test("calendar arithmetic: leap years and month lengths", () => {
  expect(isRealDate(2024, 2, 29)).toBe(true);
  expect(isRealDate(2100, 2, 29)).toBe(false);
  expect(isRealDate(2026, 4, 31)).toBe(false);
  expect(isRealDate(2026, 12, 31)).toBe(true);
  expect(isRealDate(2026, 0, 1)).toBe(false);
  expect(isRealDate(2026.5, 1, 1)).toBe(false);
});

test("every real date in range survives a round trip through every notation", () => {
  const generator = random(3);
  for (let iteration = 0; iteration < 3000; iteration++) {
    const year = generator.int(1990, 2060);
    const month = generator.int(1, 12);
    const day = generator.int(1, 28);
    const iso = formatDate({ year, month, day });
    const mm = String(month).padStart(2, "0");
    const dd = String(day).padStart(2, "0");
    expect(read(iso, "ymd")).toBe(iso);
    expect(read(`${mm}/${dd}/${year}`, "mdy")).toBe(iso);
    expect(read(`${dd}/${mm}/${year}`, "dmy")).toBe(iso);
    expect(parseOfxDate(`${year}${mm}${dd}120000[0:GMT]`)).toBe(iso);
  }
});

test("random text never throws and any date it yields is a real one", () => {
  const generator = random(5);
  const alphabet = "0123456789/-. :TZAMPJanbMrch,";
  for (let iteration = 0; iteration < 5000; iteration++) {
    let text = "";
    for (let index = generator.int(0, 20); index > 0; index--)
      text += alphabet[generator.int(0, alphabet.length - 1)];
    for (const order of ["mdy", "dmy", "ymd"] as const) {
      const parts = parseDate(text, order);
      if (parts) expect(isRealDate(parts.year, parts.month, parts.day), text).toBe(true);
    }
  }
});
