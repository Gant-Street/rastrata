import {
  decodeBookOutcome,
  encodeBookOutcome,
  executeBookCommand,
  type BookCommand,
  type BookOutcomePayload,
  type DurableBookAggregate,
} from "@rastrata/kernel";
import { requireLedger, snapshotCommand } from "./records.ts";

/** Produces one outcome payload only when the real kernel retains a new result.
 * The prior aggregate must already be authenticated by the ledger. This is not
 * indexed evaluation or an independent definition of accounting admission. */
export function evaluateOutcomePayload(before: DurableBookAggregate, input: BookCommand) {
  const command = snapshotCommand(input);
  const transition = executeBookCommand(before.state, before.protocol, command);
  const added = transition.protocol.retainedResults.length - before.protocol.retainedResults.length;
  if (added === 0) return { transition, payload: null, encoded: null };
  const retained = transition.protocol.retainedResults.at(-1);
  requireLedger(
    added === 1 &&
      retained?.commandId === command.id &&
      transition.result.disposition !== "replayed",
    "ledger_outcome_invalid",
  );
  const result = transition.result;
  const payload: BookOutcomePayload = {
    command: retained.command,
    originalResult: { ...result, disposition: transition.result.disposition },
    revision:
      result.disposition === "committed" ? (transition.state.revisions.at(-1) ?? null) : null,
  };
  const encoded = encodeBookOutcome(payload);
  return { transition, payload, encoded };
}

/** Replay verifies the complete command/result/revision, not merely matching
 * caller hashes or trusting successful structural decoding. It must add exactly
 * one retained outcome: a replay or unretained rejection is not an archive entry. */
export function replayOutcomePayload(before: DurableBookAggregate, encoded: string) {
  const decoded = decodeBookOutcome(encoded);
  requireLedger(decoded.disposition === "decoded", "recovery_outcome_invalid");
  const replayed = evaluateOutcomePayload(before, decoded.payload.command);
  requireLedger(
    replayed.encoded !== null && replayed.encoded === encoded,
    "recovery_outcome_mismatch",
  );
  return replayed.transition;
}
