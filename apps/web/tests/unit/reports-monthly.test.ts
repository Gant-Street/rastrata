import { describe, expect, test } from "bun:test";
import type { ApplicationInputs, ApplicationOutputs } from "@rastrata/application/client-contracts";
import { type ReadCore, readMonthly } from "../../src/routes/reports/monthly";

type Core = ApplicationOutputs["reports.get"];
type Input = ApplicationInputs["reports.get"];

/** A stand-in for the service: it answers a read with the revision it was read at (the current one,
 * "7", unless the read pinned another), and records every request and how many were in flight. */
function service(options: { current?: string; delayMs?: (input: Input) => number } = {}) {
  const calls: Input[] = [];
  let inFlight = 0;
  let busiest = 0;
  const read: ReadCore = async (input) => {
    calls.push(input);
    inFlight += 1;
    busiest = Math.max(busiest, inFlight);
    await new Promise((resolve) => setTimeout(resolve, options.delayMs?.(input) ?? 0));
    inFlight -= 1;
    return {
      bookRevision: input.revision ?? options.current ?? "7",
      asOf: input.asOf,
      periodStart: input.from ?? "",
    } as unknown as Core;
  };
  return { read, calls, busiest: () => busiest };
}

describe("a report by month is one book read many times", () => {
  test("the whole range is read first, and every month after it at the revision it was read at", async () => {
    const stand = service({ current: "41" });
    const reports = await readMonthly(stand.read, { from: "2026-01-01", asOf: "2026-03-31" });
    // The total comes first and is not pinned: it is the book as it is now, and it says which revision.
    expect(stand.calls[0]).toEqual({ asOf: "2026-03-31", from: "2026-01-01" });
    expect(reports.total.bookRevision).toBe("41");
    // Each month is pinned to that revision, so a posting made in between cannot split the columns.
    const months = stand.calls.slice(1);
    expect(months).toEqual([
      { asOf: "2026-01-31", from: "2026-01-01", revision: "41" },
      { asOf: "2026-02-28", from: "2026-02-01", revision: "41" },
      { asOf: "2026-03-31", from: "2026-03-01", revision: "41" },
    ]);
    expect(reports.months.map((column) => column.month)).toEqual(["2026-01", "2026-02", "2026-03"]);
    expect(reports.months.every((column) => column.data.bookRevision === "41")).toBe(true);
  });

  test("a link that pinned a revision keeps it for the total and every month", async () => {
    const stand = service({ current: "99" });
    const reports = await readMonthly(stand.read, {
      from: "2026-01-01",
      asOf: "2026-02-28",
      revision: "12",
    });
    expect(stand.calls.every((call) => call.revision === "12")).toBe(true);
    expect(reports.total.bookRevision).toBe("12");
  });

  test("the first and last months are clipped to the range", async () => {
    const stand = service();
    const reports = await readMonthly(stand.read, { from: "2026-01-20", asOf: "2026-03-05" });
    expect(reports.months.map((column) => [column.from, column.to, column.partial])).toEqual([
      ["2026-01-20", "2026-01-31", true],
      ["2026-02-01", "2026-02-28", false],
      ["2026-03-01", "2026-03-05", true],
    ]);
    expect(stand.calls.slice(1).map((call) => [call.from, call.asOf])).toEqual([
      ["2026-01-20", "2026-01-31"],
      ["2026-02-01", "2026-02-28"],
      ["2026-03-01", "2026-03-05"],
    ]);
  });

  test("only a few months are asked for at once, and the columns stay in order however they finish", async () => {
    // Earlier months are slower, so they finish last.
    const stand = service({
      delayMs: (input) => (input.from === undefined ? 0 : 30 - Number(input.asOf.slice(5, 7))),
    });
    const reports = await readMonthly(stand.read, { from: "2025-10-01", asOf: "2026-09-30" });
    expect(stand.busiest()).toBeLessThanOrEqual(4);
    expect(reports.months).toHaveLength(12);
    expect(reports.months.map((column) => column.month)).toEqual([
      "2025-10",
      "2025-11",
      "2025-12",
      "2026-01",
      "2026-02",
      "2026-03",
      "2026-04",
      "2026-05",
      "2026-06",
      "2026-07",
      "2026-08",
      "2026-09",
    ]);
    for (const column of reports.months) expect(column.data.asOf).toBe(column.to);
  });

  test("a range with no months, or too many, is refused before anything is asked", async () => {
    const stand = service();
    await expect(
      readMonthly(stand.read, { from: "2026-04-01", asOf: "2026-03-01" }),
    ).rejects.toBeInstanceOf(RangeError);
    await expect(
      readMonthly(stand.read, { from: "2024-01-01", asOf: "2026-12-31" }),
    ).rejects.toBeInstanceOf(RangeError);
    expect(stand.calls).toEqual([]);
  });

  test("one month that cannot be read fails the whole report, and no column is shown without its neighbours", async () => {
    const failing: ReadCore = async (input) => {
      if (input.asOf === "2026-02-28") throw new Error("The service is unavailable");
      return {
        bookRevision: "7",
        asOf: input.asOf,
        periodStart: input.from ?? "",
      } as unknown as Core;
    };
    await expect(readMonthly(failing, { from: "2026-01-01", asOf: "2026-03-31" })).rejects.toThrow(
      "The service is unavailable",
    );
  });
});
