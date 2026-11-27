/** Rules: when each was made and changed, and by whom, read through `rules.list` and `rules.get`
 * (the rules keep who made every revision of every rule, and when). A rule that was deleted stays in
 * `rules.list` with the status `deleted`, so a deletion is a change like another. */
import { actorOf, authorOf } from "../../../changes/actors.ts";
import type { Candidate } from "../../../changes/candidate.ts";
import type { ActorRef, ChangeKind } from "../../../changes/kinds.ts";
import type {
  ChangeRecord,
  RuleAuthor,
  RuleDetail,
  RuleList,
  RuleRecord,
} from "../../../client-contracts.gen.ts";
import { sanitizeText } from "../../../ingest/text.ts";
import { callOperation } from "../call.ts";
import { asInstant, type SourceReader, type SourceWindow } from "./types.ts";

/** The parts of a rule that an edit can change, in the words of a sentence. */
const FIELDS: Readonly<Record<string, string>> = {
  name: "its name",
  enabled: "whether it is on",
  accountIds: "the accounts it applies to",
  match: "how its conditions combine",
  conditions: "its conditions",
  groups: "its groups of conditions",
  action: "its action",
  note: "its note",
};

/** An agent's rules are recorded as "<token name> (agent:<token id>)": the name and the identifier are
 * taken apart, so the list can say who and a screen can find the agent. */
const AGENT_NAME = /^(.*) \((agent:[A-Za-z0-9_-]+)\)$/;

export function ruleActor(author: RuleAuthor): ActorRef {
  if (author.kind === "agent") {
    const found = AGENT_NAME.exec(author.name ?? "");
    if (found) return actorOf(found[2] as string, found[1] as string);
  }
  return authorOf(author);
}

const quoted = (name: string): string => `"${sanitizeText(name, 80)}"`;

function describeChange(
  name: string,
  changed: readonly string[],
): { kind: ChangeKind; summary: string; how: string } {
  if (changed.includes("deleted"))
    return {
      kind: "rule.changed",
      summary: `Deleted the rule ${quoted(name)}.`,
      how: "",
    };
  const parts = changed.flatMap((field) => (FIELDS[field] ? [FIELDS[field] as string] : []));
  return {
    kind: "rule.changed",
    summary:
      parts.length === 0
        ? `Changed the rule ${quoted(name)}.`
        : `Changed the rule ${quoted(name)}: ${parts.join(", ")}.`,
    how: "",
  };
}

function candidate(
  at: string,
  id: string,
  kind: ChangeKind,
  actor: ActorRef,
  subject: string,
  summary: string,
  how: string,
): Candidate {
  const record: ChangeRecord = {
    id,
    at,
    revision: null,
    kind,
    summary,
    subject: { kind: "rule", id: subject },
    by: { kind: actor.kind, label: actor.label, ...(actor.id ? { id: actor.id } : {}) },
    how,
  };
  return { at, revision: null, kind, actor, order: id, build: () => record };
}

/** The revisions of a rule that fall inside the window, so a rule that was edited a hundred times
 * long ago costs one read only if it was edited since. */
const mayHaveNews = (rule: RuleRecord, window: SourceWindow): boolean => {
  const updated = asInstant(rule.updatedAt);
  return (
    rule.revision > 1 && (updated === null || window.sinceAt === null || updated >= window.sinceAt)
  );
};

export const rulesSource: SourceReader = {
  name: "rules",
  title: "Rules",
  async read({ context, window }) {
    const found: Candidate[] = [];
    let incomplete: string | undefined;
    for (const status of ["active", "deleted"] as const) {
      const list = await callOperation<RuleList>(context, "rules.list", { status });
      if (status === "active" && list.orderedAt !== null && list.orderedBy !== null) {
        const at = asInstant(list.orderedAt);
        if (at !== null)
          found.push(
            candidate(
              at,
              `rule:order:${at}`,
              "rule.changed",
              ruleActor(list.orderedBy),
              "order",
              "Changed the order of the rules.",
              "",
            ),
          );
      }
      for (const rule of list.rules) {
        const created = asInstant(rule.createdAt);
        if (created !== null)
          found.push(
            candidate(
              created,
              `rule:${rule.id}:1`,
              "rule.created",
              ruleActor(rule.createdBy),
              rule.id,
              `Created the rule ${quoted(rule.name)}.`,
              "",
            ),
          );
        if (!mayHaveNews(rule, window)) continue;
        try {
          const detail = await callOperation<RuleDetail>(context, "rules.get", {
            ruleId: rule.id,
          });
          for (const revision of detail.history) {
            if (revision.revision < 2) continue;
            const at = asInstant(revision.madeAt);
            if (at === null) continue;
            const change = describeChange(rule.name, revision.changed);
            found.push(
              candidate(
                at,
                `rule:${rule.id}:${revision.revision}`,
                change.kind,
                ruleActor(revision.madeBy),
                rule.id,
                change.summary,
                change.how,
              ),
            );
          }
        } catch {
          incomplete =
            "The history of one or more rules could not be read, so their edits are missing.";
        }
      }
    }
    return incomplete === undefined ? { candidates: found } : { candidates: found, incomplete };
  },
};
