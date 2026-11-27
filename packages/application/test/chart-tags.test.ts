import { afterEach, expect, test } from "bun:test";
import { hashCanonical } from "@rastrata/kernel";
import { readAccountTags } from "../src/account-tags.ts";
import { chartFixture, cleanUp, untaggedBook, uuid } from "./chart-support.ts";

afterEach(cleanUp);

const rows = (body: { data: { accounts: { id: string; tags: object }[] } }) =>
  Object.fromEntries(body.data.accounts.map((account) => [account.id, account.tags]));

test("tags given at setup come from the setup record and show on accounts.list", async () => {
  const f = await chartFixture().then((fixture) => fixture.withBook());
  const list = await f.call("accounts.list");
  expect(list.status).toBe(200);
  expect(rows(list.body)).toEqual({
    "1000": { cashFlowClass: "cash" },
    "2000": { cashFlowClass: "operating" },
    "3000": { cashFlowClass: "financing" },
    "4000": { taxLine: "scheduleC.line1", roleKey: "revenue.sales" },
    "6000": { taxLine: "scheduleC.line8" },
    "6100": {},
  });
  const map = readAccountTags(f.service.store);
  expect(list.body.data.tagsHash).toBe(map.hash);
  expect(list.body.data.tagsRevision).toBe("0");
  expect(map.tagsFor("6000", "2026-01-01")).toEqual({ taxLine: "scheduleC.line8" });
  // The setup is part of the book's record: a restart reads the same tags.
  await f.restart();
  expect(rows((await f.call("accounts.list")).body)["4000"]).toEqual({
    taxLine: "scheduleC.line1",
    roleKey: "revenue.sales",
  });
});

test("a book set up without tags has none, and an empty tag map keeps the original digest", async () => {
  const f = await chartFixture().then((fixture) => fixture.withBook(untaggedBook));
  const list = await f.call("accounts.list");
  expect(Object.values(rows(list.body))).toEqual([{}, {}, {}, {}]);
  expect(readAccountTags(f.service.store).hash).toBe(
    hashCanonical({ type: "AccountTagMap", tags: [] }).digest,
  );
  expect(readAccountTags(f.service.store).revision).toBe(0);
});

test("setup refuses tags that cannot be right and says which account and why", async () => {
  const f = await chartFixture();
  const attempt = (accounts: unknown[]) =>
    f.call("book.setup", { ...untaggedBook, accounts }, uuid());
  const [cash, capital, sales, expense] = untaggedBook.accounts;
  const unknownLine = await attempt([
    cash,
    capital,
    sales,
    { ...expense, tags: { taxLine: "scheduleC.line88" } },
  ]);
  expect(unknownLine.status).toBe(400);
  expect(unknownLine.body.error.code).toBe("unknown_tax_line");
  expect(unknownLine.body.error.message).toContain("5000");
  expect(unknownLine.body.error.details[0].path).toBe("input.accounts[3].tags.taxLine");
  const incomeClass = await attempt([
    cash,
    capital,
    { ...sales, tags: { cashFlowClass: "operating" } },
    expense,
  ]);
  expect(incomeClass.body.error.code).toBe("invalid_tag");
  expect(incomeClass.body.error.message).toContain("balance-sheet");
  const cashLiability = await attempt([
    cash,
    { code: "2000", name: "Card", role: "liability", tags: { cashFlowClass: "cash" } },
    capital,
    sales,
    expense,
  ]);
  expect(cashLiability.body.error.code).toBe("invalid_tag");
  const wrongRole = await attempt([
    cash,
    capital,
    sales,
    { ...expense, tags: { taxLine: "scheduleC.line1" } },
  ]);
  expect(wrongRole.body.error.message).toContain("Gross receipts or sales");
  const twice = await attempt([
    { ...cash, tags: { roleKey: "bank.main" } },
    { code: "1010", name: "Savings", role: "asset", tags: { roleKey: "bank.main" } },
    capital,
    sales,
    expense,
  ]);
  expect(twice.status).toBe(409);
  expect(twice.body.error.code).toBe("role_key_in_use");
  const unknownKey = await attempt([
    { ...cash, tags: { colour: "blue" } },
    capital,
    sales,
    expense,
  ]);
  expect(unknownKey.body.error.code).toBe("invalid_input");
  // None of that configured the book.
  expect((await f.call("book.get")).body.data.setup).toBeNull();
});

test("setTags records a change from a date; earlier dates keep the earlier tag", async () => {
  const f = await chartFixture().then((fixture) => fixture.withBook());
  const change = await f.call(
    "accounts.setTags",
    { accountId: "6000", effectiveOn: "2026-07-01", tags: { taxLine: "scheduleC.line22" } },
    uuid(),
  );
  expect(change.status).toBe(200);
  expect(change.body.data).toMatchObject({
    accountId: "6000",
    effectiveOn: "2026-07-01",
    tags: { taxLine: "scheduleC.line22" },
    changed: true,
    tagsRevision: "1",
    warnings: [],
  });
  const map = readAccountTags(f.service.store);
  expect(map.tagsFor("6000", "2026-06-30")).toEqual({ taxLine: "scheduleC.line8" });
  expect(map.tagsFor("6000", "2026-07-01")).toEqual({ taxLine: "scheduleC.line22" });
  expect(map.tagsFor("6000", "2027-01-01")).toEqual({ taxLine: "scheduleC.line22" });
  expect(map.tagsFor("4000", "2027-01-01")).toEqual({
    taxLine: "scheduleC.line1",
    roleKey: "revenue.sales",
  });
  // An earlier read of the same history is still available, and a later one is not mixed in.
  expect(
    readAccountTags(f.service.store, { throughRevision: 0 }).tagsFor("6000", "2027-01-01"),
  ).toEqual({
    taxLine: "scheduleC.line8",
  });
});

test("a tag can be set on an untagged account and cleared again, one tag at a time", async () => {
  const f = await chartFixture().then((fixture) => fixture.withBook());
  const set = await f.call(
    "accounts.setTags",
    {
      accountId: "6100",
      effectiveOn: "2026-01-01",
      tags: { taxLine: "scheduleC.line16b" },
    },
    uuid(),
  );
  expect(set.body.data.tags).toEqual({ taxLine: "scheduleC.line16b" });
  const cleared = await f.call(
    "accounts.setTags",
    { accountId: "6000", effectiveOn: "2026-03-01", tags: { taxLine: null } },
    uuid(),
  );
  expect(cleared.body.data).toMatchObject({ tags: {}, changed: true });
  const map = readAccountTags(f.service.store);
  expect(map.tagsFor("6000", "2026-02-28")).toEqual({ taxLine: "scheduleC.line8" });
  expect(map.tagsFor("6000", "2026-03-01")).toEqual({});
  // Clearing something that is not there is not a change.
  const again = await f.call(
    "accounts.setTags",
    { accountId: "6100", effectiveOn: "2026-01-01", tags: { cashFlowClass: null } },
    uuid(),
  );
  expect(again.body.data.changed).toBe(false);
});

test("recording the value already in force changes nothing, not even the revision", async () => {
  const f = await chartFixture().then((fixture) => fixture.withBook());
  const before = readAccountTags(f.service.store);
  const result = await f.call(
    "accounts.setTags",
    { accountId: "6000", effectiveOn: "2026-05-01", tags: { taxLine: "scheduleC.line8" } },
    uuid(),
  );
  expect(result.body.data).toMatchObject({
    changed: false,
    tagsRevision: "0",
    tagsHash: before.hash,
  });
  expect(readAccountTags(f.service.store).revision).toBe(0);
});

test("a correction on the same date supersedes the entry without erasing it", async () => {
  const f = await chartFixture().then((fixture) => fixture.withBook());
  const set = (taxLine: string) =>
    f.call(
      "accounts.setTags",
      { accountId: "6000", effectiveOn: "2026-07-01", tags: { taxLine } },
      uuid(),
    );
  await set("scheduleC.line22");
  await set("scheduleC.line18");
  expect(readAccountTags(f.service.store).tagsFor("6000", "2026-07-01")).toEqual({
    taxLine: "scheduleC.line18",
  });
  const history = (await f.call("accounts.tagHistory", { accountId: "6000" })).body.data;
  expect(
    history.events.map((event: { value: string; source: string }) => [event.source, event.value]),
  ).toEqual([
    ["setup", "scheduleC.line8"],
    ["change", "scheduleC.line22"],
    ["change", "scheduleC.line18"],
  ]);
  // The hash describes what is in force, so reaching the same state another way gives the same hash.
  const other = await chartFixture().then((fixture) => fixture.withBook());
  await other.call(
    "accounts.setTags",
    { accountId: "6000", effectiveOn: "2026-07-01", tags: { taxLine: "scheduleC.line18" } },
    uuid(),
  );
  expect(readAccountTags(f.service.store).hash).toBe(readAccountTags(other.service.store).hash);
});

test("the hash changes with any tag change and returns when the change is undone", async () => {
  const f = await chartFixture().then((fixture) => fixture.withBook());
  const hashes = [readAccountTags(f.service.store).hash];
  const set = async (accountId: string, effectiveOn: string, tags: object) => {
    const result = await f.call("accounts.setTags", { accountId, effectiveOn, tags }, uuid());
    expect(result.status).toBe(200);
    hashes.push(readAccountTags(f.service.store).hash);
  };
  await set("6000", "2026-07-01", { taxLine: "scheduleC.line22" });
  await set("6100", "2026-01-01", { taxLine: "scheduleC.line16b" });
  await set("1000", "2026-09-01", { cashFlowClass: "operating" });
  await set("2000", "2026-01-01", { roleKey: "card.main" });
  expect(new Set(hashes).size).toBe(hashes.length);
  // Put 6000 back the way it was on the same date: the effective tags are the setup's again.
  await set("6000", "2026-07-01", { taxLine: "scheduleC.line8" });
  await set("6100", "2026-01-01", { taxLine: null });
  await set("1000", "2026-09-01", { cashFlowClass: "cash" });
  await set("2000", "2026-01-01", { roleKey: null });
  expect(hashes.at(-1)).toBe(hashes[0]);
  // The tag list on the account list carries the hash and the revision a report would pin.
  const list = await f.call("accounts.list");
  expect(list.body.data.tagsHash).toBe(hashes[0]);
  expect(list.body.data.tagsRevision).toBe("8");
});

test("tag history shows setup tags first, then each change with its date and source", async () => {
  const f = await chartFixture().then((fixture) => fixture.withBook());
  await f.call(
    "accounts.setTags",
    { accountId: "4000", effectiveOn: "2026-04-01", tags: { taxLine: "scheduleC.line6" } },
    uuid(),
  );
  const history = (await f.call("accounts.tagHistory", { accountId: "4000" })).body.data;
  expect(history.accountId).toBe("4000");
  expect(history.tagsRevision).toBe("1");
  expect(history.tagsHash).toBe(readAccountTags(f.service.store).hash);
  expect(
    history.events.map(
      (event: { tag: string; effectiveOn: string; value: string; source: string }) => [
        event.source,
        event.tag,
        event.effectiveOn,
        event.value,
      ],
    ),
  ).toEqual([
    ["setup", "taxLine", "2026-01-01", "scheduleC.line1"],
    ["setup", "roleKey", "2026-01-01", "revenue.sales"],
    ["change", "taxLine", "2026-04-01", "scheduleC.line6"],
  ]);
  expect(history.events[2].recordedAt).toMatch(/^\d{4}-\d{2}-\d{2}T/);
  expect((await f.call("accounts.tagHistory", { accountId: "nope" })).status).toBe(404);
});

test("a retry returns the first response, even after a restart; different input is a conflict", async () => {
  const f = await chartFixture().then((fixture) => fixture.withBook());
  const id = uuid();
  const input = {
    accountId: "6000",
    effectiveOn: "2026-07-01",
    tags: { taxLine: "scheduleC.line22" },
  };
  const first = await f.call("accounts.setTags", input, id);
  expect(first.status).toBe(200);
  expect(await f.call("accounts.setTags", input, id)).toEqual(first);
  await f.restart();
  expect(await f.call("accounts.setTags", input, id)).toEqual(first);
  expect(readAccountTags(f.service.store).revision).toBe(1);
  const conflict = await f.call(
    "accounts.setTags",
    { ...input, tags: { taxLine: "scheduleC.line18" } },
    id,
  );
  expect(conflict.status).toBe(409);
  expect(conflict.body.error.code).toBe("operation_identity_conflict");
  expect((await f.call("accounts.setTags", input)).body.error.code).toBe("operation_id_required");
});

test("changing tags needs the configure permission; reading them needs read", async () => {
  const f = await chartFixture().then((fixture) => fixture.withBook());
  const input = {
    accountId: "6000",
    effectiveOn: "2026-07-01",
    tags: { taxLine: "scheduleC.line22" },
  };
  expect((await f.call("accounts.setTags", input, uuid(), ["read", "draft", "post"])).status).toBe(
    403,
  );
  expect((await f.call("accounts.setTags", input, uuid(), ["configure"])).status).toBe(200);
  expect(
    (await f.call("accounts.tagHistory", { accountId: "6000" }, undefined, ["draft"])).status,
  ).toBe(403);
  expect(
    (await f.call("accounts.tagHistory", { accountId: "6000" }, undefined, ["read"])).status,
  ).toBe(200);
});

test("a request that cannot be right is refused, says why, and leaves no trace", async () => {
  const f = await chartFixture().then((fixture) => fixture.withBook());
  const attempt = (accountId: string, effectiveOn: string, tags: object) =>
    f.call("accounts.setTags", { accountId, effectiveOn, tags }, uuid());
  const refused = async (
    status: number,
    code: string,
    accountId: string,
    effectiveOn: string,
    tags: object,
  ) => {
    const result = await attempt(accountId, effectiveOn, tags);
    expect({ status: result.status, code: result.body.error?.code }).toEqual({ status, code });
    return result.body.error;
  };
  await refused(404, "account_not_found", "9999", "2026-07-01", { taxLine: "scheduleC.line8" });
  await refused(400, "invalid_tag", "6000", "2026-07-01", { cashFlowClass: "operating" });
  await refused(400, "invalid_tag", "2000", "2026-07-01", { cashFlowClass: "cash" });
  await refused(400, "unknown_tax_line", "6000", "2026-07-01", { taxLine: "scheduleC.line99" });
  await refused(400, "unknown_tax_line", "6000", "2026-07-01", { taxLine: "form9999.line1" });
  await refused(400, "invalid_tag", "6000", "2026-07-01", { taxLine: "scheduleC.line1" });
  await refused(400, "invalid_input", "6000", "2026-07-01", { roleKey: "Not A Key" });
  await refused(400, "invalid_tag", "6000", "2026-07-01", {});
  await refused(400, "effective_date_invalid", "6000", "2026-02-30", { taxLine: null });
  await refused(400, "effective_date_invalid", "6000", "2101-01-01", { taxLine: null });
  const early = await refused(400, "effective_before_account_opened", "6000", "2025-12-31", {
    taxLine: null,
  });
  expect(early.message).toContain("2026-01-01");
  const taken = await refused(409, "role_key_in_use", "1000", "2026-07-01", {
    roleKey: "revenue.sales",
  });
  expect(taken.message).toContain("4000");
  // The schema stops a malformed tag before anything runs.
  const malformed = await attempt("6000", "2026-07-01", { taxLine: 5 });
  expect(malformed.body.error.code).toBe("invalid_input");
  expect(readAccountTags(f.service.store).revision).toBe(0);
  // A rejected identity can be sent again, corrected.
  const id = uuid();
  const bad = {
    accountId: "6000",
    effectiveOn: "2026-07-01",
    tags: { taxLine: "scheduleC.line99" },
  };
  expect((await f.call("accounts.setTags", bad, id)).status).toBe(400);
  const good = { ...bad, tags: { taxLine: "scheduleC.line22" } };
  expect((await f.call("accounts.setTags", good, id)).status).toBe(200);
});

test("a role key moves between accounts by clearing it first", async () => {
  const f = await chartFixture().then((fixture) => fixture.withBook());
  const move = (accountId: string, roleKey: string | null) =>
    f.call("accounts.setTags", { accountId, effectiveOn: "2026-02-01", tags: { roleKey } }, uuid());
  expect((await move("1000", "revenue.sales")).body.error.code).toBe("role_key_in_use");
  expect((await move("4000", null)).status).toBe(200);
  expect((await move("1000", "revenue.sales")).status).toBe(200);
  const map = readAccountTags(f.service.store);
  expect(map.tagsFor("1000", "2026-03-01").roleKey).toBe("revenue.sales");
  expect(map.tagsFor("4000", "2026-03-01").roleKey).toBeUndefined();
  expect(map.tagsFor("4000", "2026-01-31").roleKey).toBe("revenue.sales");
});

test("a change that reaches into a closed period says so, and one after it does not", async () => {
  const f = await chartFixture().then((fixture) => fixture.withBook());
  const periods = (await f.call("periods.list")).body.data.periods as { id: string }[];
  const close = (
    await f.call(
      "periods.prepare",
      { periodId: periods[0]?.id, operation: "close", reason: "January reviewed" },
      uuid(),
    )
  ).body.data;
  expect(
    (await f.call("operations.commit", { planId: close.planId, planHash: close.planHash })).body
      .data.disposition,
  ).toBe("committed");
  const inside = await f.call(
    "accounts.setTags",
    { accountId: "6000", effectiveOn: "2026-01-15", tags: { taxLine: "scheduleC.line22" } },
    uuid(),
  );
  expect(inside.status).toBe(200);
  expect(inside.body.data.warnings).toHaveLength(1);
  expect(inside.body.data.warnings[0]).toContain("2026-01-01 to 2026-01-31");
  const after = await f.call(
    "accounts.setTags",
    { accountId: "6000", effectiveOn: "2026-03-01", tags: { taxLine: "scheduleC.line18" } },
    uuid(),
  );
  expect(after.body.data.warnings).toEqual([]);
  // A change that changes nothing never warns.
  const nothing = await f.call(
    "accounts.setTags",
    { accountId: "6000", effectiveOn: "2026-01-15", tags: { taxLine: "scheduleC.line22" } },
    uuid(),
  );
  expect(nothing.body.data).toMatchObject({ changed: false, warnings: [] });
});

test("tag writes do not touch the ledger or any reported figure", async () => {
  const f = await chartFixture().then((fixture) => fixture.withBook());
  const before = (await f.call("reports.get", { asOf: "2026-01-31" })).body.data;
  const head = (await f.call("book.get")).body.data.head;
  await f.call(
    "accounts.setTags",
    { accountId: "6000", effectiveOn: "2026-01-01", tags: { taxLine: "scheduleC.line22" } },
    uuid(),
  );
  const after = (await f.call("reports.get", { asOf: "2026-01-31" })).body.data;
  expect(after.populationHash).toBe(before.populationHash);
  expect((await f.call("book.get")).body.data.head).toEqual(head);
});
