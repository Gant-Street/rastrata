/** What the application keeps current from what changed, held to what is made from nothing, for a test of any
 * size to call after each thing it does to a book: the suggestions of the Inbox, what the classifier holds, the
 * counts of the Inbox's lines, the periods that hold an entry, the entries a line might be, the list of changes
 * and the Journal's pages. Each is compared with the same thing made from the whole book or every line, which is
 * what the application did at every reading before it kept them. Test support. */
import { expect } from "bun:test";
import { buildLedgerChanges } from "../../src/changes/ledger.ts";
import { periodsWithEntries } from "../../src/calendar/period-entries.ts";
import type {
  ChangeListInput,
  InboxFilter,
  InboxListInput,
} from "../../src/client-contracts.gen.ts";
import { ApplicationHttp } from "../../src/http.ts";
import { JOURNAL_PAGE_SIZE, journalBookPage } from "../../src/journal-book.ts";
import type { LocalBookService } from "../../src/local.ts";
import {
  accountActivity,
  accountActivityByPostings,
  compileGeneralLedger,
  compileGeneralLedgerByPostings,
} from "../../src/reports/activity.ts";
import { LedgerView, bookView } from "../../src/reports/ledger.ts";
import { AccountLines } from "../../src/reports/ledger-lines.ts";
import { linksOf } from "../../src/reports/ledger-links.ts";
import { ClassifierModel, type TrainingExample } from "../../src/rules/classifier.ts";
import { MerchantHistory } from "../../src/rules/starter/proposer.ts";
import { APPLICATION_API_VERSION, BUSINESS_PERMISSIONS } from "../../src/schema.ts";
import { listChanges } from "../../src/slices/changes/list.ts";
import { changesState } from "../../src/slices/changes/store.ts";
import { findLines } from "../../src/slices/ingest/find.ts";
import { buildMatchIndex, matchIndexFor } from "../../src/slices/ingest/match-index.ts";
import { ensureProposals, invalidateProposals } from "../../src/slices/ingest/proposing.ts";
import { ingestRuntime } from "../../src/slices/ingest/store.ts";
import { inboxCounts } from "../../src/slices/ingest/view.ts";
import { behind, gatherExamples } from "../../src/slices/rules/classifier-ops.ts";
import { learnerOf } from "../../src/slices/rules/learning.ts";
import { readExamples } from "../../src/slices/rules/store.ts";
import type { Json } from "./ingest-fixture.ts";
import { looked } from "./ingest-rows.ts";
import { lookedAtEveryPosting, reportedStatus } from "./reconcile-status.ts";

/** What the Inbox holds for every line: its status, what it said about its suggestions, and each suggestion. */
export function proposalsSnapshot(service: LocalBookService): string {
  const store = service.store;
  return JSON.stringify([
    store.query("SELECT id, status, proposal_problems FROM app_ingest_items ORDER BY seq").all(),
    store
      .query(
        "SELECT item_id, rank, id, proposer, kind, confidence, body FROM app_ingest_proposals ORDER BY item_id, rank",
      )
      .all(),
  ]);
}

/** Lists of the Inbox that the application answers from the tally of days and the index of what waits. */
const LISTS: readonly [InboxFilter, InboxListInput["sort"]][] = [
  [{ status: ["new", "proposed", "drafted"], covered: false, to: "2026-02-28" }, "date_asc"],
  [{ status: ["new", "proposed"], covered: false }, "date_desc"],
  [
    {
      status: ["new", "proposed", "drafted"],
      covered: false,
      ledgerAccountId: "1000",
      from: "2026-03-01",
      to: "2026-09-30",
    },
    "date_asc",
  ],
  [{ status: ["posted"] }, "date_desc"],
  [{ status: ["excluded", "drafted"], covered: true }, undefined],
  [{}, undefined],
];

/** What a set of the accounts' lines says, in text: each account's days, the postings on each, and the sums. */
export function linesSnapshot(lines: AccountLines): string {
  return JSON.stringify(
    [...lines.accounts()].sort().map((account) => {
      const days = lines.account(account);
      return {
        account,
        dates: days?.dates,
        rows: days?.rows.map((day) =>
          day.map((row) => `${row.booked.journal.id}/${row.posting.id}`),
        ),
        count: days?.count,
        net: days?.net.map(String),
        debit: days?.debit.map(String),
        credit: days?.credit.map(String),
        repeats: days?.repeats,
      };
    }),
  );
}

const asText = (value: unknown): string =>
  JSON.stringify(value, (_key, item) => (typeof item === "bigint" ? item.toString() : item));

const keyed = (list: Iterable<TrainingExample>) =>
  JSON.stringify(
    [...list]
      .map((item) => ({ ...item, source: item.source ?? null }))
      .sort((a, b) => (a.key < b.key ? -1 : a.key > b.key ? 1 : 0)),
  );

/** Every check, after whatever the test did last. The suggestions are read as a reader of the Inbox reads them,
 * everything else is compared with what is made from nothing, and then every open line is proposed for again
 * from nothing and compared with the suggestions that were kept. */
export async function checkKeptCurrent(service: LocalBookService, label: string): Promise<void> {
  const store = ingestRuntime(service).store;
  await ensureProposals(service, { prepare: true });
  const maintained = proposalsSnapshot(service);

  // The counts and the days of the Inbox's lines.
  const counted = store
    .query(
      `SELECT provider, account_key, status, covered_by IS NOT NULL AS covered,
         (exclusion_code IS NOT NULL AND exclusion_code IN ('before_cutover', 'catch_up') AND status = 'excluded') AS held,
         COUNT(*) AS n
       FROM app_ingest_items
       GROUP BY provider, account_key, status, covered_by IS NOT NULL,
         (exclusion_code IS NOT NULL AND exclusion_code IN ('before_cutover', 'catch_up') AND status = 'excluded')
       ORDER BY provider, account_key, status, covered, held`,
    )
    .all();
  expect(
    store
      .query(
        "SELECT provider, account_key, status, covered, held, n FROM app_ingest_tally WHERE n != 0 ORDER BY provider, account_key, status, covered, held",
      )
      .all(),
    `${label}: the tally`,
  ).toEqual(counted);
  const total = (store.query("SELECT COUNT(*) AS n FROM app_ingest_items").get() as { n: number })
    .n;
  expect(inboxCounts(store).total, `${label}: the count of lines`).toBe(total);
  // The tally of days, and the lists read from it and from the index of what waits.
  expect(
    store
      .query(
        "SELECT provider, account_key, day, status, covered, n FROM app_ingest_tally_days WHERE n != 0 ORDER BY provider, account_key, day, status, covered",
      )
      .all(),
    `${label}: the tally of days`,
  ).toEqual(
    store
      .query(
        `SELECT provider, account_key, posted_on AS day, status, covered_by IS NOT NULL AS covered, COUNT(*) AS n
         FROM app_ingest_items
         GROUP BY provider, account_key, posted_on, status, covered_by IS NOT NULL
         ORDER BY provider, account_key, day, status, covered`,
      )
      .all(),
  );
  for (const [filter, sort] of LISTS) {
    const found = findLines(store, filter, sort, 1, 50);
    expect(
      { total: found.total, ids: found.rows.map((row) => row.id) },
      `${label}: the list ${JSON.stringify(filter)} ${sort ?? ""}`,
    ).toEqual(looked(store, filter, sort, 1, 50));
  }

  // What the classifier holds, when it has learned as far as the book goes.
  const head = (await service.ledgerHead()).bookRevision;
  if (!behind(service, head)) {
    const { examples } = await gatherExamples(service);
    const learner = learnerOf(service);
    const status = ingestStatus(store);
    if (status.heldBack === 0) {
      expect(keyed(learner.stored.values()), `${label}: the examples`).toEqual(keyed(examples));
      expect(keyed(readExamples(store)), `${label}: the table of examples`).toEqual(
        keyed(examples),
      );
      expect(learner.model.snapshot(), `${label}: the model`).toEqual(
        ClassifierModel.from(examples).snapshot(),
      );
      const history = new MerchantHistory();
      for (const item of examples) history.add(item);
      expect(learner.history.snapshot(), `${label}: the starter's history`).toEqual(
        history.snapshot(),
      );
    }
  }

  // The entries, the periods and the changes of the book.
  const { aggregate } = await service.readAggregate();
  const state = aggregate.state;
  expect([...periodsWithEntries(state)].sort(), `${label}: the periods that hold an entry`).toEqual(
    [...new Set(state.journals.map((booked) => String(booked.fiscalPeriodId)))].sort(),
  );
  expect(matchIndexFor(state).snapshot(), `${label}: the entries a line might be`).toEqual(
    buildMatchIndex(state).snapshot(),
  );
  const context = () => ({
    service,
    access: { bookId: service.bookId, permissions: BUSINESS_PERMISSIONS },
    operationId: "",
  });
  const commits = changesState(service).commitIndex();
  const whole = buildLedgerChanges(state, commits);
  const inputs: ChangeListInput[] = [
    {},
    { pageSize: 3, page: 2 },
    { kinds: ["entry.posted"], pageSize: 10 },
  ];
  // The two lists are asked for a moment apart, and say what time it is: that is not what is compared.
  const unclocked = (list: Awaited<ReturnType<typeof listChanges>>) => ({ ...list, asOf: "" });
  for (const input of inputs)
    expect(
      unclocked(await listChanges(context(), input)),
      `${label}: the changes ${JSON.stringify(input)}`,
    ).toEqual(unclocked(await listChanges(context(), input, { ledger: whole })));

  // The Journal's pages and what a page reads of the book's corrections: the page the book's own lookups and indexes
  // give, and the page made from a view of the whole book with every reference read from the whole table.
  const links = linksOf(state.corrections);
  const named = [
    ...state.corrections.flatMap((link) => [link.originalJournalId, link.correctionJournalId]),
    ...state.journals.slice(0, 5).map((booked) => booked.journal.id),
    "no-such-entry",
  ];
  for (const id of named) {
    expect(links.firstByOriginal(id), `${label}: the first link that corrects ${id}`).toBe(
      state.corrections.find((link) => link.originalJournalId === id),
    );
    expect(
      links.firstByCorrection(id),
      `${label}: the first link that is the correction ${id}`,
    ).toBe(state.corrections.find((link) => link.correctionJournalId === id));
  }
  expect(
    links.naming(named).map((link) => state.corrections.indexOf(link)),
    `${label}: the links that name them`,
  ).toEqual(
    state.corrections.flatMap((link, at) =>
      named.includes(link.originalJournalId) || named.includes(link.correctionJournalId)
        ? [at]
        : [],
    ),
  );
  for (const id of named.slice(0, 40))
    expect(bookView(state).find(id), `${label}: the entry ${id}`).toBe(
      state.journals.find((booked) => booked.journal.id === id),
    );
  const everyReference = (
    service as unknown as { postedReferences(): ReadonlyMap<string, string> }
  ).postedReferences();
  const accountLabel = new Map<string, string>(
    state.admissionSnapshot.accounts.map((account) => [
      account.id as string,
      `${account.code} · ${account.name}`,
    ]),
  );
  const pages = [
    { page: 1, text: "", from: "", to: "", accountId: "", status: "" },
    { page: 2, text: "", from: "", to: "", accountId: "", status: "" },
    { page: 1, text: "", from: "2026-03-01", to: "2026-03-31", accountId: "", status: "Posted" },
    { page: 1, text: "", from: "", to: "", accountId: "1000", status: "" },
    { page: 2, text: "", from: "2026-03-01", to: "2026-03-31", accountId: "1000", status: "" },
    {
      page: 1,
      text: "",
      from: "2026-01-01",
      to: "2026-12-31",
      accountId: "5000",
      status: "Posted",
    },
  ];
  const fresh = new LedgerView(state);
  for (const query of pages) {
    const kept = await service.journalBook(query);
    const made = journalBookPage({
      state,
      view: fresh,
      drafts: service.listDrafts(),
      referenceOf: (booked) => everyReference.get(booked.journal.id),
      accountLabel,
      query,
    });
    expect(kept.pageSize).toBe(JOURNAL_PAGE_SIZE);
    expect(
      JSON.stringify({
        entries: kept.entries,
        count: kept.count,
        drafts: kept.drafts,
        corrections: kept.corrections,
      }),
      `${label}: the Journal's page ${JSON.stringify(query)}`,
    ).toBe(JSON.stringify(made));
  }

  // The accounts' lines by day, carried from state to state, and what the general ledger and a register read from them.
  expect(
    linesSnapshot(bookView(state).accountLines()),
    `${label}: the accounts' lines by day`,
  ).toBe(linesSnapshot(AccountLines.of(fresh.journalsByDate())));
  for (const query of [
    { asOf: "2026-12-31", page: 1 },
    { asOf: "2026-12-31", from: "2026-03-01", page: 2 },
    { asOf: "2026-06-30", page: 1 },
  ])
    expect(
      asText(compileGeneralLedger(state, query)),
      `${label}: the general ledger ${JSON.stringify(query)}`,
    ).toBe(asText(compileGeneralLedgerByPostings(state, query)));
  for (const [accountId, from, to, page] of [
    ["1000", "2026-03-01", "2026-03-31", 1],
    ["1000", "2026-01-01", "2026-12-31", 2],
    ["4000", "2026-02-01", "2026-09-30", 1],
    ["5000", "2026-01-01", "2026-12-31", 1],
  ] as const) {
    const query = { accountId, asOf: "2026-12-31", from, to, page };
    expect(
      asText(accountActivity(state, query)),
      `${label}: the register of ${accountId} ${from} to ${to}`,
    ).toBe(asText(accountActivityByPostings(state, query)));
  }

  // The status of the accounts to reconcile, whose cleared figures are kept beside the book.
  expect(
    await reportedStatus(service),
    `${label}: the status of the accounts to reconcile`,
  ).toEqual(await lookedAtEveryPosting(service));

  // And last, every open line proposed for again from nothing.
  invalidateProposals(service);
  await ensureProposals(service, { prepare: true });
  expect(maintained, `${label}: the suggestions`).toEqual(proposalsSnapshot(service));
}

function ingestStatus(store: ReturnType<typeof ingestRuntime>["store"]): { heldBack: number } {
  const row = store.query("SELECT value FROM rules_meta WHERE key='classifier_training'").get() as {
    value: string;
  } | null;
  return { heldBack: row ? ((JSON.parse(row.value) as { heldBack?: number }).heldBack ?? 0) : 0 };
}

/** An operation by name through the same `/v1` surface the screens use. */
export async function callOn(
  service: LocalBookService,
  name: string,
  input: unknown = {},
  operationId?: string,
): Promise<Json> {
  const http = new ApplicationHttp(service, {
    bookId: service.bookId,
    permissions: BUSINESS_PERMISSIONS,
  });
  const response = await http.fetch(
    new Request(`http://127.0.0.1:4010/v1/${name}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        version: APPLICATION_API_VERSION,
        bookId: service.bookId,
        input,
        ...(operationId ? { operationId } : {}),
      }),
    }),
  );
  return (await response.json()) as Json;
}

/** An entry posted through the application, as the Journal screen does it. Null when the book refuses it (a month
 * that is closed). */
export async function postByHand(
  service: LocalBookService,
  date: string,
  narration: string,
  lines: readonly { accountId: string; debit: string; credit: string }[],
): Promise<string | null> {
  const draft = await callOn(
    service,
    "drafts.create",
    // The reference is not the narration, so that a page of the Journal that reads it wrong is seen.
    { data: { date, reference: `Ref ${narration}`.slice(0, 80), narration, lines } },
    crypto.randomUUID(),
  );
  if (!draft.ok) return null;
  const prepared = await callOn(
    service,
    "journal.prepare",
    { draftId: draft.data.id, expectedVersion: draft.data.version },
    crypto.randomUUID(),
  );
  if (!prepared.ok || !prepared.data.valid) return null;
  const done = await callOn(service, "operations.commit", {
    planId: prepared.data.planId,
    planHash: prepared.data.planHash,
  });
  return done.ok && done.data.disposition === "committed"
    ? (prepared.data.effects.journals[0].id as string)
    : null;
}
