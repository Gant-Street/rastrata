import {
  commandId,
  journalId,
  postingId,
  effectKey,
  canonicalPostingReferenceId,
  createCanonicalPostingReference,
  resolveJournal,
  sealCommand,
  type BookCommand,
  type ResolvedTransaction,
} from "@rastrata/kernel";
import { allocationAndTaxWorkflow, workflowValue } from "./accounting-workflows.ts";

/** Public admitted command inputs only. Two distinct raw (journal ID, effect key)
 * tuples alias when concatenated with ':'. No digests or effects are forged. */
export function postingReferenceCollision(collision = true, reverseOrder = false) {
  const scenario = allocationAndTaxWorkflow("1.1.0");
  const template = workflowValue(scenario.commands[1]);
  const allocation = workflowValue(scenario.commands[2]);
  if (template.type !== "postJournal" || allocation.type !== "createAllocationSchedule")
    throw new Error("Unexpected allocation workflow");
  const sourceTemplate = template;
  function post(id: string, journalIdentity: string, revision: bigint) {
    const journal = {
      ...sourceTemplate.resolved.journal,
      id: journalId(journalIdentity),
      postings: sourceTemplate.resolved.journal.postings.map((p, i) => ({
        ...p,
        id: postingId(`${journalIdentity}-${i}`),
      })),
    };
    const resolved = resolveJournal(
      journal,
      scenario.initial.state.policies,
      scenario.initial.state.identity.ownerId,
      sourceTemplate.resolved.quantizationPolicy,
      journal.postings.map((p) => p.bookValue.amount.toRational()),
    );
    if (Array.isArray(resolved)) throw new Error("Source journal must resolve");
    return sealCommand({
      ...sourceTemplate,
      id: commandId(id),
      expectedBookRevision: revision,
      resolved: resolved as ResolvedTransaction,
    });
  }
  const original = post("b:c", "a", reverseOrder ? 2n : 1n);
  const unrelated = post("c", collision ? "a:b" : "not-colliding", reverseOrder ? 1n : 2n);
  const reference = createCanonicalPostingReference(
    canonicalPostingReferenceId("tuple-source"),
    original.bookId,
    original.resolved.journal.id,
    workflowValue(original.resolved.journal.postings[0]),
    effectKey("b:c:journal:0"),
  );
  const create = sealCommand({
    ...allocation,
    expectedBookRevision: 3n,
    request: { ...allocation.request, source: reference },
  });
  const commands: readonly BookCommand[] = [
    workflowValue(scenario.commands[0]),
    ...(reverseOrder ? [unrelated, original] : [original, unrelated]),
    create,
  ];
  return { initial: scenario.initial, commands, original, unrelated, reference, create };
}
