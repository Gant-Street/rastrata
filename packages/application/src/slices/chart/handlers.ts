import {
  ensureChartTables,
  readAccountTags,
  readTagLog,
  setupRecords,
  type AccountTagMap,
} from "../../account-tags.ts";
import { lockedPeriods } from "../../calendar/periods.ts";
import { isCalendarDate, isTagKey, TAG_KEYS, tagProblem, type TagKey } from "../../chart/tags.ts";
import { describePrincipal } from "../../agent/principal.ts";
import { ApplicationError } from "../../errors.ts";
import type { ApplicationService } from "../../service.ts";
import { sliceState } from "../state.ts";
import type { SliceHandlers } from "../types.ts";
import { catalogHandlers } from "./catalog.ts";

/** Per-service runtime state: the tables exist, and the clock tags are stamped with. A test may
 * seed its own clock with `sliceState(service, "chart", () => ({ now }))` before the first call. */
export interface ChartState {
  readonly now: () => string;
}
export function chartState(service: ApplicationService): ChartState {
  return sliceState(service, "chart", (store) => {
    ensureChartTables(store);
    return { now: () => service.now() };
  });
}

const FIRST_DATE = "2000-01-01";
const LAST_DATE = "2100-12-31";
/** Far enough ahead that "the latest state" means every recorded change has taken effect. */
const END_OF_TIME = "9999-12-31";

interface BookAccount {
  readonly id: string;
  readonly code: string;
  readonly name: string;
  readonly role: Parameters<typeof tagProblem>[0];
  readonly openedOn: string;
}

async function bookAccounts(service: ApplicationService) {
  const { aggregate } = await service.readAggregate();
  const state = aggregate.state;
  const locked = lockedPeriods(state);
  const closedPeriods = state.periods
    .filter((period) => locked.has(period.id))
    .map((period) => ({ label: period.label, startsOn: period.startsOn, endsOn: period.endsOn }));
  return {
    accounts: state.admissionSnapshot.accounts as readonly BookAccount[],
    closedPeriods,
  };
}

function findAccount(accounts: readonly BookAccount[], accountId: string): BookAccount {
  const account = accounts.find((item) => item.id === accountId);
  if (!account)
    throw new ApplicationError(
      "account_not_found",
      "No account has that id. Use accounts.list to find an account's id.",
      404,
    );
  return account;
}

type Patch = Partial<Record<TagKey, string | null>>;

/** Validate and record one change under the caller's transaction. Returns the result the first
 * caller gets and every retry replays. */
function applyTags(
  service: ApplicationService,
  context: Awaited<ReturnType<typeof bookAccounts>>,
  account: BookAccount,
  request: { readonly effectiveOn: string; readonly tags: Patch },
  operationId: string,
  recordedAt: string,
  principal: string,
) {
  const store = service.store;
  const entries = TAG_KEYS.flatMap((tag) => {
    const value = request.tags[tag];
    return value === undefined ? [] : [[tag, value] as const];
  });
  if (entries.length === 0)
    throw new ApplicationError(
      "invalid_tag",
      "Nothing to change: give at least one of cashFlowClass, taxLine, roleKey or kind (null clears one).",
      400,
    );
  const { effectiveOn } = request;
  if (!isCalendarDate(effectiveOn) || effectiveOn < FIRST_DATE || effectiveOn > LAST_DATE)
    throw new ApplicationError(
      "effective_date_invalid",
      `effectiveOn must be a real date from ${FIRST_DATE} to ${LAST_DATE}.`,
      400,
      [{ path: "input.effectiveOn", message: "Not a supported date" }],
    );
  if (effectiveOn < account.openedOn)
    throw new ApplicationError(
      "effective_before_account_opened",
      `Account ${account.code} opened on ${account.openedOn}; tags can start on or after that date.`,
      400,
      [{ path: "input.effectiveOn", message: `Account opened on ${account.openedOn}` }],
    );
  for (const [tag, value] of entries) {
    if (value === null) continue;
    const problem = tagProblem(account.role, tag, value);
    if (problem)
      throw new ApplicationError(problem.code, problem.message, 400, [
        { path: `input.tags.${tag}`, message: problem.message },
      ]);
  }

  const before = readAccountTags(store);
  const inForce = before.tagsFor(account.id, effectiveOn);
  const roleKey = request.tags.roleKey;
  if (typeof roleKey === "string") {
    const holder = context.accounts.find(
      (other) =>
        other.id !== account.id && before.tagsFor(other.id, END_OF_TIME).roleKey === roleKey,
    );
    if (holder)
      throw new ApplicationError(
        "role_key_in_use",
        `Role key ${roleKey} is on account ${holder.code} (${holder.name}). A role key names one account: clear it there first.`,
        409,
        [{ path: "input.tags.roleKey", message: `Already on account ${holder.code}` }],
      );
  }
  // Only a value that differs from what is in force on that date is a change; recording the same
  // value again would add history without meaning.
  const changes = entries.filter(([tag, value]) => (inForce[tag] ?? null) !== value);
  for (const [tag, value] of changes)
    store
      .query(
        "INSERT INTO chart_tag_log (account_id, tag, effective_on, value, recorded_at, operation_id, principal) VALUES (?, ?, ?, ?, ?, ?, ?)",
      )
      .run(account.id, tag, effectiveOn, value, recordedAt, operationId, principal);

  const after = changes.length ? readAccountTags(store) : before;
  const affected = context.closedPeriods.filter((period) => period.endsOn >= effectiveOn);
  const warnings =
    changes.length && affected.length
      ? [
          `This takes effect in closed ${affected.length === 1 ? "period" : "periods"} (${affected
            .map((period) => `${period.label}, ${period.startsOn} to ${period.endsOn}`)
            .join("; ")}). Reports for ${
            affected.length === 1 ? "it" : "them"
          } will differ from the ones recorded when ${
            affected.length === 1 ? "it was" : "they were"
          } closed. Start the tag after the last closed period to leave them as they were.`,
        ]
      : [];
  return {
    accountId: account.id,
    effectiveOn,
    tags: after.tagsFor(account.id, effectiveOn),
    changed: changes.length > 0,
    tagsRevision: String(after.revision),
    tagsHash: after.hash,
    warnings,
  };
}

export const chartHandlers: SliceHandlers = {
  ...catalogHandlers,

  "accounts.setTags": async (input, { service, access, operationId }) => {
    const request = input as unknown as {
      accountId: string;
      effectiveOn: string;
      tags: Patch;
    };
    const { now } = chartState(service);
    const context = await bookAccounts(service);
    const account = findAccount(context.accounts, request.accountId);
    const recordedAt = now();
    // A retry replays the first response without running this again; a failure rolls everything
    // back, so a rejected request leaves no trace and can be sent again corrected.
    return service.retainRequest(operationId, "accounts.setTags", request, () =>
      applyTags(
        service,
        context,
        account,
        request,
        operationId,
        recordedAt,
        describePrincipal(access.principal),
      ),
    );
  },

  "accounts.tagHistory": async (input, { service }) => {
    const { accountId } = input as unknown as { accountId: string };
    chartState(service);
    const { accounts } = await bookAccounts(service);
    const account = findAccount(accounts, accountId);
    const store = service.store;
    const configuredAt =
      (
        store.query("SELECT configured_at FROM app_book WHERE id=1").get() as {
          configured_at: string;
        } | null
      )?.configured_at ?? "";
    const events = [
      // Tags given at setup are part of the immutable setup record; they read as starting with the
      // account.
      ...setupRecords(store)
        .filter((record) => record.accountId === account.id)
        .map((record) => ({
          tag: record.tag,
          effectiveOn: account.openedOn,
          value: record.value,
          source: "setup" as const,
          recordedAt: configuredAt,
        })),
      ...readTagLog(store)
        .filter((row) => row.account_id === account.id && isTagKey(row.tag))
        .map((row) => ({
          tag: row.tag as TagKey,
          effectiveOn: row.effective_on,
          value: row.value,
          source: "change" as const,
          recordedAt: row.recorded_at,
          ...(row.principal ? { by: row.principal } : {}),
        })),
    ];
    const map: AccountTagMap = readAccountTags(store);
    return {
      accountId: account.id,
      tagsRevision: String(map.revision),
      tagsHash: map.hash,
      events,
    };
  },
};
