/**
 * The generator of journal admission inputs, for `admission.test.ts`.
 *
 * A case is a WORLD: a snapshot, a journal and a coordinate, made in two steps.
 *   1. A clean world: a chart, dimensions and members that are open on the accounting date, and a
 *      journal that admission admits (balanced, every posting valid, every required dimension
 *      selected once).
 *   2. Defects: some of the mutators below, each of which spoils one named thing, so that every
 *      diagnostic `journal.ts` can produce is reached often (`MUTATORS` says which one each
 *      targets), with now and then a heap of them at once.
 * The edge classes are mutators too: identifiers whose UTF-16 order and code point order differ,
 * ties on ordinals, enormous ordinals, amounts at and over the size limit, dates that are not dates.
 *
 * A world holds plain descriptions, not the shipped values, and `build*` makes the values with the
 * shipped constructors (`accountId`, `localDate`, `ExactDecimal.of`, ...). The wire is made from the
 * values (`wave2b-wire.ts`), so the model reads what the TypeScript read.
 *
 * Every source character in this file is ASCII: a code point is written as a number.
 */
import {
  type AccountSnapshot,
  type AccountingCoordinate,
  type AccountingDimensionSnapshot,
  type DimensionMemberSnapshot,
  ExactDecimal,
  ExactRational,
  type Instant,
  type JournalAdmissionSnapshot,
  type JournalKind,
  type JournalTransaction,
  type LocalDate,
  type Posting,
  accountId,
  bookId,
  commodityId,
  dimensionId,
  dimensionMemberId,
  instant,
  journalId,
  localDate,
  postingId,
} from "../src/index.ts";
import type { Rng } from "./wave2b-wire.ts";
import { chr, maxDay } from "./wave2a-wire.ts";

// ---------------------------------------------------------------------------------------------
// Descriptions
// ---------------------------------------------------------------------------------------------

export interface AccountSpec {
  id: string;
  bookId: string;
  code: string;
  name: string;
  role: AccountSnapshot["role"];
  normalSide: AccountSnapshot["normalSide"];
  postingAllowed: boolean;
  openedOn: string;
  closedOn?: string;
  parentId?: string;
  allowedCommodityIds: string[];
}

export interface DimensionSpec {
  id: string;
  bookId: string;
  code: string;
  name: string;
  openedOn: string;
  closedOn?: string;
}

export interface MemberSpec {
  id: string;
  dimensionId: string;
  code: string;
  name: string;
  openedOn: string;
  closedOn?: string;
  parentId?: string;
}

export interface SnapshotSpec {
  bookId: string;
  functionalCommodityId: string;
  accounts: AccountSpec[];
  dimensions: DimensionSpec[];
  members: MemberSpec[];
  required: string[];
  /** The map of required dimensions by posting, as pairs in the order of the object's keys. */
  byPosting?: [string, string[]][];
}

export interface PostingSpec {
  id: string;
  ordinal: bigint;
  accountId: string;
  units: { canonical: ExactRational; commodityId: string; source?: ExactDecimal };
  bookValue: { amount: ExactDecimal; functionalCommodityId: string };
  price?: { unitRate: ExactRational; base: string; quote: string };
  basis?: { total: ExactRational; commodityId: string; source?: ExactDecimal };
  members: string[];
}

export interface JournalSpec {
  id: string;
  kind: JournalKind;
  bookId: string;
  functionalCommodityId: string;
  economicAt: string;
  accountingDate: string;
  settledAt?: string;
  recordedAt: string;
  narration: string;
  postings: PostingSpec[];
}

export interface World {
  snapshot: SnapshotSpec;
  journal: JournalSpec;
  /** What differs between the coordinate and the first posting. */
  coordinate: { bookId: string; functionalCommodityId: string };
  /** The `requiredDimensionIds` argument of `validateAccountingCoordinate`. */
  coordinateRequired: string[];
  /** What the case is, for the counts that say the generator reached it. */
  tags: Set<string>;
  names: Names;
}

// ---------------------------------------------------------------------------------------------
// Names, dates, instants
// ---------------------------------------------------------------------------------------------

/** Code points whose UTF-16 order and code point order differ when they are mixed: the astral ones
 * (a pair of surrogates, below U+E000 in UTF-16) and the ones from U+E000 up. */
export const ORDER_POINTS = [
  0xe9, 0xff5e, 0x1f600, 0xe000, 0xd7ff, 0xffe5, 0x10000, 0x10ffff, 0xc0, 0x7a, 0x41, 0xff41, 0x3a9,
  0xfffd, 0xffff, 0x1d7d8, 0xf900, 0x20000,
];

export interface Names {
  readonly exotic: boolean;
  acc(index: number): string;
  dim(index: number): string;
  mem(index: number): string;
  post(index: number): string;
}

export function namesFor(r: Rng, exotic: boolean): Names {
  const bare = exotic && r.chance(0.5);
  // Posting identifiers that are numbers: keys that a JavaScript object orders before the others.
  const numeric = !exotic && r.chance(0.15);
  const make = (prefix: string, shift: number) => (index: number) => {
    if (!exotic) return `${prefix}${index + 1}`;
    const point = ORDER_POINTS[(index + shift) % ORDER_POINTS.length] as number;
    const round = Math.floor((index + shift) / ORDER_POINTS.length);
    return `${bare ? "" : prefix}${chr(point)}${round === 0 ? "" : String(round)}`;
  };
  return {
    exotic,
    acc: make("a", 3),
    dim: make("d", 7),
    mem: make("m", 0),
    post: numeric ? (index: number) => String(index) : make("p", 1),
  };
}

/** Valid local dates in ascending order. */
export const LADDER = [
  "0000-01-01",
  "1900-01-01",
  "1999-12-31",
  "2018-12-31",
  "2019-01-01",
  "2019-06-15",
  "2020-01-01",
  "2023-12-31",
  "2024-01-01",
  "2024-06-29",
  "2024-06-30",
  "2024-07-01",
  "2024-12-31",
  "2025-01-01",
  "2030-01-01",
  "2100-02-28",
  "9999-12-31",
];

/** Strings that are not dates, but are what a `LocalDate` is at run time: a string. They test that
 * the string comparison of the dates is the same on both sides, on any text. */
const WEIRD_DATES = [
  "",
  "2024-6-30",
  chr(0x1f600),
  chr(0xff5e),
  chr(0xe000),
  `2024-06-30${chr(0xe000)}`,
  `2024-06-30${chr(0x10000)}`,
  "2024-06-30T",
  " ",
  "9999-99-99",
  `${chr(0x10ffff)}`,
  "2024-06-3",
  "2024-06-300",
  chr(0xd7ff),
];

/** Instants, in many notations: a fraction of a second of any length, an offset of any kind. */
const INSTANT_EXAMPLES = [
  "2024-01-01T00:00:00Z",
  "2024-01-01T00:00:00.5Z",
  "2024-01-02T10:00:00+02:00",
  "2024-01-03T00:00:00.123456789-05:30",
  "2023-12-31T23:59:59.999+14:00",
  "0000-01-01T00:00:00Z",
  "9999-12-31T23:59:59.999999999999-14:00",
  "2024-02-29T12:30:45+00:00",
];

function randomInstant(r: Rng): string {
  if (r.chance(0.5)) return r.pick(INSTANT_EXAMPLES) as string;
  const pad2 = (n: number) => String(n).padStart(2, "0");
  const year = r.int(1900, 2100);
  const month = r.int(1, 12);
  const day = r.int(1, maxDay(year, month));
  const fraction = r.chance(0.5) ? "" : `.${String(r.int(0, 999999)).padStart(r.int(1, 6), "0")}`;
  const offset = r.chance(0.4)
    ? "Z"
    : `${r.chance(0.5) ? "+" : "-"}${pad2(r.int(0, 13))}:${pad2(r.int(0, 59))}`;
  return `${String(year).padStart(4, "0")}-${pad2(month)}-${pad2(day)}T${pad2(r.int(0, 23))}:${pad2(r.int(0, 59))}:${pad2(r.int(0, 59))}${fraction}${offset}`;
}

const NARRATIONS = [
  "n",
  "",
  "x y",
  `${chr(0x1f600)} caf${chr(0xe9)} ${chr(0)} end`,
  chr(0xff5e),
  "line\nbreak\r\n",
  `${chr(0xe000)}${chr(0x10000)}${chr(0xffff)}`,
  "Opening balance",
  " padded ",
  chr(0x301),
  "a".repeat(300),
];

// ---------------------------------------------------------------------------------------------
// The clean world
// ---------------------------------------------------------------------------------------------

const COMMODITIES = ["USD", "EUR", "BTC", "XAU"];
const ROLES: AccountSnapshot["role"][] = [
  "asset",
  "liability",
  "equity",
  "income",
  "expense",
  "gain",
  "unrealizedGain",
];
const KINDS: JournalKind[] = ["opening", "ordinary", "adjustment", "reversing", "closing"];
const CODE_TEXTS = [
  "1000",
  "1100",
  "2000",
  "3000",
  "4000",
  "5000",
  "6000",
  "7000",
  `9${chr(0xe9)}`,
  `x${chr(0)}y`,
  chr(0x1f600),
];

/** The index into `LADDER` of the accounting date, with room before and after. */
function cleanSnapshot(r: Rng, names: Names, dateIndex: number): SnapshotSpec {
  const before = () => LADDER[r.int(0, dateIndex)] as string;
  const after = () => LADDER[r.int(dateIndex, LADDER.length - 1)] as string;
  const accounts: AccountSpec[] = [];
  const accountCount = r.int(3, 6);
  const codes = r.shuffle(CODE_TEXTS);
  for (let index = 0; index < accountCount; index++) {
    accounts.push({
      id: names.acc(index),
      bookId: "b",
      code: codes[index] as string,
      name: "Account",
      role: r.pick(ROLES),
      normalSide: r.chance(0.5) ? "debit" : "credit",
      postingAllowed: true,
      openedOn: before(),
      ...(r.chance(0.3) ? { closedOn: after() } : {}),
      ...(index > 0 && r.chance(0.4) ? { parentId: names.acc(r.int(0, index - 1)) } : {}),
      allowedCommodityIds: r.chance(0.35) ? r.shuffle(COMMODITIES).slice(0, r.int(1, 3)) : [],
    });
  }
  const dimensions: DimensionSpec[] = [];
  const members: MemberSpec[] = [];
  const dimensionCount = r.weighted([1, 3, 4, 3]);
  let memberIndex = 0;
  for (let index = 0; index < dimensionCount; index++) {
    dimensions.push({
      id: names.dim(index),
      bookId: "b",
      code: `D${index}`,
      name: "Dimension",
      openedOn: before(),
      ...(r.chance(0.3) ? { closedOn: after() } : {}),
    });
    const first = members.length;
    const memberCount = r.int(1, 3);
    for (let at = 0; at < memberCount; at++) {
      members.push({
        id: names.mem(memberIndex++),
        dimensionId: names.dim(index),
        code: `M${at}`,
        name: "Member",
        openedOn: before(),
        ...(r.chance(0.3) ? { closedOn: after() } : {}),
        ...(at > 0 && r.chance(0.4)
          ? { parentId: (members[first + at - 1] as MemberSpec).id }
          : {}),
      });
    }
  }
  return {
    bookId: "b",
    functionalCommodityId: "USD",
    accounts,
    dimensions,
    members,
    required: r.subset(
      dimensions.map((d) => d.id),
      0.5,
    ),
  };
}

const small = (r: Rng) => BigInt(r.int(1, 500) * (r.chance(0.5) ? 1 : -1));

function cleanJournal(r: Rng, names: Names, snapshot: SnapshotSpec, date: string): JournalSpec {
  const postingCount = r.weighted([0, 0, 6, 4, 3, 2]); // 2 to 5 postings
  const postings: PostingSpec[] = [];
  // Amounts that add up to zero exactly: a common scale S, each posting a coefficient at its own
  // scale up to S, the last at scale S, cancelling the rest.
  const scale = r.int(0, 4);
  const coefficients: bigint[] = [];
  const scales: number[] = [];
  for (let index = 0; index < postingCount; index++) {
    scales.push(index === postingCount - 1 ? scale : r.int(0, scale));
    coefficients.push(small(r));
  }
  const others = (): bigint => {
    let sum = 0n;
    for (let index = 0; index < postingCount - 1; index++) {
      sum += (coefficients[index] as bigint) * 10n ** BigInt(scale - (scales[index] as number));
    }
    return sum;
  };
  coefficients[postingCount - 1] = -others();
  if (coefficients[postingCount - 1] === 0n) {
    // The rest add up to zero: move the first posting off its value (never onto zero).
    coefficients[0] = (coefficients[0] as bigint) + ((coefficients[0] as bigint) === -1n ? 2n : 1n);
    coefficients[postingCount - 1] = -others();
  }
  const useByPosting = r.chance(0.3);
  const byPosting: [string, string[]][] = [];
  const ordinals = r.shuffle(Array.from({ length: postingCount }, (_, index) => index));
  const dimensionIds = snapshot.dimensions.map((d) => d.id);
  for (let index = 0; index < postingCount; index++) {
    const id = names.post(index);
    const account = r.pick(snapshot.accounts) as AccountSpec;
    const commodity =
      account.allowedCommodityIds.length > 0
        ? (r.pick(account.allowedCommodityIds) as string)
        : (r.pick(COMMODITIES) as string);
    // The dimensions this posting must select.
    let required = snapshot.required;
    if (useByPosting && r.chance(0.6)) {
      required = r.subset(dimensionIds, 0.5);
      byPosting.push([id, required]);
    }
    const chosen: string[] = [];
    const wanted = new Set(required);
    for (const dimension of dimensionIds) {
      if (wanted.has(dimension) || r.chance(0.3)) {
        const options = snapshot.members.filter((m) => m.dimensionId === dimension);
        if (options.length > 0) chosen.push((r.pick(options) as MemberSpec).id);
      }
    }
    // Members may be chosen only when their dimension and they are open: all are, by construction.
    const sourceDecimal = r.chance(0.5)
      ? ExactDecimal.of(BigInt(r.int(-999, 999)), BigInt(r.int(0, 3)))
      : undefined;
    const canonical =
      sourceDecimal === undefined
        ? ExactRational.of(BigInt(r.int(-9, 9)), BigInt(r.int(1, 6)))
        : sourceDecimal.toRational();
    const basisSource = r.chance(0.5)
      ? ExactDecimal.of(BigInt(r.int(-999, 999)), BigInt(r.int(0, 3)))
      : undefined;
    postings.push({
      id,
      ordinal: BigInt(ordinals[index] as number),
      accountId: account.id,
      units: {
        canonical,
        commodityId: commodity,
        ...(sourceDecimal === undefined ? {} : { source: sourceDecimal }),
      },
      bookValue: {
        amount: ExactDecimal.of(coefficients[index] as bigint, BigInt(scales[index] as number)),
        functionalCommodityId: "USD",
      },
      ...(r.chance(0.3)
        ? {
            price: {
              unitRate: ExactRational.of(BigInt(r.int(1, 9)), BigInt(r.int(1, 4))),
              base: commodity,
              quote: "USD",
            },
          }
        : {}),
      ...(r.chance(0.3)
        ? {
            basis: {
              total:
                basisSource === undefined
                  ? ExactRational.of(BigInt(r.int(-50, 50)), BigInt(r.int(1, 5)))
                  : basisSource.toRational(),
              commodityId: "USD",
              ...(basisSource === undefined ? {} : { source: basisSource }),
            },
          }
        : {}),
      members: r.shuffle(chosen),
    });
  }
  if (useByPosting) snapshot.byPosting = byPosting;
  return {
    id: "j",
    kind: r.pick(KINDS),
    bookId: "b",
    functionalCommodityId: "USD",
    economicAt: randomInstant(r),
    accountingDate: date,
    ...(r.chance(0.3) ? { settledAt: randomInstant(r) } : {}),
    recordedAt: randomInstant(r),
    narration: r.pick(NARRATIONS),
    postings,
  };
}

export function cleanWorld(r: Rng, exoticChance = 0.35): World {
  const exotic = r.chance(exoticChance);
  const names = namesFor(r, exotic);
  const dateIndex = r.int(2, LADDER.length - 3);
  const date = LADDER[dateIndex] as string;
  const snapshot = cleanSnapshot(r, names, dateIndex);
  const journal = cleanJournal(r, names, snapshot, date);
  return {
    snapshot,
    journal,
    coordinate: { bookId: "b", functionalCommodityId: "USD" },
    coordinateRequired: [...snapshot.required],
    tags: new Set<string>(exotic ? ["exotic ids"] : []),
    names,
  };
}

// ---------------------------------------------------------------------------------------------
// Mutators: one defect each
// ---------------------------------------------------------------------------------------------

export type Group = "snapshot" | "site" | "journal" | "coordinate" | "edge" | "dates";

interface Mutator {
  readonly name: string;
  readonly group: Group;
  /** The diagnostic the defect is aimed at, for the reader. */
  readonly aim: string;
  readonly apply: (w: World, r: Rng) => void;
}

/** The accounts a posting reaches: the chart entry of a posting, if the chart has it. */
const accountOf = (w: World, posting: PostingSpec) =>
  w.snapshot.accounts.find((a) => a.id === posting.accountId);

const somePosting = (w: World, r: Rng): PostingSpec | undefined =>
  w.journal.postings.length === 0 ? undefined : (r.pick(w.journal.postings) as PostingSpec);

const someAccount = (w: World, r: Rng): AccountSpec | undefined =>
  w.snapshot.accounts.length === 0 ? undefined : (r.pick(w.snapshot.accounts) as AccountSpec);

const someDimension = (w: World, r: Rng): DimensionSpec | undefined =>
  w.snapshot.dimensions.length === 0 ? undefined : (r.pick(w.snapshot.dimensions) as DimensionSpec);

const someMember = (w: World, r: Rng): MemberSpec | undefined =>
  w.snapshot.members.length === 0 ? undefined : (r.pick(w.snapshot.members) as MemberSpec);

/** A date strictly after `date` and one strictly before it, if the ladder has them. */
const later = (date: string): string => LADDER.find((d) => d > date) ?? "9999-12-31";
const earlier = (date: string): string =>
  [...LADDER].reverse().find((d) => d < date) ?? "0000-01-01";

/** A decimal whose value is one unit of the last place more or less than the amount. */
function nudge(amount: ExactDecimal, by: bigint): ExactDecimal {
  try {
    return ExactDecimal.of(amount.coefficient + by, amount.scale);
  } catch {
    return amount; // an amount at the size limit cannot be nudged up
  }
}

function ensureDimensionWithMembers(w: World, r: Rng, members: number): DimensionSpec {
  let dimension: DimensionSpec;
  const existing = someDimension(w, r);
  if (existing === undefined) {
    dimension = {
      id: w.names.dim(0),
      bookId: "b",
      code: "D0",
      name: "Dimension",
      openedOn: LADDER[0] as string,
    };
    w.snapshot.dimensions.push(dimension);
  } else dimension = existing;
  const ownerId = dimension.id;
  while (w.snapshot.members.filter((m) => m.dimensionId === ownerId).length < members) {
    const index = w.snapshot.members.length;
    w.snapshot.members.push({
      id: w.names.mem(index + 20),
      dimensionId: ownerId,
      code: `Z${index}`,
      name: "Member",
      openedOn: LADDER[0] as string,
    });
  }
  return dimension;
}

const MUTATORS: Mutator[] = [
  // ---- the snapshot ----
  {
    name: "dupAccountId",
    group: "snapshot",
    aim: "canonical_identity_conflict @ snapshot.accounts",
    apply(w) {
      const [first, second] = w.snapshot.accounts;
      if (first !== undefined && second !== undefined) second.id = first.id;
    },
  },
  {
    name: "dupDimensionId",
    group: "snapshot",
    aim: "canonical_identity_conflict @ snapshot.dimensions",
    apply(w, r) {
      ensureDimensionWithMembers(w, r, 1);
      if (w.snapshot.dimensions.length < 2) {
        w.snapshot.dimensions.push({
          id: w.names.dim(9),
          bookId: "b",
          code: "D9",
          name: "Dimension",
          openedOn: LADDER[0] as string,
        });
      }
      (w.snapshot.dimensions[1] as DimensionSpec).id = (
        w.snapshot.dimensions[0] as DimensionSpec
      ).id;
    },
  },
  {
    name: "dupMemberId",
    group: "snapshot",
    aim: "canonical_identity_conflict @ snapshot.dimensionMembers",
    apply(w, r) {
      ensureDimensionWithMembers(w, r, 2);
      const [first, second] = w.snapshot.members;
      if (first !== undefined && second !== undefined) second.id = first.id;
    },
  },
  {
    name: "accountOtherBook",
    group: "snapshot",
    aim: "book_isolation_violation @ snapshot.accounts[].bookId",
    apply(w, r) {
      const account = someAccount(w, r);
      if (account !== undefined) account.bookId = "b2";
    },
  },
  {
    name: "dupAccountCode",
    group: "snapshot",
    aim: "invalid_chart_or_account @ snapshot.accounts[].code",
    apply(w) {
      const [first, , third] = w.snapshot.accounts;
      const last = w.snapshot.accounts[w.snapshot.accounts.length - 1];
      if (first !== undefined && last !== undefined && last !== first) {
        (third ?? last).code = first.code;
      }
    },
  },
  {
    name: "accountClosesBeforeOpens",
    group: "snapshot",
    aim: "invalid_chart_or_account @ snapshot.accounts[].closedOn",
    apply(w, r) {
      const account = someAccount(w, r);
      if (account !== undefined) {
        account.openedOn = r.pick(LADDER.slice(3)) as string;
        account.closedOn = earlier(account.openedOn);
      }
    },
  },
  {
    name: "accountParentUnresolved",
    group: "snapshot",
    aim: "invalid_chart_or_account @ snapshot.accounts[].parentId (unresolved)",
    apply(w, r) {
      const account = someAccount(w, r);
      if (account !== undefined) account.parentId = r.pick(["zz", w.names.acc(40), ""]) as string;
    },
  },
  {
    name: "accountParentCycle",
    group: "snapshot",
    aim: "invalid_chart_or_account @ snapshot.accounts[].parentId (cycle)",
    apply(w, r) {
      const accounts = w.snapshot.accounts;
      if (accounts.length === 0) return;
      const shape = r.int(0, 2);
      const [a, b, c] = accounts as [AccountSpec, AccountSpec | undefined, AccountSpec | undefined];
      if (shape === 0 || b === undefined) a.parentId = a.id;
      else if (shape === 1 || c === undefined) {
        a.parentId = b.id;
        b.parentId = a.id;
      } else {
        a.parentId = b.id;
        b.parentId = c.id;
        c.parentId = a.id;
      }
    },
  },
  {
    name: "dimensionOtherBook",
    group: "snapshot",
    aim: "book_isolation_violation @ snapshot.dimensions[].bookId",
    apply(w, r) {
      const dimension = ensureDimensionWithMembers(w, r, 1);
      dimension.bookId = "b2";
    },
  },
  {
    name: "dupDimensionCode",
    group: "snapshot",
    aim: "invalid_dimension_selection @ snapshot.dimensions[].code",
    apply(w, r) {
      ensureDimensionWithMembers(w, r, 1);
      if (w.snapshot.dimensions.length < 2) {
        w.snapshot.dimensions.push({
          id: w.names.dim(9),
          bookId: "b",
          code: "D9",
          name: "Dimension",
          openedOn: LADDER[0] as string,
        });
      }
      (w.snapshot.dimensions[w.snapshot.dimensions.length - 1] as DimensionSpec).code = (
        w.snapshot.dimensions[0] as DimensionSpec
      ).code;
    },
  },
  {
    name: "dimensionClosesBeforeOpens",
    group: "snapshot",
    aim: "invalid_dimension_selection @ snapshot.dimensions[].closedOn",
    apply(w, r) {
      const dimension = ensureDimensionWithMembers(w, r, 1);
      dimension.openedOn = r.pick(LADDER.slice(3)) as string;
      dimension.closedOn = earlier(dimension.openedOn);
    },
  },
  {
    name: "memberDimensionUnresolved",
    group: "snapshot",
    aim: "invalid_dimension_selection @ snapshot.dimensionMembers[].dimensionId",
    apply(w, r) {
      ensureDimensionWithMembers(w, r, 1);
      const member = someMember(w, r);
      if (member !== undefined) member.dimensionId = r.pick(["dz", w.names.dim(40)]) as string;
    },
  },
  {
    name: "dupMemberCode",
    group: "snapshot",
    aim: "invalid_dimension_selection @ snapshot.dimensionMembers[].code",
    apply(w, r) {
      const dimension = ensureDimensionWithMembers(w, r, 2);
      const owned = w.snapshot.members.filter((m) => m.dimensionId === dimension.id);
      (owned[1] as MemberSpec).code = (owned[0] as MemberSpec).code;
    },
  },
  {
    name: "memberClosesBeforeOpens",
    group: "snapshot",
    aim: "invalid_dimension_selection @ snapshot.dimensionMembers[].closedOn",
    apply(w, r) {
      ensureDimensionWithMembers(w, r, 1);
      const member = someMember(w, r);
      if (member !== undefined) {
        member.openedOn = r.pick(LADDER.slice(3)) as string;
        member.closedOn = earlier(member.openedOn);
      }
    },
  },
  {
    name: "memberParentUnresolved",
    group: "snapshot",
    aim: "invalid_dimension_selection @ snapshot.dimensionMembers[].parentId (unresolved or other dimension)",
    apply(w, r) {
      ensureDimensionWithMembers(w, r, 2);
      const member = someMember(w, r);
      if (member === undefined) return;
      const other = w.snapshot.members.find((m) => m.dimensionId !== member.dimensionId);
      member.parentId = other !== undefined && r.chance(0.5) ? other.id : "mz";
    },
  },
  {
    name: "memberParentCycle",
    group: "snapshot",
    aim: "invalid_dimension_selection @ snapshot.dimensionMembers[].parentId (cycle)",
    apply(w, r) {
      const dimension = ensureDimensionWithMembers(w, r, 2);
      const owned = w.snapshot.members.filter((m) => m.dimensionId === dimension.id);
      const [a, b] = owned as [MemberSpec, MemberSpec];
      if (r.chance(0.4)) a.parentId = a.id;
      else {
        a.parentId = b.id;
        b.parentId = a.id;
      }
    },
  },
  {
    name: "requiredUnresolved",
    group: "snapshot",
    aim: "invalid_dimension_selection @ snapshot.requiredDimensionIds",
    apply(w, r) {
      if (w.snapshot.required.length > 0 && r.chance(0.5)) {
        w.snapshot.required[r.int(0, w.snapshot.required.length - 1)] = "dz";
      } else w.snapshot.required.push("dz");
    },
  },
  {
    name: "requiredDuplicate",
    group: "snapshot",
    aim: "(coordinate.requiredDimensionIds) and a doubled requirement",
    apply(w, r) {
      const dimension = ensureDimensionWithMembers(w, r, 1);
      w.snapshot.required.push(dimension.id, dimension.id);
      w.coordinateRequired = [...w.snapshot.required];
    },
  },
  // ---- the coordinate and the postings: the account ----
  {
    name: "accountUnresolved",
    group: "site",
    aim: "invalid_chart_or_account @ .accountId (unresolved)",
    apply(w, r) {
      const posting = somePosting(w, r);
      if (posting !== undefined) posting.accountId = r.pick(["a9", w.names.acc(40)]) as string;
    },
  },
  {
    name: "accountNotPostingAllowed",
    group: "site",
    aim: "invalid_chart_or_account @ .accountId (not posting-enabled)",
    apply(w, r) {
      const posting = somePosting(w, r);
      const account = posting === undefined ? undefined : accountOf(w, posting);
      if (account !== undefined) account.postingAllowed = false;
    },
  },
  {
    name: "accountNotYetOpen",
    group: "site",
    aim: "invalid_chart_or_account @ .accountId (opens later)",
    apply(w, r) {
      const posting = somePosting(w, r);
      const account = posting === undefined ? undefined : accountOf(w, posting);
      if (account !== undefined) account.openedOn = later(w.journal.accountingDate);
    },
  },
  {
    name: "accountClosed",
    group: "site",
    aim: "invalid_chart_or_account @ .accountId (closed earlier)",
    apply(w, r) {
      const posting = somePosting(w, r);
      const account = posting === undefined ? undefined : accountOf(w, posting);
      if (account !== undefined) {
        account.openedOn = LADDER[0] as string;
        account.closedOn = earlier(w.journal.accountingDate);
      }
    },
  },
  {
    name: "commodityNotAllowed",
    group: "site",
    aim: "invalid_chart_or_account @ .units.commodityId",
    apply(w, r) {
      const posting = somePosting(w, r);
      const account = posting === undefined ? undefined : accountOf(w, posting);
      if (posting !== undefined && account !== undefined) {
        account.allowedCommodityIds = [r.pick(["EUR", "BTC", "XAU"]) as string];
        posting.units.commodityId = "USD";
        if (posting.price !== undefined) posting.price.base = "USD";
      }
    },
  },
  // ---- the coordinate and the postings: the members ----
  {
    name: "memberUnresolved",
    group: "site",
    aim: "invalid_dimension_selection @ .dimensionMemberIds (unresolved)",
    apply(w, r) {
      const posting = somePosting(w, r);
      if (posting !== undefined) {
        posting.members.splice(
          r.int(0, posting.members.length),
          0,
          r.pick(["mx", w.names.mem(40)]) as string,
        );
      }
    },
  },
  {
    name: "memberDimensionClosed",
    group: "site",
    aim: "invalid_dimension_selection @ .dimensionMemberIds (dimension closed)",
    apply(w, r) {
      const posting = somePosting(w, r);
      const member =
        posting === undefined
          ? undefined
          : w.snapshot.members.find((m) => posting.members.includes(m.id));
      const dimension =
        member === undefined
          ? undefined
          : w.snapshot.dimensions.find((d) => d.id === member.dimensionId);
      if (dimension !== undefined) {
        dimension.openedOn = LADDER[0] as string;
        dimension.closedOn = earlier(w.journal.accountingDate);
      }
    },
  },
  {
    name: "memberClosed",
    group: "site",
    aim: "invalid_dimension_selection @ .dimensionMemberIds (member closed)",
    apply(w, r) {
      const posting = somePosting(w, r);
      const member =
        posting === undefined
          ? undefined
          : w.snapshot.members.find((m) => posting.members.includes(m.id));
      if (member !== undefined) {
        member.openedOn = LADDER[0] as string;
        member.closedOn = earlier(w.journal.accountingDate);
      }
    },
  },
  {
    name: "memberNotYetOpen",
    group: "site",
    aim: "invalid_dimension_selection @ .dimensionMemberIds (member opens later)",
    apply(w, r) {
      const posting = somePosting(w, r);
      const member =
        posting === undefined
          ? undefined
          : w.snapshot.members.find((m) => posting.members.includes(m.id));
      if (member !== undefined) member.openedOn = later(w.journal.accountingDate);
    },
  },
  {
    name: "memberDimensionOtherBook",
    group: "site",
    aim: "invalid_dimension_selection @ .dimensionMemberIds (dimension of another book)",
    apply(w, r) {
      const posting = somePosting(w, r);
      const member =
        posting === undefined
          ? undefined
          : w.snapshot.members.find((m) => posting.members.includes(m.id));
      const dimension =
        member === undefined
          ? undefined
          : w.snapshot.dimensions.find((d) => d.id === member.dimensionId);
      if (dimension !== undefined) dimension.bookId = "b2";
    },
  },
  {
    name: "memberOfMissingDimension",
    group: "site",
    aim: "invalid_dimension_selection @ .dimensionMemberIds (member's dimension does not resolve)",
    apply(w, r) {
      const posting = somePosting(w, r);
      const member =
        posting === undefined
          ? undefined
          : w.snapshot.members.find((m) => posting.members.includes(m.id));
      if (member !== undefined) member.dimensionId = "dz";
    },
  },
  {
    name: "twoMembersOfOneDimension",
    group: "site",
    aim: "invalid_dimension_selection @ .dimensionMemberIds (two of one dimension)",
    apply(w, r) {
      const posting = somePosting(w, r);
      if (posting === undefined) return;
      const dimension = ensureDimensionWithMembers(w, r, 2);
      const owned = w.snapshot.members.filter((m) => m.dimensionId === dimension.id);
      // Open on the date, so that the defect is the repetition and not the dates.
      dimension.openedOn = LADDER[0] as string;
      delete dimension.closedOn;
      for (const member of owned) {
        member.openedOn = LADDER[0] as string;
        delete member.closedOn;
      }
      const ids = new Set(owned.map((m) => m.id));
      const first = (owned[0] as MemberSpec).id;
      const second = r.chance(0.35) ? first : (owned[1] as MemberSpec).id;
      posting.members = [...posting.members.filter((id) => !ids.has(id)), first, second];
    },
  },
  {
    name: "omitRequired",
    group: "site",
    aim: "invalid_dimension_selection @ .dimensionMemberIds (omits required)",
    apply(w, r) {
      const posting = somePosting(w, r);
      if (posting === undefined) return;
      posting.members = [];
      if (w.snapshot.byPosting !== undefined) {
        w.snapshot.byPosting = w.snapshot.byPosting.filter(([key]) => key !== posting.id);
      }
      if (w.snapshot.required.length === 0) {
        const dimension = ensureDimensionWithMembers(w, r, 1);
        w.snapshot.required.push(dimension.id);
        w.coordinateRequired = [...w.snapshot.required];
      }
    },
  },
  // ---- the journal ----
  {
    name: "journalOtherBook",
    group: "journal",
    aim: "book_isolation_violation @ journal.bookId",
    apply(w) {
      w.journal.bookId = "b2";
    },
  },
  {
    name: "journalFunctionalMismatch",
    group: "journal",
    aim: "monetary_type_mismatch @ journal.functionalCommodityId",
    apply(w) {
      w.journal.functionalCommodityId = "EUR";
    },
  },
  {
    name: "fewPostings",
    group: "journal",
    aim: "invalid_journal_structure @ journal.postings (fewer than two)",
    apply(w, r) {
      w.journal.postings = w.journal.postings.slice(0, r.int(0, 1));
    },
  },
  {
    name: "dupPostingId",
    group: "journal",
    aim: "invalid_journal_structure @ journal.postings[].id",
    apply(w) {
      const [first, second] = w.journal.postings;
      if (first !== undefined && second !== undefined) second.id = first.id;
    },
  },
  {
    name: "negativeOrdinal",
    group: "journal",
    aim: "invalid_journal_structure @ journal.postings[].ordinal (negative)",
    apply(w, r) {
      const posting = somePosting(w, r);
      if (posting !== undefined)
        posting.ordinal = r.chance(0.7) ? -1n : -(2n ** BigInt(r.int(1, 200)));
    },
  },
  {
    name: "dupOrdinal",
    group: "journal",
    aim: "invalid_journal_structure @ journal.postings[].ordinal (duplicated)",
    apply(w) {
      const [first, second] = w.journal.postings;
      if (first !== undefined && second !== undefined) second.ordinal = first.ordinal;
    },
  },
  {
    name: "zeroAmount",
    group: "journal",
    aim: "invalid_journal_structure @ journal.postings[].bookValue.amount",
    apply(w, r) {
      const posting = somePosting(w, r);
      if (posting !== undefined)
        posting.bookValue.amount = ExactDecimal.of(0n, BigInt(r.int(0, 4)));
    },
  },
  {
    name: "postingFunctionalMismatch",
    group: "journal",
    aim: "monetary_type_mismatch @ journal.postings[].bookValue.functionalCommodityId",
    apply(w, r) {
      const posting = somePosting(w, r);
      if (posting !== undefined) posting.bookValue.functionalCommodityId = "EUR";
    },
  },
  {
    name: "unitsSourceMismatch",
    group: "journal",
    aim: "invalid_exact_number @ journal.postings[].units",
    apply(w, r) {
      const posting = somePosting(w, r);
      if (posting === undefined) return;
      const source = posting.units.source ?? ExactDecimal.of(BigInt(r.int(-9, 9)), 1n);
      posting.units.source = nudge(source, BigInt(r.pick([1, -1, 7])));
    },
  },
  {
    name: "basisSourceMismatch",
    group: "journal",
    aim: "invalid_exact_number @ journal.postings[].costBasis",
    apply(w, r) {
      const posting = somePosting(w, r);
      if (posting === undefined) return;
      const source = posting.basis?.source ?? ExactDecimal.of(BigInt(r.int(-9, 9)), 1n);
      const total = posting.basis?.total ?? ExactRational.of(3n, 2n);
      posting.basis = {
        total,
        commodityId: posting.basis?.commodityId ?? "USD",
        source: nudge(source, BigInt(r.pick([1, -1, 7]))),
      };
    },
  },
  {
    name: "priceInvalid",
    group: "journal",
    aim: "monetary_type_mismatch @ journal.postings[].transactionPrice",
    apply(w, r) {
      const posting = somePosting(w, r);
      if (posting === undefined) return;
      const price = posting.price ?? {
        unitRate: ExactRational.of(2n, 1n),
        base: posting.units.commodityId,
        quote: "USD",
      };
      switch (r.int(0, 3)) {
        case 0:
          price.unitRate = ExactRational.zero();
          break;
        case 1:
          price.unitRate = ExactRational.of(-BigInt(r.int(1, 9)), BigInt(r.int(1, 4)));
          break;
        case 2:
          price.base = posting.units.commodityId === "BTC" ? "EUR" : "BTC";
          break;
        default:
          price.quote = "EUR";
      }
      posting.price = price;
    },
  },
  {
    name: "basisCommodityMismatch",
    group: "journal",
    aim: "monetary_type_mismatch @ journal.postings[].costBasis.basisCommodityId",
    apply(w, r) {
      const posting = somePosting(w, r);
      if (posting === undefined) return;
      posting.basis = {
        total: posting.basis?.total ?? ExactRational.of(5n, 3n),
        commodityId: "EUR",
        ...(posting.basis?.source === undefined ? {} : { source: posting.basis.source }),
      };
    },
  },
  {
    name: "imbalance",
    group: "journal",
    aim: "journal_imbalance @ journal.postings",
    apply(w, r) {
      const posting = somePosting(w, r);
      if (posting !== undefined) {
        posting.bookValue.amount = nudge(posting.bookValue.amount, BigInt(r.pick([1, -1, 3, 100])));
        // A nudge to zero would be the other defect; leave it, it is one more case.
      }
    },
  },
  // ---- the coordinate ----
  {
    name: "coordinateOtherBook",
    group: "coordinate",
    aim: "book_isolation_violation @ coordinate.bookId",
    apply(w) {
      w.coordinate.bookId = "b2";
    },
  },
  {
    name: "coordinateFunctionalMismatch",
    group: "coordinate",
    aim: "monetary_type_mismatch @ coordinate.functionalCommodityId",
    apply(w) {
      w.coordinate.functionalCommodityId = "EUR";
    },
  },
  {
    name: "coordinateRequiredBad",
    group: "coordinate",
    aim: "invalid_dimension_selection @ coordinate.requiredDimensionIds",
    apply(w, r) {
      const dimension = someDimension(w, r);
      switch (r.int(0, 2)) {
        case 0:
          w.coordinateRequired = [...w.coordinateRequired, "dz"];
          break;
        case 1:
          if (dimension !== undefined)
            w.coordinateRequired = [...w.coordinateRequired, dimension.id, dimension.id];
          else w.coordinateRequired = ["dz", "dz"];
          break;
        default:
          w.coordinateRequired = [...w.coordinateRequired, w.names.dim(40)];
      }
    },
  },
  {
    name: "dateEarly",
    group: "site",
    aim: "the accounting date before everything opens",
    apply(w) {
      w.journal.accountingDate = LADDER[0] as string;
    },
  },
  {
    name: "dateLate",
    group: "site",
    aim: "the accounting date after everything closes",
    apply(w) {
      w.journal.accountingDate = LADDER[LADDER.length - 1] as string;
    },
  },
  // ---- edges ----
  {
    name: "ordinalTies",
    group: "edge",
    aim: "postings with one ordinal, ordered by identifier",
    apply(w, r) {
      const value = BigInt(r.int(0, 1));
      for (const posting of w.journal.postings) {
        posting.ordinal = r.chance(0.8) ? value : BigInt(r.int(0, 2));
      }
      w.tags.add("ordinal ties");
    },
  },
  {
    name: "hugeOrdinals",
    group: "edge",
    aim: "ordinals whose difference is not a number",
    apply(w, r) {
      for (const posting of w.journal.postings) {
        const magnitude = 2n ** BigInt(r.pick([53, 64, 128, 1023, 1024, 1100, 2000, 5000]));
        posting.ordinal = r.chance(0.3) ? -magnitude : magnitude + BigInt(r.int(0, 3));
      }
      w.tags.add("huge ordinals");
    },
  },
  {
    name: "overLimit",
    group: "edge",
    aim: "an amount sum over the size limit: the exact-number error",
    apply(w, r) {
      const [first, second] = w.journal.postings;
      if (first === undefined || second === undefined) return;
      const bits = r.pick([16000, 16383, 16384]);
      const big = (1n << BigInt(bits - 1)) + BigInt(r.int(0, 12345));
      first.bookValue.amount = ExactDecimal.of(big, BigInt(r.pick([0, 2, 1000])));
      second.bookValue.amount = ExactDecimal.of(
        r.chance(0.5) ? big : -big + 1n,
        BigInt(r.pick([0, 3, 999])),
      );
      w.tags.add("size limit");
    },
  },
  {
    name: "atLimit",
    group: "edge",
    aim: "amounts at the size limit, whose sum is just inside or just outside it",
    apply(w, r) {
      const [first, second, third] = w.journal.postings;
      if (first === undefined || second === undefined) return;
      const top = 1n << 16383n; // the smallest number of 16384 binary digits
      const limit = (1n << 16384n) - 1n; // the largest
      const firstValue = r.chance(0.3) ? -top : top;
      const secondValue = [top - 1n, top, -top, -(top - 1n), limit, -limit][r.int(0, 5)] as bigint;
      first.bookValue.amount = ExactDecimal.of(firstValue, 0n);
      second.bookValue.amount = ExactDecimal.of(secondValue, 0n);
      if (third !== undefined) {
        const rest = -(firstValue + secondValue);
        const fits = rest !== 0n && (rest < 0n ? -rest : rest) <= limit;
        third.bookValue.amount = ExactDecimal.of(fits ? rest : -1n, 0n);
      }
      w.tags.add("size limit");
    },
  },
  {
    name: "manyPostings",
    group: "edge",
    aim: "many postings, with ties on both ordinal and identifier: a stable order is the only order",
    apply(w, r) {
      const base = w.journal.postings;
      if (base.length === 0) return;
      const total = r.int(10, 40);
      const ids = [w.names.post(0), w.names.post(1), w.names.post(2)];
      const out: PostingSpec[] = [];
      for (let index = 0; index < total; index++) {
        const from = base[index % base.length] as PostingSpec;
        out.push({
          ...from,
          id: r.pick(ids) as string,
          ordinal: BigInt(r.int(0, 2)),
          // Each copy keeps its own place in the input by what it holds.
          bookValue: {
            amount: ExactDecimal.of(BigInt(index + 1), 0n),
            functionalCommodityId: from.bookValue.functionalCommodityId,
          },
          members: r.shuffle(from.members),
        });
      }
      w.journal.postings = out;
      w.tags.add("many postings");
    },
  },
  {
    name: "scopedCodeCollision",
    group: "snapshot",
    aim: "two members whose dimension and code run together into one scoped code (the NUL separator)",
    apply(w, r) {
      // The scoped code of a member is its dimension, a NUL and its code. With a dimension
      // identifier that holds a NUL, two members of two dimensions can have one scoped code.
      const left = ensureDimensionWithMembers(w, r, 1);
      const owner = `${left.id}${chr(0)}x`;
      w.snapshot.dimensions.push({
        id: owner,
        bookId: "b",
        code: `Q${r.int(0, 9999)}`,
        name: "Dimension",
        openedOn: LADDER[0] as string,
      });
      w.snapshot.members.push(
        {
          id: w.names.mem(80),
          dimensionId: left.id,
          code: `x${chr(0)}y`,
          name: "Member",
          openedOn: LADDER[0] as string,
        },
        {
          id: w.names.mem(81),
          dimensionId: owner,
          code: "y",
          name: "Member",
          openedOn: LADDER[0] as string,
        },
      );
    },
  },
  {
    name: "rescale",
    group: "edge",
    aim: "amounts and source numbers at a scale of hundreds of digits, the same values",
    apply(w, r) {
      const target = r.pick([40, 500, 999, 1000]);
      const grow = (value: ExactDecimal): ExactDecimal => {
        const by = BigInt(target) - value.scale;
        try {
          return by <= 0n ? value : ExactDecimal.of(value.coefficient * 10n ** by, BigInt(target));
        } catch {
          return value; // already near the size limit
        }
      };
      for (const posting of w.journal.postings) {
        if (r.chance(0.7)) posting.bookValue.amount = grow(posting.bookValue.amount);
        if (posting.units.source !== undefined && r.chance(0.7)) {
          posting.units.source = grow(posting.units.source);
        }
        if (posting.basis?.source !== undefined && r.chance(0.7)) {
          posting.basis.source = grow(posting.basis.source);
        }
      }
      w.tags.add("big scales");
    },
  },
  {
    name: "longChains",
    group: "snapshot",
    aim: "a chart and a dimension with long chains of parents, now and then closed into a cycle",
    apply(w, r) {
      const total = r.int(30, 90);
      const closed = r.chance(0.3);
      const base = w.snapshot.accounts.length;
      for (let index = base; index < total; index++) {
        w.snapshot.accounts.push({
          id: w.names.acc(index + 50),
          bookId: "b",
          code: `L${index}`,
          name: "Account",
          role: "asset",
          normalSide: "debit",
          postingAllowed: true,
          openedOn: LADDER[0] as string,
          parentId:
            index === base
              ? (w.snapshot.accounts[0] as AccountSpec).id
              : w.names.acc(index - 1 + 50),
          allowedCommodityIds: [],
        });
      }
      if (closed && w.snapshot.accounts.length > 1) {
        (w.snapshot.accounts[0] as AccountSpec).parentId = (
          w.snapshot.accounts[w.snapshot.accounts.length - 1] as AccountSpec
        ).id;
      }
      const dimension = ensureDimensionWithMembers(w, r, 1);
      const owner = dimension.id;
      const chain = r.int(10, 40);
      const owned = w.snapshot.members.filter((m) => m.dimensionId === owner);
      for (let index = 0; index < chain; index++) {
        w.snapshot.members.push({
          id: w.names.mem(index + 70),
          dimensionId: owner,
          code: `LC${index}`,
          name: "Member",
          openedOn: LADDER[0] as string,
          parentId: index === 0 ? (owned[0] as MemberSpec).id : w.names.mem(index - 1 + 70),
        });
      }
      w.tags.add("long chains");
    },
  },
  {
    name: "weirdDates",
    group: "dates",
    aim: "dates that are any string: the same order on both sides",
    apply(w, r) {
      const weird = () => r.pick(WEIRD_DATES) as string;
      const mix = r.int(0, 4);
      const account = someAccount(w, r);
      if (account !== undefined && mix !== 1) {
        if (r.chance(0.5)) account.openedOn = weird();
        else account.closedOn = weird();
      }
      const dimension = someDimension(w, r);
      if (dimension !== undefined && mix !== 2) {
        if (r.chance(0.5)) dimension.openedOn = weird();
        else dimension.closedOn = weird();
      }
      const member = someMember(w, r);
      if (member !== undefined && mix !== 3) {
        if (r.chance(0.5)) member.openedOn = weird();
        else member.closedOn = weird();
      }
      if (mix === 1 || mix === 4) w.journal.accountingDate = weird();
      w.tags.add("weird dates");
    },
  },
  {
    name: "keysOfByPosting",
    group: "edge",
    aim: "the map of required dimensions by posting, with keys that are not postings",
    apply(w, r) {
      const dimensions = w.snapshot.dimensions.map((d) => d.id);
      const keys = ["0", "length", w.names.post(r.int(0, 3)), "1", chr(0x1f600)];
      const entries: [string, string[]][] = [...(w.snapshot.byPosting ?? [])];
      for (const key of keys) {
        if (!entries.some(([existing]) => existing === key)) {
          entries.push([key, r.subset(dimensions, 0.5)]);
        }
      }
      // A requirement that does not resolve, and one that is repeated, for some of the keys.
      for (const entry of entries) {
        if (r.chance(0.3)) entry[1] = [...entry[1], "dz"];
        else if (r.chance(0.2) && entry[1].length > 0) entry[1] = [...entry[1], ...entry[1]];
      }
      w.snapshot.byPosting = entries;
    },
  },
];

export const MUTATOR_NAMES = MUTATORS.map((m) => m.name);

// ---------------------------------------------------------------------------------------------
// A case
// ---------------------------------------------------------------------------------------------

/** What a test asks of the generator: which groups of defects may be chosen. */
export interface Profile {
  readonly groups: readonly Group[];
  /** The chance that the world is left clean. */
  readonly clean: number;
  /** The chance of a heap of defects at once. */
  readonly heap: number;
}

export const ADMIT: Profile = {
  groups: ["snapshot", "site", "journal", "edge", "dates"],
  clean: 0.28,
  heap: 0.1,
};
export const COORDINATE: Profile = {
  groups: ["snapshot", "site", "coordinate", "dates"],
  clean: 0.28,
  heap: 0.08,
};
export const SNAPSHOT: Profile = { groups: ["snapshot", "dates"], clean: 0.25, heap: 0.1 };
export const HASH: Profile = {
  groups: ["site", "journal", "edge", "dates"],
  clean: 0.2,
  heap: 0.15,
};

export function makeWorld(r: Rng, profile: Profile, exoticChance = 0.35): World {
  const world = cleanWorld(r, exoticChance);
  const pool = MUTATORS.filter((m) => profile.groups.includes(m.group));
  let defects = 0;
  if (!r.chance(profile.clean))
    defects = r.chance(profile.heap) ? r.int(4, 9) : r.weighted([0, 5, 3, 2]) + 0;
  if (defects === 0 && world.tags.size === 0) world.tags.add("clean");
  for (let index = 0; index < defects; index++) {
    const mutator = r.pick(pool) as Mutator;
    mutator.apply(world, r);
    world.tags.add(`mutator:${mutator.name}`);
  }
  return world;
}

// ---------------------------------------------------------------------------------------------
// From descriptions to the shipped values
// ---------------------------------------------------------------------------------------------

function tryMake<T>(make: (value: string) => T, value: string, tags: Set<string>): T {
  try {
    return make(value);
  } catch {
    tags.add("forged identifier");
    return value as unknown as T;
  }
}

function date(value: string): LocalDate {
  try {
    return localDate(value);
  } catch {
    return value as LocalDate;
  }
}

function at(value: string): Instant {
  try {
    return instant(value);
  } catch {
    return value as Instant;
  }
}

export function buildSnapshot(w: World): JournalAdmissionSnapshot {
  const s = w.snapshot;
  const tags = w.tags;
  const accounts: AccountSnapshot[] = s.accounts.map((a) => ({
    id: tryMake(accountId, a.id, tags),
    bookId: tryMake(bookId, a.bookId, tags),
    code: a.code,
    name: a.name,
    role: a.role,
    normalSide: a.normalSide,
    postingAllowed: a.postingAllowed,
    openedOn: date(a.openedOn),
    ...(a.closedOn === undefined ? {} : { closedOn: date(a.closedOn) }),
    ...(a.parentId === undefined ? {} : { parentId: tryMake(accountId, a.parentId, tags) }),
    allowedCommodityIds: a.allowedCommodityIds.map((c) => tryMake(commodityId, c, tags)),
  }));
  const dimensions: AccountingDimensionSnapshot[] = s.dimensions.map((d) => ({
    id: tryMake(dimensionId, d.id, tags),
    bookId: tryMake(bookId, d.bookId, tags),
    code: d.code,
    name: d.name,
    openedOn: date(d.openedOn),
    ...(d.closedOn === undefined ? {} : { closedOn: date(d.closedOn) }),
  }));
  const dimensionMembers: DimensionMemberSnapshot[] = s.members.map((m) => ({
    id: tryMake(dimensionMemberId, m.id, tags),
    dimensionId: tryMake(dimensionId, m.dimensionId, tags),
    code: m.code,
    name: m.name,
    openedOn: date(m.openedOn),
    ...(m.closedOn === undefined ? {} : { closedOn: date(m.closedOn) }),
    ...(m.parentId === undefined ? {} : { parentId: tryMake(dimensionMemberId, m.parentId, tags) }),
  }));
  let byPosting: Record<string, readonly ReturnType<typeof dimensionId>[]> | undefined;
  if (s.byPosting !== undefined) {
    byPosting = {};
    for (const [key, ids] of s.byPosting) {
      // `defineProperty`, not an assignment: a key such as `__proto__` is then an own property.
      Object.defineProperty(byPosting, key, {
        value: ids.map((id) => tryMake(dimensionId, id, tags)),
        enumerable: true,
        writable: true,
        configurable: true,
      });
    }
  }
  return {
    bookId: tryMake(bookId, s.bookId, tags),
    functionalCommodityId: tryMake(commodityId, s.functionalCommodityId, tags),
    accounts,
    dimensions,
    dimensionMembers,
    requiredDimensionIds: s.required.map((id) => tryMake(dimensionId, id, tags)),
    ...(byPosting === undefined ? {} : { requiredDimensionIdsByPosting: byPosting }),
  };
}

export function buildPosting(p: PostingSpec, tags: Set<string>): Posting {
  return {
    id: tryMake(postingId, p.id, tags),
    ordinal: p.ordinal,
    accountId: tryMake(accountId, p.accountId, tags),
    units: {
      canonicalNumber: p.units.canonical,
      commodityId: tryMake(commodityId, p.units.commodityId, tags),
      ...(p.units.source === undefined ? {} : { sourceNumber: p.units.source }),
    },
    bookValue: {
      amount: p.bookValue.amount,
      functionalCommodityId: tryMake(commodityId, p.bookValue.functionalCommodityId, tags),
    },
    ...(p.price === undefined
      ? {}
      : {
          transactionPrice: {
            unitRate: p.price.unitRate,
            baseCommodityId: tryMake(commodityId, p.price.base, tags),
            quoteCommodityId: tryMake(commodityId, p.price.quote, tags),
          },
        }),
    ...(p.basis === undefined
      ? {}
      : {
          costBasis: {
            totalBasis: p.basis.total,
            basisCommodityId: tryMake(commodityId, p.basis.commodityId, tags),
            ...(p.basis.source === undefined ? {} : { sourceTotalBasis: p.basis.source }),
          },
        }),
    dimensionMemberIds: p.members.map((m) => tryMake(dimensionMemberId, m, tags)),
  };
}

export function buildJournal(w: World): JournalTransaction {
  const j = w.journal;
  return {
    id: tryMake(journalId, j.id, w.tags),
    kind: j.kind,
    bookId: tryMake(bookId, j.bookId, w.tags),
    functionalCommodityId: tryMake(commodityId, j.functionalCommodityId, w.tags),
    economicAt: at(j.economicAt),
    accountingDate: date(j.accountingDate),
    ...(j.settledAt === undefined ? {} : { settledAt: at(j.settledAt) }),
    recordedAt: at(j.recordedAt),
    narration: j.narration,
    postings: j.postings.map((p) => buildPosting(p, w.tags)),
  };
}

/** The coordinate of a world: the first posting's account, commodity and members at the journal's
 * accounting date; a world with no posting asks about an account that is not there. */
export function buildCoordinate(w: World): AccountingCoordinate {
  const posting = w.journal.postings[0];
  return {
    bookId: tryMake(bookId, w.coordinate.bookId, w.tags),
    functionalCommodityId: tryMake(commodityId, w.coordinate.functionalCommodityId, w.tags),
    accountingDate: date(w.journal.accountingDate),
    accountId: tryMake(accountId, posting?.accountId ?? "a9", w.tags),
    unitsCommodityId: tryMake(commodityId, posting?.units.commodityId ?? "USD", w.tags),
    dimensionMemberIds: (posting?.members ?? []).map((m) => tryMake(dimensionMemberId, m, w.tags)),
  };
}

export function buildRequired(w: World): ReturnType<typeof dimensionId>[] {
  return w.coordinateRequired.map((id) => tryMake(dimensionId, id, w.tags));
}
