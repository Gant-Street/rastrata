/-
The core of `packages/kernel/src/accounting.ts` (lines 75 to 85, 503 to 567, 682 to 865 and 2165 to
2233, with `usesCumulativeAllocation` and `allocationPlanIsValid` of lines 1555 to 1574), and its
laws. A file that models a later part of `accounting.ts` imports this one.

- `Core/Canonical.lean`: the model of `canonicalize` (the class `Canonicalize`, an instance for
  every type of the module), `canonicalAccountingValue`, `accountingHash`, the body of a value
  without its `contentHash`; every canonical value is well formed and determines its value
  (`LawfulCanonicalize`), so equal `accountingHash`es mean equal values or a SHA-256 collision.
- `Core/Model.lean`: every function of those lines, with the same checks in the same order.
- `Core/Hashes.lean`: what each hash covers (every field but `contentHash`), policy, snapshot,
  state and effect hashes; the snapshot hash depends on the order of policies that share a kind,
  an identifier and a version.
- `Core/Artifacts.lean`: `artifactHashValid`, `verifyAccountingPolicyArtifacts`,
  `createAccountingPolicySnapshot`.
- `Core/Effects.lean`: `applyAccountingEffect`, `accountingEffectExists`,
  `validateAccountingEffectHash`, `validateAccountingEffectIdentities`,
  `validateAccountingEffectAdmission`.
- `Core/Plan.lean`: `planAllocationPostings` (the posted amounts add up to the posted allocable
  basis; each is within one unit of its exact share; every rejection and every error
  characterised) and `allocationPlanIsValid`.
- `Core/Checks.lean`: `reject`, `drafted`, `validAccountingDerivation`,
  `rejectExternalAccountingAuthority`, the version tests, `policyAt`.
- `Core/Examples.lean`: digests of the model checked against the TypeScript's.
-/
import Rastrata.Kernel.Accounting.Core.Canonical
import Rastrata.Kernel.Accounting.Core.Model
import Rastrata.Kernel.Accounting.Core.Hashes
import Rastrata.Kernel.Accounting.Core.Artifacts
import Rastrata.Kernel.Accounting.Core.Effects
import Rastrata.Kernel.Accounting.Core.Plan
import Rastrata.Kernel.Accounting.Core.Checks
import Rastrata.Kernel.Accounting.Core.Examples
