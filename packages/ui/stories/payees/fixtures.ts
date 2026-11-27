import { centsToMoney, moneyToCents } from "../../src/format";
import type {
  PayeeAmbiguousView,
  PayeeDetailData,
  PayeeReportData,
  PayeeRestView,
  PayeeRowView,
  PayeeTallyView,
  PayeeTestData,
  PayeeTransactionView,
  PayeeUnnamedView,
  PayeeView,
} from "../../src";

/** Invented data for the payees stories: a fictional design studio. Nothing here is real; names, bank texts
 * and amounts are made up, and the texts show the shape of what a bank writes. The figures are worked out
 * from the parts, so every report ties to its profit and loss the way the service's does. */

export const HASH = "9f2c41d7a0b83e65c7d1f4a29b60e8d35a7c1e04f9b2d86a3c5e7f10b4d9a26c";

const cents = (value: string): bigint => moneyToCents(value);
export const none = "0.00";

export const tally = (received: string, spent: string, transactions: number): PayeeTallyView => ({
  received,
  spent,
  transactions,
});

const net = (received: string, spent: string): string =>
  centsToMoney(cents(received) - cents(spent));

export function sum(items: readonly PayeeTallyView[]): PayeeTallyView {
  return {
    received: centsToMoney(items.reduce((total, item) => total + cents(item.received), 0n)),
    spent: centsToMoney(items.reduce((total, item) => total + cents(item.spent), 0n)),
    transactions: items.reduce((total, item) => total + item.transactions, 0),
  };
}

export const payeeRow = (
  payeeId: string,
  name: string,
  received: string,
  spent: string,
  transactions: number,
  firstOn = "2026-03-02",
  lastOn = "2026-03-27",
  retired = false,
): PayeeRowView => ({
  payeeId,
  name,
  retired,
  received,
  spent,
  net: net(received, spent),
  transactions,
  firstOn,
  lastOn,
});

export const unnamedRow = (
  key: string,
  text: string,
  suggestedWords: string,
  received: string,
  spent: string,
  transactions: number,
  firstOn = "2026-03-04",
  lastOn = "2026-03-25",
): PayeeUnnamedView => ({
  key,
  text,
  suggestedWords,
  received,
  spent,
  net: net(received, spent),
  transactions,
  firstOn,
  lastOn,
});

const noRest: PayeeRestView = { groups: 0, received: none, spent: none, transactions: 0 };

/** A report built from its parts. Whatever is not listed (the rows past the page, the texts past the
 * limit) is given as a tally, so the places still add up to the profit and loss. */
export function build(parts: {
  rows: readonly PayeeRowView[];
  rowCount?: number;
  hiddenRows?: PayeeTallyView;
  page?: number;
  pageSize?: number;
  unnamed: readonly PayeeUnnamedView[];
  unnamedCount?: number;
  unnamedRest?: PayeeRestView;
  ambiguous?: readonly PayeeAmbiguousView[];
  ambiguousRest?: PayeeRestView;
  byHand?: PayeeTallyView;
  noBankText?: PayeeTallyView;
  /** Made wrong on purpose: the profit and loss's income is this much more than the places add up to. */
  incomeOff?: string;
  warnings?: PayeeReportData["warnings"];
  from?: string;
  to?: string;
}): PayeeReportData {
  const ambiguous = parts.ambiguous ?? [];
  const unnamedRest = parts.unnamedRest ?? noRest;
  const ambiguousRest = parts.ambiguousRest ?? noRest;
  const byHand = parts.byHand ?? tally(none, none, 0);
  const noBankText = parts.noBankText ?? tally(none, none, 0);
  const places = {
    payees: sum([...parts.rows, ...(parts.hiddenRows ? [parts.hiddenRows] : [])]),
    unnamed: sum([...parts.unnamed, unnamedRest]),
    ambiguous: sum([...ambiguous, ambiguousRest]),
    noPayee: sum([byHand, noBankText]),
  };
  const totals = sum([places.payees, places.unnamed, places.ambiguous, places.noPayee]);
  return {
    from: parts.from ?? "2026-03-01",
    to: parts.to ?? "2026-03-31",
    currency: "USD",
    basis: "cash",
    bookRevision: "412",
    payeesRevision: "6",
    populationHash: HASH,
    direction: "both",
    rows: parts.rows,
    rowCount: parts.rowCount ?? parts.rows.length,
    page: parts.page ?? 1,
    pageSize: parts.pageSize ?? 100,
    unnamed: parts.unnamed,
    unnamedCount: parts.unnamedCount ?? parts.unnamed.length,
    unnamedRest,
    ambiguous,
    ambiguousCount: ambiguous.length,
    ambiguousRest,
    noPayee: { byHand, noBankText },
    totals,
    tieOut: {
      profitLossIncome: centsToMoney(cents(totals.received) + cents(parts.incomeOff ?? none)),
      profitLossExpenses: totals.spent,
      income: totals.received,
      expenses: totals.spent,
      places,
      matches: parts.incomeOff === undefined,
    },
    inboxRead: true,
    warnings: parts.warnings ?? [],
  };
}

// ---- The studio's March -------------------------------------------------------------------------

export const northwind = payeeRow("pay_northwind", "Northwind Design", "4000.00", none, 3);
export const stripe = payeeRow("pay_stripe", "Stripe", "2550.00", "193.18", 41);
export const adobe = payeeRow("pay_adobe", "Adobe", none, "164.97", 4, "2026-03-05", "2026-03-26");
export const uber = payeeRow("pay_uber", "Uber", none, "133.40", 6, "2026-03-03", "2026-03-24");
export const studioSpace = payeeRow(
  "pay_space",
  "Studio Space Co",
  none,
  "450.00",
  1,
  "2026-03-01",
  "2026-03-01",
  true,
);

export const bottle = unnamedRow(
  "sq blue bottle coffee #",
  "SQ *BLUE BOTTLE COFFEE 1234",
  "blue bottle coffee",
  none,
  "41.20",
  7,
);
export const acme = unnamedRow(
  "zelle payment from acme design #",
  "ZELLE PAYMENT FROM ACME DESIGN 7781",
  "acme design",
  "2550.00",
  none,
  1,
  "2026-03-12",
  "2026-03-12",
);
export const check = unnamedRow(
  "check #",
  "CHECK 1041",
  "",
  none,
  "750.00",
  1,
  "2026-03-09",
  "2026-03-09",
);
export const chipotle = unnamedRow("chipotle #", "CHIPOTLE 2188", "chipotle", none, "76.00", 4);

export const amazon: PayeeAmbiguousView = {
  key: "amazon mktplace amzn",
  text: "AMAZON MKTPLACE AMZN",
  payees: [
    { id: "pay_amazon", name: "Amazon" },
    { id: "pay_aws", name: "Amazon Web Services" },
  ],
  received: none,
  spent: "52.19",
  net: "-52.19",
  transactions: 2,
  firstOn: "2026-03-08",
  lastOn: "2026-03-19",
};

export const report: PayeeReportData = build({
  rows: [northwind, stripe, adobe, uber, studioSpace],
  unnamed: [acme, check, chipotle, bottle],
  ambiguous: [amazon],
  byHand: tally(none, "1200.00", 1),
  noBankText: tally(none, "18.50", 1),
});

/** Nobody is named yet: the first time the screen is opened on a book with a bank in it. */
export const unnamedOnly: PayeeReportData = build({
  rows: [],
  unnamed: [acme, check, chipotle, bottle],
  byHand: tally(none, "1200.00", 1),
});

export const empty: PayeeReportData = build({ rows: [], unnamed: [] });

/** Only payees: every text has a name. */
export const allNamed: PayeeReportData = build({
  rows: [northwind, stripe, adobe, uber],
  unnamed: [],
});

/** The proof does not hold: a report the service would refuse to give. Shown so the failure is plain. */
export const brokenProof: PayeeReportData = build({
  rows: [northwind, stripe, adobe, uber],
  unnamed: [chipotle],
  incomeOff: "0.01",
});

export const inboxUnreadable: PayeeReportData = build({
  rows: [northwind, stripe],
  unnamed: [chipotle],
  warnings: [
    {
      code: "inbox_unreadable",
      message:
        "The Inbox could not be read, so every entry was matched on its own narration. Names found in bank lines may be missing.",
    },
  ],
});

// ---- Hostile and long text ----------------------------------------------------------------------

export const LONG_WORD = `${"ABCDEFGHIJ".repeat(29)}0`;
export const HOSTILE_NAME = `<script>alert("payee")</script> ${"Ünïcödé ".repeat(8)}العربية 🙂 Ltd`;

export const longText: PayeeReportData = build({
  rows: [
    payeeRow("pay_long", HOSTILE_NAME.slice(0, 120), "1200.00", "35.00", 3),
    payeeRow("pay_plain", "Northwind Design", "800.00", none, 1),
  ],
  unnamed: [
    unnamedRow("long", LONG_WORD, "", none, "9.99", 2),
    unnamedRow(
      "spaces",
      "PAYMENT TO A BUSINESS WITH A VERY LONG NAME THAT THE BANK WROTE IN FULL, WITH ITS ADDRESS, ITS BRANCH AND THE REFERENCE THE CUSTOMER GAVE 118820044 THEREAFTER",
      "payment business",
      none,
      "120.00",
      1,
    ),
  ],
});

// ---- A big book ---------------------------------------------------------------------------------

/** A small deterministic generator, so the same story is the same every time. */
function numbers(seed: number): () => number {
  let state = seed;
  return () => {
    state = (state * 1103515245 + 12345) % 2147483648;
    return state;
  };
}

const nameAt = (index: number): string => NAMES[index % NAMES.length] ?? "";

const NAMES = [
  "Acme Design",
  "Birch Coffee",
  "Cedar Print",
  "Dunmore Law",
  "Elm Hosting",
  "Fenwick Supply",
  "Granite Freight",
  "Harbor Insurance",
  "Iris Fonts",
  "Juniper Travel",
];

export function manyReport(): PayeeReportData {
  const random = numbers(7);
  const money = (limit: number) => centsToMoney(BigInt(random() % limit) + 100n);
  const rows = Array.from({ length: 100 }, (_, index) =>
    payeeRow(
      `pay_${index}`,
      `${nameAt(index)} ${Math.floor(index / NAMES.length) + 1}`,
      index % 7 === 0 ? money(500_000) : none,
      index % 7 === 0 ? none : money(300_000),
      (random() % 40) + 1,
    ),
  );
  const unnamed = Array.from({ length: 100 }, (_, index) =>
    unnamedRow(
      `text ${index} #`,
      `POS PURCHASE ${nameAt(index).toUpperCase()} STORE ${1000 + index}`,
      nameAt(index).toLowerCase(),
      index % 11 === 0 ? money(200_000) : none,
      index % 11 === 0 ? none : money(80_000),
      (random() % 12) + 1,
    ),
  );
  return build({
    rows,
    rowCount: 137,
    hiddenRows: tally(none, "4210.55", 61),
    unnamed,
    unnamedCount: 142,
    unnamedRest: { groups: 42, received: none, spent: "812.30", transactions: 57 },
    ambiguous: [amazon],
    byHand: tally(none, "1200.00", 1),
  });
}

// ---- The sheets ---------------------------------------------------------------------------------

export const stripePayee: PayeeView = {
  id: "pay_stripe",
  version: 3,
  name: "Stripe",
  words: ["stripe", "stripe payments"],
  defaultAccountId: null,
  note: "Card payments from the studio's shop.",
  retired: false,
  hasTaxDetails: false,
  recordedAt: "2026-03-18T15:20:00.000Z",
  principal: "owner",
};

export const vendorPayee: PayeeView = {
  ...stripePayee,
  id: "pay_adobe",
  version: 2,
  name: "Adobe",
  words: ["adobe", "adobe systems"],
  note: "",
  hasTaxDetails: true,
};

export const bottlePayee: PayeeView = {
  id: "pay_bottle",
  version: 1,
  name: "Blue Bottle Coffee",
  words: ["blue bottle coffee"],
  defaultAccountId: null,
  note: "",
  retired: false,
  hasTaxDetails: false,
  recordedAt: "2026-03-20T09:00:00.000Z",
  principal: "agent:tok_1f3a",
};

const transaction = (
  index: number,
  text: string,
  spent: string,
  received = none,
  extra: Partial<PayeeTransactionView> = {},
): PayeeTransactionView => ({
  date: `2026-03-${String(2 + index).padStart(2, "0")}`,
  journalId: `jnl_${index}`,
  narration: text,
  text,
  textFrom: "description",
  received,
  spent,
  accounts: "6150 Software",
  payee: null,
  key: null,
  reverses: null,
  ...extra,
});

export function detail(
  overrides: Partial<PayeeDetailData> & Pick<PayeeDetailData, "subject">,
): PayeeDetailData {
  const transactions = overrides.transactions ?? [];
  return {
    payee: null,
    history: [],
    transactions,
    count: transactions.length,
    page: 1,
    pageSize: 50,
    totals: sum(transactions.map((row) => tally(row.received, row.spent, 1))),
    from: "2026-03-01",
    to: "2026-03-31",
    inboxRead: true,
    ...overrides,
  };
}

export const stripeDetail: PayeeDetailData = detail({
  subject: { kind: "payee", payeeId: "pay_stripe" },
  payee: stripePayee,
  history: [
    {
      version: 1,
      name: "Stripe",
      words: ["stripe"],
      note: "",
      retired: false,
      recordedAt: "2026-03-10T10:00:00.000Z",
      principal: "service:payees-migration",
      via: "migration",
    },
    {
      version: 2,
      name: "Stripe",
      words: ["stripe", "stripe payments"],
      note: "",
      retired: false,
      recordedAt: "2026-03-14T12:30:00.000Z",
      principal: "agent:tok_1f3a",
      via: "payees.save",
    },
    {
      version: 3,
      name: "Stripe",
      words: ["stripe", "stripe payments"],
      note: "Card payments from the studio's shop.",
      retired: false,
      recordedAt: "2026-03-18T15:20:00.000Z",
      principal: "owner",
      via: "payees.save",
    },
  ],
  transactions: [
    transaction(0, "Stripe", none, "840.00", {
      textFrom: "connector",
      accounts: "4000 Sales",
      key: "stripe",
    }),
    transaction(1, "STRIPE PAYMENTS FEE", "24.36", none, {
      accounts: "6310 Payment fees",
      key: "stripe payments",
    }),
    transaction(4, "Stripe", none, "1710.00", {
      textFrom: "connector",
      accounts: "4000 Sales",
      key: "stripe",
    }),
    transaction(9, "STRIPE REFUND 4491", "100.00", none, {
      accounts: "4000 Sales",
      key: "stripe",
      reverses: "jnl_0",
    }),
  ],
  count: 41,
  pageSize: 4,
});

export const unnamedDetail: PayeeDetailData = detail({
  subject: { kind: "unnamed", key: "sq blue bottle coffee #", text: "SQ *BLUE BOTTLE COFFEE 1234" },
  transactions: [
    transaction(1, "SQ *BLUE BOTTLE COFFEE 1234", "5.75", none, { accounts: "6170 Meals" }),
    transaction(3, "SQ *BLUE BOTTLE COFFEE 1250", "6.50", none, { accounts: "6170 Meals" }),
    transaction(6, "SQ *BLUE BOTTLE COFFEE 1288", "5.75", none, { accounts: "6170 Meals" }),
  ],
});

export const ambiguousDetail: PayeeDetailData = detail({
  subject: {
    kind: "ambiguous",
    key: "amazon mktplace amzn",
    text: "AMAZON MKTPLACE AMZN",
    payees: amazon.payees,
  },
  transactions: [
    transaction(6, "AMAZON MKTPLACE AMZN", "30.99", none, { accounts: "6120 Supplies" }),
    transaction(17, "AMAZON MKTPLACE AMZN", "21.20", none, { accounts: "6150 Software" }),
  ],
});

export const byHandDetail: PayeeDetailData = detail({
  subject: { kind: "no_payee", why: "by_hand" },
  transactions: [
    transaction(14, "Rent for March, paid by transfer", "1200.00", none, {
      accounts: "6500 Rent",
      text: "Rent for March, paid by transfer",
      textFrom: "narration",
    }),
  ],
});

export const longDetail: PayeeDetailData = detail({
  subject: { kind: "unnamed", key: "long", text: LONG_WORD },
  transactions: [
    transaction(1, LONG_WORD, "9.99", none, { accounts: `6990 ${"Miscellaneous ".repeat(12)}` }),
    transaction(5, "<img src=x onerror=alert(1)> PAYMENT", "4.50", none),
  ],
});

export const emptyDetail: PayeeDetailData = detail({
  subject: { kind: "payee", payeeId: "pay_stripe" },
  payee: stripePayee,
  transactions: [],
});

// ---- What some words find -----------------------------------------------------------------------

const nothing = tally(none, none, 0);

export const testFinds: PayeeTestData = {
  keys: ["blue bottle coffee"],
  problems: [],
  matches: tally(none, "41.20", 7),
  stays: nothing,
  fromUnnamed: tally(none, "29.45", 5),
  fromAmbiguous: nothing,
  fromNowhere: nothing,
  taken: [
    { payee: { id: "pay_bottle2", name: "Blue Bottle Roasters" }, tally: tally(none, "11.75", 2) },
  ],
  lost: nothing,
  tied: { ...nothing, payees: [] },
  beaten: [],
};

export const testNothing: PayeeTestData = {
  keys: ["no such words"],
  problems: [],
  matches: nothing,
  stays: nothing,
  fromUnnamed: nothing,
  fromAmbiguous: nothing,
  fromNowhere: nothing,
  taken: [],
  lost: nothing,
  tied: { ...nothing, payees: [] },
  beaten: [],
};

export const testTied: PayeeTestData = {
  ...testFinds,
  tied: {
    ...tally(none, "52.19", 2),
    payees: [
      { id: "pay_amazon", name: "Amazon" },
      { id: "pay_aws", name: "Amazon Web Services" },
    ],
  },
  taken: [],
  lost: tally(none, "8.00", 1),
  beaten: [
    { payee: { id: "pay_aws", name: "Amazon Web Services" }, tally: tally(none, "9.00", 1) },
  ],
};

export const testRefused: PayeeTestData = {
  ...testNothing,
  keys: [],
  problems: [
    {
      code: "invalid_input",
      message:
        'The words need at least 3 letters or digits: "ab" is too short and would match too many transactions.',
    },
    {
      code: "payee_key_in_use",
      message: '"stripe" already belongs to Stripe. A set of words names one payee.',
    },
  ],
};
