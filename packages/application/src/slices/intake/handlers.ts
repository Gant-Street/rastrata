import { describePrincipal } from "../../agent/principal.ts";
import { ApplicationError } from "../../errors.ts";
import { deriveUuid } from "../../ingest/hash.ts";
import { formatMoney } from "../../money.ts";
import { type FileFacts, inspectFile, isoTitleDate } from "../../intake/inspect.ts";
import {
  buildPlan,
  resolveAccount,
  type PlanBook,
  type PlanFileInfo,
  type PlanInput,
  type PlanTrialBalanceRow,
} from "../../intake/plan.ts";
import {
  type Expectations,
  type Recipe,
  type RecipeReport,
  testRecipe,
} from "../../intake/recipe.ts";
import { type FrictionKind, isUnsafeCodePoint, neutral, scrub } from "../../intake/sets.ts";
import { parseXeroTrialBalance } from "../../shadow/xero/trial-balance.ts";
import type { SavedMapping } from "../../statements/parse.ts";
import { decodeText } from "../../statements/text.ts";
import { callOperation } from "../shadow/operations.ts";
import { recordedCutoverDate } from "../shadow/cutover-date.ts";
import { chartAccount } from "../statements/analysis.ts";
import { mappingProblems } from "../statements/mappings.ts";
import { listProfiles, statementsState } from "../statements/store.ts";
import { ingestFor } from "../statements/ports.ts";
import type { SliceHandler, SliceHandlers } from "../types.ts";
import {
  eventStats,
  intakeState,
  listEvents,
  listRecipes,
  saveRecipe,
  writeEvents,
} from "./store.ts";

/** The most one scan reads: a call does a bounded amount of work, and says which files it left for
 * another call. */
const SCAN_BYTE_BUDGET = 96 * 1024 * 1024;

const scan: SliceHandler = (input, { service }) => {
  const ingest = ingestFor(service);
  const today = service.today();
  const requested = [...new Set(input.files as string[])];
  const files: Record<string, unknown>[] = [];
  const missing: string[] = [];
  const deferred: string[] = [];
  const totals = { files: 0, bytes: 0, parsed: 0, needRecipe: 0, needAgent: 0, needHuman: 0 };
  let budget = SCAN_BYTE_BUDGET;
  for (const sha256 of requested) {
    if (budget <= 0) {
      deferred.push(sha256);
      continue;
    }
    const stored = ingest.readArchive(sha256);
    if (!stored) {
      missing.push(sha256);
      continue;
    }
    budget -= stored.bytes.byteLength;
    const facts = inspectFile(stored.bytes, {
      ...(stored.name !== undefined ? { name: stored.name } : {}),
      today,
    });
    totals.files++;
    totals.bytes += stored.bytes.byteLength;
    if (facts.parsed) totals.parsed++;
    if (facts.need === "recipe") totals.needRecipe++;
    else if (facts.need === "agent") totals.needAgent++;
    else if (facts.need === "human") totals.needHuman++;
    files.push({
      sha256,
      ...(stored.name !== undefined ? { name: neutral(stored.name, 200) } : {}),
      size: stored.bytes.byteLength,
      ...facts,
    });
  }
  return scrub({ files, missing, deferred, totals });
};

/** The SHA-256 of every file a plan input names. */
function namedFiles(input: PlanInput): string[] {
  const named = new Set<string>();
  for (const source of input.sources) for (const sha of source.files) named.add(sha);
  for (const sha of input.files ?? []) named.add(sha);
  for (const sha of input.payoutReports ?? []) named.add(sha);
  for (const sha of [input.trialBalance, input.chart, input.generalLedger])
    if (sha !== undefined) named.add(sha);
  for (const balance of input.balances ?? []) named.add(balance.file);
  return [...named];
}

/** The book as the plan needs it; before the book is set up it is empty, and the plan says so. */
async function bookOf(service: Parameters<typeof recordedCutoverDate>[0]): Promise<PlanBook> {
  try {
    const chart = await service.accounts();
    return {
      configured: true,
      accounts: chart.accounts.map((account) => ({
        id: account.id,
        code: account.code,
        name: account.name,
        role: account.role,
        closedOn: account.closedOn,
      })),
      recordedCutover: recordedCutoverDate(service),
    };
  } catch (error) {
    // Planning comes before the book is set up; any other failure is not that.
    if (error instanceof Error && /^Book is not configured/.test(error.message))
      return { configured: false, accounts: [], recordedCutover: null };
    throw error;
  }
}

const plan: SliceHandler = async (input, { service }) => {
  const request = input as unknown as PlanInput & { gapsOnly?: boolean };
  const ingest = ingestFor(service);
  const today = service.today();
  const book = await bookOf(service);
  const state = statementsState(service);
  // The recipes saved for the account a file is assigned to: a file one of them reads is read.
  const recipesOf = new Map<string, readonly SavedMapping[]>();
  for (const source of request.sources) {
    const { account } = resolveAccount(book.accounts, source.account);
    if (!account) continue;
    const saved = listProfiles(state, account.id).map((item) => ({
      id: item.id,
      name: item.name,
      mapping: item.mapping,
    }));
    for (const sha of source.files) recipesOf.set(sha, saved);
  }
  const infos = new Map<string, PlanFileInfo>();
  let tbRows: PlanTrialBalanceRow[] | null = null;
  let budget = SCAN_BYTE_BUDGET;
  for (const sha of namedFiles(request)) {
    const stored = ingest.readArchive(sha);
    if (!stored) continue;
    budget -= stored.bytes.byteLength;
    if (budget < 0)
      throw new ApplicationError(
        "request_too_large",
        "The plan names more file content than one call reads (96 MiB). Plan the accounts in parts.",
        413,
      );
    const profiles = recipesOf.get(sha);
    const facts: FileFacts = inspectFile(stored.bytes, {
      ...(stored.name !== undefined ? { name: stored.name } : {}),
      today,
      ...(profiles && profiles.length > 0 ? { profiles } : {}),
    });
    infos.set(sha, { sha256: sha, facts });
    if (sha === request.trialBalance && facts.role === "trial_balance") {
      const tb = parseXeroTrialBalance(decodeText(stored.bytes).text, { decimal: "." });
      const ytd = tb.layout !== "period";
      tbRows = tb.rows.map((row) => ({
        code: row.code,
        name: row.name,
        balance: ytd ? row.ytdDebit - row.ytdCredit : row.debit - row.credit,
      }));
    }
  }
  const built = buildPlan(request, infos, book, tbRows);
  const result =
    request.gapsOnly === true
      ? { ...built, items: built.items.filter((item) => item.status !== "present") }
      : built;
  return scrub(result);
};

// ---- A trial balance in exact cents -----------------------------------------------------------

/** Debit-normal roles read a balance as debits less credits; the others as credits less debits. */
const DEBIT_NORMAL = new Set(["asset", "expense"]);

const trialBalance: SliceHandler = async (input, { service }) => {
  const stored = ingestFor(service).readArchive(input.sha256 as string);
  if (!stored)
    throw new ApplicationError(
      "upload_not_found",
      "That file is not stored, or was never uploaded. Upload it again.",
      404,
    );
  const text = decodeText(stored.bytes).text;
  const tb = parseXeroTrialBalance(text, { decimal: "." });
  // A date written year first in a title line ("As of 2026-04-30") is not one the reader knows.
  const asOf =
    tb.asOf ??
    isoTitleDate(
      text
        .split(/\r?\n/)
        .slice(0, 12)
        .map((line) => line.toLowerCase()),
    );
  const book = await bookOf(service);
  const normal = (value: string) => value.trim().toLowerCase().replace(/\s+/g, " ");
  const useYtd = tb.layout !== "period";
  const rows = tb.rows.slice(0, 1200).map((row) => {
    // "1010 Harbor Checking": a number then the name, which the reader does not split.
    let code = row.code;
    let name = row.name;
    if (code === null) {
      const leading = /^(\d{2,10})\s+(\S.*)$/.exec(name);
      if (leading) {
        code = leading[1] ?? null;
        name = leading[2] ?? name;
      }
    }
    const debit = useYtd ? row.ytdDebit : row.debit;
    const credit = useYtd ? row.ytdCredit : row.credit;
    const byCode =
      code === null ? [] : book.accounts.filter((account) => normal(account.code) === normal(code));
    const byName = book.accounts.filter((account) => normal(account.name) === normal(name));
    const matched =
      byCode.length === 1
        ? { account: byCode[0], how: "code" as const }
        : byName.length === 1
          ? { account: byName[0], how: "name" as const }
          : null;
    const balance = debit - credit;
    return {
      row: row.row,
      ...(row.section !== null ? { section: row.section } : {}),
      ...(code !== null ? { code } : {}),
      name,
      debit: formatMoney(debit),
      credit: formatMoney(credit),
      balance: formatMoney(balance),
      ...(matched?.account
        ? {
            match: { accountId: matched.account.id, how: matched.how, role: matched.account.role },
            suggested: formatMoney(DEBIT_NORMAL.has(matched.account.role) ? balance : -balance),
          }
        : {}),
    };
  });
  return scrub({
    asOf,
    layout: tb.layout,
    balanced: tb.balanced,
    debit: formatMoney(useYtd ? tb.sums.ytdDebit : tb.sums.debit),
    credit: formatMoney(useYtd ? tb.sums.ytdCredit : tb.sums.credit),
    rows,
    issues: tb.issues.slice(0, 20).map((issue) => ({
      severity: issue.severity,
      ...(issue.row !== undefined ? { row: issue.row } : {}),
      message: neutral(issue.message, 300),
    })),
  });
};

// ---- Recipes -----------------------------------------------------------------------------------

type Service = Parameters<typeof recordedCutoverDate>[0];

/** A recipe whose mapping means something: the schema checks the shape, this checks the sense. */
function checkedRecipe(value: unknown): Recipe {
  const recipe = value as Recipe;
  // A recipe's name becomes an import profile's name: it carries no control or direction character.
  for (const [path, text] of [
    ["input.recipe.name", recipe.name],
    ["input.recipe.note", recipe.note ?? ""],
  ] as const)
    if ([...text].some((symbol) => isUnsafeCodePoint(symbol.codePointAt(0) ?? 0)))
      throw new ApplicationError(
        "invalid_input",
        "Text with control or direction characters is not a name",
        400,
        [{ path, message: "Remove the control and direction characters" }],
      );
  const problems = mappingProblems(recipe.mapping);
  if (problems.length > 0)
    throw new ApplicationError(
      "invalid_mapping",
      "The recipe's mapping is incomplete or contradicts itself",
      400,
      problems.map((item) => ({
        ...item,
        path: item.path.replace("input.mapping", "input.recipe.mapping"),
      })),
    );
  return recipe;
}

const expectations = (input: Record<string, unknown>): Expectations => ({
  ...(typeof input.openingBalance === "string" ? { openingBalance: input.openingBalance } : {}),
  ...(typeof input.endingBalance === "string" ? { endingBalance: input.endingBalance } : {}),
  ...(typeof input.periodFrom === "string" ? { periodFrom: input.periodFrom } : {}),
  ...(typeof input.periodTo === "string" ? { periodTo: input.periodTo } : {}),
  ...(input.skipInvalidRows === true ? { skipInvalidRows: true } : {}),
});

async function bookCurrency(service: Service): Promise<string> {
  try {
    return (await service.accounts()).currency;
  } catch {
    return "USD";
  }
}

async function runTest(
  service: Service,
  input: Record<string, unknown>,
): Promise<RecipeReport & { file: Record<string, unknown>; recipe?: Record<string, unknown> }> {
  const stored = ingestFor(service).readArchive(input.sha256 as string);
  if (!stored)
    throw new ApplicationError(
      "upload_not_found",
      "That file is not stored, or was never uploaded. Upload it again.",
      404,
    );
  const recipe = input.recipe === undefined ? undefined : checkedRecipe(input.recipe);
  let kind: "bank" | "card" | undefined;
  if (typeof input.ledgerAccountId === "string") {
    const { account } = await chartAccount(service, input.ledgerAccountId);
    kind = account.role === "liability" ? "card" : "bank";
    if (recipe && recipe.accountKind !== kind)
      throw new ApplicationError(
        "recipe_account_mismatch",
        `The recipe is for a ${recipe.accountKind} and that chart account is a ${kind}`,
        409,
      );
  }
  const report = testRecipe({
    bytes: stored.bytes,
    ...(recipe ? { recipe } : {}),
    expect: expectations(input),
    defaultCurrency: await bookCurrency(service),
    ...(kind ? { accountKind: kind } : {}),
  });
  return {
    ...report,
    file: {
      sha256: input.sha256,
      size: stored.bytes.byteLength,
      ...(stored.name !== undefined ? { name: neutral(stored.name, 200) } : {}),
    },
    ...(recipe ? { recipe: { name: recipe.name, version: recipe.version } } : {}),
  };
}

const recipeTest: SliceHandler = async (input, { service }) => scrub(await runTest(service, input));

function savedView(saved: ReturnType<typeof listRecipes>[number]) {
  const recipe = saved.recipe as Recipe;
  return {
    name: saved.name,
    revision: saved.revision,
    accountKind: recipe.accountKind,
    profileId: saved.profileId,
    ledgerAccountId: saved.ledgerAccountId,
    proven: saved.proven,
    savedAt: saved.savedAt,
    savedBy: saved.savedBy,
    recipe,
  };
}

const recipeSave: SliceHandler = (input, { service, access, operationId }) => {
  const recipe = checkedRecipe(input.recipe);
  const proofs = input.proofs as Record<string, unknown>[];
  const state = intakeState(service);
  const ledgerAccountId =
    typeof input.ledgerAccountId === "string" ? input.ledgerAccountId : undefined;
  return service.retainAsyncRequest(operationId, "intake.recipeSave", input, async () => {
    // The proof is run again here, on the files as the book holds them: a recipe is saved on what
    // this program verified, never on a claim.
    const proven: Record<string, unknown>[] = [];
    const refusals: { path: string; message: string }[] = [];
    for (const [at, proof] of proofs.entries()) {
      const report = await runTest(service, {
        ...proof,
        recipe,
        ...(ledgerAccountId !== undefined ? { ledgerAccountId } : {}),
      });
      if (report.valid && report.verified && report.verification.method !== "none") {
        proven.push({
          sha256: proof.sha256,
          method: report.verification.method,
          lines: report.rows.lines,
          from: report.range?.from,
          to: report.range?.to,
        });
        continue;
      }
      const failing = report.gates.filter((gate) => gate.status === "fail");
      const reasons =
        failing.length > 0 ? failing : report.gates.filter((gate) => gate.status === "unverified");
      for (const gate of reasons.slice(0, 4))
        refusals.push({ path: `proofs[${at}].${gate.gate}`, message: neutral(gate.detail, 300) });
      if (reasons.length === 0)
        refusals.push({ path: `proofs[${at}]`, message: neutral(report.verification.detail, 300) });
    }
    if (refusals.length > 0)
      throw new ApplicationError(
        "recipe_unproven",
        "The recipe is not saved: it did not pass every gate on every proof. Run intake.recipeTest on each file, read the gates, and fix the recipe or the balances you were given.",
        409,
        refusals.slice(0, 12),
      );
    const profile = await callOperation<{ id: string }>(
      { service, access, operationId },
      "import.profileSave",
      {
        name: recipe.name,
        mapping: recipe.mapping,
        ...(ledgerAccountId !== undefined ? { ledgerAccountId } : {}),
      },
      deriveUuid(["intake.recipeSave", operationId, "profile"]),
    );
    const saved = saveRecipe(state, {
      name: recipe.name,
      recipe,
      proven,
      profileId: profile.id,
      ledgerAccountId: ledgerAccountId ?? null,
      at: service.now(),
      by: describePrincipal(access.principal),
    });
    return scrub(savedView(saved));
  });
};

const recipeList: SliceHandler = (_input, { service }) =>
  scrub({ recipes: listRecipes(intakeState(service)).map(savedView) });

// ---- The friction log ------------------------------------------------------------------------

/** Text for the log: cleaned of control and direction characters and bounded, whoever wrote it. */
const safe = (value: unknown, limit: number): string =>
  typeof value === "string" ? neutral(value.trim(), limit) : "";

const friction: SliceHandler = (input, { service, access, operationId }) => {
  const events = ((input.events as Record<string, unknown>[] | undefined) ?? []).map((event) => ({
    kind: event.kind as FrictionKind,
    source: safe(event.source, 120),
    reason: safe(event.reason, 300),
    key: typeof event.key === "string" && event.key !== "" ? safe(event.key, 120) : null,
  }));
  const resolve = ((input.resolve as string[] | undefined) ?? []).map((key) => safe(key, 120));
  if (events.length === 0 && resolve.length === 0)
    throw new ApplicationError(
      "invalid_input",
      "Record at least one event, or name a key to resolve",
      400,
    );
  if (events.some((event) => event.reason === ""))
    throw new ApplicationError("invalid_input", "Every event needs a reason", 400);
  const state = intakeState(service);
  const at = service.now();
  const actor = describePrincipal(access.principal);
  const note = safe(input.note, 300);
  return service.retainRequest(operationId, "intake.friction", input, () => {
    const written = writeEvents(state, operationId, events, resolve, note, actor, at);
    return { ...written, openGaps: eventStats(state).openGaps };
  });
};

const frictionList: SliceHandler = (input, { service }) => {
  const page = typeof input.page === "number" ? input.page : 1;
  const pageSize = typeof input.pageSize === "number" ? input.pageSize : 50;
  const status = (input.status as "open" | "resolved" | "all" | undefined) ?? "all";
  const { count, events } = listEvents(
    intakeState(service),
    {
      status,
      ...(typeof input.kind === "string" ? { kind: input.kind as FrictionKind } : {}),
    },
    page,
    pageSize,
  );
  return scrub({
    count,
    page,
    pageSize,
    events: events.map((event) => ({
      id: event.id,
      kind: event.kind,
      class: event.class,
      ...(event.key !== null ? { key: event.key } : {}),
      source: event.source,
      reason: event.reason,
      actor: event.actor,
      at: event.at,
      ...(event.resolvedAt !== null ? { resolvedAt: event.resolvedAt } : {}),
      ...(event.resolution !== null && event.resolution !== ""
        ? { resolution: event.resolution }
        : {}),
    })),
  });
};

const seconds = (from: string | null, to: string | null): number | null => {
  if (from === null || to === null) return null;
  const difference = Math.round((Date.parse(to) - Date.parse(from)) / 1000);
  return Number.isFinite(difference) ? Math.max(0, difference) : null;
};

const status: SliceHandler = async (_input, context) => {
  const stats = eventStats(intakeState(context.service));
  // The first import and the first reconciliation are read from the lanes that own them, through
  // their own operations, oldest last on the last page.
  let imports = 0;
  let firstImportAt: string | null = null;
  try {
    const first = await callOperation<{ count: number; runs: { at: string }[] }>(
      context,
      "import.history",
      { page: 1 },
    );
    imports = first.count;
    if (imports > 0) {
      const last =
        imports > first.runs.length
          ? await callOperation<{ runs: { at: string }[] }>(context, "import.history", {
              page: Math.ceil(imports / 10),
            })
          : first;
      firstImportAt = last.runs.at(-1)?.at ?? null;
    }
  } catch {
    // A lane that cannot be read leaves its measure empty; it is never guessed.
  }
  let reconciliations = 0;
  let firstReconciliationAt: string | null = null;
  try {
    const first = await callOperation<{ count: number; items: { completedAt: string | null }[] }>(
      context,
      "reconcile.list",
      { status: "completed", page: 1 },
    );
    reconciliations = first.count;
    if (reconciliations > 0) {
      const last =
        reconciliations > first.items.length
          ? await callOperation<{ items: { completedAt: string | null }[] }>(
              context,
              "reconcile.list",
              { status: "completed", page: Math.ceil(reconciliations / 25) },
            )
          : first;
      firstReconciliationAt = last.items.at(-1)?.completedAt ?? null;
    }
  } catch {}
  let gapLog = 0;
  try {
    gapLog = (await callOperation<{ open: number }>(context, "gaps.list", { status: "open" })).open;
  } catch {}
  return scrub({
    startedAt: stats.firstAt,
    firstImportAt,
    firstReconciliationAt,
    secondsToFirstImport: seconds(stats.firstAt, firstImportAt),
    secondsToFirstReconciliation: seconds(stats.firstAt, firstReconciliationAt),
    interventions: stats.byClass.agent + stats.byClass.retry + stats.byClass.human,
    unresolvedGaps: stats.openGaps,
    events: { total: stats.total, ...stats.byClass },
    byKind: stats.byKind,
    imports,
    reconciliations,
    gapLog: { open: gapLog },
  });
};

export const intakeHandlers: SliceHandlers = {
  "intake.scan": scan,
  "intake.plan": plan,
  "intake.trialBalance": trialBalance,
  "intake.recipeTest": recipeTest,
  "intake.recipeSave": recipeSave,
  "intake.recipeList": recipeList,
  "intake.friction": friction,
  "intake.frictionList": frictionList,
  "intake.status": status,
};
