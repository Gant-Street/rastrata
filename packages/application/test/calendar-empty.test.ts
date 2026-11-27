import { afterEach, expect, test } from "bun:test";
import {
  batchOf,
  closeFixtures,
  type Fixture,
  ingestFixture,
  type Json,
  postManual,
} from "./support/ingest-fixture.ts";

afterEach(() => closeFixtures());

/** `periods.list`, as a map from the month a period starts in ("2026-03") to whether nothing is recorded in it. */
async function emptyByPeriod(f: Fixture): Promise<Map<string, boolean>> {
  const reply = await f.call("periods.list");
  expect(reply.body.ok, JSON.stringify(reply.body)).toBe(true);
  return new Map(
    (reply.body.data.periods as Json[]).map((row: Json) => [
      (row.startsOn as string).slice(0, 7),
      row.empty as boolean,
    ]),
  );
}

test("a period with no entry and no bank transaction dated in it is empty, and nothing else is", async () => {
  const f = await ingestFixture();
  // A fresh book: every period holds nothing.
  const before = await emptyByPeriod(f);
  expect(before.size).toBeGreaterThan(0);
  expect([...before.values()].every((empty) => empty)).toBe(true);

  // An entry dated in March fills March and nothing else.
  await postManual(f, "2026-03-09", "Rent", [
    { accountId: "5000", debit: "80.00", credit: "" },
    { accountId: "1000", debit: "", credit: "80.00" },
  ]);
  // A bank transaction in the Inbox dated in May fills May, whether or not anyone has looked at it.
  f.port.submit(
    batchOf(f.port, [{ date: "2026-05-14", amount: "-12.40", description: "LUNCH" }], {
      ledgerAccountId: "1000",
    }),
  );
  const after = await emptyByPeriod(f);
  expect(after.get("2026-03")).toBe(false);
  expect(after.get("2026-05")).toBe(false);
  for (const month of ["01", "02", "04", "06", "07", "08", "09", "10", "11", "12"])
    expect(after.get(`2026-${month}`), month).toBe(true);
});

test("a bank transaction kept out of the books still counts: the month is not empty", async () => {
  const f = await ingestFixture();
  f.port.submit(
    batchOf(f.port, [{ date: "2026-02-03", amount: "-4.50", description: "COFFEE" }], {
      ledgerAccountId: "1000",
    }),
  );
  const listed = await f.call("inbox.list", {});
  const item = listed.body.data.items[0] as Json;
  const excluded = await f.call(
    "inbox.exclude",
    { itemIds: [item.id], reason: "Personal" },
    crypto.randomUUID(),
  );
  expect(excluded.body.ok, JSON.stringify(excluded.body)).toBe(true);
  expect((await emptyByPeriod(f)).get("2026-02")).toBe(false);
});
