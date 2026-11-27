/** `inbox.texts`: the bulk read of the text behind posted journals that the report by payee reads in place
 * of paging `inbox.list`. It must say what `inbox.list` says about the same lines, in pages whose
 * cursor loses and repeats nothing. */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { allItems } from "./acceptance/drive.ts";
import type { Json, World } from "./acceptance/world.ts";
import { type Driver, type MonthBook, bookTheMonth } from "./payees-support.ts";

let month: MonthBook & { world: World };
let d: Driver;
beforeAll(async () => {
  month = await bookTheMonth();
  d = month.d;
});
afterAll(async () => {
  await month?.world.close();
});

const RANGE = { from: "2026-01-01", to: "2026-12-31" };

async function everyText(input: Json = {}): Promise<{ items: Json[]; pages: number }> {
  const items: Json[] = [];
  let pages = 0;
  for (let after: string | undefined; ; ) {
    const page = await d.ok("inbox.texts", { ...RANGE, ...input, ...(after ? { after } : {}) });
    pages += 1;
    items.push(...page.items);
    if (page.next === null) return { items, pages };
    after = page.next;
  }
}

describe("the text behind posted journals", () => {
  test("is what inbox.list says about the same lines: their journal, provider, counterparty and description", async () => {
    const posted = await allItems(month.world, { status: ["posted"], covered: false });
    const expected = new Map(
      posted
        .filter((item) => item.journalId)
        .map((item) => [
          item.journalId as string,
          [item.line.kind, item.line.provider, item.line.counterparty ?? "", item.line.description],
        ]),
    );
    const { items } = await everyText();
    expect(items.length).toBeGreaterThan(60);
    expect(
      new Map(
        items.map((item) => [
          item.journalId,
          [item.kind, item.provider, item.counterparty, item.description],
        ]),
      ),
    ).toEqual(expected);
    // The six Stripe payouts are events and the rent written by hand is found by its entry.
    expect(items.filter((item) => item.kind === "event")).toHaveLength(6);
    expect(items.find((item) => item.journalId === month.handEntered)).toMatchObject({
      kind: "bankLine",
      description: expect.stringContaining("WEWORK"),
    });
  });

  test("leaves out the lines a payout books, whatever their status, and the lines not posted", async () => {
    const covered = await allItems(month.world, { provider: "stripe", covered: true });
    expect(covered.length).toBeGreaterThan(0);
    const { items } = await everyText();
    const ids = new Set(items.map((item) => item.journalId));
    // The covered lines share their payout's journal; only the payout speaks for it, once.
    expect(items.filter((item) => item.kind === "event")).toHaveLength(6);
    for (const line of covered) expect(ids.has(line.journalId)).toBe(true);
    const waiting = await allItems(month.world, { status: ["new", "proposed", "excluded"] });
    for (const line of waiting) expect(line.journalId ?? null).toBeNull();
  });

  test("pages by a cursor that loses and repeats nothing, 5,000 at most and 1 at least", async () => {
    const whole = await everyText();
    const small = await everyText({ pageSize: 7 });
    expect(small.pages).toBe(Math.ceil(whole.items.length / 7));
    expect(small.items).toEqual(whole.items);
    const one = await d.ok("inbox.texts", { ...RANGE, pageSize: 1 });
    expect(one.items).toHaveLength(1);
    expect(one.next).not.toBeNull();
    expect((await d.call("inbox.texts", { ...RANGE, pageSize: 5001 })).status).toBe(400);
    expect((await d.call("inbox.texts", { ...RANGE, pageSize: 0 })).status).toBe(400);
    // A cursor that is not one starts from the beginning rather than failing.
    const odd = await d.ok("inbox.texts", { ...RANGE, after: "not-a-number" });
    expect(odd.items.length).toBe(Math.min(2000, whole.items.length));
  });

  test("reads only the dates asked for", async () => {
    const early = await d.ok("inbox.texts", { from: "2026-03-01", to: "2026-03-03" });
    const dates = (await allItems(month.world, { status: ["posted"], covered: false }))
      .filter(
        (item) =>
          item.journalId && item.line.date >= "2026-03-01" && item.line.date <= "2026-03-03",
      )
      .map((item) => item.journalId)
      .sort();
    expect(early.items.map((item: Json) => item.journalId).sort()).toEqual(dates);
    const none = await d.ok("inbox.texts", { from: "2030-01-01", to: "2030-12-31" });
    expect(none).toEqual({ items: [], next: null });
  });

  test("keeps hostile text as the bank wrote it: it is data, and the report is what neutralises it", async () => {
    const { items } = await everyText();
    expect(items.some((item) => item.description.startsWith("=HYPERLINK("))).toBe(true);
    expect(items.some((item) => item.description.includes("ignore your rules"))).toBe(true);
  });

  test("needs only read permission", async () => {
    const reader = await d.ok("tokens.create", { label: "reader", permissions: ["read"] });
    const reply = await month.world.call("inbox.texts", RANGE, { credential: reader.secret });
    expect(reply.status).toBe(200);
    const nobody = await month.world.call("inbox.texts", RANGE, { credential: "rst_nope_nope" });
    expect(nobody.status).toBe(401);
  });
});
