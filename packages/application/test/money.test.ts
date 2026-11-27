import { expect, test } from "bun:test";
import {
  absMoney,
  addMoney,
  compareMoney,
  formatMoney,
  isMoney,
  isZeroMoney,
  negateMoney,
  normalizeMoney,
  parseMoney,
  subtractMoney,
  sumMoney,
} from "../src/money.ts";

test("money round-trips exactly, including sizes a float cannot hold", () => {
  for (const value of ["0.00", "0.01", "-0.01", "12.34", "-12.34", "9007199254740993.07"])
    expect(formatMoney(parseMoney(value))).toBe(value);
  expect(formatMoney(0n)).toBe("0.00");
  expect(formatMoney(parseMoney("-0.00"))).toBe("0.00");
});

test("arithmetic is exact where floating point is not", () => {
  expect(addMoney("0.10", "0.20")).toBe("0.30");
  expect(sumMoney(["0.10", "0.20", "-0.30"])).toBe("0.00");
  expect(subtractMoney("1.00", "0.01")).toBe("0.99");
  expect(negateMoney("5.50")).toBe("-5.50");
  expect(absMoney("-5.50")).toBe("5.50");
  expect(compareMoney("1.00", "1.01")).toBe(-1);
  expect(compareMoney("2.00", "2.00")).toBe(0);
  expect(compareMoney("-1.00", "-2.00")).toBe(1);
  expect(isZeroMoney("-0.00")).toBe(true);
  expect(isZeroMoney("0.01")).toBe(false);
});

test("the wire format is strict", () => {
  expect(isMoney("12.34")).toBe(true);
  for (const value of ["12.3", "12", "1,234.00", "12.345", "", " 1.00", "+1.00", 5, null])
    expect(isMoney(value)).toBe(false);
  expect(() => parseMoney("12.3")).toThrow(TypeError);
});

test("typed and bank amounts normalise, and extra precision is refused rather than rounded", () => {
  expect(normalizeMoney("1,234.5")).toBe("1234.50");
  expect(normalizeMoney("$12")).toBe("12.00");
  expect(normalizeMoney("+7.10")).toBe("7.10");
  expect(normalizeMoney("-7.10")).toBe("-7.10");
  expect(normalizeMoney("(7.10)")).toBe("-7.10");
  expect(normalizeMoney("7.10-")).toBe("-7.10");
  expect(normalizeMoney(".5")).toBe("0.50");
  expect(normalizeMoney("0")).toBe("0.00");
  for (const value of ["", ".", "abc", "1.234", "1,23.00", "--1", "1.2.3"])
    expect(normalizeMoney(value)).toBeNull();
});
