/** Home's facts for the unit tests: by default an established book where everything is done and nothing
 * needs a person (every read ok, a backup verified, every account reconciled, nothing waiting), so each
 * test changes only the one thing it is about. */
import type { HomeFacts, Read } from "../../src/routes/home-facts";

export const ok = <T>(value: T): Read<T> => ({ ok: true, value });
export const failed = (message = "The read failed."): Read<never> => ({ ok: false, message });

export const NOW = new Date("2026-10-05T12:00:00Z");

export const counts = (over: Record<string, number> = {}) => ({
  total: 30,
  new: 0,
  proposed: 0,
  drafted: 0,
  posted: 28,
  excluded: 2,
  toReview: 0,
  covered: 0,
  postable: 0,
  beforeCutover: 0,
  ...over,
});

export const inbox = (over: Record<string, number> = {}, oldest: string | null = null) =>
  ok({
    counts: counts(over),
    sources: [],
    unmapped: 0,
    oldestToReviewOn: oldest,
    lastSubmittedAt: null,
  } as never);

export const bank = (id: string, over: Record<string, unknown> = {}) => ({
  id,
  code: id,
  name: `Account ${id}`,
  role: "asset",
  parentId: null,
  openedOn: "2026-01-01",
  closedOn: null,
  balance: "100.00",
  tags: { cashFlowClass: "cash" },
  ...over,
});

export const reconcileRow = (id: string, lastReconciledDate: string | null = "2026-09-30") => ({
  account: { id, code: id, name: `Account ${id}`, role: "asset", normalSide: "debit" },
  tracked: true,
  lastReconciledDate,
  lastReconciledBalance: lastReconciledDate ? "100.00" : null,
  lastReconciliationId: null,
  openReconciliationId: null,
  unclearedCount: 0,
  unclearedTotal: "0.00",
  oldestUnclearedDate: null,
  bookBalance: "100.00",
});

export const period = (id: string, label: string, startsOn: string, endsOn: string, over = {}) => ({
  id,
  label,
  startsOn,
  endsOn,
  status: "closed",
  closePackageId: null,
  reportPopulationHash: null,
  closingRevision: null,
  fiscalYear: 2026,
  ordinal: 1,
  ended: endsOn < "2026-10-05",
  closeSuperseded: false,
  beforeBooks: false,
  empty: false,
  supersedes: [],
  alsoReopens: [],
  ...over,
});

export const calendar = (over: Record<string, unknown> = {}) => ({
  today: "2026-10-05",
  firstDate: "2026-01-01",
  lastDate: "2026-12-31",
  fiscalYearStartMonth: 1,
  periodModel: "monthly",
  fiscalYears: [
    {
      fiscalYear: 2026,
      startsOn: "2026-01-01",
      endsOn: "2026-12-31",
      periodCount: 12,
      closedCount: 9,
      supersededCount: 0,
      status: "partlyClosed",
      ended: false,
      beforeBooks: false,
      periodsBeforeBooks: 0,
    },
  ],
  canExtend: true,
  nextFiscalYear: 2027,
  nextStartsOn: "2027-01-01",
  nextEndsOn: "2027-12-31",
  extendNote: "",
  booksBegan: "2026-01-01",
  ...over,
});

export const periods = (
  rows: readonly ReturnType<typeof period>[] = [],
  over: Record<string, unknown> = {},
) => ok({ bookRevision: "1", calendar: calendar(over), periods: rows, history: [] } as never);

export const verified = (at = "2026-10-05T08:00:00Z") => ({
  id: "b1",
  createdAt: at,
  verification: { backupId: "b1", verifiedAt: at, passed: true, durationMs: 1 },
});

export const backup = (
  over: { warnings?: { code: string; tone: string; message: string }[] } & Record<
    string,
    unknown
  > = {},
) =>
  ok({
    generatedAt: "2026-10-05T12:00:00Z",
    settings: { warnAfterHours: 48 },
    latest: verified(),
    latestVerified: verified(),
    lastDrill: null,
    changesSinceLatest: 0,
    backupCount: 1,
    warnings: [],
    ...over,
  } as never);

/** What `changes.list` says since the last look: by default nothing, read in full, asked by the owner. */
export const changesList = (over: Record<string, unknown> = {}) =>
  ok({
    revision: "50",
    asOf: "2026-10-05T11:59:00.000Z",
    window: { since: "the start of the book", sinceRevision: "0", sinceAt: null, until: null },
    count: 0,
    page: 1,
    pageSize: 1,
    changes: [],
    actors: [],
    sources: ["ledger", "review", "rules", "tags", "reconciliation", "access"].map((name) => ({
      name,
      title: name,
      read: true,
      reason: null,
      changes: 0,
    })),
    notCovered: [],
    attribution: null,
    lastReview: null,
    caller: { kind: "owner", label: "owner" },
    ...over,
  } as never);

export const checklist = (over: Record<string, unknown> = {}) =>
  ok({
    asOf: "2026-10-05",
    hasHistory: true,
    currency: "USD",
    cutover: null,
    opening: { status: "posted" },
    verdict: { state: "nothing_to_close", summary: "", blocking: [], attention: [] },
    accounts: [],
    ...over,
  } as never);

export function homeFacts(over: Partial<HomeFacts> = {}): HomeFacts {
  return {
    today: "2026-10-05",
    now: NOW,
    setup: {
      name: "Willow Lane Studio",
      currency: "USD",
      fiscalYear: 2026,
      periodModel: "monthly",
      basis: "cash",
      accounts: [],
    },
    accounts: ok({
      currency: "USD",
      accounts: [bank("1000"), bank("2000", { role: "liability" })],
    } as never),
    inbox: inbox(),
    reconcile: ok({ bookRevision: "1", accounts: [reconcileRow("1000")] } as never),
    imports: ok({ count: 1, page: 1, pageSize: 20, runs: [] } as never),
    backup: backup(),
    periods: periods(),
    target: null,
    closing: checklist(),
    stripe: ok({ configured: false } as never),
    bankfeed: ok({ connected: false } as never),
    banks: { ok: false, message: "The service connects no bank this way.", denied: true },
    tokens: ok({ tokens: [], ownerAccess: "open" } as never),
    changes: changesList(),
    ...over,
  };
}
