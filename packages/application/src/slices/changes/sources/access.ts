/** Who has access: an agent's token made or revoked, and a person put in the book, given another role
 * or taken out. Tokens are read through `tokens.list`, which needs the permission to manage access;
 * people through `members.list`, which any reader may call and which holds no address of a person
 * who has left (the book erases it) and none of anyone's that this list repeats: a person is named
 * here by their role and identifier, and a screen turns the identifier into the address it already
 * shows on the people page.
 *
 * What is read from each is only what each keeps: a token keeps who made it and when it was revoked
 * but not who revoked it; a member keeps who added them and who last changed them, so an earlier
 * change of role is not here. The list says so. */
import { actorOf } from "../../../changes/actors.ts";
import type { Candidate } from "../../../changes/candidate.ts";
import { type ActorRef, UNKNOWN_ACTOR } from "../../../changes/kinds.ts";
import { shortDate } from "../../../changes/ledger.ts";
import type { AgentToken, AgentTokenList, MemberList } from "../../../client-contracts.gen.ts";
import { ApplicationError } from "../../../errors.ts";
import { sanitizeText } from "../../../ingest/text.ts";
import { callOperation } from "../call.ts";
import { changesState } from "../store.ts";
import { asInstant, type SourceReader } from "./types.ts";

function candidate(
  at: string,
  id: string,
  kind: "access.granted" | "access.revoked",
  actor: ActorRef,
  subject: { kind: "token" | "member"; id: string },
  summary: string,
  how: string,
): Candidate {
  const record = {
    id,
    at,
    revision: null,
    kind,
    summary: sanitizeText(summary, 400),
    subject,
    by: { kind: actor.kind, label: actor.label, ...(actor.id ? { id: actor.id } : {}) },
    how,
  };
  return { at, revision: null, kind, actor, order: id, build: () => record };
}

const permissionsOf = (token: AgentToken): string => token.permissions.join(", ");

function tokenChanges(tokens: readonly AgentToken[], labelFor: (p: string) => string): Candidate[] {
  const found: Candidate[] = [];
  for (const token of tokens) {
    const name = `"${sanitizeText(token.label, 80)}"`;
    const created = asInstant(token.createdAt);
    if (created !== null) {
      const until = asInstant(token.expiresAt);
      found.push(
        candidate(
          created,
          `token:${token.id}:granted`,
          "access.granted",
          actorOf(token.createdBy, labelFor(token.createdBy)),
          { kind: "token", id: token.id },
          `Gave the agent ${name} access to ${permissionsOf(token)}${until === null ? "" : `, until ${shortDate(until.slice(0, 10))}`}.`,
          "",
        ),
      );
    }
    const revoked = asInstant(token.revokedAt);
    if (revoked !== null) {
      const why = token.revokedReason ? ` (reason: ${sanitizeText(token.revokedReason, 120)})` : "";
      found.push(
        candidate(
          revoked,
          `token:${token.id}:revoked`,
          "access.revoked",
          UNKNOWN_ACTOR,
          { kind: "token", id: token.id },
          `Took access away from the agent ${name}${why}.`,
          "",
        ),
      );
    }
  }
  return found;
}

function memberChanges(members: MemberList, labelFor: (p: string) => string): Candidate[] {
  const found: Candidate[] = [];
  const maker = (principal: string | undefined): ActorRef =>
    principal === undefined || principal === ""
      ? UNKNOWN_ACTOR
      : actorOf(principal, labelFor(principal));
  for (const member of members.members) {
    const added = asInstant(member.addedAt);
    const changed = asInstant(member.changedAt);
    // Only the last change of a person is kept, so a role is named as the one they were given only when
    // nothing changed it since.
    const changedSince = changed !== null && added !== null && changed > added;
    if (added !== null)
      found.push(
        candidate(
          added,
          `member:${member.userId}:granted`,
          "access.granted",
          maker(member.addedBy),
          { kind: "member", id: member.userId },
          changedSince
            ? "Put a person in the book."
            : `Put a person in the book as ${member.role}.`,
          "",
        ),
      );
    if (changedSince && changed !== null)
      found.push(
        candidate(
          changed,
          `member:${member.userId}:changed`,
          "access.granted",
          maker(member.changedBy),
          { kind: "member", id: member.userId },
          `Made a person in the book ${member.role}.`,
          "",
        ),
      );
  }
  for (const gone of members.removed ?? []) {
    const added = asInstant(gone.addedAt);
    if (added !== null)
      found.push(
        candidate(
          added,
          `member:${gone.userId}:granted`,
          "access.granted",
          maker(gone.addedBy),
          { kind: "member", id: gone.userId },
          "Put a person in the book.",
          "",
        ),
      );
    const removed = asInstant(gone.removedAt);
    if (removed !== null)
      found.push(
        candidate(
          removed,
          `member:${gone.userId}:revoked`,
          "access.revoked",
          maker(gone.removedBy),
          { kind: "member", id: gone.userId },
          `Removed a person from the book (their last role was ${gone.role}).`,
          "",
        ),
      );
  }
  return found;
}

export const accessSource: SourceReader = {
  name: "access",
  title: "Who has access",
  async read({ context }) {
    const state = changesState(context.service);
    const labelFor = (principal: string) => state.labelFor(principal);
    const found: Candidate[] = [];
    let incomplete: string | undefined;
    let withheld: string | undefined;
    let read = 0;
    try {
      const tokens = await callOperation<AgentTokenList>(context, "tokens.list", {});
      found.push(...tokenChanges(tokens.tokens, labelFor));
      read += 1;
    } catch (error) {
      if (!(error instanceof ApplicationError)) throw error;
      // The agent keys are the owner's to see: for anyone else they are left out, and that is said.
      if (error.code === "permission_denied")
        withheld = "Changes to agent keys are shown to the owner.";
      else incomplete = "Agent keys could not be read.";
    }
    try {
      const members = await callOperation<MemberList>(context, "members.list", {
        includeRemoved: true,
      });
      found.push(...memberChanges(members, labelFor));
      read += 1;
    } catch (error) {
      if (!(error instanceof ApplicationError)) throw error;
      incomplete = `${incomplete === undefined ? "" : `${incomplete} `}The people in the book could not be read.`;
    }
    if (read === 0) throw new ApplicationError("source_unreadable", incomplete ?? "", 403);
    return {
      candidates: found,
      ...(incomplete === undefined ? {} : { incomplete }),
      ...(withheld === undefined ? {} : { withheld }),
    };
  },
};
