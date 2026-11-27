import { ApplicationError } from "../../errors.ts";
import { compileEntry, type PreparedLine, prepareLine } from "../../rules/engine.ts";
import { asBankLine } from "../../rules/history.ts";
import { canonicalText, textMatches } from "../../rules/text.ts";
import { suggestRule } from "../../rules/suggest.ts";
import type { ChartAccount, RuleAuthor, RuleDefinition } from "../../rules/types.ts";
import { measureUsage, type RuleUsage } from "../../rules/usage.ts";
import { validateRule } from "../../rules/validate.ts";
import type { ApplicationService } from "../../service.ts";
import type { SliceContext, SliceHandler, SliceHandlers } from "../types.ts";
import * as classifier from "./classifier-ops.ts";
import { readChart, readLedgerView } from "./history.ts";
import { readInbox } from "./inbox.ts";
// Registers the rules and classifier proposers with the Inbox when this slice loads.
import "./proposers.ts";
import {
  appendRevision,
  bumpRulesRevision,
  MAX_ACTIVE_RULES,
  readOrderChange,
  readRevisions,
  readRule,
  readRules,
  rulesRevision,
  rulesState,
  saveRule,
  setPositions,
  type StoredRule,
  writeOrderChange,
} from "./store.ts";
import { checkTypedLines, emptySection, runRuleTest, type TypedLine } from "./testing.ts";
import {
  assertUsable,
  changedFields,
  resolveAuthor,
  type RuleInputWire,
  toDefinition,
  toInput,
  toRecord,
  toRevision,
} from "./wire.ts";

/** The rules lane's operations. Inputs are already validated against the schema, the caller's
 * permission is checked and the book is configured by the time a handler runs. Writes are
 * retained under the caller's operation identity (a retry returns the first response and never
 * repeats the effect). Rules and the classifier only propose; nothing here posts anything. */

const notFound = () => new ApplicationError("rule_not_found", "No rule has that id", 404);

function staleRule(current: StoredRule, expected: number): ApplicationError {
  return new ApplicationError(
    "rule_revision_conflict",
    `This rule changed since you read it (it is at revision ${current.revision}; you sent ${expected}). Read it again and reapply your change.`,
    409,
  );
}

function activeRule(service: ApplicationService, id: string): StoredRule {
  const rule = readRule(service.store, id);
  if (!rule) throw notFound();
  if (rule.status !== "active")
    throw new ApplicationError(
      "rule_deleted",
      "This rule has been deleted. Create a new rule instead.",
      409,
    );
  return rule;
}

function listWire(
  service: ApplicationService,
  status: "active" | "deleted",
  chart: ReadonlyMap<string, ChartAccount>,
  measured: {
    usage: ReadonlyMap<string, RuleUsage>;
    window: Record<string, unknown>;
  } | null = null,
): Record<string, unknown> {
  const rules = readRules(service.store, status);
  const order = readOrderChange(service.store);
  return {
    rulesRevision: rulesRevision(service.store),
    count: rules.length,
    enabled: rules.filter((rule) => rule.enabled).length,
    orderedBy: order?.madeBy ?? null,
    orderedAt: order?.madeAt ?? null,
    window: measured?.window ?? null,
    rules: rules.map((rule) => {
      const usage = measured?.usage.get(rule.id);
      return { ...toRecord(rule, chart), ...(usage ? { usage } : {}) };
    }),
  };
}

const list = async (input: Record<string, unknown>, { service }: SliceContext) => {
  const state = rulesState(service);
  const status = (input.status as "active" | "deleted" | undefined) ?? "active";
  const days = (input.days as number | undefined) ?? 90;
  if (input.usage !== true || status !== "active")
    return listWire(service, status, await readChart(service));
  const ledger = await readLedgerView(service);
  // Usage is measured with the same engine that proposes, over the lines waiting in the Inbox and
  // the posted lines of the last `days`.
  const to = state.today();
  const from = addDays(to, -(days - 1));
  const inbox = readInbox(service);
  const prepared: PreparedLine[] = [];
  for (const item of inbox.items)
    if (item.line.kind === "bankLine") prepared.push(prepareLine(item.line, item.ledgerAccountId));
  const history = ledger.lines.filter((line) => line.date >= from && line.date <= to);
  for (const line of history)
    prepared.push(prepareLine(asBankLine(line, ledger.currency), line.bankAccountId));
  const entries = readRules(service.store, "active").map(compileEntry);
  const report = measureUsage(entries, prepared);
  const notes: string[] = [];
  if (!inbox.available)
    notes.push("The Inbox could not be read; the figures are posted history only.");
  else if (inbox.truncated)
    notes.push("The Inbox has more lines than one pass reads; the figures cover the first ones.");
  if (report.considered === 0)
    notes.push("There are no lines in the window yet, so no rule has anything to match.");
  return listWire(service, status, ledger.chart, {
    usage: report.perRule,
    window: {
      from,
      to,
      days,
      inbox: inbox.items.length,
      history: history.length,
      considered: report.considered,
      decided: report.decidedLines,
      notes,
    },
  });
};

const get = async (input: Record<string, unknown>, { service }: SliceContext) => {
  const rule = readRule(service.store, input.ruleId as string);
  if (!rule) throw notFound();
  const chart = await readChart(service);
  return {
    rule: toRecord(rule, chart),
    history: readRevisions(service.store, rule.id).map(toRevision),
  };
};

const create = async (
  input: Record<string, unknown>,
  { service, operationId, access }: SliceContext,
) => {
  const state = rulesState(service);
  const wire = input as { rule: RuleInputWire; madeBy?: RuleAuthor; position?: number };
  const definition = toDefinition(wire.rule);
  const chart = await readChart(service);
  assertUsable(definition, chart);
  return service.retainRequest(operationId, "rules.create", input, () => {
    const active = readRules(service.store, "active");
    if (active.length >= MAX_ACTIVE_RULES)
      throw new ApplicationError(
        "rule_limit_reached",
        `A book can hold ${MAX_ACTIVE_RULES} active rules. Delete rules that no longer earn their place, or fold several into one.`,
        409,
      );
    const author = resolveAuthor(access, wire.madeBy);
    const now = state.now();
    const position = Math.min(Math.max(1, wire.position ?? active.length + 1), active.length + 1);
    const rule: StoredRule = {
      ...definition,
      id: crypto.randomUUID(),
      status: "active",
      priority: position,
      revision: 1,
      createdBy: author,
      createdAt: now,
      updatedBy: author,
      updatedAt: now,
    };
    const order = active.map((item) => item.id);
    order.splice(position - 1, 0, rule.id);
    saveRule(service.store, rule);
    setPositions(service.store, order);
    appendRevision(service.store, rule, ["created"], null);
    if (position <= active.length) writeOrderChange(service.store, author, now);
    bumpRulesRevision(service.store);
    return toRecord(rule, chart);
  });
};

const update = async (
  input: Record<string, unknown>,
  { service, operationId, access }: SliceContext,
) => {
  const state = rulesState(service);
  const wire = input as {
    ruleId: string;
    expectedRevision: number;
    rule: RuleInputWire;
    madeBy?: RuleAuthor;
  };
  const definition = toDefinition(wire.rule);
  const chart = await readChart(service);
  assertUsable(definition, chart);
  return service.retainRequest(operationId, "rules.update", input, () => {
    const current = activeRule(service, wire.ruleId);
    if (current.revision !== wire.expectedRevision) throw staleRule(current, wire.expectedRevision);
    const changed = changedFields(current, definition);
    // An edit that changes nothing is not a revision: the history stays a record of real changes.
    if (changed.length === 0) return toRecord(current, chart);
    const author = resolveAuthor(access, wire.madeBy);
    const next: StoredRule = {
      ...current,
      ...definition,
      revision: current.revision + 1,
      updatedBy: author,
      updatedAt: state.now(),
    };
    saveRule(service.store, next);
    appendRevision(service.store, next, changed, null);
    bumpRulesRevision(service.store);
    return toRecord(next, chart);
  });
};

const remove = async (
  input: Record<string, unknown>,
  { service, operationId, access }: SliceContext,
) => {
  const state = rulesState(service);
  const wire = input as {
    ruleId: string;
    expectedRevision: number;
    madeBy?: RuleAuthor;
    reason?: string;
  };
  const chart = await readChart(service);
  return service.retainRequest(operationId, "rules.delete", input, () => {
    const current = activeRule(service, wire.ruleId);
    if (current.revision !== wire.expectedRevision) throw staleRule(current, wire.expectedRevision);
    const next: StoredRule = {
      ...current,
      status: "deleted",
      priority: 0,
      revision: current.revision + 1,
      updatedBy: resolveAuthor(access, wire.madeBy),
      updatedAt: state.now(),
    };
    saveRule(service.store, next);
    setPositions(
      service.store,
      readRules(service.store, "active").map((rule) => rule.id),
    );
    appendRevision(service.store, next, ["deleted"], wire.reason?.trim() || null);
    bumpRulesRevision(service.store);
    return toRecord(next, chart);
  });
};

const reorder = async (
  input: Record<string, unknown>,
  { service, operationId, access }: SliceContext,
) => {
  const state = rulesState(service);
  const wire = input as {
    expectedRulesRevision: number;
    orderedRuleIds: readonly string[];
    madeBy?: RuleAuthor;
  };
  const chart = await readChart(service);
  return service.retainRequest(operationId, "rules.reorder", input, () => {
    const current = rulesRevision(service.store);
    if (current !== wire.expectedRulesRevision)
      throw new ApplicationError(
        "rules_order_conflict",
        `The rules changed since you read them (they are at revision ${current}; you sent ${wire.expectedRulesRevision}). Read the list again and reorder that.`,
        409,
      );
    const active = readRules(service.store, "active");
    const ids = new Set(wire.orderedRuleIds);
    const complete =
      ids.size === wire.orderedRuleIds.length &&
      ids.size === active.length &&
      active.every((rule) => ids.has(rule.id));
    if (!complete)
      throw new ApplicationError(
        "rules_order_invalid",
        "List every active rule exactly once, highest priority first.",
        400,
        [{ path: "input.orderedRuleIds", message: "Must be every active rule exactly once" }],
      );
    const unchanged = active.every((rule, index) => wire.orderedRuleIds[index] === rule.id);
    if (!unchanged) {
      setPositions(service.store, wire.orderedRuleIds);
      writeOrderChange(service.store, resolveAuthor(access, wire.madeBy), state.now());
      bumpRulesRevision(service.store);
    }
    return listWire(service, "active", chart);
  });
};

function addDays(date: string, delta: number): string {
  const [year = 0, month = 1, day = 1] = date.split("-").map(Number);
  return new Date(Date.UTC(year, month - 1, day + delta)).toISOString().slice(0, 10);
}

const STRUCTURAL = ["name", "conditions", "groups", "accountIds"];

const test = async (input: Record<string, unknown>, { service }: SliceContext) => {
  const state = rulesState(service);
  const wire = input as {
    ruleId?: string;
    rule?: RuleInputWire;
    position?: number;
    days?: number;
    asOf?: string;
    samples?: number;
    lines?: readonly {
      description: string;
      counterparty?: string;
      reference?: string;
      amount: string;
      accountId?: string;
      provider?: string;
    }[];
  };
  const ledger = await readLedgerView(service);
  const active = readRules(service.store, "active");
  let definition: RuleDefinition;
  let candidateId: string | null = null;
  let position: number;
  if (wire.ruleId !== undefined) {
    const stored = activeRule(service, wire.ruleId);
    candidateId = stored.id;
    definition = wire.rule ? toDefinition(wire.rule) : stored;
    position = stored.priority;
  } else if (wire.rule) {
    definition = toDefinition(wire.rule);
    position = Math.min(Math.max(1, wire.position ?? active.length + 1), active.length + 1);
  } else
    throw new ApplicationError("invalid_input", "Give a ruleId, or a rule to test", 400, [
      { path: "input", message: "Supply ruleId, rule, or both" },
    ]);
  const to = wire.asOf ?? state.today();
  const days = wire.days ?? 90;
  const from = addDays(to, -(days - 1));
  const problems = validateRule(definition, ledger.chart);
  const blocked = problems.some((problem) =>
    STRUCTURAL.some((field) => problem.path === field || problem.path.startsWith(`${field}[`)),
  );
  const base = { from, to, days, problems };
  const typedInput = wire.lines ?? [];
  if (blocked)
    return {
      ...base,
      position,
      inbox: emptySection(),
      history: emptySection(),
      agreement: { agreed: 0, differed: 0, notComparable: 0 },
      lines: [],
      notes: ["Fix the problems above to see what the rule matches."],
    };
  const others = active.filter((rule) => rule.id !== candidateId);
  const actionComplete = problems.length === 0;
  // The lines a person typed are on an account: the one they name, else the rule's own, else the
  // first open asset account (a bank account is where a line lands).
  const fallbackAccount = (): string | null => {
    const scoped = definition.accountIds.find((accountId) => ledger.chart.has(accountId));
    if (scoped) return scoped;
    const banks = [...ledger.chart.values()]
      .filter((account) => account.role === "asset" && account.closedOn === null)
      .sort((a, b) => (a.code < b.code ? -1 : a.code > b.code ? 1 : 0));
    return banks[0]?.id ?? null;
  };
  const typed: TypedLine[] = typedInput.map((line, index) => {
    const accountId = line.accountId ?? fallbackAccount();
    if (accountId === null || !ledger.chart.has(accountId))
      throw new ApplicationError("invalid_input", "That account is not in the chart", 400, [
        { path: `input.lines[${index}].accountId`, message: "Choose an account from the chart" },
      ]);
    return {
      description: line.description,
      amount: line.amount,
      accountId,
      provider: (line.provider ?? "csv").trim().toLowerCase() || "csv",
      ...(line.counterparty ? { counterparty: line.counterparty } : {}),
      ...(line.reference ? { reference: line.reference } : {}),
    };
  });
  const inbox = readInbox(service);
  const result = runRuleTest({
    candidate: definition,
    candidateId,
    position,
    others,
    chart: ledger.chart,
    currency: ledger.currency,
    history: ledger.lines.filter((line) => line.date >= from && line.date <= to),
    inbox,
    samples: wire.samples ?? 5,
    actionComplete,
  });
  const lines = checkTypedLines(
    { candidate: definition, candidateId, position, others, chart: ledger.chart, actionComplete },
    typed,
  );
  return { ...base, ...result, lines };
};

const suggest = async (input: Record<string, unknown>, { service }: SliceContext) => {
  const wire = input as {
    description: string;
    counterparty?: string;
    amount: string;
    accountId?: string;
    categoryAccountId?: string;
  };
  const ledger = await readLedgerView(service);
  const chosen = wire.categoryAccountId ? ledger.chart.get(wire.categoryAccountId) : undefined;
  const usable = chosen !== undefined && chosen.closedOn === null;
  const suggestion = suggestRule({
    description: wire.description,
    amount: wire.amount,
    ...(wire.counterparty !== undefined ? { counterparty: wire.counterparty } : {}),
    ...(usable && wire.categoryAccountId ? { categoryAccountId: wire.categoryAccountId } : {}),
  });
  const notes = [...suggestion.notes];
  if (wire.categoryAccountId && !usable)
    notes.push(
      "The account you named is not in the chart or is closed, so none was chosen for the rule.",
    );
  let rule = suggestion.rule;
  if (rule && suggestion.basis) {
    // What did the book do with lines like this before?
    const needle = canonicalText(suggestion.basis.phrase);
    const direction = rule.conditions.find((condition) => condition.field === "direction")?.value;
    const tally = new Map<string, number>();
    let seen = 0;
    for (const line of ledger.lines) {
      if (direction && (line.cents > 0n ? "in" : "out") !== direction) continue;
      if (!textMatches("contains", canonicalText(line.text), needle)) continue;
      seen++;
      tally.set(line.categoryId, (tally.get(line.categoryId) ?? 0) + 1);
    }
    const label = (id: string): string => {
      const account = ledger.chart.get(id);
      return account ? `${account.code} ${account.name}` : id;
    };
    const top = [...tally.entries()].sort((a, b) => b[1] - a[1] || (a[0] < b[0] ? -1 : 1))[0];
    if (top && seen > 0) {
      const [accountId, times] = top;
      const target = ledger.chart.get(accountId);
      if (
        !rule.action.accountId &&
        seen >= 2 &&
        times * 10 >= seen * 8 &&
        target?.closedOn === null
      ) {
        rule = { ...rule, action: { ...rule.action, accountId } };
        notes.push(
          `${times} of the ${seen} earlier lines like this were booked to ${label(accountId)}, so the rule books to it. Check that it is right.`,
        );
      } else if (rule.action.accountId) {
        const agreed = tally.get(rule.action.accountId) ?? 0;
        notes.push(
          `${agreed} of the ${seen} earlier lines like this were booked to ${label(rule.action.accountId)}${agreed < seen ? `; the others went elsewhere, most often to ${label(accountId)}` : ""}.`,
        );
      } else
        notes.push(
          `${seen} earlier lines look like this and they were booked to different accounts, so choose the account yourself.`,
        );
    } else if (!rule.action.accountId)
      notes.push("No earlier line looks like this one, so choose the account to book it to.");
  }
  return {
    rule: rule ? toInput(rule) : null,
    basis: suggestion.basis
      ? {
          field: suggestion.basis.field,
          phrase: suggestion.basis.phrase,
          dropped: suggestion.basis.dropped.slice(0, 50),
        }
      : null,
    notes: notes.slice(0, 20),
  };
};

/** The lane's tables are created on first use. Every operation opens them before it reads or writes,
 * so the first call on a fresh book (a list, a status) finds them and does not fail. */
const opened =
  (handler: SliceHandler): SliceHandler =>
  (input, context) => {
    rulesState(context.service);
    return handler(input, context);
  };

export const rulesHandlers: SliceHandlers = Object.fromEntries(
  Object.entries({
    "rules.list": list,
    "rules.get": get,
    "rules.create": create,
    "rules.update": update,
    "rules.delete": remove,
    "rules.reorder": reorder,
    "rules.test": test,
    "rules.suggest": suggest,
    "classifier.status": (_input: Record<string, unknown>, { service }: SliceContext) =>
      classifier.status(service),
    "classifier.configure": (
      input: Record<string, unknown>,
      { service, operationId }: SliceContext,
    ) => classifier.configure(service, operationId, input),
    "classifier.train": (_input: Record<string, unknown>, { service, operationId }: SliceContext) =>
      classifier.train(service, operationId),
    "classifier.evaluate": (input: Record<string, unknown>, { service }: SliceContext) =>
      classifier.evaluateNow(service, input),
  }).map(([name, handler]) => [name, opened(handler)]),
);
