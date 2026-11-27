import { describe, expect, test } from "bun:test";
import {
  accountOptions,
  foldText,
  groupedInOrder,
  matchAccounts,
  offeredAccounts,
  type AccountOption,
  type AccountRowLike,
} from "../src/kit/accounts";
import { defaultMessages } from "../src/messages";

const rows: AccountRowLike[] = [
  { id: "a1", code: "1000", name: "Business checking", role: "asset" },
  { id: "a2", code: "1010", name: "Business savings", role: "asset" },
  { id: "l1", code: "2000", name: "Business credit card", role: "liability" },
  { id: "e0", code: "6000", name: "Operating expenses", role: "expense" },
  { id: "e1", code: "6100", name: "Office supplies", role: "expense", parentId: "e0" },
  { id: "e2", code: "6050", name: "Domestic", role: "expense", parentId: "e0" },
  { id: "e3", code: "6300", name: "Professional services", role: "expense", parentId: "e2" },
  { id: "e4", code: "6060", name: "International", role: "expense", parentId: "e0" },
  { id: "e5", code: "6350", name: "Professional services", role: "expense", parentId: "e4" },
  { id: "e9", code: "6900", name: "Legacy expenses", role: "expense", closedOn: "2025-12-31" },
  { id: "x1", code: "8000", name: "Other", role: "futureRole" },
];

describe("accountOptions", () => {
  const options = accountOptions(rows);
  const byId = (id: string) => options.find((option) => option.value === id) as AccountOption;

  test("a name, a code and the heading its kind is listed under, in the order of the rows", () => {
    expect(options.map((option) => option.value)).toEqual(rows.map((row) => row.id));
    expect(byId("a1")).toMatchObject({
      value: "a1",
      label: "Business checking",
      code: "1000",
      group: "Assets",
    });
    expect(byId("l1").group).toBe("Liabilities");
    expect(byId("e1").group).toBe("Expenses");
  });

  test("a kind it has no heading for is listed under its own name", () => {
    expect(byId("x1").group).toBe("futureRole");
  });

  test("an account with another account under it is a group, and nothing else is", () => {
    expect(options.filter((option) => option.isGroup).map((option) => option.value)).toEqual([
      "e0",
      "e2",
      "e4",
    ]);
  });

  test("where an account sits is its parents' names, so two with one name can be told apart", () => {
    expect(byId("e1").path).toBe("Operating expenses");
    expect(byId("e3").path).toBe("Operating expenses > Domestic");
    expect(byId("e5").path).toBe("Operating expenses > International");
    expect(byId("a1").path).toBeUndefined();
  });

  test("a closed account is listed but cannot be chosen, and says why", () => {
    expect(byId("e9")).toMatchObject({ disabled: true, reason: "Closed account" });
    expect(byId("e1").disabled).toBeUndefined();
  });

  test("a parent that is not in the rows makes nothing a group and gives no path", () => {
    const orphan = accountOptions([
      { id: "o1", code: "1", name: "Orphan", role: "asset", parentId: "gone" },
    ]);
    expect(orphan[0]?.isGroup).toBe(false);
    expect(orphan[0]?.path).toBeUndefined();
  });

  test("a parent loop (the kernel refuses one, but a picker must not hang on one) ends", () => {
    const loop = accountOptions([
      { id: "p", code: "1", name: "P", role: "asset", parentId: "q" },
      { id: "q", code: "2", name: "Q", role: "asset", parentId: "p" },
    ]);
    expect(loop.map((option) => option.path)).toEqual(["Q", "P"]);
  });

  test("the words are the application's, so a lane can reword them", () => {
    const reworded = accountOptions(rows, {
      headings: { asset: "Bank and cash" },
      closed: "Closed",
    });
    expect(reworded[0]?.group).toBe("Bank and cash");
    expect(reworded.find((option) => option.value === "e9")?.reason).toBe("Closed");
    expect(defaultMessages.account.headings.asset).toBe("Assets");
  });
});

describe("offeredAccounts", () => {
  const options = accountOptions(rows);
  test("a group account is never offered unless the picker is asked to", () => {
    const offered = offeredAccounts(options, false).map((option) => option.value);
    expect(offered).not.toContain("e0");
    expect(offered).not.toContain("e2");
    expect(offered).toContain("e1");
    expect(offered).toContain("e3");
  });

  test("asked to, it offers them all", () => {
    expect(offeredAccounts(options, true)).toHaveLength(rows.length);
  });

  test("an account in the old shape, with no group flag, is offered", () => {
    const legacy: AccountOption[] = [
      { value: "x", label: "1000 · Cash", path: "Assets / Current assets", group: "Assets" },
    ];
    expect(offeredAccounts(legacy, false)).toEqual(legacy);
  });
});

describe("foldText", () => {
  test("lower case, no accents, single spaces", () => {
    expect(foldText("  Café   SUPPLIES ")).toBe("cafe supplies");
    expect(foldText("Über Straße")).toBe("uber straße");
  });
});

describe("groupedInOrder", () => {
  const option = (value: string, group?: string): AccountOption => ({
    value,
    label: value,
    ...(group ? { group } : {}),
  });

  test("a ranked list that mixes the groups is put in the order the headings show it", () => {
    const ranked = [
      option("a1", "Assets"),
      option("e1", "Expenses"),
      option("a2", "Assets"),
      option("i1", "Income"),
      option("e2", "Expenses"),
    ];
    expect(groupedInOrder(ranked).map((item) => item.value)).toEqual([
      "a1",
      "a2",
      "e1",
      "e2",
      "i1",
    ]);
  });

  test("the heading of the best match is first, and each heading keeps the order it was given", () => {
    const ranked = [option("e1", "Expenses"), option("a1", "Assets"), option("e2", "Expenses")];
    expect(groupedInOrder(ranked).map((item) => item.value)).toEqual(["e1", "e2", "a1"]);
  });

  test("options with no heading stay together, in order, and nothing is lost or repeated", () => {
    const list = [option("x"), option("a1", "Assets"), option("y"), option("a2", "Assets")];
    expect(groupedInOrder(list).map((item) => item.value)).toEqual(["x", "y", "a1", "a2"]);
    expect(groupedInOrder([])).toEqual([]);
  });
});

describe("matchAccounts", () => {
  const accounts: AccountOption[] = [
    { value: "1", label: "Business checking", code: "1000" },
    { value: "2", label: "Business savings", code: "1010" },
    { value: "3", label: "Accounts payable", code: "2000" },
    { value: "4", label: "Office supplies", code: "6100" },
    { value: "5", label: "Supplies", code: "6110" },
    { value: "6", label: "Professional services", code: "6300", path: "Operating > Domestic" },
    { value: "7", label: "Professional services", code: "6350", path: "Operating > International" },
    { value: "8", label: "Café", code: "6400" },
    { value: "9", label: "Misc", code: "6500" },
    { value: "10", label: "6500 club", code: "7000" },
  ];
  const find = (query: string) => matchAccounts(accounts, query).map((account) => account.value);

  test("nothing typed lists every account in the order given", () => {
    expect(find("")).toEqual(accounts.map((account) => account.value));
    expect(find("   ")).toEqual(accounts.map((account) => account.value));
  });

  test("it finds a name by any part of it", () => {
    expect(find("chec")).toEqual(["1"]);
    expect(find("savings")).toEqual(["2"]);
  });

  test("every word typed has to be there, in any order", () => {
    expect(find("bus chec")).toEqual(["1"]);
    expect(find("checking business")).toEqual(["1"]);
    expect(find("1000 chec")).toEqual(["1"]);
    expect(find("bus xyz")).toEqual([]);
  });

  test("it finds an account by its code, and an exact code comes first", () => {
    expect(find("1010")).toEqual(["2"]);
    // "100" starts 1000's code and is inside 6100's.
    expect(find("100")).toEqual(["1", "4"]);
    expect(find("101")).toEqual(["2"]);
    // "6500" is Misc's code and the start of another account's name: the code wins.
    expect(find("6500")).toEqual(["9", "10"]);
  });

  test("the start of the name comes before the start of a word and before the middle of one", () => {
    expect(find("sup")).toEqual(["5", "4"]);
    const ranked: AccountOption[] = [
      { value: "middle", label: "Reexport fees" },
      { value: "word", label: "Operating expenses" },
      { value: "start", label: "Expenses" },
    ];
    expect(matchAccounts(ranked, "exp").map((account) => account.value)).toEqual([
      "start",
      "word",
      "middle",
    ]);
  });

  test("it finds an account by where it sits, which is how two of one name are told apart", () => {
    expect(find("professional")).toEqual(["6", "7"]);
    expect(find("professional international")).toEqual(["7"]);
    expect(find("domestic")).toEqual(["6"]);
  });

  test("accents and capitals do not matter", () => {
    expect(find("cafe")).toEqual(["8"]);
    expect(find("CAFÉ")).toEqual(["8"]);
    expect(find("BUSINESS")).toEqual(["1", "2"]);
  });

  test("a label in the old shape, with the code written into it, still matches both ways", () => {
    const legacy: AccountOption[] = [
      { value: "c", label: "1000 · Cash", path: "Assets / Current assets", group: "Assets" },
      { value: "o", label: "6100 · Office expenses", path: "Expenses / Operating expenses" },
    ];
    expect(matchAccounts(legacy, "6100").map((a) => a.value)).toEqual(["o"]);
    expect(matchAccounts(legacy, "cash").map((a) => a.value)).toEqual(["c"]);
    expect(matchAccounts(legacy, "expenses operating").map((a) => a.value)).toEqual(["o"]);
  });

  test("ties keep the order the chart gave", () => {
    expect(find("business")).toEqual(["1", "2"]);
  });

  test("nothing matches nothing", () => {
    expect(find("does not exist")).toEqual([]);
  });
});
