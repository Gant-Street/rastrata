// How the page's load is told to the control plane (src/load-timing.ts): the numbers the browser measured, rounded, bounded, and nothing else.
import { expect, test } from "bun:test";
import { loadMessage } from "../../src/load-timing";

interface Fake {
  mark?: { startTime: number; detail?: { held?: number; copy?: number } | null };
  paint?: number;
  navigation?: { type: string; responseStart: number };
  resources?: { name: string; responseEnd: number }[];
}

const measured = (fake: Fake) =>
  ({
    getEntriesByName: (name: string) =>
      name === "rastrata:drawn" && fake.mark
        ? [{ name, ...fake.mark }]
        : name === "first-contentful-paint" && fake.paint !== undefined
          ? [{ name, startTime: fake.paint }]
          : [],
    getEntriesByType: (type: string) =>
      type === "navigation" && fake.navigation
        ? [fake.navigation]
        : type === "resource"
          ? (fake.resources ?? [])
          : [],
  }) as never;

test("a drawn page's load is its first draw, paints, first byte, token and book, the reads before the draw, and what was held", () => {
  const message = loadMessage(
    measured({
      mark: { startTime: 412.4, detail: { held: 12, copy: 3 } },
      paint: 188.2,
      navigation: { type: "reload", responseStart: 61.5 },
      resources: [
        { name: "https://app.rastrata.com/auth/workspace-token", responseEnd: 118.4 },
        { name: "https://app.rastrata.com/v1/book.get", responseEnd: 190.3 },
        { name: "https://app.rastrata.com/v1/accounts.list", responseEnd: 300 },
        { name: "https://app.rastrata.com/v1/periods.list", responseEnd: 500 },
        { name: "https://app.rastrata.com/assets/index-x.js", responseEnd: 20 },
      ],
    }),
    { largest: 419.8 },
    "index-357mzf7f.js",
  );
  expect(message).toEqual({
    v: 1,
    build: "index-357mzf7f.js",
    kind: "reload",
    draw: 412,
    fcp: 188,
    lcp: 420,
    ttfb: 62,
    tokenAt: 118,
    bookAt: 190,
    reads: 2,
    held: 12,
    copy: 1,
  });
});

test("what was not measured is left out, a page that was not drawn says nothing, and a number is whole and within a day's reason", () => {
  expect(loadMessage(measured({}), {})).toBeNull();
  expect(loadMessage(measured({ resources: [] }), { largest: 5 })).toBeNull();
  const bare = loadMessage(measured({ mark: { startTime: 900 } }), {}, "dev");
  expect(bare).toEqual({
    v: 1,
    build: "dev",
    kind: "navigate",
    draw: 900,
    reads: 0,
    held: 0,
    copy: 0,
  });
  const odd = loadMessage(
    measured({
      mark: { startTime: 1_000_000, detail: { held: -4, copy: 0 } },
      paint: Number.NaN,
      navigation: { type: "back_forward", responseStart: -1 },
    }),
    { largest: Number.POSITIVE_INFINITY },
    "dev",
  );
  expect(odd).toEqual({
    v: 1,
    build: "dev",
    kind: "back_forward",
    draw: 120_000,
    reads: 0,
    held: 0,
    copy: 0,
  });
});
