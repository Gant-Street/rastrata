/-
The basis projection: the Lean model of `packages/kernel/src/accounting.ts` lines 1329 to 1495
(`hashAccountingBasisSourcePopulation`, `hashAccountingReadSnapshot`, `hashAccountingReadPopulation`,
`canonicalPostingSourceKey`, `accountingStateHashesAreValid`, `projectAccountingBasis`), and its laws. It
builds on the types of `Accounting/BasisTypes.lean` and on `Accounting/Core.lean` (`canonicalize`,
`accountingHash`, `policyAt`, the helpers, `validateAccountingEffectHash`).

The files, in the order of the layers:

- Model: `Basis/Canonical.lean` (the canonical value `canonicalize` writes for the journal, policy, book
  and basis types the snapshot holds) and `Basis/Model.lean` (one definition for each TypeScript member;
  the header of that file lists where the model differs in form).
- Meaning: `Basis/Laws5.lean` (`BasisEntryMeans`, `BasisLoopMeans`: what an entry and the loop over the
  events compute, as equations over rationals) and the `WF` predicates of `Accounting/BasisTypes.lean`.
- Laws: `Basis/Laws1.lean` to `Basis/Laws13.lean`, and `Basis/Lawful.lean` (the canonical value of each
  type determines it). `Basis/Check.lean` runs the model on data built twice, in Lean and in TypeScript
  with the kernel's own functions, and fails the build when a digest, an entry, a total or a diagnostic
  differs.

What the TypeScript does that the model cannot say, repeated from the header of `Basis/Model.lean`: the
test `"amount" in event || "settlementRatio" in event` (line 1401) is about JavaScript properties that a
`BasisSourceEvent` does not have; a Lean event has exactly its fields, so the test always passes in the
model (`BasisSourceEvent.carriesComputedAmount` is `false`). The other run-time tests of `projectAccountingBasis`
are on things the TypeScript types guarantee and are modelled as written.

The laws, with the theorem that states each:

1. `projectAccountingBasis`.
   - One entry for each event that passes, in the order of the identifiers, numbered from one:
     `projectAccountingBasis_entries_order`.
   - Each entry's amounts as equations over meanings (the treatment of the event's rule; included
     `basisIncluded` of the posting's amount and the settlement ratio; excluded the rest; the recognized
     amount the included amount rounded in the policy's rule, none for `exclude`; the allocation
     identifiers sorted): `projectAccountingBasis_entry_amounts` (with `BasisEntryMeans`,
     `processBasisEvent_spec`, `settlementRatioOf_ratio_spec`).
   - The reconciliation is exact, and its diagnostic is never given:
     `projectAccountingBasis_reconciliation_exact`, `projectAccountingBasis_reconciliation_never`.
   - The projection and its reconciliation carry the hash of their bodies:
     `projectAccountingBasis_projected_spec`, `basisProjection_contentHash`,
     `basisReconciliation_contentHash`.
   - Every source is found in the booked journals, and one that is not is refused:
     `projectAccountingBasis_sources_found`, `projectAccountingBasis_unfound_source_refused`.
   - The order of the booked journals does not matter, except that the projection echoes it:
     `projectAccountingBasis_journals_order`, `projectAccountingBasis_journals_echo`.
2. Hashes: `hashAccountingBasisSourcePopulation_inj_or_collision`,
   `hashAccountingReadSnapshot_inj_or_collision`, `hashAccountingReadPopulation_inj_or_collision` (equal
   hashes mean the same hashed content, `SameHashedContent`, or a collision of SHA-256);
   `hashAccountingReadSnapshot_eq_of_sameHashedContent` and its population twin (the hash is a function of
   that content); `hashAccountingReadSnapshot_ignores_contentHash` and
   `hashAccountingReadPopulation_ignores_hashes` (the fields they do not cover);
   `hashAccountingBasisSourcePopulation_perm`, `hashAccountingReadSnapshot_perm`,
   `hashAccountingReadPopulation_perm` (the order of the lists does not count when their keys are
   distinct); `hashAccountingReadSnapshot_inj_or_collision_content` and its population twin (the
   configuration snapshots of equal hashes have the same content, `BookConfigurationSnapshot.SameContent`:
   every field the same, the entries of `requiredDimensionIdsByPosting` the same in some order).
3. `accountingStateHashesAreValid`: `accountingStateHashesAreValid_true_iff`, `_false_iff`, `_error_iff`,
   `_isOk_of_no_schedules`; `canonicalPostingSourceKey`: `canonicalPostingSourceKey_eq_iff`,
   `canonicalPostingSourceKey_inj_of_valid`, `canonicalPostingSourceKey_not_injective` (a witness: the
   key leaves out the reference's identifier and posting hash).
4. Rejections, one iff for each: `projectAccountingBasis_policy_iff`, `_bound_iff`, `_identity_iff`,
   `_snapshot_iff`, `_event_iff`, `_rule_iff`, `_graph_iff`, `_range_iff`, `_reconciliation_iff`, and the
   exits that throw and that project: `projectAccountingBasis_error_iff`, `projectAccountingBasis_projected_iff`;
   the conditions of the early rejections as statements: `populationIdentityRejects_iff`,
   `snapshotFailsBeforeState_iff`, `readSnapshotRejects_true_iff`, `readSnapshotRejects_false_iff`,
   `snapshotHashesDiffer_iff`, `configuredPolicyMatches_iff`, `journalPopulationValid_iff`,
   `uniqueJournalSources_iff`, `completeClassification_iff`, `exactReferenceClassification_iff`,
   `sourcePopulationCloses_iff`, `postingReferenceCloses_true_iff`. The only throws are the size limit and the
   `RangeError` of `quantize` for a scale outside 0 to 1,000, and, through an allocation schedule, what the plan
   check throws: `projectAccountingBasis_error_class`.
-/
import Rastrata.Kernel.Accounting.Core
import Rastrata.Kernel.Accounting.Basis.Canonical
import Rastrata.Kernel.Accounting.Basis.Model
import Rastrata.Kernel.Accounting.Basis.Lawful
import Rastrata.Kernel.Accounting.Basis.Laws1
import Rastrata.Kernel.Accounting.Basis.Laws2
import Rastrata.Kernel.Accounting.Basis.Laws3
import Rastrata.Kernel.Accounting.Basis.Laws4
import Rastrata.Kernel.Accounting.Basis.Laws5
import Rastrata.Kernel.Accounting.Basis.Laws6
import Rastrata.Kernel.Accounting.Basis.Laws7
import Rastrata.Kernel.Accounting.Basis.Laws8
import Rastrata.Kernel.Accounting.Basis.Laws9
import Rastrata.Kernel.Accounting.Basis.Laws10
import Rastrata.Kernel.Accounting.Basis.Laws11
import Rastrata.Kernel.Accounting.Basis.Laws12
import Rastrata.Kernel.Accounting.Basis.Laws13
import Rastrata.Kernel.Accounting.Basis.Check
