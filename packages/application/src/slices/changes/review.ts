/** `changes.review`: a person says they have looked at the changes up to a point. A review is a
 * statement, like a reconciliation: it is added and never edited, and the list that starts "since the
 * last look" begins after the newest one, whoever made it. */
import { describePrincipal } from "../../agent/principal.ts";
import { actorOf } from "../../changes/actors.ts";
import type { ChangeReview, ChangeReviewInput } from "../../client-contracts.gen.ts";
import { ApplicationError } from "../../errors.ts";
import { sanitizeText } from "../../ingest/text.ts";
import type { SliceContext } from "../types.ts";
import { unreadSources } from "./list.ts";
import { changesState, labelOf } from "./store.ts";

export async function reviewChanges(
  context: SliceContext,
  input: ChangeReviewInput,
): Promise<ChangeReview> {
  const { service, access, operationId } = context;
  // A review is a person's statement that they looked. An agent must not mark its own work as looked at,
  // and the control plane is not a person. (An agent that holds the owner's own key is the owner as far
  // as the book can tell: a person who gives an agent that key has given it this too.)
  const kind = access.principal?.kind;
  if (kind === "token" || kind === "service")
    throw new ApplicationError(
      "review_needs_a_person",
      "Only a person can mark changes as looked at. An agent cannot mark its own work as looked at: ask the owner to look.",
      403,
    );
  // "I have looked at these" has to be true of all of them. A list with a part this sign-in cannot read
  // is not all there is, and the next list starts after the point named here, so what was not shown
  // would never be shown: someone who can read all of it has to look.
  // A look that was recorded is returned as it was, whatever can be read now: asking again with the same
  // identity (after a reply was lost) must not turn a recorded look into a refusal.
  const recorded = await service.operation(operationId).then(
    (found) => found.disposition === "completed",
    () => false,
  );
  const unread = recorded ? [] : await unreadSources(context);
  if (unread.length > 0) {
    const names = unread.map((source) => source.title).join(", ");
    throw new ApplicationError(
      "review_incomplete",
      unread.every((source) => source.read)
        ? `A part of the list (${names}) is shown only to the owner, so this sign-in cannot mark it as looked at. Ask the owner to look.`
        : `The list is not complete, so it cannot be marked as looked at: ${names} could not be read. Ask someone who can read all of it, such as the owner, to look.`,
      409,
    );
  }
  const store = changesState(service);
  const { aggregate } = await service.readAggregate();
  const head = aggregate.state.bookRevision;
  const now = service.now();
  const upToRevision = input.upToRevision === undefined ? head : BigInt(input.upToRevision);
  if (upToRevision > head)
    throw new ApplicationError(
      "invalid_input",
      "That revision is later than the book's latest, so it cannot have been looked at.",
      400,
    );
  const requested = input.upToAt === undefined ? now : new Date(input.upToAt).toISOString();
  const upToAt = requested > now ? now : requested;
  const by = describePrincipal(access.principal);
  const label = labelOf(access.principal);
  const note = sanitizeText(input.note ?? "", 500);
  return service.retainRequest(operationId, "changes.review", input, () => {
    const newest = store.newestReview();
    if (newest !== null && (BigInt(newest.upToRevision) > upToRevision || newest.upToAt > upToAt))
      throw new ApplicationError(
        "review_out_of_date",
        `The changes up to revision ${newest.upToRevision} were already marked as looked at. Read the list again.`,
        409,
      );
    const row = store.addReview({
      at: now,
      principal: by,
      label,
      upToRevision: upToRevision.toString(),
      upToAt,
      note,
      operationId,
    });
    return {
      seq: row.seq,
      at: row.at,
      by: actorOf(row.principal, row.label),
      upToRevision: row.upToRevision,
      upToAt: row.upToAt,
      note: row.note,
    };
  });
}
