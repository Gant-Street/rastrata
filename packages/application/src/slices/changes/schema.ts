import { ACTOR_KINDS, CHANGE_KINDS, SOURCE_NAMES, SUBJECT_KINDS } from "../../changes/kinds.ts";
import {
  array,
  date,
  money,
  nullable,
  object,
  operation,
  page,
  ref,
  revision,
  text,
  type Schema,
} from "../../schema-kit.ts";
import type { SliceSchema } from "../types.ts";

const count: Schema = { type: "integer", minimum: 0, maximum: 2147483647 };
/** An instant in UTC, as the service writes one: `2026-04-02T12:00:00.000Z`. */
const instant: Schema = {
  type: "string",
  pattern: "^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}(\\.[0-9]{1,6})?Z$",
  maxLength: 40,
};
const kind: Schema = { type: "string", enum: [...CHANGE_KINDS] };
const actorKind: Schema = { type: "string", enum: [...ACTOR_KINDS] };
const noteText = text(500);
/** Where a window starts or ends: a point the book names (`lastClose`, `lastReview`), a book revision
 * (digits) or a date. */
const point: Schema = {
  type: "string",
  pattern: "^(lastClose|lastReview|[0-9]{1,18}|[0-9]{4}-[0-9]{2}-[0-9]{2})$",
  maxLength: 20,
};
/** The end of a window cannot be a point the book names: only a revision or a date. */
const until: Schema = {
  type: "string",
  pattern: "^([0-9]{1,18}|[0-9]{4}-[0-9]{2}-[0-9]{2})$",
  maxLength: 20,
};

/** One list of what changed in the books, who made each change and when, and the record that a
 * person has looked at it.
 *
 * The ledger holds every fact, so most of the list is read from it; the rest (rules, tags,
 * reconciliations, who has access) lives in product state that other parts of Rastrata keep, and is
 * read only through their own operations. A source that cannot be read is named in the answer with
 * the reason; it is never left out quietly. */
export const changesSchema: SliceSchema = {
  name: "changes",
  definitions: {
    ChangeActor: object(
      {
        kind: actorKind,
        /** What the maker is called: "owner", an agent's name, a member's role, the service's name. For
         * a change whose maker the book did not record it is "not recorded". */
        label: text(100),
        /** The maker's identifier where it has one: an agent token's, a member's. */
        id: text(128),
      },
      ["kind", "label"],
    ),
    /** A kind of maker, and optionally one of them: by the name they go by, or, exactly, by their
     * identifier (`caller` can be passed as it is; the name is then not compared). */
    ChangeActorFilter: object({ kind: actorKind, label: text(100), id: text(128) }, ["kind"]),
    ChangeSubject: object({ kind: { type: "string", enum: [...SUBJECT_KINDS] }, id: text(128) }),
    /** For an entry, what a person reads first. Text from a bank or a person is kept short and plain. */
    ChangeEntry: object({
      journalId: text(128),
      /** The number a person reads the entry by ("No. 214"). */
      number: count,
      date,
      description: text(240),
      /** The total of the entry's debits (equal to its credits). */
      amount: money,
      /** The accounts it touches, by code and name, at most eight. */
      accounts: array(text(160), 8),
      accountCount: count,
    }),
    ChangeRecord: object(
      {
        /** Stable: the same change has the same id on every read. */
        id: text(160),
        at: instant,
        /** The book revision the change made, or null for a change that is not in the ledger. */
        revision: nullable(revision),
        kind,
        /** One sentence built by Rastrata. Text that came from outside is shortened and plain. */
        summary: text(400),
        subject: ref("ChangeSubject"),
        by: ref("ChangeActor"),
        /** How it was done, in words: the operation or the decision. */
        how: text(240),
        entry: ref("ChangeEntry"),
      },
      ["id", "at", "revision", "kind", "summary", "subject", "by", "how"],
    ),
    ChangeSourceStatus: object(
      {
        name: { type: "string", enum: [...SOURCE_NAMES] },
        /** In plain words: "The books", "For review", "Rules". */
        title: text(80),
        read: { type: "boolean" },
        /** Why it could not be read, in words; null when it was. */
        reason: nullable(text(300)),
        /** What the caller may not read of it, left out and said in one sentence; null when nothing was. */
        withheld: nullable(text(300)),
        /** How many changes it gave inside the window, before any filter. */
        changes: count,
      },
      ["name", "title", "read", "reason", "changes"],
    ),
    ChangeActorCount: object({ by: ref("ChangeActor"), count }),
    ChangeWindow: object({
      /** Where the list starts, in words: "the start of the book", "the close of March 2026". */
      since: text(240),
      /** The changes after this revision are in the window; "0" is the start of the book. */
      sinceRevision: revision,
      sinceAt: nullable(instant),
      /** Where it ends, in words, when `until` narrowed it. */
      until: nullable(text(240)),
    }),
    ChangeAttribution: object({
      /** The first change whose maker the book recorded. Earlier ones say "not recorded". */
      fromRevision: revision,
      fromAt: instant,
    }),
    ChangeReview: object({
      seq: count,
      at: instant,
      by: ref("ChangeActor"),
      /** The book revision up to which the person looked. */
      upToRevision: revision,
      /** The instant up to which they looked, for changes that are not in the ledger. */
      upToAt: instant,
      note: noteText,
    }),
    ChangeListInput: object(
      {
        since: point,
        until,
        /** Only these kinds of change. */
        kinds: array({ type: "string", enum: [...CHANGE_KINDS] }, CHANGE_KINDS.length),
        /** Only changes by this kind of maker, or by one named maker. A change whose maker was not
         * recorded matches only `unknown`. */
        by: ref("ChangeActorFilter"),
        /** Only changes whose sentence, subject or maker contains this text (no patterns). */
        text: text(200),
        /** Read the ledger up to this revision. Pass back the `revision` of the first page to read
         * the next page of the same list. */
        revision,
        /** Read the other sources up to this instant. Pass back the `asOf` of the first page. */
        asOf: instant,
        page,
        pageSize: { type: "integer", minimum: 1, maximum: 200 },
      },
      [],
    ),
    ChangeList: object(
      {
        /** The book revision the ledger was read at. */
        revision,
        /** The instant the other sources were read at. */
        asOf: instant,
        window: ref("ChangeWindow"),
        /** How many changes match, over all pages. */
        count,
        page,
        pageSize: { type: "integer", minimum: 1, maximum: 200 },
        /** Newest first. */
        changes: array(ref("ChangeRecord"), 200),
        /** Who made the changes in the window, before the `by` filter was applied. */
        actors: array(ref("ChangeActorCount"), 100),
        sources: array(ref("ChangeSourceStatus"), SOURCE_NAMES.length),
        /** What this list does not cover, so that a quiet list is not mistaken for a complete one. */
        notCovered: array(text(160), 8),
        /** How far back the book recorded who made each change; null when it never has. */
        attribution: nullable(ref("ChangeAttribution")),
        lastReview: nullable(ref("ChangeReview")),
        /** Who is asking, named as a change they make would name them: an agent finds its own changes by
         * it, and a screen says "you". */
        caller: ref("ChangeActor"),
      },
      [
        "revision",
        "asOf",
        "window",
        "count",
        "page",
        "pageSize",
        "changes",
        "actors",
        "sources",
        "notCovered",
        "attribution",
        "lastReview",
      ],
    ),
    ChangeReviewInput: object(
      {
        /** The book revision the list was read at. Omitted: the book as it is now. */
        upToRevision: revision,
        /** The instant the list was read at (its `asOf`). Omitted: now. */
        upToAt: instant,
        note: noteText,
      },
      [],
    ),
  },
  operations: [
    operation(
      "changes.list",
      `One list of what changed in the books, newest first: entries posted and reversed, periods closed and reopened, accounts added, changed and closed, rules, account tags, reconciliations, who was given or lost access, and the day the book was opened. Each change says what happened in one sentence, who made it (an agent, a person or the owner), how, and when. It can start at the last time the books were closed (\`since: "lastClose"\`), at the last time a person marked the changes as looked at (\`since: "lastReview"\`), at a book revision or at a date, and be narrowed by kind, maker or text. Read this at the end of a routine to give the owner an honest account of what you did, and show it with the sources it did and did not read: \`sources\` names every source and the reason one could not be read, and \`notCovered\` says what the list leaves out (changes to 1099 vendors, to the book's settings and to bank and Stripe connections). A change made before Rastrata recorded who made it says "not recorded"; that is never a guess. \`caller\` names who is asking, the way their own changes are named: pass it as \`by\` to read only yours. Pages are read at the revision the first page was read at (pass back \`revision\` and \`asOf\`), so a page does not shift while it is read.`,
      "read",
      "ChangeListInput",
      false,
      "ChangeList",
    ),
    operation(
      "changes.review",
      'Record that you have looked at all the changes up to a point: the next list that starts "since the last look" begins after it. This is a statement by a person, so it is refused for an agent (code review_needs_a_person): an agent must not mark its own work as looked at. Needs close permission. It only adds a record; nothing is edited or deleted, and a record made earlier is kept. Pass the revision and asOf of the list that was looked at; if the book changed after it, those later changes stay unreviewed.',
      "close",
      "ChangeReviewInput",
      true,
      "ChangeReview",
    ),
  ],
};
