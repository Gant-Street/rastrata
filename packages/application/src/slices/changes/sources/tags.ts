/** Account tags: a tag set or cleared on an account after the book was set up, read through
 * `accounts.list` (which accounts there are, and the revision of the tags) and `accounts.tagHistory`
 * (every recorded change to one account's tags). The tags that were given when the book was set up are
 * part of the book being opened, not changes after it.
 *
 * Reading the history takes one call for each account, so what was read is kept for as long as neither
 * the tags nor the chart has changed. */
import { actorOf } from "../../../changes/actors.ts";
import type { Candidate } from "../../../changes/candidate.ts";
import { type ActorRef, UNKNOWN_ACTOR } from "../../../changes/kinds.ts";
import { shortDate } from "../../../changes/ledger.ts";
import type { AccountList, AccountTagHistory } from "../../../client-contracts.gen.ts";
import { sanitizeText } from "../../../ingest/text.ts";
import { callOperation } from "../call.ts";
import { changesState, type TagRow } from "../store.ts";
import { asInstant, type SourceReader } from "./types.ts";

const WHAT: Readonly<Record<string, string>> = {
  cashFlowClass: "cash-flow class",
  taxLine: "tax line",
  roleKey: "role key",
};

export const tagsSource: SourceReader = {
  name: "tags",
  title: "Account tags",
  async read({ context }) {
    const state = changesState(context.service);
    const chart = await callOperation<AccountList>(context, "accounts.list", {});
    const key = `${chart.tagsRevision ?? ""}:${chart.configurationRevision}`;
    let rows = state.tagCache?.key === key ? state.tagCache.rows : null;
    if (rows === null) {
      const read: TagRow[] = [];
      for (const account of chart.accounts) {
        const history = await callOperation<AccountTagHistory>(context, "accounts.tagHistory", {
          accountId: account.id,
        });
        for (const event of history.events)
          if (event.source === "change")
            read.push({
              accountId: account.id,
              code: account.code,
              name: account.name,
              tag: event.tag,
              effectiveOn: event.effectiveOn,
              value: event.value,
              recordedAt: event.recordedAt,
              by: event.by ?? null,
            });
      }
      state.tagCache = { key, rows: read };
      rows = read;
    }
    const found: Candidate[] = [];
    const ordinal = new Map<string, number>();
    for (const row of rows) {
      const at = asInstant(row.recordedAt);
      if (at === null) continue;
      const n = (ordinal.get(row.accountId) ?? 0) + 1;
      ordinal.set(row.accountId, n);
      const actor: ActorRef =
        row.by === null ? UNKNOWN_ACTOR : actorOf(row.by, state.labelFor(row.by));
      const what = WHAT[row.tag] ?? "tag";
      const account = `${sanitizeText(row.code, 20)} ${sanitizeText(row.name, 120)}`;
      const summary =
        row.value === null
          ? `Cleared the ${what} of account ${account} (from ${shortDate(row.effectiveOn)}).`
          : `Set the ${what} of account ${account} to ${sanitizeText(row.value, 60)} (from ${shortDate(row.effectiveOn)}).`;
      const id = `tag:${row.accountId}:${n}`;
      const record = {
        id,
        at,
        revision: null,
        kind: "account.tagged" as const,
        summary: sanitizeText(summary, 400),
        subject: { kind: "account" as const, id: row.accountId },
        by: { kind: actor.kind, label: actor.label, ...(actor.id ? { id: actor.id } : {}) },
        how: "",
      };
      found.push({
        at,
        revision: null,
        kind: "account.tagged",
        actor,
        order: id,
        build: () => record,
      });
    }
    return { candidates: found };
  },
};
