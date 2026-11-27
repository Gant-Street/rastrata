/-
Tax determination: the Lean model of `packages/kernel/src/accounting.ts` lines 1756 to 2024
(`TaxableLine`, `TaxRequest`, `PreResolvedTaxLine`, `determineTax`) and the proofs of its laws.

The model is cut into the stages of the TypeScript, each a function named in its doc comment with
its lines: the request test (`requestRejected`, line 1769), the line test (`invalidTaxLines`, 1770 to
1772), the checks of a line (`lineCheck`, 1783 to 1811), its exact arithmetic (`lineExact`, 1813 to
1830), the line loop (`preResolveLine`, `preResolveLines`, 1782 to 1833), rounding (`allocate`: the
document level `allocateDocumentLevel`, 1845 to 1911, and the line level `allocateLineLevel`, 1912
to 1944), the postings and line results (`buildPostingsAndLineResults`, 1946 to 2016, with
`addPosting`, `partPosting`, `componentPostings`, `applyComponentPostings`), and the balance test
and the draft (`finish`, 2018 to 2022). `determineTax` is their composition and
`determineTax_stages` says so. Every diagnostic is a named value with the TypeScript's code, path,
message and requirement identifiers. Where the TypeScript throws, the model returns `.error`:
`TaxErr.exactNumber` (an `ExactNumberError`), `TaxErr.scaleOutOfRange` (the `RangeError` of
`quantize`) or `TaxErr.canonical` (the `IdentityError` of `identifier`).

How it was checked against the TypeScript: a Bun script generated 1,405 requests (random policies
of one to six components, every treatment, inclusion and share, compounding, both rounding levels,
both grouping markers, scales 0 to 3 and out of range, all five rounding modes, shared accounts, one
to four lines, every direction, and faults for every rejection), ran the real `determineTax` on each
and wrote the same inputs as Lean terms; the model, run with `lake env lean --run`, printed the same
result for all 1,405, value for value: the diagnostics, every posting (identifier, account, amount),
every line result and quantization, and the content hash digest. That includes a size-limit error,
the `RangeError` of an out-of-range scale, and a request identifier outside ASCII.

What is assumed about JavaScript, and what is not modelled:

- `Object.freeze` and object identity are not modelled.
- `[...policy.components].sort((a, b) => Number(a.compoundOrdinal - b.compoundOrdinal))` reads only
  the sign of the difference (`Number` of a `bigint` keeps it, even at infinity), and
  `Array.prototype.sort` is stable: a stable insertion sort by ordinal (`sortComponents`).
- A `Map` iterates in insertion order and `set` on a present key keeps its place (`assocSet`,
  `insertOccurrence`); a `Set` is the list of what was added.
- `JSON.stringify(["structural", ...])` and `JSON.stringify(["legacy", ...])` are injective on
  strings and the tags keep the kinds apart: the key is the inductive `TaxGroupKey`.
- The test of line 1789 (rounding level neither `lineLevel` nor `documentLevel`) and the test that
  `groupingAlgorithm` is some other string are tests of what the TypeScript types already exclude:
  `TaxRoundingLevel` and `TaxGroupingAlgorithm` have no other value, so they always pass and the
  first diagnostic of line 1790 is never produced.
- `lineOrdinal * (components.length * 2 + 4)` is a JavaScript number; with at most 100 lines it is
  exact, and it is a `Nat` here.
- `request.governedAt.slice(0, 10)` takes ten UTF-16 code units; the model takes ten characters. They
  differ only for an instant with a character beyond the Basic Multilingual Plane among its first
  ten code units, where `slice` can cut a surrogate pair that a Lean string cannot hold. `governedAt`
  is never validated by `determineTax`.

What the TypeScript does that a law did not expect (each reproduced on the real code):

- `addPosting` (line 1949) replaces an account's entry, dropping its amount, when a later posting
  to the same account has a smaller order (`addPosting_overwrite`). Orders are
  `lineOrdinal * (2n + 4) + ...` with `n` the line's own number of components, so a line can post
  below an earlier line's orders. A request whose journal balances in exact arithmetic is then
  refused with "The taxed transaction journal is not balanced": two purchase lines sharing the
  payable account, the first with a five-component policy and the second with a one-component
  policy (the same lines in the other order are drafted). 40 of 800 random valid requests hit it.
  Inside one line, a reverse-charge component posts its non-recoverable part at order `2i + 2` and
  its liability at `2i + 1`: when it names its liability account as its non-recoverable account, a
  single-line purchase is refused the same way. `determineTax_never_unbalanced` proves the refusal
  never happens when neither can occur.
- The size limit is not the only error: a policy whose quantization scale is outside 0 to 1000
  makes `quantize` throw a `RangeError` (`allocateLineComponent_scale`, `determineTax_scale_error`).
- Line-level rounding rounds each line: two lines whose exact tax is 0.005 each (half away from
  zero, scale 2) are taxed 0.01 + 0.01 = 0.02, while their exact total 0.01 rounds to 0.01.
  Document-level rounding rounds each group's running total (`allocateGroup_rounded_total`), not the
  document's: groups are rounded separately.
- Document level, the split of a group's rounded total among its lines depends on their order:
  lines A (exact tax 0.003) and B (0.004) in the order A, B give the cent to B; in the order B, A
  they give it to A. The group's total does not depend on the order (`allocateGroup_total_perm`).
- Legacy grouping keys `${policy.id}:${component.id}` without the version: policy `a:b` with
  component `c` and policy `a` with component `b:c` share a group (`taxGroupKey_legacy_collision`).
- The refusals of lines 1816 ("no positive exact solution") and 1830 ("no exact reconstruction")
  can never happen (`determineTax_never_inclusive_refusals`).
-/
import Rastrata.Prelude
import Rastrata.Kernel.Accounting.Types
import Rastrata.Kernel.Accounting.Core.Model

namespace Rastrata.Kernel

/-! ## Types (`accounting.ts` lines 1756 to 1767) -/

/-- `TaxableLine` (`accounting.ts` line 1756). `lineId` is a plain string, not an identifier. -/
structure TaxableLine where
  lineId : String
  sourcePostingId : PostingId
  counterpartyPostingId : PostingId
  policyId : PolicyId
  policyVersion : SemanticVersion
  statedAmount : ExactRational
  amountIncludesTax : Bool
  sourceAccountId : AccountId
  payableAccountId : AccountId
  deriving DecidableEq, Repr, Inhabited

/-- `TaxRequest` (`accounting.ts` line 1757). -/
structure TaxRequest where
  id : TaxDeterminationId
  sourceTransactionId : JournalId
  governedAt : Instant
  direction : TaxDirection
  lines : List TaxableLine
  derivation : DerivationRecord
  deriving DecidableEq, Repr, Inhabited

/-- A constructible taxable line: its identifiers are valid and its stated amount is constructible. -/
structure TaxableLine.WF (line : TaxableLine) : Prop where
  sourcePostingId : line.sourcePostingId.WF
  counterpartyPostingId : line.counterpartyPostingId.WF
  policyId : line.policyId.WF
  statedAmount : line.statedAmount.WF
  sourceAccountId : line.sourceAccountId.WF
  payableAccountId : line.payableAccountId.WF

/-- A constructible tax request: its identifiers are valid, each line is constructible, and its
derivation is constructible. -/
structure TaxRequest.WF (request : TaxRequest) : Prop where
  id : request.id.WF
  sourceTransactionId : request.sourceTransactionId.WF
  lines : ∀ line ∈ request.lines, line.WF
  derivation : request.derivation.WF

/-- What `determineTax` throws: the `RangeError` of `quantize` for a policy scale outside 0 to 1000,
an `ExactNumberError` of `numeric.ts`, or the `IdentityError` of `identifier` (`canonical.ts`). -/
inductive TaxErr where
  | scaleOutOfRange
  | exactNumber (code : NumErr)
  | canonical (code : CanonicalErr)
  deriving DecidableEq, Repr, Inhabited

namespace Tax

/-- Carries an `ExactNumberError` out unchanged. -/
def liftNum {α : Type} : Except NumErr α → Except TaxErr α
  | .ok v => .ok v
  | .error e => .error (.exactNumber e)

/-- Carries what `quantize` throws out unchanged. -/
def liftQuantize {α : Type} : Except QuantizeErr α → Except TaxErr α
  | .ok v => .ok v
  | .error .scaleOutOfRange => .error .scaleOutOfRange
  | .error (.exactNumber e) => .error (.exactNumber e)

/-- Carries what `identifier` throws out unchanged. -/
def liftCanonical {α : Type} : Except CanonicalErr α → Except TaxErr α
  | .ok v => .ok v
  | .error e => .error (.canonical e)

/-- `ExactRational.of(1n, 1n)`. -/
def one : ExactRational := ⟨1, 1⟩

/-! ### The diagnostics, in the order the TypeScript can produce them -/

/-- Line 1769. -/
def requestDiagnostic : SemanticDiagnostic :=
  diagnostic .tax_policy_ambiguity "command.tax"
    "Tax determination requires approved lineage and at least one taxable line within the executable bound"
    ["ACC-045.1"]

/-- Line 1772. -/
def linesDiagnostic : SemanticDiagnostic :=
  diagnostic .tax_policy_ambiguity "command.tax.lines"
    "Every taxable line requires a unique identity, distinct postings, and a non-zero stated amount"
    ["ACC-045.1"]

/-- Line 1784. -/
def policyDiagnostic (lineId : String) : SemanticDiagnostic :=
  diagnostic .tax_policy_ambiguity ("command.tax.lines[" ++ lineId ++ "].policy")
    "Exactly one applicable tax policy with matching executable capability evidence is required for every taxable line"
    ["ACC-045.1", "ACC-045.5"]

/-- Line 1787. -/
def groupingDiagnostic (lineId : String) : SemanticDiagnostic :=
  diagnostic .tax_policy_ambiguity ("command.tax.lines[" ++ lineId ++ "].policy.groupingAlgorithm")
    "Structural tax grouping requires its explicit marker and supported implementation version"
    ["ACC-038", "ACC-045.4"]

/-- Line 1796 (line 1790, the same path with another message, is never reached: see the header). -/
def roundingDiagnostic (lineId : String) : SemanticDiagnostic :=
  diagnostic .tax_policy_ambiguity ("command.tax.lines[" ++ lineId ++ "].policy.roundingLevel")
    "All taxable lines in a tax determination request must share the same rounding level policy"
    ["ACC-045.1", "ACC-045.4"]

/-- Line 1802. -/
def quantizationDiagnostic (lineId : String) : SemanticDiagnostic :=
  diagnostic .tax_policy_ambiguity ("command.tax.lines[" ++ lineId ++ "].policy.quantizationPolicy")
    "All taxable lines in a tax determination request must share compatible quantization policies"
    ["ACC-045.1", "ACC-045.4"]

/-- Line 1811. -/
def componentsDiagnostic (lineId : String) : SemanticDiagnostic :=
  diagnostic .tax_policy_ambiguity ("command.tax.lines[" ++ lineId ++ "].components")
    "Tax component graph, direction, inclusion, rate, or recoverability is invalid"
    ["ACC-045.2", "ACC-045.5"]

/-- Line 1816. -/
def graphDiagnostic (lineId : String) : SemanticDiagnostic :=
  diagnostic .tax_policy_ambiguity ("command.tax.lines[" ++ lineId ++ "].inclusive")
    "Inclusive tax graph has no positive exact solution" ["ACC-045.3"]

/-- Line 1830. -/
def reconstructionDiagnostic (lineId : String) : SemanticDiagnostic :=
  diagnostic .tax_policy_ambiguity ("command.tax.lines[" ++ lineId ++ "].inclusive")
    "Inclusive tax amount has no exact reconstruction" ["ACC-045.3"]

/-- Line 1978. -/
def recoverableDiagnostic (lineId : String) : SemanticDiagnostic :=
  diagnostic .tax_policy_ambiguity ("command.tax.lines[" ++ lineId ++ "].components")
    "Recoverable tax requires a policy-declared destination" ["ACC-045.4", "ACC-045.5"]

/-- Line 1983. -/
def nonRecoverableDiagnostic (lineId : String) : SemanticDiagnostic :=
  diagnostic .tax_policy_ambiguity ("command.tax.lines[" ++ lineId ++ "].components")
    "Nonrecoverable tax requires a policy-declared destination" ["ACC-045.4", "ACC-045.5"]

/-- Line 2019. -/
def balanceDiagnostic : SemanticDiagnostic :=
  diagnostic .tax_policy_ambiguity "command.tax" "The taxed transaction journal is not balanced"
    ["ACC-045.4"]

/-! ### Stage 1: the request (lines 1769 to 1776) -/

/-- The test of line 1769: lineage not approved, no line, or more lines than the bound. -/
def requestRejected (request : TaxRequest) : Bool :=
  !validAccountingDerivation request.derivation || request.lines.isEmpty ||
    decide (request.lines.length > accountingLimits.maxTaxLines)

/-- `request.lines.some(...)` of line 1771, with the three sets of identifiers seen before the line.
`set.add` returns the set, so `!set.add(x)` is `false`: a line that passes the three `has` tests adds
its three identifiers and goes on to the last three tests. -/
def invalidTaxLinesAux (seenLineIds : List String) (seenSource : List PostingId)
    (seenCounterparty : List PostingId) : List TaxableLine → Bool
  | [] => false
  | line :: rest =>
    seenLineIds.contains line.lineId ||
    seenSource.contains line.sourcePostingId ||
    seenCounterparty.contains line.counterpartyPostingId ||
    (jsTrim line.lineId).length == 0 ||
    line.sourcePostingId == line.counterpartyPostingId ||
    line.statedAmount.isZero ||
    invalidTaxLinesAux (line.lineId :: seenLineIds) (line.sourcePostingId :: seenSource)
      (line.counterpartyPostingId :: seenCounterparty) rest

/-- The test of lines 1770 and 1771, from three empty sets. -/
def invalidTaxLines (lines : List TaxableLine) : Bool :=
  invalidTaxLinesAux [] [] [] lines

/-- `isSale` (line 1774). -/
def isSale (direction : TaxDirection) : Bool :=
  direction == .sale || direction == .saleCredit

/-- `isCredit` (line 1775). -/
def isCredit (direction : TaxDirection) : Bool :=
  direction == .purchaseCredit || direction == .saleCredit

/-- `sourceSign` (line 1776): `ExactRational.of(1n, 1n)` or `ExactRational.of(-1n, 1n)`, which are
these two values in lowest terms. -/
def sourceSign (direction : TaxDirection) : ExactRational :=
  if direction == .purchase || direction == .saleCredit then ⟨1, 1⟩ else ⟨-1, 1⟩

/-! ### Stage 2: the policy and components of one line (lines 1783 to 1811) -/

/-- `commonRoundingLevel` and `commonQuantizationPolicy` (lines 1779 and 1780): both `undefined`
until the first line sets both (lines 1792 to 1794), never changed after. -/
abbrev CommonRounding := Option (TaxRoundingLevel × QuantizationPolicy)

/-- The common state after a line whose policy is `policy` passed (lines 1792 to 1794). -/
def nextCommon (common : CommonRounding) (policy : TaxPolicy) : CommonRounding :=
  match common with
  | none => some (policy.roundingLevel, policy.quantizationPolicy)
  | some c => some c

/-- The test of line 1786. -/
def groupingUnsupported (policy : TaxPolicy) : Bool :=
  policy.groupingAlgorithm.isSome && !usesStructuralTaxGrouping policy

/-- The test of line 1795. -/
def roundingMismatch (common : CommonRounding) (policy : TaxPolicy) : Bool :=
  match common with
  | none => false
  | some (level, _) => policy.roundingLevel != level

/-- The test of lines 1797 to 1801 (`commonQuantizationPolicy` is defined whenever the common
rounding level is). -/
def quantizationMismatch (common : CommonRounding) (policy : TaxPolicy) : Bool :=
  match common with
  | none => false
  | some (_, qp) =>
    policy.quantizationPolicy.targetScale != qp.targetScale ||
      policy.quantizationPolicy.roundingMode != qp.roundingMode

/-- One step of the stable insertion sort of line 1805: the item goes before the first member
whose ordinal is not smaller. -/
def insertComponentSorted (item : TaxPolicyComponent) :
    List TaxPolicyComponent → List TaxPolicyComponent
  | [] => [item]
  | next :: rest =>
    if item.compoundOrdinal ≤ next.compoundOrdinal then item :: next :: rest
    else next :: insertComponentSorted item rest

/-- `[...policy.components].sort((a, b) => Number(a.compoundOrdinal - b.compoundOrdinal))`
(line 1805): a stable sort by ordinal. -/
def sortComponents : List TaxPolicyComponent → List TaxPolicyComponent
  | [] => []
  | item :: rest => insertComponentSorted item (sortComponents rest)

/-- The first `components.some` of line 1808, from the component at some index: the identifiers of
the components before it and the ordinal of the one just before it. -/
def badGraphComponents (priorIds : List PolicyId) (prevOrdinal : Option Int)
    (includesTax : Bool) : List TaxPolicyComponent → Bool
  | [] => false
  | c :: rest =>
    decide (c.compoundOrdinal ≤ 0) ||
    (match prevOrdinal with | none => false | some prev => decide (c.compoundOrdinal ≤ prev)) ||
    !positive c.rate ||
    c.inclusion != (if includesTax then .inclusive else .exclusive) ||
    c.compoundsOn.any (fun id => !priorIds.contains id) ||
    badGraphComponents (c.id :: priorIds) (some c.compoundOrdinal) includesTax rest

/-- The test of lines 1806 to 1810 on the sorted components. -/
def invalidComponents (bookId : BookId) (isSaleFlag includesTax : Bool) (policy : TaxPolicy)
    (components : List TaxPolicyComponent) : Bool :=
  policy.bookId != bookId ||
  components.isEmpty ||
  (components.map (·.id)).dedup.length != components.length ||
  badGraphComponents [] none includesTax components ||
  components.any (fun c =>
    c.recoverableShare.compare ExactRational.zero == .lt ||
    c.recoverableShare.compare one == .gt ||
    ((c.treatment == .outputTax || c.treatment == .withholding) && !c.recoverableShare.isZero)) ||
  components.any (fun c =>
    if isSaleFlag then c.treatment != .outputTax else c.treatment == .outputTax)

/-- The checks of one line before any arithmetic, in the TypeScript's order (lines 1783 to 1811):
the policy, its grouping marker, the common rounding level, the common quantization policy, and its
components. The test of line 1789 always passes (see the header). -/
def lineCheck (policies : List AccountingPolicy) (bookId : BookId) (governedAt : Instant)
    (isSaleFlag : Bool) (common : CommonRounding) (line : TaxableLine) :
    SemanticDiagnostic ⊕ TaxPolicy :=
  match policyAt TaxPolicy policies line.policyId line.policyVersion governedAt with
  | .rejected _ => .inl (policyDiagnostic line.lineId)
  | .selected policy =>
    if groupingUnsupported policy then .inl (groupingDiagnostic line.lineId)
    else if roundingMismatch common policy then .inl (roundingDiagnostic line.lineId)
    else if quantizationMismatch common policy then .inl (quantizationDiagnostic line.lineId)
    else if invalidComponents bookId isSaleFlag line.amountIncludesTax policy
        (sortComponents policy.components) then .inl (componentsDiagnostic line.lineId)
    else .inr policy

/-! ### Stage 3: the exact tax of one line (lines 1813 to 1830) -/

/-- `Map.prototype.get` on an association list in insertion order. -/
def assocGet {κ ν : Type} [BEq κ] (entries : List (κ × ν)) (key : κ) : Option ν :=
  (entries.find? (fun e => e.1 == key)).map (·.2)

/-- `Map.prototype.set`: a key already present keeps its place, a new key goes last. -/
def assocSet {κ ν : Type} [BEq κ] (entries : List (κ × ν)) (key : κ) (val : ν) :
    List (κ × ν) :=
  if entries.any (fun e => e.1 == key) then
    entries.map fun e => if e.1 == key then (key, val) else e
  else entries ++ [(key, val)]

/-- Element of `PreResolvedTaxLine.componentExactTaxes` (lines 1763 to 1766). -/
structure ComponentExactTax where
  component : TaxPolicyComponent
  exactTax : ExactRational
  deriving DecidableEq, Repr, Inhabited

/-- `PreResolvedTaxLine` (lines 1758 to 1767). -/
structure PreResolvedTaxLine where
  line : TaxableLine
  policy : TaxPolicy
  components : List TaxPolicyComponent
  unroundedExclusive : ExactRational
  componentExactTaxes : List ComponentExactTax
  deriving DecidableEq, Repr, Inhabited

/-- The loop of line 1814: each component's coefficient is one plus the coefficients it compounds
on (zero for an identifier not seen), times its rate. -/
def computeCoefficients (coeffs : List (PolicyId × ExactRational)) :
    List TaxPolicyComponent → Except TaxErr (List (PolicyId × ExactRational))
  | [] => .ok coeffs
  | c :: rest =>
    match liftNum (accountingSum (c.compoundsOn.map fun id =>
        (assocGet coeffs id).getD ExactRational.zero)) with
    | .error e => .error e
    | .ok compoundCoeff =>
      match liftNum (one.add compoundCoeff) with
      | .error e => .error e
      | .ok baseCoeff =>
        match liftNum (baseCoeff.multiply c.rate) with
        | .error e => .error e
        | .ok cCoeff =>
          computeCoefficients (assocSet coeffs c.id cCoeff) rest

/-- Whether a component's tax is part of the gross amount (lines 1815, 1829, 1962): input or
output tax. -/
def isGross (c : TaxPolicyComponent) : Bool :=
  c.treatment == .inputTax || c.treatment == .outputTax

/-- The terms of the sum of line 1815. -/
def grossCoefficientTerms (coeffs : List (PolicyId × ExactRational))
    (components : List TaxPolicyComponent) : List ExactRational :=
  (components.filter isGross).map fun c => (assocGet coeffs c.id).getD ExactRational.zero

/-- The loop of lines 1822 to 1827: each component's exact tax is the exclusive amount plus the
taxes it compounds on, times its rate. -/
def computeExactTaxes (exclusive : ExactRational) (seen : List (PolicyId × ExactRational)) :
    List TaxPolicyComponent → Except TaxErr (List ComponentExactTax)
  | [] => .ok []
  | c :: rest =>
    match liftNum (accountingSum (c.compoundsOn.map fun id =>
        (assocGet seen id).getD ExactRational.zero)) with
    | .error e => .error e
    | .ok compound =>
      match liftNum (exclusive.add compound) with
      | .error e => .error e
      | .ok base =>
        match liftNum (base.multiply c.rate) with
        | .error e => .error e
        | .ok exactTax =>
          match computeExactTaxes exclusive (assocSet seen c.id exactTax) rest with
          | .error e => .error e
          | .ok tail => .ok ({ component := c, exactTax } :: tail)

/-- The terms of the sum of line 1829. -/
def grossTaxTerms (items : List ComponentExactTax) : List ExactRational :=
  (items.filter fun item => isGross item.component).map (·.exactTax)

/-- `line.amountIncludesTax ? line.statedAmount.divide(grossCoefficient) : line.statedAmount`
(line 1818). -/
def exclusiveOf (line : TaxableLine) (grossCoefficient : ExactRational) :
    Except TaxErr ExactRational :=
  if line.amountIncludesTax then liftNum (line.statedAmount.divide grossCoefficient)
  else .ok line.statedAmount

/-- The arithmetic of one line (lines 1813 to 1830): the coefficients, the gross coefficient and
its test, the exclusive amount, the exact tax of each component, and the test that an inclusive
amount is reconstructed exactly. -/
def lineExact (line : TaxableLine) (components : List TaxPolicyComponent) :
    Except TaxErr (SemanticDiagnostic ⊕ (ExactRational × List ComponentExactTax)) :=
  match computeCoefficients [] components with
  | .error e => .error e
  | .ok coeffs =>
    match liftNum (accountingSum (grossCoefficientTerms coeffs components)) with
    | .error e => .error e
    | .ok taxCoeffSum =>
      match liftNum (one.add taxCoeffSum) with
      | .error e => .error e
      | .ok grossCoefficient =>
        if !positive grossCoefficient then .ok (.inl (graphDiagnostic line.lineId))
        else
          match exclusiveOf line grossCoefficient with
          | .error e => .error e
          | .ok exclusive =>
            match computeExactTaxes exclusive [] components with
            | .error e => .error e
            | .ok items =>
              match liftNum (accountingSum (grossTaxTerms items)) with
              | .error e => .error e
              | .ok grossTax =>
                if line.amountIncludesTax then
                  match liftNum (exclusive.add grossTax) with
                  | .error e => .error e
                  | .ok reconstructed =>
                    if !reconstructed.equals line.statedAmount then
                      .ok (.inl (reconstructionDiagnostic line.lineId))
                    else .ok (.inr (exclusive, items))
                else .ok (.inr (exclusive, items))

/-- One pass of the loop of lines 1782 to 1833: the checks, then the arithmetic. -/
def preResolveLine (policies : List AccountingPolicy) (bookId : BookId) (governedAt : Instant)
    (isSaleFlag : Bool) (common : CommonRounding) (line : TaxableLine) :
    Except TaxErr (SemanticDiagnostic ⊕ PreResolvedTaxLine) :=
  match lineCheck policies bookId governedAt isSaleFlag common line with
  | .inl d => .ok (.inl d)
  | .inr policy =>
    match lineExact line (sortComponents policy.components) with
    | .error e => .error e
    | .ok (.inl d) => .ok (.inl d)
    | .ok (.inr (exclusive, items)) =>
      .ok (.inr
        { line := line
          policy := policy
          components := sortComponents policy.components
          unroundedExclusive := exclusive
          componentExactTaxes := items })

/-- The loop of lines 1782 to 1833: the first line that is refused ends it; the common rounding
state is carried from line to line. -/
def preResolveLines (policies : List AccountingPolicy) (bookId : BookId) (governedAt : Instant)
    (isSaleFlag : Bool) :
    CommonRounding → List TaxableLine →
      Except TaxErr (SemanticDiagnostic ⊕ (CommonRounding × List PreResolvedTaxLine))
  | common, [] => .ok (.inr (common, []))
  | common, line :: rest =>
    match preResolveLine policies bookId governedAt isSaleFlag common line with
    | .error e => .error e
    | .ok (.inl d) => .ok (.inl d)
    | .ok (.inr pre) =>
      match preResolveLines policies bookId governedAt isSaleFlag
          (nextCommon common pre.policy) rest with
      | .error e => .error e
      | .ok (.inl d) => .ok (.inl d)
      | .ok (.inr (final, tail)) => .ok (.inr (final, pre :: tail))

/-! ### Stage 4: rounding (lines 1835 to 1944) -/

/-- `AllocatedComponent` (lines 1835 to 1842). -/
structure AllocatedComponent where
  policyId : PolicyId
  exactTax : ExactRational
  quantizedAmount : ExactRational
  quantization : QuantizedValue
  recoverable : ExactRational
  nonRecoverable : ExactRational
  deriving DecidableEq, Repr, Inhabited

/-- `OccurrenceRef` (lines 1846 to 1852). -/
structure OccurrenceRef where
  lineIdx : Nat
  compIdx : Nat
  policy : TaxPolicy
  component : TaxPolicyComponent
  exactTax : ExactRational
  deriving DecidableEq, Repr, Inhabited

/-- The key of a document-level group (lines 1859 to 1861):
`JSON.stringify(["structural", policy.id, policy.version, component.id])` or
`JSON.stringify(["legacy", `${policy.id}:${component.id}`])`. `JSON.stringify` of an array of
strings is injective and the two tags keep the two kinds apart, so equal texts are equal values
of this type. -/
inductive TaxGroupKey where
  | structural (policyId : PolicyId) (policyVersion : SemanticVersion) (componentId : PolicyId)
  | legacy (combined : String)
  deriving DecidableEq, Repr, Inhabited

/-- The key of one occurrence (lines 1859 to 1861). -/
def taxGroupKey (policy : TaxPolicy) (component : TaxPolicyComponent) : TaxGroupKey :=
  if usesStructuralTaxGrouping policy then
    .structural policy.id policy.version component.id
  else
    .legacy (policy.id.value ++ ":" ++ component.id.value)

/-- `groups.get(key)` then `push` or `set` (lines 1863 to 1865): an occurrence goes last in its
group, and a new group goes last. -/
def insertOccurrence (key : TaxGroupKey) (occ : OccurrenceRef) :
    List (TaxGroupKey × List OccurrenceRef) → List (TaxGroupKey × List OccurrenceRef)
  | [] => [(key, [occ])]
  | (k, occs) :: rest =>
    if k == key then (k, occs ++ [occ]) :: rest
    else (k, occs) :: insertOccurrence key occ rest

/-- The inner loop of lines 1856 to 1866, for one line, from component index `compIdx`. -/
def buildLineGroups (lineIdx : Nat) (policy : TaxPolicy) :
    Nat → List ComponentExactTax → List (TaxGroupKey × List OccurrenceRef) →
      List (TaxGroupKey × List OccurrenceRef)
  | _, [], groups => groups
  | compIdx, item :: rest, groups =>
    let key := taxGroupKey policy item.component
    let occ : OccurrenceRef :=
      { lineIdx, compIdx, policy, component := item.component, exactTax := item.exactTax }
    buildLineGroups lineIdx policy (compIdx + 1) rest (insertOccurrence key occ groups)

/-- The outer loop of lines 1854 to 1867, from line index `lineIdx`. -/
def buildGroupsAux : Nat → List PreResolvedTaxLine → List (TaxGroupKey × List OccurrenceRef) →
    List (TaxGroupKey × List OccurrenceRef)
  | _, [], groups => groups
  | lineIdx, pre :: rest, groups =>
    buildGroupsAux (lineIdx + 1) rest
      (buildLineGroups lineIdx pre.policy 0 pre.componentExactTaxes groups)

/-- The map `groups` of lines 1853 to 1867, in insertion order. -/
def buildGroups (preLines : List PreResolvedTaxLine) :
    List (TaxGroupKey × List OccurrenceRef) :=
  buildGroupsAux 0 preLines []

/-- One pass of the loop of lines 1875 to 1909, with the four running values of lines 1870 to
1873. -/
def allocateOccurrence (cumExact : ExactRational) (prevCumCoeff : Int)
    (cumAllocated : ExactRational) (prevCumRecCoeff : Int) (occ : OccurrenceRef) :
    Except TaxErr (ExactRational × Int × ExactRational × Int × AllocatedComponent) :=
  match liftNum (cumExact.add occ.exactTax) with
  | .error e => .error e
  | .ok nextCumExact =>
    match liftQuantize (quantize nextCumExact occ.policy.quantizationPolicy.rule) with
    | .error e => .error e
    | .ok qCum =>
      let diffCoeff := qCum.amount.coefficient - prevCumCoeff
      match liftNum (ExactDecimal.of diffCoeff occ.policy.quantizationPolicy.targetScale) with
      | .error e => .error e
      | .ok decimalAmount =>
        match liftNum decimalAmount.toRational with
        | .error e => .error e
        | .ok allocatedAmount =>
          match liftNum (occ.exactTax.subtract allocatedAmount) with
          | .error e => .error e
          | .ok residual =>
            let qv : QuantizedValue := { amount := decimalAmount, residual }
            if occ.component.recoverableShare.equals one then
              .ok (nextCumExact, qCum.amount.coefficient, cumAllocated, prevCumRecCoeff,
                { policyId := occ.component.id, exactTax := occ.exactTax,
                  quantizedAmount := allocatedAmount, quantization := qv,
                  recoverable := allocatedAmount, nonRecoverable := ExactRational.zero })
            else if occ.component.recoverableShare.isZero then
              .ok (nextCumExact, qCum.amount.coefficient, cumAllocated, prevCumRecCoeff,
                { policyId := occ.component.id, exactTax := occ.exactTax,
                  quantizedAmount := allocatedAmount, quantization := qv,
                  recoverable := ExactRational.zero, nonRecoverable := allocatedAmount })
            else
              match liftNum (cumAllocated.add allocatedAmount) with
              | .error e => .error e
              | .ok nextCumAllocated =>
                match liftNum (nextCumAllocated.multiply occ.component.recoverableShare) with
                | .error e => .error e
                | .ok recTarget =>
                  match liftQuantize (quantize recTarget occ.policy.quantizationPolicy.rule) with
                  | .error e => .error e
                  | .ok qCumRec =>
                    let diffRecCoeff := qCumRec.amount.coefficient - prevCumRecCoeff
                    match liftNum (ExactDecimal.of diffRecCoeff
                        occ.policy.quantizationPolicy.targetScale) with
                    | .error e => .error e
                    | .ok decimalRec =>
                      match liftNum decimalRec.toRational with
                      | .error e => .error e
                      | .ok allocatedRec =>
                        match liftNum (allocatedAmount.subtract allocatedRec) with
                        | .error e => .error e
                        | .ok allocatedNonRec =>
                          .ok (nextCumExact, qCum.amount.coefficient, nextCumAllocated,
                            qCumRec.amount.coefficient,
                            { policyId := occ.component.id, exactTax := occ.exactTax,
                              quantizedAmount := allocatedAmount, quantization := qv,
                              recoverable := allocatedRec, nonRecoverable := allocatedNonRec })

/-- The loop of lines 1875 to 1910 over one group, each allocation tagged with its line and
component index (the target of line 1902). -/
def allocateGroupAux (cumExact : ExactRational) (prevCumCoeff : Int)
    (cumAllocated : ExactRational) (prevCumRecCoeff : Int) :
    List OccurrenceRef → Except TaxErr (List ((Nat × Nat) × AllocatedComponent))
  | [] => .ok []
  | occ :: rest =>
    match allocateOccurrence cumExact prevCumCoeff cumAllocated prevCumRecCoeff occ with
    | .error e => .error e
    | .ok (ce, pcc, ca, prc, alloc) =>
      match allocateGroupAux ce pcc ca prc rest with
      | .error e => .error e
      | .ok tail => .ok (((occ.lineIdx, occ.compIdx), alloc) :: tail)

/-- The loop of lines 1869 to 1911 over the groups in insertion order, each from zero. -/
def allocateGroups :
    List (TaxGroupKey × List OccurrenceRef) → Except TaxErr (List ((Nat × Nat) × AllocatedComponent))
  | [] => .ok []
  | (_, occs) :: rest =>
    match allocateGroupAux ExactRational.zero 0 ExactRational.zero 0 occs with
    | .error e => .error e
    | .ok head =>
      match allocateGroups rest with
      | .error e => .error e
      | .ok tail => .ok (head ++ tail)

/-- `lineAllocatedComponents[lineIdx]` read in component order: the allocation written at
`[lineIdx][compIdx]` (line 1902). -/
def collectLineAllocated (pairs : List ((Nat × Nat) × AllocatedComponent)) (lineIdx : Nat) :
    Nat → List ComponentExactTax → List AllocatedComponent
  | _, [] => []
  | compIdx, _ :: rest =>
    let item := (pairs.find? (fun p => p.1 == (lineIdx, compIdx))).map (·.2) |>.getD default
    item :: collectLineAllocated pairs lineIdx (compIdx + 1) rest

/-- `lineAllocatedComponents` after the document-level loops, line by line. -/
def collectAllAllocated (pairs : List ((Nat × Nat) × AllocatedComponent)) :
    Nat → List PreResolvedTaxLine → List (List AllocatedComponent)
  | _, [] => []
  | lineIdx, pre :: rest =>
    collectLineAllocated pairs lineIdx 0 pre.componentExactTaxes ::
      collectAllAllocated pairs (lineIdx + 1) rest

/-- Document-level rounding (lines 1845 to 1911). -/
def allocateDocumentLevel (preLines : List PreResolvedTaxLine) :
    Except TaxErr (List (List AllocatedComponent)) :=
  match allocateGroups (buildGroups preLines) with
  | .error e => .error e
  | .ok pairs => .ok (collectAllAllocated pairs 0 preLines)

/-- Line-level rounding of one component (lines 1916 to 1940). -/
def allocateLineComponent (qp : QuantizationPolicy) (item : ComponentExactTax) :
    Except TaxErr AllocatedComponent :=
  match liftQuantize (quantize item.exactTax qp.rule) with
  | .error e => .error e
  | .ok q =>
    match liftNum q.amount.toRational with
    | .error e => .error e
    | .ok quantizedAmount =>
      match liftNum (item.exactTax.subtract quantizedAmount) with
      | .error e => .error e
      | .ok residual =>
        let qv : QuantizedValue := { amount := q.amount, residual }
        if item.component.recoverableShare.equals one then
          .ok
            { policyId := item.component.id, exactTax := item.exactTax,
              quantizedAmount := quantizedAmount, quantization := qv,
              recoverable := quantizedAmount, nonRecoverable := ExactRational.zero }
        else if item.component.recoverableShare.isZero then
          .ok
            { policyId := item.component.id, exactTax := item.exactTax,
              quantizedAmount := quantizedAmount, quantization := qv,
              recoverable := ExactRational.zero, nonRecoverable := quantizedAmount }
        else
          match liftNum (quantizedAmount.multiply item.component.recoverableShare) with
          | .error e => .error e
          | .ok recTarget =>
            match liftQuantize (quantize recTarget qp.rule) with
            | .error e => .error e
            | .ok qRec =>
              match liftNum qRec.amount.toRational with
              | .error e => .error e
              | .ok rec =>
                match liftNum (quantizedAmount.subtract rec) with
                | .error e => .error e
                | .ok nonRec =>
                  .ok
                    { policyId := item.component.id, exactTax := item.exactTax,
                      quantizedAmount := quantizedAmount, quantization := qv,
                      recoverable := rec, nonRecoverable := nonRec }

/-- Line-level rounding of one line's components (lines 1914 to 1942). -/
def allocateLineComponents (qp : QuantizationPolicy) :
    List ComponentExactTax → Except TaxErr (List AllocatedComponent)
  | [] => .ok []
  | item :: rest =>
    match allocateLineComponent qp item with
    | .error e => .error e
    | .ok head =>
      match allocateLineComponents qp rest with
      | .error e => .error e
      | .ok tail => .ok (head :: tail)

/-- Line-level rounding (lines 1912 to 1944), each line with its own policy's quantization. -/
def allocateLineLevel : List PreResolvedTaxLine → Except TaxErr (List (List AllocatedComponent))
  | [] => .ok []
  | pre :: rest =>
    match allocateLineComponents pre.policy.quantizationPolicy pre.componentExactTaxes with
    | .error e => .error e
    | .ok head =>
      match allocateLineLevel rest with
      | .error e => .error e
      | .ok tail => .ok (head :: tail)

/-- The branch of line 1845: document level when the common rounding level is `documentLevel`. -/
def allocate (common : CommonRounding) (preLines : List PreResolvedTaxLine) :
    Except TaxErr (List (List AllocatedComponent)) :=
  if common.map (·.1) == some .documentLevel then allocateDocumentLevel preLines
  else allocateLineLevel preLines

/-! ### Stage 5: postings and line results (lines 1946 to 2016) -/

/-- An entry of the map `entries` (line 1946). -/
structure TaxEntry where
  id : PostingId
  amount : ExactRational
  order : Nat
  deriving DecidableEq, Repr, Inhabited

/-- `addPosting` (lines 1947 to 1950). When the account has an entry whose order is larger than
`order`, the entry is replaced by `{ id, amount, order }` and its amount is dropped. -/
def addPosting (id : PostingId) (accountId : AccountId) (amount : ExactRational) (order : Nat)
    (entries : List (AccountId × TaxEntry)) : Except TaxErr (List (AccountId × TaxEntry)) :=
  match assocGet entries accountId with
  | none => .ok (entries ++ [(accountId, { id, amount, order })])
  | some prior =>
    if order < prior.order then
      .ok (assocSet entries accountId { id, amount, order })
    else
      match liftNum (prior.amount.add amount) with
      | .error e => .error e
      | .ok nextAmount => .ok (assocSet entries accountId { prior with amount := nextAmount })

/-- The posting identifier `${request.id}-tax-${lineOrdinal + 1}-${index + 1}-${kind}`. -/
def taxPostingText (requestId : TaxDeterminationId) (lineOrdinal index : Nat) (kind : String) :
    String :=
  requestId.value ++ "-tax-" ++ toString (lineOrdinal + 1) ++ "-" ++ toString (index + 1) ++ "-" ++
    kind

/-- A tax posting (lines 1980, 1985, 1991, 1995): its identifier is made, then it is added. -/
def taxPosting (requestId : TaxDeterminationId) (lineOrdinal index : Nat) (kind : String)
    (accountId : AccountId) (amount : ExactRational) (order : Nat)
    (entries : List (AccountId × TaxEntry)) : Except TaxErr (List (AccountId × TaxEntry)) :=
  match liftCanonical (identifier "Posting" (taxPostingText requestId lineOrdinal index kind)) with
  | .error e => .error e
  | .ok pid => addPosting pid accountId amount order entries

/-- Lines 1977 to 1981 (recoverable) and 1982 to 1986 (non-recoverable): a part that is not zero is
posted, negated for a credit, to the account the component names for it; a component that names
none is refused. -/
def partPosting (requestId : TaxDeterminationId) (isCreditFlag : Bool) (lineOrdinal index : Nat)
    (kind : String) (diag : SemanticDiagnostic) (part : ExactRational)
    (accountId? : Option AccountId) (order : Nat) (entries : List (AccountId × TaxEntry)) :
    Except TaxErr (SemanticDiagnostic ⊕ List (AccountId × TaxEntry)) :=
  if !part.isZero then
    match accountId? with
    | none => .ok (.inl diag)
    | some accountId =>
      match taxPosting requestId lineOrdinal index kind accountId
          (if isCreditFlag then part.negate else part) order entries with
      | .error e => .error e
      | .ok entries' => .ok (.inr entries')
  else .ok (.inr entries)

/-- One pass of the loop of lines 1974 to 1998: the postings of one component and the new
counterparty amount. -/
def componentPostings (requestId : TaxDeterminationId) (isCreditFlag : Bool) (lineId : String)
    (lineOrdinal orderBase index : Nat) (allocated : AllocatedComponent)
    (component : TaxPolicyComponent) (entries : List (AccountId × TaxEntry))
    (counterpartyAmount : ExactRational) :
    Except TaxErr (SemanticDiagnostic ⊕ (List (AccountId × TaxEntry) × ExactRational)) :=
  if component.treatment == .inputTax || component.treatment == .reverseCharge then
    match partPosting requestId isCreditFlag lineOrdinal index "recoverable"
        (recoverableDiagnostic lineId) allocated.recoverable component.recoverableAccountId
        (orderBase + index * 2 + 1) entries with
    | .error e => .error e
    | .ok (.inl d) => .ok (.inl d)
    | .ok (.inr entries1) =>
      match partPosting requestId isCreditFlag lineOrdinal index "nonrecoverable"
          (nonRecoverableDiagnostic lineId) allocated.nonRecoverable
          component.nonRecoverableAccountId (orderBase + index * 2 + 2) entries1 with
      | .error e => .error e
      | .ok (.inl d) => .ok (.inl d)
      | .ok (.inr entries2) =>
        if component.treatment == .inputTax then
          match liftNum (if isCreditFlag then counterpartyAmount.add allocated.quantizedAmount
              else counterpartyAmount.subtract allocated.quantizedAmount) with
          | .error e => .error e
          | .ok counterpartyAmount' => .ok (.inr (entries2, counterpartyAmount'))
        else
          match taxPosting requestId lineOrdinal index "liability" component.liabilityAccountId
              (if isCreditFlag then allocated.quantizedAmount else allocated.quantizedAmount.negate)
              (orderBase + index * 2 + 1) entries2 with
          | .error e => .error e
          | .ok entries3 => .ok (.inr (entries3, counterpartyAmount))
  else
    match taxPosting requestId lineOrdinal index "liability" component.liabilityAccountId
        (if isCreditFlag then allocated.quantizedAmount else allocated.quantizedAmount.negate)
        (orderBase + index * 2 + 1) entries with
    | .error e => .error e
    | .ok entries1 =>
      match liftNum (if isCreditFlag then counterpartyAmount.subtract allocated.quantizedAmount
          else counterpartyAmount.add allocated.quantizedAmount) with
      | .error e => .error e
      | .ok counterpartyAmount' => .ok (.inr (entries1, counterpartyAmount'))

/-- The loop of lines 1974 to 1998 over one line's components, from component `index`, with the
running counterparty amount; the first refusal ends it. -/
def applyComponentPostings (requestId : TaxDeterminationId) (isCreditFlag : Bool)
    (lineId : String) (lineOrdinal orderBase : Nat) :
    Nat → List (AllocatedComponent × TaxPolicyComponent) →
      List (AccountId × TaxEntry) → ExactRational →
      Except TaxErr (SemanticDiagnostic ⊕ (List (AccountId × TaxEntry) × ExactRational))
  | _, [], entries, counterpartyAmount => .ok (.inr (entries, counterpartyAmount))
  | index, (allocated, component) :: rest, entries, counterpartyAmount =>
    match componentPostings requestId isCreditFlag lineId lineOrdinal orderBase index allocated
        component entries counterpartyAmount with
    | .error e => .error e
    | .ok (.inl d) => .ok (.inl d)
    | .ok (.inr (entries', counterpartyAmount')) =>
      applyComponentPostings requestId isCreditFlag lineId lineOrdinal orderBase (index + 1) rest
        entries' counterpartyAmount'

/-- `TaxComponentResult` of an allocation (lines 2002 to 2008). -/
def toComponentResult (c : AllocatedComponent) : TaxComponentResult :=
  { policyId := c.policyId, exactTax := c.exactTax, quantization := c.quantization,
    recoverable := c.recoverable, nonRecoverable := c.nonRecoverable }

/-- The terms of `grossAllocatedTax` (lines 1958 to 1965). -/
def grossAllocatedTerms (allocatedComps : List AllocatedComponent)
    (components : List TaxPolicyComponent) : List ExactRational :=
  (allocatedComps.zip components).filterMap fun (c, comp) =>
    if isGross comp then some c.quantizedAmount else none

/-- `lineExclusive` (lines 1967 to 1969). -/
def lineExclusiveOf (pre : PreResolvedTaxLine) (grossAllocatedTax : ExactRational) :
    Except TaxErr ExactRational :=
  if pre.line.amountIncludesTax then liftNum (pre.line.statedAmount.subtract grossAllocatedTax)
  else .ok pre.unroundedExclusive

/-- The loop of lines 1954 to 2016 from line `lineOrdinal`: the source posting, the component
postings, the counterparty posting, and the line result. -/
def buildPostingsAndLineResults (requestId : TaxDeterminationId) (isCreditFlag : Bool)
    (sign : ExactRational) :
    Nat → List (PreResolvedTaxLine × List AllocatedComponent) → List (AccountId × TaxEntry) →
      Except TaxErr (SemanticDiagnostic ⊕ (List (AccountId × TaxEntry) × List TaxLineResult))
  | _, [], entries => .ok (.inr (entries, []))
  | lineOrdinal, (pre, allocatedComps) :: rest, entries =>
    let orderBase := lineOrdinal * (pre.components.length * 2 + 4)
    match liftNum (accountingSum (grossAllocatedTerms allocatedComps pre.components)) with
    | .error e => .error e
    | .ok grossAllocatedTax =>
      match lineExclusiveOf pre grossAllocatedTax with
      | .error e => .error e
      | .ok lineExclusive =>
        match liftNum (lineExclusive.multiply sign) with
        | .error e => .error e
        | .ok sourceAmount =>
          match addPosting pre.line.sourcePostingId pre.line.sourceAccountId
              sourceAmount orderBase entries with
          | .error e => .error e
          | .ok entries1 =>
            match applyComponentPostings requestId isCreditFlag pre.line.lineId lineOrdinal
                orderBase 0 (allocatedComps.zip pre.components) entries1 sourceAmount.negate with
            | .error e => .error e
            | .ok (.inl diag) => .ok (.inl diag)
            | .ok (.inr (entries2, counterpartyAmount)) =>
              match addPosting pre.line.counterpartyPostingId pre.line.payableAccountId
                  counterpartyAmount (orderBase + pre.components.length * 2 + 2) entries2 with
              | .error e => .error e
              | .ok entries3 =>
                let lineResult : TaxLineResult :=
                  { lineId := pre.line.lineId, policyId := pre.policy.id,
                    exclusiveBasis := lineExclusive,
                    components := allocatedComps.map toComponentResult }
                match buildPostingsAndLineResults requestId isCreditFlag sign
                    (lineOrdinal + 1) rest entries3 with
                | .error e => .error e
                | .ok (.inl diag) => .ok (.inl diag)
                | .ok (.inr (entriesFinal, tail)) =>
                  .ok (.inr (entriesFinal, lineResult :: tail))

/-! ### Stage 6: the journal and the effect (lines 2018 to 2022) -/

/-- `postings` (line 2018): one posting an entry, in the map's order, with no cost basis. -/
def postingsOf (commodityId : CommodityId) (entries : List (AccountId × TaxEntry)) :
    List ExactPreparedPosting :=
  entries.map fun (accountId, entry) =>
    { id := entry.id, accountId, units := entry.amount, unitsCommodityId := commodityId,
      exactBookValue := entry.amount, costBasis := none }

/-- `body` (line 2020), as a determination whose `contentHash` is not yet set: `bodyValue` leaves
the field out. -/
def determinationBody (request : TaxRequest) (bookId : BookId) (lineResults : List TaxLineResult) :
    TaxDetermination :=
  { id := request.id, bookId, taxPoint := request.governedAt,
    sourceTransactionId := request.sourceTransactionId, direction := request.direction,
    lines := lineResults, derivation := request.derivation, contentHash := default }

/-- `effect` (line 2020): `{ ...body, contentHash: accountingHash("TaxDetermination", body) }`. -/
def determinationOf (request : TaxRequest) (bookId : BookId) (lineResults : List TaxLineResult) :
    TaxDetermination :=
  let body := determinationBody request bookId lineResults
  { body with contentHash := accountingBodyHash "TaxDetermination" body }

/-- `journal` (line 2021). `request.governedAt.slice(0, 10)` is the first ten characters (see the
header for instants beyond the Basic Multilingual Plane). -/
def taxJournal (request : TaxRequest) (postings : List ExactPreparedPosting) :
    ExactPreparedJournal :=
  { requiredQuantizationPolicy := none, id := request.sourceTransactionId, kind := .ordinary,
    economicAt := request.governedAt,
    accountingDate := ⟨String.ofList (request.governedAt.value.toList.take 10)⟩,
    recordedAt := request.governedAt, narration := "Taxed transaction", postings,
    derivations := [request.derivation] }

/-- Lines 2018 to 2022: the balance test, then the draft. -/
def finish (request : TaxRequest) (bookId : BookId) (commodityId : CommodityId)
    (entries : List (AccountId × TaxEntry)) (lineResults : List TaxLineResult) :
    Except TaxErr AccountingCalculation :=
  let postings := postingsOf commodityId entries
  match liftNum (accountingSum (postings.map (·.exactBookValue))) with
  | .error e => .error e
  | .ok total =>
    if !total.isZero then .ok (.rejected [balanceDiagnostic])
    else .ok (drafted [taxJournal request postings]
      [.taxDetermination (determinationOf request bookId lineResults)])

end Tax

/-- `determineTax` (`accounting.ts` line 1768): the composition of the stages above. A `reject(...)`
of the TypeScript is `.rejected [d]` with the named diagnostic `d`. -/
def determineTax (policies : List AccountingPolicy) (bookId : BookId) (commodityId : CommodityId)
    (request : TaxRequest) : Except TaxErr AccountingCalculation :=
  if Tax.requestRejected request then .ok (.rejected [Tax.requestDiagnostic])
  else if Tax.invalidTaxLines request.lines then .ok (.rejected [Tax.linesDiagnostic])
  else
    match Tax.preResolveLines policies bookId request.governedAt (Tax.isSale request.direction)
        none request.lines with
    | .error e => .error e
    | .ok (.inl d) => .ok (.rejected [d])
    | .ok (.inr (common, preLines)) =>
      match Tax.allocate common preLines with
      | .error e => .error e
      | .ok allocated =>
        match Tax.buildPostingsAndLineResults request.id (Tax.isCredit request.direction)
            (Tax.sourceSign request.direction) 0 (preLines.zip allocated) [] with
        | .error e => .error e
        | .ok (.inl d) => .ok (.rejected [d])
        | .ok (.inr (entries, lineResults)) =>
          Tax.finish request bookId commodityId entries lineResults


/-! ## Meaning and basic lifting lemmas -/

namespace Tax

theorem liftNum_eq_ok_iff {α : Type} {x : Except NumErr α} {v : α} :
    liftNum x = .ok v ↔ x = .ok v := by
  cases x <;> simp [liftNum]

theorem liftNum_eq_error_iff {α : Type} {x : Except NumErr α} {e : TaxErr} :
    liftNum x = .error e ↔ ∃ code, x = .error code ∧ e = .exactNumber code := by
  cases x <;> simp [liftNum, eq_comm]

theorem liftQuantize_eq_ok_iff {α : Type} {x : Except QuantizeErr α} {v : α} :
    liftQuantize x = .ok v ↔ x = .ok v := by
  cases x with
  | ok _ => simp [liftQuantize]
  | error e => cases e <;> simp [liftQuantize]

theorem liftQuantize_eq_error_iff {α : Type} {x : Except QuantizeErr α} {e : TaxErr} :
    liftQuantize x = .error e ↔
      (x = .error .scaleOutOfRange ∧ e = .scaleOutOfRange) ∨
      (∃ code, x = .error (.exactNumber code) ∧ e = .exactNumber code) := by
  cases x with
  | ok _ => simp [liftQuantize]
  | error err => cases err <;> simp [liftQuantize, eq_comm]

theorem liftCanonical_eq_ok_iff {α : Type} {x : Except CanonicalErr α} {v : α} :
    liftCanonical x = .ok v ↔ x = .ok v := by
  cases x <;> simp [liftCanonical]

theorem liftCanonical_eq_error_iff {α : Type} {x : Except CanonicalErr α} {e : TaxErr} :
    liftCanonical x = .error e ↔ ∃ code, x = .error code ∧ e = .canonical code := by
  cases x <;> simp [liftCanonical, eq_comm]

/-- When `accountingSum` returns `.ok`, its result is constructible and equals the rational sum. -/
theorem accountingSum_ok {values : List ExactRational} {result : ExactRational}
    (hv : ∀ v ∈ values, v.WF) (h : accountingSum values = .ok result) :
    result.WF ∧ result.toRat = (values.map ExactRational.toRat).sum := by
  obtain ⟨hwf, hrat⟩ := addExactValues_ok ExactRational.zero_wf hv h
  refine ⟨hwf, ?_⟩
  rw [hrat, ExactRational.zero_toRat, zero_add]
  rfl

/-- `addExactValues` on constructible values throws only `.representationLimitExceeded`. -/
theorem addExactValues_error_is_limit {values : List ExactRational} :
    ∀ {total : ExactRational} {code : NumErr},
      total.WF → (∀ v ∈ values, v.WF) → addExactValues total values = .error code →
      code = .representationLimitExceeded := by
  induction values with
  | nil => intro total code _ _ h; simp [addExactValues] at h
  | cons v rest ih =>
    intro total code ht hv h
    simp only [addExactValues] at h
    cases hadd : total.add v with
    | error err =>
      rw [hadd] at h
      cases h
      rcases ExactRational.add_ok_or_limit ht (hv v (by simp)) with ⟨c, hc⟩ | hlim
      · rw [hc] at hadd; cases hadd
      · rw [hlim] at hadd; exact (Except.error.inj hadd).symm
    | ok next =>
      rw [hadd] at h
      obtain ⟨hnwf, -⟩ := ExactRational.add_ok ht (hv v (by simp)) hadd
      exact ih hnwf (fun x hx => hv x (by simp [hx])) h

/-- `accountingSum` on constructible values throws only `.representationLimitExceeded`. -/
theorem accountingSum_error_is_limit {values : List ExactRational} {code : NumErr}
    (hv : ∀ v ∈ values, v.WF) (h : accountingSum values = .error code) :
    code = .representationLimitExceeded :=
  addExactValues_error_is_limit ExactRational.zero_wf hv h

/-- Auxiliary characterization of `invalidTaxLinesAux`. -/
theorem invalidTaxLinesAux_eq_false_iff :
    ∀ (lines : List TaxableLine) (seenIds : List String)
      (seenSrc seenCP : List PostingId),
      invalidTaxLinesAux seenIds seenSrc seenCP lines = false ↔
        (lines.map (·.lineId)).Nodup ∧
        (lines.map (·.sourcePostingId)).Nodup ∧
        (lines.map (·.counterpartyPostingId)).Nodup ∧
        (∀ l ∈ lines,
          l.lineId ∉ seenIds ∧ l.sourcePostingId ∉ seenSrc ∧ l.counterpartyPostingId ∉ seenCP ∧
          (jsTrim l.lineId).length ≠ 0 ∧ l.sourcePostingId ≠ l.counterpartyPostingId ∧
          l.statedAmount.isZero = false)
  | [], _, _, _ => by simp [invalidTaxLinesAux]
  | line :: rest, seenIds, seenSrc, seenCP => by
    have ih := invalidTaxLinesAux_eq_false_iff rest (line.lineId :: seenIds)
      (line.sourcePostingId :: seenSrc) (line.counterpartyPostingId :: seenCP)
    simp only [invalidTaxLinesAux, Bool.or_eq_false_iff, ih, List.map_cons, List.nodup_cons,
      List.mem_map, not_exists, not_and, List.mem_cons, forall_eq_or_imp]
    simp only [Bool.eq_false_iff, ne_eq, List.contains_iff_mem, beq_iff_eq]
    constructor
    · rintro ⟨⟨⟨⟨⟨⟨h1, h2⟩, h3⟩, h4⟩, h5⟩, h6⟩, ⟨hn1, hn2, hn3, hall⟩⟩
      refine ⟨⟨fun l hl heq => (hall l hl).1 (heq ▸ Or.inl rfl), hn1⟩,
        ⟨fun l hl heq => (hall l hl).2.1 (heq ▸ Or.inl rfl), hn2⟩,
        ⟨fun l hl heq => (hall l hl).2.2.1 (heq ▸ Or.inl rfl), hn3⟩,
        ⟨h1, h2, h3, h4, h5, h6⟩, fun l hl =>
          ⟨fun hm => (hall l hl).1 (Or.inr hm),
           fun hm => (hall l hl).2.1 (Or.inr hm),
           fun hm => (hall l hl).2.2.1 (Or.inr hm),
           (hall l hl).2.2.2⟩⟩
    · rintro ⟨⟨hf1, hn1⟩, ⟨hf2, hn2⟩, ⟨hf3, hn3⟩, ⟨h1, h2, h3, h4, h5, h6⟩, hall⟩
      refine ⟨⟨⟨⟨⟨⟨h1, h2⟩, h3⟩, h4⟩, h5⟩, by simp [h6]⟩, ⟨hn1, hn2, hn3, fun l hl => ?_⟩⟩
      rcases hall l hl with ⟨hs1, hs2, hs3, hs4, hs5, hs6⟩
      exact ⟨fun hm => by rcases hm with heq | hm; exact hf1 l hl heq; exact hs1 hm,
        fun hm => by rcases hm with heq | hm; exact hf2 l hl heq; exact hs2 hm,
        fun hm => by rcases hm with heq | hm; exact hf3 l hl heq; exact hs3 hm,
        hs4, hs5, hs6⟩

/-- `invalidTaxLines` returns `false` iff line IDs, source posting IDs and counterparty posting IDs
are each distinct, and every line has non-empty trimmed `lineId`, distinct source/counterparty
postings, and non-zero `statedAmount`. -/
theorem invalidTaxLines_eq_false_iff (lines : List TaxableLine) :
    invalidTaxLines lines = false ↔
      (lines.map (·.lineId)).Nodup ∧
      (lines.map (·.sourcePostingId)).Nodup ∧
      (lines.map (·.counterpartyPostingId)).Nodup ∧
      ∀ l ∈ lines,
        (jsTrim l.lineId).length ≠ 0 ∧ l.sourcePostingId ≠ l.counterpartyPostingId ∧
        l.statedAmount.isZero = false := by
  rw [invalidTaxLines, invalidTaxLinesAux_eq_false_iff]
  simp

theorem insertComponentSorted_perm (item : TaxPolicyComponent) :
    ∀ xs : List TaxPolicyComponent, (insertComponentSorted item xs).Perm (item :: xs)
  | [] => List.Perm.refl _
  | next :: rest => by
    unfold insertComponentSorted
    split_ifs
    · exact List.Perm.refl _
    · exact (List.Perm.cons next (insertComponentSorted_perm item rest)).trans
        (List.Perm.swap item next rest)

theorem sortComponents_perm : ∀ xs : List TaxPolicyComponent, (sortComponents xs).Perm xs
  | [] => List.Perm.nil
  | item :: rest => (insertComponentSorted_perm item _).trans (List.Perm.cons item (sortComponents_perm rest))

theorem insertComponentSorted_pairwise {item : TaxPolicyComponent} :
    ∀ {xs : List TaxPolicyComponent},
      xs.Pairwise (fun a b => a.compoundOrdinal ≤ b.compoundOrdinal) →
      (insertComponentSorted item xs).Pairwise (fun a b => a.compoundOrdinal ≤ b.compoundOrdinal)
  | [], _ => List.pairwise_singleton _ _
  | next :: rest, h => by
    unfold insertComponentSorted
    split_ifs with hle
    · rw [List.pairwise_cons]
      refine ⟨fun x hx => ?_, h⟩
      rcases List.mem_cons.mp hx with rfl | hx'
      · exact hle
      · exact le_trans hle ((List.pairwise_cons.mp h).1 x hx')
    · rw [List.pairwise_cons]
      have hp := List.pairwise_cons.mp h
      refine ⟨fun x hx => ?_, insertComponentSorted_pairwise hp.2⟩
      have hmem := (insertComponentSorted_perm item rest).mem_iff.mp hx
      rcases List.mem_cons.mp hmem with rfl | hx'
      · omega
      · exact hp.1 x hx'

theorem sortComponents_sorted : ∀ xs : List TaxPolicyComponent,
    (sortComponents xs).Pairwise (fun a b => a.compoundOrdinal ≤ b.compoundOrdinal)
  | [] => List.Pairwise.nil
  | _ :: rest => insertComponentSorted_pairwise (sortComponents_sorted rest)

theorem dedup_length_eq_iff_nodup {α : Type} [DecidableEq α] :
    ∀ xs : List α, xs.dedup.length = xs.length ↔ xs.Nodup
  | [] => by simp
  | x :: rest => by
    by_cases hx : x ∈ rest
    · have hsub : rest.dedup.Sublist rest := List.dedup_sublist rest
      have hlen : rest.dedup.length ≤ rest.length := hsub.length_le
      have hdedup : (x :: rest).dedup = rest.dedup := List.dedup_cons_of_mem hx
      simp [hdedup, hx, show rest.dedup.length ≠ rest.length + 1 by omega]
    · have hdedup : (x :: rest).dedup = x :: rest.dedup := List.dedup_cons_of_notMem hx
      simp [hdedup, hx, dedup_length_eq_iff_nodup rest]

/-- Validated component graph invariant for `badGraphComponents`. -/
def ValidComponentGraph (priorIds : List PolicyId) (prevOrdinal : Option Int)
    (includesTax : Bool) : List TaxPolicyComponent → Prop
  | [] => True
  | c :: rest =>
    0 < c.compoundOrdinal ∧
    (∀ prev, prevOrdinal = some prev → prev < c.compoundOrdinal) ∧
    positive c.rate = true ∧
    c.inclusion = (if includesTax then .inclusive else .exclusive) ∧
    (∀ id ∈ c.compoundsOn, id ∈ priorIds) ∧
    ValidComponentGraph (c.id :: priorIds) (some c.compoundOrdinal) includesTax rest

theorem badGraphComponents_eq_false_iff :
    ∀ (priorIds : List PolicyId) (prevOrdinal : Option Int) (includesTax : Bool)
      (components : List TaxPolicyComponent),
      badGraphComponents priorIds prevOrdinal includesTax components = false ↔
        ValidComponentGraph priorIds prevOrdinal includesTax components
  | _, _, _, [] => by simp [badGraphComponents, ValidComponentGraph]
  | priorIds, prevOrdinal, includesTax, c :: rest => by
    have ih := badGraphComponents_eq_false_iff (c.id :: priorIds) (some c.compoundOrdinal)
      includesTax rest
    simp only [badGraphComponents, Bool.or_eq_false_iff, Bool.not_eq_false', Bool.not_eq_true',
      bne_eq_false_iff_eq, decide_eq_false_iff_not, not_le, ih, ValidComponentGraph,
      List.any_eq_false]
    constructor
    · rintro ⟨⟨⟨⟨⟨h1, h2⟩, h3⟩, h4⟩, h5⟩, h6⟩
      refine ⟨h1, fun prev hp => ?_, h3, h4, fun id hid => by simpa using h5 id hid, h6⟩
      subst hp; simpa using h2
    · rintro ⟨h1, h2, h3, h4, h5, h6⟩
      refine ⟨⟨⟨⟨⟨h1, ?_⟩, h3⟩, h4⟩, fun id hid => by simpa using h5 id hid⟩, h6⟩
      cases prevOrdinal with
      | none => rfl
      | some prev => simpa using h2 prev rfl

/-- Exact specification of valid component graphs (`accounting.ts` lines 1806 to 1811). -/
def ValidComponents (bookId : BookId) (isSaleFlag includesTax : Bool) (policy : TaxPolicy)
    (components : List TaxPolicyComponent) : Prop :=
  policy.bookId = bookId ∧
  components ≠ [] ∧
  (components.map (·.id)).Nodup ∧
  ValidComponentGraph [] none includesTax components ∧
  (∀ c ∈ components,
    c.recoverableShare.compare ExactRational.zero ≠ .lt ∧
    c.recoverableShare.compare one ≠ .gt ∧
    ((c.treatment = .outputTax ∨ c.treatment = .withholding) → c.recoverableShare.isZero = true)) ∧
  (∀ c ∈ components, if isSaleFlag then c.treatment = .outputTax else c.treatment ≠ .outputTax)

theorem invalidComponents_eq_false_iff (bookId : BookId) (isSaleFlag includesTax : Bool)
    (policy : TaxPolicy) (components : List TaxPolicyComponent) :
    invalidComponents bookId isSaleFlag includesTax policy components = false ↔
      ValidComponents bookId isSaleFlag includesTax policy components := by
  unfold invalidComponents ValidComponents
  have hlen : (components.map (·.id)).dedup.length = components.length ↔
      (components.map (·.id)).Nodup := by
    have hlm : (components.map (·.id)).length = components.length := by simp
    conv_lhs => rw [← hlm]
    exact dedup_length_eq_iff_nodup _
  have hempty : components.isEmpty = false ↔ components ≠ [] := by
    cases components <;> simp
  simp only [Bool.or_eq_false_iff, bne_eq_false_iff_eq, hempty, hlen,
    badGraphComponents_eq_false_iff, List.any_eq_false]
  constructor
  · rintro ⟨⟨⟨⟨⟨h1, h2⟩, h3⟩, h4⟩, h5⟩, h6⟩
    refine ⟨h1, h2, h3, h4, fun c hc => ?_, fun c hc => ?_⟩
    · have hc5 := h5 c hc
      simp only [Bool.or_eq_true, Bool.and_eq_true, beq_iff_eq, Bool.not_eq_true',
        not_or, not_and] at hc5
      refine ⟨hc5.1.1, hc5.1.2, fun ht => ?_⟩
      by_contra hnz
      exact hc5.2 ht (Bool.eq_false_iff.mpr hnz)
    · have hc6 := h6 c hc
      cases isSaleFlag <;> simpa using hc6
  · rintro ⟨h1, h2, h3, h4, h5, h6⟩
    refine ⟨⟨⟨⟨⟨h1, h2⟩, h3⟩, h4⟩, fun c hc => ?_⟩, fun c hc => ?_⟩
    · obtain ⟨hc1, hc2, hc3⟩ := h5 c hc
      simp only [Bool.or_eq_true, Bool.and_eq_true, beq_iff_eq, Bool.not_eq_true',
        not_or, not_and]
      exact ⟨⟨hc1, hc2⟩, fun ht => by simp [hc3 ht]⟩
    · have hc6 := h6 c hc
      cases isSaleFlag <;> simpa using hc6

/-- Appending a suffix to a well-formed identifier produces a valid `PostingId` when the combined
string is in Unicode NFC form and the suffix ends without JavaScript whitespace or control
characters. -/
theorem postingId_append_of_isNFC {Kind : String} (id : Identifier Kind) (suf : String)
    (hid : id.WF) (hsuf_ne : suf ≠ "")
    (hsuf_ctrl : ∀ c ∈ suf.toList, isControlChar c = false)
    (hsuf_no_end_ws : ∀ h : suf.toList ≠ [], isJsWhitespace (suf.toList.getLast h) = false)
    (hnfc : isNFC (id.value ++ suf) = true) :
    ∃ pid : PostingId, identifier "Posting" (id.value ++ suf) = .ok pid ∧ pid.value = id.value ++ suf := by
  have hid_ne_list : id.value.toList ≠ [] := fun h => hid.nonempty (by
    rw [← String.ofList_toList (s := id.value), h])
  have hsuf_ne_list : suf.toList ≠ [] := fun h => hsuf_ne (by
    rw [← String.ofList_toList (s := suf), h])
  have hcomb_ne : id.value ++ suf ≠ "" := by
    intro h
    have hl := congrArg String.toList h
    rw [String.toList_append] at hl
    simp only [String.toList_empty, List.append_eq_nil_iff] at hl
    exact hid_ne_list hl.1
  have hcomb_ne_list : (id.value ++ suf).toList ≠ [] := fun h => hcomb_ne (by
    rw [← String.ofList_toList (s := id.value ++ suf), h])
  have hhead_id := ((jsTrim_eq_self_iff id.value hid.nonempty).mp hid.no_boundary_whitespace)
    hid_ne_list |>.1
  have htrim : jsTrim (id.value ++ suf) = id.value ++ suf := by
    rw [jsTrim_eq_self_iff _ hcomb_ne]
    intro h
    have hlist : (id.value ++ suf).toList = id.value.toList ++ suf.toList := String.toList_append ..
    constructor
    · have hhead : (id.value ++ suf).toList.head h = id.value.toList.head hid_ne_list := by
        simp only [List.head_eq_getElem_zero]
        have : (id.value ++ suf).toList[0]' (List.length_pos_iff.mpr h) =
            (id.value.toList ++ suf.toList)[0]' (by rw [← hlist]; exact List.length_pos_iff.mpr h) := by
          simp [hlist]
        rw [this, List.getElem_append_left (List.length_pos_iff.mpr hid_ne_list)]
      rw [hhead]; exact hhead_id
    · have hlast : (id.value ++ suf).toList.getLast h = suf.toList.getLast hsuf_ne_list := by
        simp only [List.getLast_eq_getElem, hlist, List.length_append]
        have hlpos : 0 < suf.toList.length := List.length_pos_iff.mpr hsuf_ne_list
        rw [List.getElem_append_right (by omega)]
        congr 1; omega
      rw [hlast]; exact hsuf_no_end_ws hsuf_ne_list
  have hctrl : ∀ c ∈ (id.value ++ suf).toList, isControlChar c = false := by
    intro c hc
    rw [String.toList_append, List.mem_append] at hc
    rcases hc with hc | hc
    · exact hid.no_control_chars c hc
    · exact hsuf_ctrl c hc
  exact ⟨⟨id.value ++ suf⟩,
    (identifier_ok_iff "Posting" (id.value ++ suf) ⟨id.value ++ suf⟩).mpr
      ⟨⟨hcomb_ne, htrim, hnfc, hctrl⟩, rfl⟩,
    rfl⟩

/-- When an identifier is pure ASCII, appending any non-empty ASCII suffix without control
characters or trailing JavaScript whitespace always succeeds as a `PostingId`. -/
theorem postingId_append_ascii_ok {Kind : String} (id : Identifier Kind) (suf : String)
    (hid : id.WF) (hascii : ∀ c ∈ id.value.toList, c.toNat < 128) (hsuf_ne : suf ≠ "")
    (hsuf_ascii : ∀ c ∈ suf.toList, c.toNat < 128)
    (hsuf_ctrl : ∀ c ∈ suf.toList, isControlChar c = false)
    (hsuf_no_end_ws : ∀ h : suf.toList ≠ [], isJsWhitespace (suf.toList.getLast h) = false) :
    ∃ pid : PostingId, identifier "Posting" (id.value ++ suf) = .ok pid ∧ pid.value = id.value ++ suf := by
  apply postingId_append_of_isNFC id suf hid hsuf_ne hsuf_ctrl hsuf_no_end_ws
  apply ascii_isNFC
  intro c hc
  rw [String.toList_append, List.mem_append] at hc
  rcases hc with hc | hc
  · exact hascii c hc
  · exact hsuf_ascii c hc

/-! ## Component graph coefficients, exact taxes, and inclusive reconstruction -/

theorem assocGet_mem {κ ν : Type} [BEq κ] [LawfulBEq κ] :
    ∀ {entries : List (κ × ν)} {key : κ} {val : ν},
      assocGet entries key = some val → (key, val) ∈ entries
  | [], _, _, h => by simp [assocGet] at h
  | (k, v) :: rest, key, val, h => by
    unfold assocGet at h
    simp only [List.find?_cons] at h
    by_cases hk : k == key
    · simp only [hk, Option.map_some, Option.some.injEq] at h
      have hk' : k = key := beq_iff_eq.mp hk
      subst hk' h; simp
    · simp only [hk] at h
      exact List.mem_cons_of_mem _ (assocGet_mem h)

theorem assocGet_assocSet_eq {κ ν : Type} [BEq κ] [LawfulBEq κ] :
    ∀ (entries : List (κ × ν)) (key : κ) (val : ν),
      (entries.map Prod.fst).Nodup →
      assocGet (assocSet entries key val) key = some val
  | entries, key, val, hnodup => by
    unfold assocSet assocGet
    split_ifs with hhas
    · induction entries with
      | nil => simp at hhas
      | cons e rest ih =>
        obtain ⟨k, v⟩ := e
        simp only [List.any_cons, Bool.or_eq_true, beq_iff_eq] at hhas
        simp only [List.map_cons, List.nodup_cons] at hnodup
        by_cases hk : k = key
        · subst hk; simp
        · simp only [hk, false_or] at hhas
          rw [List.map_cons]
          simp only [beq_false_of_ne hk, Bool.false_eq_true, ↓reduceIte, List.find?_cons]
          exact ih hnodup.2 hhas
    · induction entries with
      | nil => simp
      | cons e rest ih =>
        obtain ⟨k, v⟩ := e
        simp only [List.any_cons, Bool.or_eq_true, beq_iff_eq, not_or] at hhas
        simp only [List.map_cons, List.nodup_cons] at hnodup
        rw [List.cons_append, List.find?_cons]
        simp only [beq_false_of_ne hhas.1]
        exact ih hnodup.2 hhas.2

theorem assocGet_assocSet_ne {κ ν : Type} [BEq κ] [LawfulBEq κ] :
    ∀ (entries : List (κ × ν)) (k1 k2 : κ) (val : ν),
      k1 ≠ k2 →
      assocGet (assocSet entries k1 val) k2 = assocGet entries k2
  | entries, k1, k2, val, hne => by
    have hmap : ∀ l : List (κ × ν),
        Option.map Prod.snd
          (List.find? (fun e => e.1 == k2)
            (l.map fun e => if e.1 == k1 then (k1, val) else e)) =
        Option.map Prod.snd (List.find? (fun e => e.1 == k2) l) := by
      intro l
      induction l with
      | nil => rfl
      | cons e rest ih =>
        obtain ⟨k, v⟩ := e
        by_cases hk1 : k == k1
        · have hk1' : k = k1 := beq_iff_eq.mp hk1
          subst hk1'
          have hne' : (k == k2) = false := beq_false_of_ne hne
          rw [List.map_cons]
          simp only [hk1, ↓reduceIte, List.find?_cons, hne']
          exact ih
        · rw [List.map_cons]
          simp only [hk1, Bool.false_eq_true, ↓reduceIte, List.find?_cons]
          by_cases hk2 : k == k2
          · simp only [hk2]
          · simp only [hk2]; exact ih
    have happ : ∀ l : List (κ × ν),
        Option.map Prod.snd (List.find? (fun e => e.1 == k2) (l ++ [(k1, val)])) =
        Option.map Prod.snd (List.find? (fun e => e.1 == k2) l) := by
      intro l
      induction l with
      | nil => simp [beq_false_of_ne hne]
      | cons e rest ih =>
        obtain ⟨k, v⟩ := e
        rw [List.cons_append, List.find?_cons, List.find?_cons]
        by_cases hk2 : k == k2
        · simp only [hk2]
        · simp only [hk2]; exact ih
    unfold assocSet assocGet
    split_ifs
    · exact hmap entries
    · exact happ entries

theorem assocSet_keys_nodup {κ ν : Type} [BEq κ] [LawfulBEq κ]
    (entries : List (κ × ν)) (key : κ) (val : ν) (hnodup : (entries.map Prod.fst).Nodup) :
    ((assocSet entries key val).map Prod.fst).Nodup := by
  have hmap : ∀ l : List (κ × ν),
      (l.map fun e => if e.1 == key then (key, val) else e).map Prod.fst =
        l.map Prod.fst := by
    intro l
    induction l with
    | nil => rfl
    | cons e rest ih =>
      obtain ⟨k, v⟩ := e
      simp only [List.map_cons, List.cons.injEq]
      refine ⟨?_, ih⟩
      by_cases hk : k = key
      · subst hk; simp
      · simp [hk]
  unfold assocSet
  split_ifs with hhas
  · rw [hmap entries]; exact hnodup
  · simp only [List.any_eq_true, beq_iff_eq, not_exists, not_and] at hhas
    rw [List.map_append, List.map_singleton, List.nodup_append]
    refine ⟨hnodup, List.nodup_singleton _, fun a ha b hb heq => ?_⟩
    simp only [List.mem_singleton] at hb
    subst hb; subst heq
    rw [List.mem_map] at ha
    rcases ha with ⟨e, he, rfl⟩
    exact hhas e he rfl

theorem positive_iff {r : ExactRational} (hr : r.WF) : positive r = true ↔ 0 < r.toRat := by
  unfold positive
  rw [beq_iff_eq, ExactRational.compare_gt_iff hr ExactRational.zero_wf, ExactRational.zero_toRat]

theorem assocGet_wf {κ : Type} [BEq κ] [LawfulBEq κ] {entries : List (κ × ExactRational)}
    (hw : ∀ kv ∈ entries, kv.2.WF) (key : κ) :
    ((assocGet entries key).getD ExactRational.zero).WF := by
  cases hg : assocGet entries key with
  | none => exact ExactRational.zero_wf
  | some v => simpa using hw (key, v) (assocGet_mem hg)

theorem computeCoefficients_ok :
    ∀ (components : List TaxPolicyComponent) (priorIds : List PolicyId)
      (prevOrd : Option Int) (includesTax : Bool)
      (coeffs out : List (PolicyId × ExactRational)),
      (∀ c ∈ components, c.WF) →
      (components.map (·.id)).Nodup →
      ValidComponentGraph priorIds prevOrd includesTax components →
      (∀ kv ∈ coeffs, kv.1 ∈ priorIds ∧ kv.2.WF ∧ 0 < kv.2.toRat) →
      (coeffs.map Prod.fst).Nodup →
      (∀ c ∈ components, c.id ∉ priorIds) →
      computeCoefficients coeffs components = .ok out →
      (out.map Prod.fst).Nodup ∧
      (∀ kv ∈ out, (kv.1 ∈ priorIds ∨ kv.1 ∈ components.map (·.id)) ∧ kv.2.WF ∧ 0 < kv.2.toRat) ∧
      (∀ id, id ∉ components.map (·.id) → assocGet out id = assocGet coeffs id) ∧
      ∀ c ∈ components, ∃ coeff, assocGet out c.id = some coeff ∧ coeff.WF ∧ 0 < coeff.toRat ∧
        coeff.toRat = (1 + (c.compoundsOn.map fun id =>
          ((assocGet out id).getD ExactRational.zero).toRat).sum) * c.rate.toRat
  | [], _, _, _, coeffs, out, _, _, _, hcoeffs, hnodup, _, h => by
    simp only [computeCoefficients, Except.ok.injEq] at h
    subst h
    refine ⟨hnodup, fun kv hkv => ?_, fun _ _ => rfl, fun c hc => by cases hc⟩
    obtain ⟨hp, hwf, hpos⟩ := hcoeffs kv hkv
    exact ⟨Or.inl hp, hwf, hpos⟩
  | c :: rest, priorIds, prevOrd, includesTax, coeffs, out, hwf, hcomp_nodup, hgraph,
      hcoeffs, hcoeffs_nodup, hdisj, h => by
    obtain ⟨_, _, hpos_rate, _, hcompounds, hgraph_rest⟩ := hgraph
    have hc_wf : c.WF := hwf c (by simp)
    have hrate_pos : 0 < c.rate.toRat := (positive_iff hc_wf.rate).mp hpos_rate
    simp only [List.map_cons, List.nodup_cons, List.mem_map, not_exists, not_and] at hcomp_nodup
    unfold computeCoefficients at h
    cases hsum : liftNum (accountingSum (c.compoundsOn.map fun id =>
        (assocGet coeffs id).getD ExactRational.zero)) with
    | error e => simp [hsum] at h
    | ok compoundCoeff =>
      simp only [hsum] at h
      cases hadd : liftNum (one.add compoundCoeff) with
      | error e => simp [hadd] at h
      | ok baseCoeff =>
        simp only [hadd] at h
        cases hmul : liftNum (baseCoeff.multiply c.rate) with
        | error e => simp [hmul] at h
        | ok cCoeff =>
          simp only [hmul] at h
          have hterms_wf : ∀ v ∈ c.compoundsOn.map (fun id =>
              (assocGet coeffs id).getD ExactRational.zero), v.WF := by
            intro v hv
            rw [List.mem_map] at hv
            rcases hv with ⟨id, -, rfl⟩
            exact assocGet_wf (fun kv hkv => (hcoeffs kv hkv).2.1) id
          have hterms_nonneg : ∀ id ∈ c.compoundsOn,
              0 ≤ ((assocGet coeffs id).getD ExactRational.zero).toRat := by
            intro id _
            cases hg : assocGet coeffs id with
            | none => simp [ExactRational.zero_toRat]
            | some v => exact le_of_lt (hcoeffs (id, v) (assocGet_mem hg)).2.2
          obtain ⟨hcc_wf, hcc_rat⟩ := accountingSum_ok hterms_wf (liftNum_eq_ok_iff.mp hsum)
          have hone_wf : one.WF :=
            ⟨Int.one_pos, by decide, withinMagnitude_one, withinMagnitude_one⟩
          obtain ⟨hbc_wf, hbc_rat⟩ := ExactRational.add_ok hone_wf hcc_wf (liftNum_eq_ok_iff.mp hadd)
          obtain ⟨hcc2_wf, hcc2_rat⟩ := ExactRational.multiply_ok hbc_wf hc_wf.rate
            (liftNum_eq_ok_iff.mp hmul)
          have hcc_nonneg : 0 ≤ compoundCoeff.toRat := by
            rw [hcc_rat]
            apply List.sum_nonneg
            intro x hx
            rw [List.mem_map] at hx
            rcases hx with ⟨v, hv, rfl⟩
            rw [List.mem_map] at hv
            rcases hv with ⟨id, hid, rfl⟩
            exact hterms_nonneg id hid
          have hbc_pos : 0 < baseCoeff.toRat := by
            rw [hbc_rat]
            have hone_rat : one.toRat = 1 := by simp [one, ExactRational.toRat]
            linarith
          have hcc2_pos : 0 < cCoeff.toRat := by
            rw [hcc2_rat]
            exact mul_pos hbc_pos hrate_pos
          have hnext_coeffs : ∀ kv ∈ assocSet coeffs c.id cCoeff,
              kv.1 ∈ c.id :: priorIds ∧ kv.2.WF ∧ 0 < kv.2.toRat := by
            intro kv hkv
            unfold assocSet at hkv
            split_ifs at hkv
            · rw [List.mem_map] at hkv
              rcases hkv with ⟨kv0, hkv0, rfl⟩
              split_ifs
              · exact ⟨by simp, hcc2_wf, hcc2_pos⟩
              · obtain ⟨hp, hw, hpo⟩ := hcoeffs kv0 hkv0
                exact ⟨List.mem_cons_of_mem _ hp, hw, hpo⟩
            · rw [List.mem_append, List.mem_singleton] at hkv
              rcases hkv with hkv | rfl
              · obtain ⟨hp, hw, hpo⟩ := hcoeffs kv hkv
                exact ⟨List.mem_cons_of_mem _ hp, hw, hpo⟩
              · exact ⟨by simp, hcc2_wf, hcc2_pos⟩
          have hnext_disj : ∀ c' ∈ rest, c'.id ∉ c.id :: priorIds := by
            intro c' hc' hm
            rcases List.mem_cons.mp hm with heq | hm
            · exact hcomp_nodup.1 c' hc' heq
            · exact hdisj c' (by simp [hc']) hm
          obtain ⟨hout_nodup, hout_inv, hout_pres, hout_rest⟩ :=
            computeCoefficients_ok rest (c.id :: priorIds) (some c.compoundOrdinal) includesTax
              (assocSet coeffs c.id cCoeff) out
              (fun c' hc' => hwf c' (by simp [hc'])) hcomp_nodup.2 hgraph_rest
              hnext_coeffs (assocSet_keys_nodup coeffs c.id cCoeff hcoeffs_nodup) hnext_disj h
          refine ⟨hout_nodup, fun kv hkv => ?_, fun id hid => ?_, fun c' hc' => ?_⟩
          · obtain ⟨hp, hw, hpo⟩ := hout_inv kv hkv
            rcases hp with hp | hp
            · rcases List.mem_cons.mp hp with heq | hp
              · exact ⟨Or.inr (by simp [heq]), hw, hpo⟩
              · exact ⟨Or.inl hp, hw, hpo⟩
            · exact ⟨Or.inr (List.mem_cons_of_mem _ hp), hw, hpo⟩
          · simp only [List.map_cons, List.mem_cons, List.mem_map, not_or, not_exists,
              not_and] at hid
            have hid_rest : id ∉ rest.map (·.id) := by
              intro hm
              rw [List.mem_map] at hm
              rcases hm with ⟨x, hx, heq⟩
              exact hid.2 x hx heq
            rw [hout_pres id hid_rest, assocGet_assocSet_ne _ _ _ _ (Ne.symm hid.1)]
          · rcases List.mem_cons.mp hc' with heq | hc'
            · subst heq
              have hc_notin : c'.id ∉ rest.map (·.id) := by
                intro hm
                rw [List.mem_map] at hm
                rcases hm with ⟨x, hx, heq⟩
                exact hcomp_nodup.1 x hx heq
              rw [hout_pres c'.id hc_notin, assocGet_assocSet_eq coeffs c'.id cCoeff hcoeffs_nodup]
              refine ⟨cCoeff, rfl, hcc2_wf, hcc2_pos, ?_⟩
              have hmap_eq : (c'.compoundsOn.map fun id =>
                  ((assocGet out id).getD ExactRational.zero).toRat) =
                  c'.compoundsOn.map fun id =>
                    ((assocGet coeffs id).getD ExactRational.zero).toRat := by
                apply List.map_congr_left
                intro id hid
                have hid_prior : id ∈ priorIds := hcompounds id hid
                have hid_notin_rest : id ∉ rest.map (·.id) := by
                  intro hm
                  rw [List.mem_map] at hm
                  rcases hm with ⟨x, hx, heq⟩
                  exact hdisj x (by simp [hx]) (heq ▸ hid_prior)
                have hne_c : c'.id ≠ id := fun heq => hdisj c' (by simp) (heq ▸ hid_prior)
                rw [hout_pres id hid_notin_rest, assocGet_assocSet_ne coeffs c'.id id cCoeff hne_c]
              rw [hmap_eq, hcc2_rat, hbc_rat, hcc_rat]
              have hone_rat : one.toRat = 1 := by simp [one, ExactRational.toRat]
              rw [hone_rat, List.map_map]
              rfl
            · exact hout_rest c' hc'

private theorem sum_map_mul_left {α : Type} (c : ℚ) (f : α → ℚ) :
    ∀ xs : List α, (xs.map (fun x => c * f x)).sum = c * (xs.map f).sum
  | [] => by simp
  | x :: xs => by
    simp only [List.map_cons, List.sum_cons, sum_map_mul_left c f xs]
    ring

theorem computeExactTaxes_ok (exclusive : ExactRational) (fullCoeffs : List (PolicyId × ExactRational)) :
    ∀ (components : List TaxPolicyComponent) (priorIds : List PolicyId)
      (prevOrd : Option Int) (includesTax : Bool)
      (seen : List (PolicyId × ExactRational)) (items : List ComponentExactTax),
      exclusive.WF →
      (∀ c ∈ components, c.WF) →
      (components.map (·.id)).Nodup →
      ValidComponentGraph priorIds prevOrd includesTax components →
      (∀ id ∈ priorIds, ∃ v, assocGet seen id = some v ∧ v.WF ∧
        v.toRat = exclusive.toRat * ((assocGet fullCoeffs id).getD ExactRational.zero).toRat) →
      (∀ kv ∈ seen, kv.2.WF) →
      (seen.map Prod.fst).Nodup →
      (∀ c ∈ components, c.id ∉ priorIds) →
      (∀ c ∈ components, ∃ coeff, assocGet fullCoeffs c.id = some coeff ∧
        coeff.toRat = (1 + (c.compoundsOn.map fun id =>
          ((assocGet fullCoeffs id).getD ExactRational.zero).toRat).sum) * c.rate.toRat) →
      computeExactTaxes exclusive seen components = .ok items →
      items.map (·.component) = components ∧
      (∀ item ∈ items, item.exactTax.WF) ∧
      ∀ item ∈ items, item.exactTax.toRat =
        exclusive.toRat * ((assocGet fullCoeffs item.component.id).getD ExactRational.zero).toRat
  | [], _, _, _, _, items, _, _, _, _, _, _, _, _, _, h => by
    simp only [computeExactTaxes, Except.ok.injEq] at h
    subst h
    simp
  | c :: rest, priorIds, prevOrd, includesTax, seen, items, hexc, hwf, hcomp_nodup, hgraph,
      hseen_cov, hseen_wf, hseen_nodup, hdisj, hcoeff_eq, h => by
    obtain ⟨_, _, _, _, hcompounds, hgraph_rest⟩ := hgraph
    have hc_wf : c.WF := hwf c (by simp)
    simp only [List.map_cons, List.nodup_cons, List.mem_map, not_exists, not_and] at hcomp_nodup
    unfold computeExactTaxes at h
    cases hsum : liftNum (accountingSum (c.compoundsOn.map fun id =>
        (assocGet seen id).getD ExactRational.zero)) with
    | error e => simp [hsum] at h
    | ok compound =>
      simp only [hsum] at h
      cases hadd : liftNum (exclusive.add compound) with
      | error e => simp [hadd] at h
      | ok base =>
        simp only [hadd] at h
        cases hmul : liftNum (base.multiply c.rate) with
        | error e => simp [hmul] at h
        | ok exactTax =>
          simp only [hmul] at h
          cases htail : computeExactTaxes exclusive (assocSet seen c.id exactTax) rest with
          | error e => simp [htail] at h
          | ok tail =>
            simp only [htail, Except.ok.injEq] at h
            subst h
            have hterms_wf : ∀ v ∈ c.compoundsOn.map (fun id =>
                (assocGet seen id).getD ExactRational.zero), v.WF := by
              intro v hv
              rw [List.mem_map] at hv
              rcases hv with ⟨id, -, rfl⟩
              exact assocGet_wf hseen_wf id
            obtain ⟨hcomp_wf, hcomp_rat⟩ := accountingSum_ok hterms_wf (liftNum_eq_ok_iff.mp hsum)
            obtain ⟨hbase_wf, hbase_rat⟩ := ExactRational.add_ok hexc hcomp_wf
              (liftNum_eq_ok_iff.mp hadd)
            obtain ⟨het_wf, het_rat⟩ := ExactRational.multiply_ok hbase_wf hc_wf.rate
              (liftNum_eq_ok_iff.mp hmul)
            obtain ⟨coeff, hcoeff_some, hcoeff_formula⟩ := hcoeff_eq c (by simp)
            have het_eq : exactTax.toRat =
                exclusive.toRat * ((assocGet fullCoeffs c.id).getD ExactRational.zero).toRat := by
              have hterms_eq : (c.compoundsOn.map fun id =>
                  ((assocGet seen id).getD ExactRational.zero).toRat) =
                  c.compoundsOn.map fun id =>
                    exclusive.toRat * ((assocGet fullCoeffs id).getD ExactRational.zero).toRat := by
                apply List.map_congr_left
                intro id hid
                obtain ⟨v, hv_some, -, hv_rat⟩ := hseen_cov id (hcompounds id hid)
                rw [hv_some, Option.getD_some, hv_rat]
              rw [het_rat, hbase_rat, hcomp_rat, List.map_map]
              change (_ + (c.compoundsOn.map fun id =>
                ((assocGet seen id).getD ExactRational.zero).toRat).sum) * c.rate.toRat = _
              rw [hterms_eq, sum_map_mul_left, hcoeff_some, Option.getD_some, hcoeff_formula]
              ring
            have hnext_cov : ∀ id ∈ c.id :: priorIds, ∃ v, assocGet (assocSet seen c.id exactTax) id = some v ∧
                v.WF ∧ v.toRat = exclusive.toRat * ((assocGet fullCoeffs id).getD ExactRational.zero).toRat := by
              intro id hid
              rcases List.mem_cons.mp hid with heq | hid
              · subst heq
                rw [assocGet_assocSet_eq seen c.id exactTax hseen_nodup]
                exact ⟨exactTax, rfl, het_wf, het_eq⟩
              · have hne : c.id ≠ id := fun heq => hdisj c (by simp) (heq ▸ hid)
                rw [assocGet_assocSet_ne seen c.id id exactTax hne]
                exact hseen_cov id hid
            have hnext_wf : ∀ kv ∈ assocSet seen c.id exactTax, kv.2.WF := by
              intro kv hkv
              unfold assocSet at hkv
              split_ifs at hkv
              · rw [List.mem_map] at hkv
                rcases hkv with ⟨kv0, hkv0, rfl⟩
                split_ifs
                · exact het_wf
                · exact hseen_wf kv0 hkv0
              · rw [List.mem_append, List.mem_singleton] at hkv
                rcases hkv with hkv | rfl
                · exact hseen_wf kv hkv
                · exact het_wf
            have hnext_disj : ∀ c' ∈ rest, c'.id ∉ c.id :: priorIds := by
              intro c' hc' hm
              rcases List.mem_cons.mp hm with heq | hm
              · exact hcomp_nodup.1 c' hc' heq
              · exact hdisj c' (by simp [hc']) hm
            obtain ⟨ht_comp, ht_wf, ht_eq⟩ :=
              computeExactTaxes_ok exclusive fullCoeffs rest (c.id :: priorIds)
                (some c.compoundOrdinal) includesTax (assocSet seen c.id exactTax) tail
                hexc (fun c' hc' => hwf c' (by simp [hc'])) hcomp_nodup.2 hgraph_rest
                hnext_cov hnext_wf (assocSet_keys_nodup seen c.id exactTax hseen_nodup) hnext_disj
                (fun c' hc' => hcoeff_eq c' (by simp [hc'])) htail
            refine ⟨by simp [ht_comp], fun item hi => ?_, fun item hi => ?_⟩
            · rcases List.mem_cons.mp hi with rfl | hi
              · exact het_wf
              · exact ht_wf item hi
            · rcases List.mem_cons.mp hi with rfl | hi
              · exact het_eq
              · exact ht_eq item hi

/-- A selected `TaxPolicy` returned by `policyAt` belongs to `policies`. -/
theorem policyAt_selected_mem {policies : List AccountingPolicy} {id : PolicyId}
    {version : SemanticVersion} {at_ : Instant} {p : TaxPolicy}
    (h : policyAt TaxPolicy policies id version at_ = .selected p) :
    AccountingPolicy.taxDetermination p ∈ policies := by
  unfold policyAt at h
  cases hfilt : policies.filter (policyMatches (AccountingPolicyKind.kind TaxPolicy) id version at_) with
  | nil => simp [hfilt] at h
  | cons sel rest =>
    cases rest with
    | cons _ _ => simp [hfilt] at h
    | nil =>
      simp only [hfilt] at h
      split_ifs at h with hexec
      cases sel with
      | taxDetermination tp =>
        simp only [AccountingPolicyKind.ofPolicy?] at h
        injection h with h
        subst h
        have hm : AccountingPolicy.taxDetermination tp ∈
            policies.filter (policyMatches (AccountingPolicyKind.kind TaxPolicy) id version at_) := by
          rw [hfilt]; simp
        exact (List.mem_filter.mp hm).1
      | _ => simp [AccountingPolicyKind.ofPolicy?] at h

/-! ## The line stages: what a line that passes satisfies -/

theorem one_wf : one.WF := ⟨Int.one_pos, by decide, withinMagnitude_one, withinMagnitude_one⟩

theorem one_toRat : one.toRat = 1 := by simp [one, ExactRational.toRat]

/-- A line passes its checks only with the policy `policyAt` selected, a supported grouping marker,
the common rounding level and quantization, and valid components. -/
theorem lineCheck_inr {policies : List AccountingPolicy} {bookId : BookId} {governedAt : Instant}
    {isSaleFlag : Bool} {common : CommonRounding} {line : TaxableLine} {policy : TaxPolicy}
    (h : lineCheck policies bookId governedAt isSaleFlag common line = .inr policy) :
    policyAt TaxPolicy policies line.policyId line.policyVersion governedAt = .selected policy ∧
    groupingUnsupported policy = false ∧ roundingMismatch common policy = false ∧
    quantizationMismatch common policy = false ∧
    invalidComponents bookId isSaleFlag line.amountIncludesTax policy
      (sortComponents policy.components) = false := by
  unfold lineCheck at h
  split at h
  · cases h
  · rename_i p hp
    split_ifs at h with h1 h2 h3 h4
    cases h
    exact ⟨hp, by simpa using h1, by simpa using h2, by simpa using h3, by simpa using h4⟩

/-- The exact gross tax of a line: the exact taxes of its input and output tax components. -/
def grossExactTax (items : List ComponentExactTax) : ℚ :=
  ((items.filter fun item => isGross item.component).map (·.exactTax.toRat)).sum

/-- The exact gross tax is the exclusive amount times the gross coefficients, when every exact tax
is the exclusive amount times its coefficient. -/
theorem grossExactTax_eq (exclusive : ExactRational) (coeffs : List (PolicyId × ExactRational)) :
    ∀ (items : List ComponentExactTax),
      (∀ item ∈ items, item.exactTax.toRat =
        exclusive.toRat * ((assocGet coeffs item.component.id).getD ExactRational.zero).toRat) →
      grossExactTax items =
        exclusive.toRat * (((items.map (·.component)).filter isGross).map fun c =>
          ((assocGet coeffs c.id).getD ExactRational.zero).toRat).sum
  | [], _ => by simp [grossExactTax]
  | item :: rest, h => by
    have ih := grossExactTax_eq exclusive coeffs rest (fun x hx => h x (by simp [hx]))
    have hi := h item (by simp)
    unfold grossExactTax at ih ⊢
    by_cases ht : isGross item.component = true
    · simp only [List.filter_cons, ht, ↓reduceIte, List.map_cons, List.sum_cons, ih, hi]
      ring
    · simp only [List.filter_cons, ht, Bool.false_eq_true, ↓reduceIte, List.map_cons]
      exact ih

/-- The sum of the exact gross taxes, computed by `accountingSum`, is `grossExactTax`. -/
theorem grossTaxTerms_sum {items : List ComponentExactTax} {total : ExactRational}
    (hw : ∀ item ∈ items, item.exactTax.WF) (h : accountingSum (grossTaxTerms items) = .ok total) :
    total.WF ∧ total.toRat = grossExactTax items := by
  have hw' : ∀ v ∈ grossTaxTerms items, v.WF := by
    intro v hv
    simp only [grossTaxTerms, List.mem_map, List.mem_filter] at hv
    obtain ⟨item, ⟨hm, -⟩, rfl⟩ := hv
    exact hw item hm
  obtain ⟨hwf, hr⟩ := accountingSum_ok hw' h
  refine ⟨hwf, ?_⟩
  rw [hr, grossExactTax, grossTaxTerms, List.map_map]
  rfl

/-- What the exact arithmetic of a line guarantees when it returns: every value is constructible,
one exact tax per component in order, each exact tax is the exclusive amount times the
component's compound coefficient, and the exclusive amount is the stated amount, or (inclusive)
it and the exact gross tax add up to the stated amount exactly. -/
structure LineExactSpec (line : TaxableLine) (components : List TaxPolicyComponent)
    (exclusive : ExactRational) (items : List ComponentExactTax) : Prop where
  exclusive_wf : exclusive.WF
  components_eq : items.map (·.component) = components
  exactTax_wf : ∀ item ∈ items, item.exactTax.WF
  inclusive_exact : line.amountIncludesTax = true →
    exclusive.toRat + grossExactTax items = line.statedAmount.toRat
  exclusive_eq : line.amountIncludesTax = false → exclusive = line.statedAmount
  coefficients : ∃ coeffs : List (PolicyId × ExactRational),
    (∀ c ∈ components, ∃ coeff, assocGet coeffs c.id = some coeff ∧ 0 < coeff.toRat ∧
      coeff.toRat = (1 + (c.compoundsOn.map fun id =>
        ((assocGet coeffs id).getD ExactRational.zero).toRat).sum) * c.rate.toRat) ∧
    ∀ item ∈ items, item.exactTax.toRat =
      exclusive.toRat * ((assocGet coeffs item.component.id).getD ExactRational.zero).toRat

/-- On valid components, the arithmetic of a line never rejects: when it returns, it returns the
exact taxes, with `LineExactSpec`. -/
theorem lineExact_ok {line : TaxableLine} {components : List TaxPolicyComponent}
    {r : SemanticDiagnostic ⊕ (ExactRational × List ComponentExactTax)}
    (hline : line.WF) (hwf : ∀ c ∈ components, c.WF) (hnodup : (components.map (·.id)).Nodup)
    (hgraph : ValidComponentGraph [] none line.amountIncludesTax components)
    (h : lineExact line components = .ok r) :
    ∃ exclusive items, r = .inr (exclusive, items) ∧
      LineExactSpec line components exclusive items := by
  unfold lineExact at h
  cases hcc : computeCoefficients [] components with
  | error e => simp [hcc] at h
  | ok coeffs =>
    simp only [hcc] at h
    obtain ⟨-, hcoeff_inv, -, hcoeff_eq⟩ := computeCoefficients_ok components [] none
      line.amountIncludesTax [] coeffs hwf hnodup hgraph (fun _ hk => by cases hk) List.nodup_nil
      (fun _ _ hm => by cases hm) hcc
    have hterms_wf : ∀ v ∈ grossCoefficientTerms coeffs components, v.WF := by
      intro v hv
      simp only [grossCoefficientTerms, List.mem_map] at hv
      obtain ⟨c, -, rfl⟩ := hv
      exact assocGet_wf (fun kv hkv => (hcoeff_inv kv hkv).2.1) c.id
    cases hts : liftNum (accountingSum (grossCoefficientTerms coeffs components)) with
    | error e => simp [hts] at h
    | ok taxCoeffSum =>
      simp only [hts] at h
      obtain ⟨hts_wf, hts_rat⟩ := accountingSum_ok hterms_wf (liftNum_eq_ok_iff.mp hts)
      cases hgc : liftNum (one.add taxCoeffSum) with
      | error e => simp [hgc] at h
      | ok grossCoefficient =>
        simp only [hgc] at h
        obtain ⟨hgc_wf, hgc_rat⟩ := ExactRational.add_ok one_wf hts_wf (liftNum_eq_ok_iff.mp hgc)
        have hts_nonneg : 0 ≤ taxCoeffSum.toRat := by
          rw [hts_rat]
          apply List.sum_nonneg
          intro x hx
          simp only [grossCoefficientTerms, List.map_map, List.mem_map] at hx
          obtain ⟨c, -, rfl⟩ := hx
          show 0 ≤ ((assocGet coeffs c.id).getD ExactRational.zero).toRat
          cases hg : assocGet coeffs c.id with
          | none => simp [ExactRational.zero_toRat]
          | some v => exact le_of_lt (hcoeff_inv (c.id, v) (assocGet_mem hg)).2.2
        have hgc_eq : grossCoefficient.toRat = 1 + taxCoeffSum.toRat := by rw [hgc_rat, one_toRat]
        have hpos : positive grossCoefficient = true :=
          (positive_iff hgc_wf).mpr (by rw [hgc_eq]; linarith)
        simp only [hpos, Bool.not_true, Bool.false_eq_true, ↓reduceIte] at h
        cases hexc : exclusiveOf line grossCoefficient with
        | error e => simp [hexc] at h
        | ok exclusive =>
          simp only [hexc] at h
          have hexc_wf : exclusive.WF := by
            unfold exclusiveOf at hexc
            split_ifs at hexc
            · exact (ExactRational.divide_ok hline.statedAmount hgc_wf
                (liftNum_eq_ok_iff.mp hexc)).1
            · cases hexc; exact hline.statedAmount
          cases het : computeExactTaxes exclusive [] components with
          | error e => simp [het] at h
          | ok items =>
            simp only [het] at h
            obtain ⟨het_comp, het_wf, het_rat⟩ := computeExactTaxes_ok exclusive coeffs components
              [] none line.amountIncludesTax [] items hexc_wf hwf hnodup hgraph
              (fun _ hid => by cases hid) (fun _ hkv => by cases hkv) List.nodup_nil
              (fun _ _ hm => by cases hm)
              (fun c hc => by
                obtain ⟨cf, hcf1, _, _, hcf2⟩ := hcoeff_eq c hc
                exact ⟨cf, hcf1, hcf2⟩) het
            have hgross : grossExactTax items = exclusive.toRat * taxCoeffSum.toRat := by
              rw [grossExactTax_eq exclusive coeffs items het_rat, het_comp, hts_rat,
                grossCoefficientTerms, List.map_map]
              rfl
            have hinc : line.amountIncludesTax = true →
                exclusive.toRat + grossExactTax items = line.statedAmount.toRat := by
              intro hi
              simp only [exclusiveOf, hi, ↓reduceIte] at hexc
              obtain ⟨-, hnz, hdiv⟩ := ExactRational.divide_ok hline.statedAmount hgc_wf
                (liftNum_eq_ok_iff.mp hexc)
              rw [hgross, hdiv]
              calc line.statedAmount.toRat / grossCoefficient.toRat +
                    line.statedAmount.toRat / grossCoefficient.toRat * taxCoeffSum.toRat
                  = line.statedAmount.toRat / grossCoefficient.toRat * (1 + taxCoeffSum.toRat) := by
                    ring
                _ = line.statedAmount.toRat / grossCoefficient.toRat * grossCoefficient.toRat := by
                    rw [hgc_eq]
                _ = line.statedAmount.toRat := div_mul_cancel₀ _ hnz
            have hexcl : line.amountIncludesTax = false → exclusive = line.statedAmount := by
              intro hi
              simp only [exclusiveOf, hi, Bool.false_eq_true, ↓reduceIte, Except.ok.injEq] at hexc
              exact hexc.symm
            have spec : LineExactSpec line components exclusive items :=
              ⟨hexc_wf, het_comp, het_wf, hinc, hexcl, ⟨coeffs, fun c hc => by
                obtain ⟨cf, hcf1, _, hcf_pos, hcf2⟩ := hcoeff_eq c hc
                exact ⟨cf, hcf1, hcf_pos, hcf2⟩, het_rat⟩⟩
            cases hgt : liftNum (accountingSum (grossTaxTerms items)) with
            | error e => simp [hgt] at h
            | ok grossTax =>
              simp only [hgt] at h
              obtain ⟨hgt_wf, hgt_rat⟩ := grossTaxTerms_sum het_wf (liftNum_eq_ok_iff.mp hgt)
              by_cases hi : line.amountIncludesTax = true
              · simp only [hi, ↓reduceIte] at h
                cases hrec : liftNum (exclusive.add grossTax) with
                | error e => simp [hrec] at h
                | ok reconstructed =>
                  simp only [hrec] at h
                  obtain ⟨hrec_wf, hrec_rat⟩ := ExactRational.add_ok hexc_wf hgt_wf
                    (liftNum_eq_ok_iff.mp hrec)
                  have heq : reconstructed.equals line.statedAmount = true :=
                    (ExactRational.equals_iff hrec_wf hline.statedAmount).mpr
                      (by rw [hrec_rat, hgt_rat]; exact hinc hi)
                  simp only [heq, Bool.not_true, Bool.false_eq_true, ↓reduceIte,
                    Except.ok.injEq] at h
                  exact ⟨exclusive, items, h.symm, spec⟩
              · simp only [hi, Bool.false_eq_true, ↓reduceIte, Except.ok.injEq] at h
                exact ⟨exclusive, items, h.symm, spec⟩

/-- What a resolved line guarantees (lines 1783 to 1832): the selected policy is one of the
policies and constructible, its grouping marker is supported, its components sorted by ordinal pass
every test of lines 1806 to 1810, and the exact taxes satisfy `LineExactSpec`. -/
structure PreResolvedSpec (policies : List AccountingPolicy) (bookId : BookId)
    (governedAt : Instant) (isSaleFlag : Bool) (line : TaxableLine) (pre : PreResolvedTaxLine) :
    Prop where
  line_eq : pre.line = line
  selected : policyAt TaxPolicy policies line.policyId line.policyVersion governedAt =
    .selected pre.policy
  policy_mem : AccountingPolicy.taxDetermination pre.policy ∈ policies
  policy_wf : pre.policy.WF
  grouping : groupingUnsupported pre.policy = false
  components_eq : pre.components = sortComponents pre.policy.components
  valid : ValidComponents bookId isSaleFlag line.amountIncludesTax pre.policy pre.components
  components_wf : ∀ c ∈ pre.components, c.WF
  exact : LineExactSpec line pre.components pre.unroundedExclusive pre.componentExactTaxes

/-- The components of a policy that passed the checks are constructible, distinct and a valid
graph. -/
theorem lineCheck_components {policies : List AccountingPolicy} {bookId : BookId}
    {governedAt : Instant} {isSaleFlag : Bool} {common : CommonRounding} {line : TaxableLine}
    {policy : TaxPolicy} (hpols : ∀ p ∈ policies, p.WF)
    (h : lineCheck policies bookId governedAt isSaleFlag common line = .inr policy) :
    AccountingPolicy.taxDetermination policy ∈ policies ∧ policy.WF ∧
      ValidComponents bookId isSaleFlag line.amountIncludesTax policy
        (sortComponents policy.components) ∧
      ∀ c ∈ sortComponents policy.components, c.WF := by
  obtain ⟨hsel, -, -, -, hinv⟩ := lineCheck_inr h
  have hmem := policyAt_selected_mem hsel
  have hwf : policy.WF := hpols _ hmem
  exact ⟨hmem, hwf, (invalidComponents_eq_false_iff _ _ _ _ _).mp hinv,
    fun c hc => hwf.components c ((sortComponents_perm _).mem_iff.mp hc)⟩

/-- A line is resolved only when it passed its checks, and then `PreResolvedSpec` holds. -/
theorem preResolveLine_inr {policies : List AccountingPolicy} {bookId : BookId}
    {governedAt : Instant} {isSaleFlag : Bool} {common : CommonRounding} {line : TaxableLine}
    {pre : PreResolvedTaxLine} (hpols : ∀ p ∈ policies, p.WF) (hline : line.WF)
    (h : preResolveLine policies bookId governedAt isSaleFlag common line = .ok (.inr pre)) :
    lineCheck policies bookId governedAt isSaleFlag common line = .inr pre.policy ∧
      PreResolvedSpec policies bookId governedAt isSaleFlag line pre := by
  unfold preResolveLine at h
  cases hc : lineCheck policies bookId governedAt isSaleFlag common line with
  | inl d => simp [hc] at h
  | inr policy =>
    simp only [hc] at h
    obtain ⟨hmem, hwf, hvalid, hcwf⟩ := lineCheck_components hpols hc
    cases he : lineExact line (sortComponents policy.components) with
    | error e => simp [he] at h
    | ok r =>
      obtain ⟨exclusive, items, rfl, spec⟩ :=
        lineExact_ok hline hcwf hvalid.2.2.1 hvalid.2.2.2.1 he
      simp only [he, Except.ok.injEq, Sum.inr.injEq] at h
      subst h
      exact ⟨rfl, ⟨rfl, (lineCheck_inr hc).1, hmem, hwf, (lineCheck_inr hc).2.1, rfl, hvalid, hcwf,
        spec⟩⟩

/-- A line is refused exactly when its checks refuse it, with the same diagnostic: the arithmetic
of lines 1813 to 1830 never refuses (the diagnostics of lines 1816 and 1830 are never produced). -/
theorem preResolveLine_inl_iff {policies : List AccountingPolicy} {bookId : BookId}
    {governedAt : Instant} {isSaleFlag : Bool} {common : CommonRounding} {line : TaxableLine}
    {d : SemanticDiagnostic} (hpols : ∀ p ∈ policies, p.WF) (hline : line.WF) :
    preResolveLine policies bookId governedAt isSaleFlag common line = .ok (.inl d) ↔
      lineCheck policies bookId governedAt isSaleFlag common line = .inl d := by
  unfold preResolveLine
  cases hc : lineCheck policies bookId governedAt isSaleFlag common line with
  | inl d' => simp
  | inr policy =>
    simp only [reduceCtorEq, iff_false]
    obtain ⟨-, -, hvalid, hcwf⟩ := lineCheck_components hpols hc
    intro h
    cases he : lineExact line (sortComponents policy.components) with
    | error e => simp [he] at h
    | ok r =>
      obtain ⟨exclusive, items, rfl, -⟩ := lineExact_ok hline hcwf hvalid.2.2.1 hvalid.2.2.2.1 he
      simp [he] at h

/-- A policy never mismatches the common state it sets. -/
theorem mismatch_nextCommon (common : CommonRounding) (policy : TaxPolicy)
    (hr : roundingMismatch common policy = false) (hq : quantizationMismatch common policy = false) :
    roundingMismatch (nextCommon common policy) policy = false ∧
      quantizationMismatch (nextCommon common policy) policy = false := by
  cases common with
  | none => simp [nextCommon, roundingMismatch, quantizationMismatch]
  | some c => exact ⟨hr, hq⟩

/-- When all lines are resolved: one resolved line for each taxable line in order, each with
`PreResolvedSpec`; the final common state is the one the first line set; and every line's policy
has the common rounding level and the common quantization scale and mode. -/
theorem preResolveLines_inr {policies : List AccountingPolicy} {bookId : BookId}
    {governedAt : Instant} {isSaleFlag : Bool} (hpols : ∀ p ∈ policies, p.WF) :
    ∀ {common : CommonRounding} {lines : List TaxableLine} {final : CommonRounding}
      {preLines : List PreResolvedTaxLine}, (∀ l ∈ lines, l.WF) →
      preResolveLines policies bookId governedAt isSaleFlag common lines =
        .ok (.inr (final, preLines)) →
      List.Forall₂ (PreResolvedSpec policies bookId governedAt isSaleFlag) lines preLines ∧
      final = (match preLines with
        | [] => common
        | pre :: _ => nextCommon common pre.policy) ∧
      ∀ pre ∈ preLines, roundingMismatch final pre.policy = false ∧
        quantizationMismatch final pre.policy = false
  | common, [], final, preLines, _, h => by
    simp only [preResolveLines, Except.ok.injEq, Sum.inr.injEq, Prod.mk.injEq] at h
    obtain ⟨rfl, rfl⟩ := h
    exact ⟨List.Forall₂.nil, rfl, fun _ hp => by cases hp⟩
  | common, line :: rest, final, preLines, hw, h => by
    unfold preResolveLines at h
    cases hl : preResolveLine policies bookId governedAt isSaleFlag common line with
    | error e => simp [hl] at h
    | ok r =>
      cases r with
      | inl d => simp [hl] at h
      | inr pre =>
        simp only [hl] at h
        obtain ⟨hc, spec⟩ := preResolveLine_inr hpols (hw line (by simp)) hl
        obtain ⟨-, -, hr, hq, -⟩ := lineCheck_inr hc
        cases hrest : preResolveLines policies bookId governedAt isSaleFlag
            (nextCommon common pre.policy) rest with
        | error e => simp [hrest] at h
        | ok r' =>
          cases r' with
          | inl d => simp [hrest] at h
          | inr fp =>
            obtain ⟨final', tail⟩ := fp
            simp only [hrest, Except.ok.injEq, Sum.inr.injEq, Prod.mk.injEq] at h
            obtain ⟨rfl, rfl⟩ := h
            obtain ⟨hall, hfinal, hmis⟩ :=
              preResolveLines_inr hpols (fun l hl' => hw l (by simp [hl'])) hrest
            have hnext : ∀ p : TaxPolicy, nextCommon (nextCommon common pre.policy) p =
                nextCommon common pre.policy := by
              intro p; cases common <;> rfl
            have hfin : final' = nextCommon common pre.policy := by
              rw [hfinal]; cases tail <;> simp [hnext]
            refine ⟨List.Forall₂.cons spec hall, hfin, fun p hp => ?_⟩
            rcases List.mem_cons.mp hp with rfl | hp
            · rw [hfin]; exact mismatch_nextCommon common _ hr hq
            · exact hmis p hp

/-! ## Rounding -/

theorem liftQuantize_ok {α : Type} {x : Except QuantizeErr α} {v : α}
    (h : liftQuantize x = .ok v) : x = .ok v := liftQuantize_eq_ok_iff.mp h

theorem liftNum_ok {α : Type} {x : Except NumErr α} {v : α} (h : liftNum x = .ok v) :
    x = .ok v := liftNum_eq_ok_iff.mp h

/-- What every rounded component satisfies, at both levels (lines 1876 to 1909 and 1916 to 1940):
it carries its component's identifier and exact tax; its amount is at the scale of the rule and is
its quantized amount; its residual is the exact tax less that amount; and the amount splits exactly
into a recoverable and a non-recoverable part, all recoverable for a share of one and all
non-recoverable for a share of zero. -/
structure AllocationSpec (rule : QuantizationRule) (item : ComponentExactTax)
    (alloc : AllocatedComponent) : Prop where
  policyId_eq : alloc.policyId = item.component.id
  exactTax_eq : alloc.exactTax = item.exactTax
  quantizedAmount_wf : alloc.quantizedAmount.WF
  amount_wf : alloc.quantization.amount.WF
  residual_wf : alloc.quantization.residual.WF
  recoverable_wf : alloc.recoverable.WF
  nonRecoverable_wf : alloc.nonRecoverable.WF
  amount_scale : alloc.quantization.amount.scale = rule.targetScale
  amount_toRat : alloc.quantization.amount.toRat = alloc.quantizedAmount.toRat
  residual_toRat : alloc.quantization.residual.toRat = item.exactTax.toRat - alloc.quantizedAmount.toRat
  split : alloc.recoverable.toRat + alloc.nonRecoverable.toRat = alloc.quantizedAmount.toRat
  full : item.component.recoverableShare.equals one = true →
    alloc.recoverable = alloc.quantizedAmount ∧ alloc.nonRecoverable = ExactRational.zero
  none_recoverable : item.component.recoverableShare.equals one = false →
    item.component.recoverableShare.isZero = true →
    alloc.recoverable = ExactRational.zero ∧ alloc.nonRecoverable = alloc.quantizedAmount

/-- Line-level rounding of a component (lines 1916 to 1940): `AllocationSpec`, the amount is the
exact tax rounded by the policy's rule, and a share strictly between zero and one gives a
recoverable part that is the rounded amount times the share, rounded again. -/
theorem allocateLineComponent_ok {qp : QuantizationPolicy} {item : ComponentExactTax}
    {alloc : AllocatedComponent} (hx : item.exactTax.WF) (hs : item.component.recoverableShare.WF)
    (h : allocateLineComponent qp item = .ok alloc) :
    AllocationSpec qp.rule item alloc ∧
      (∃ q, quantize item.exactTax qp.rule = .ok q ∧ alloc.quantization.amount = q.amount) ∧
      (item.component.recoverableShare.equals one = false →
        item.component.recoverableShare.isZero = false →
        ∃ target qRec, target.toRat = alloc.quantizedAmount.toRat *
            item.component.recoverableShare.toRat ∧
          quantize target qp.rule = .ok qRec ∧ alloc.recoverable.toRat = qRec.amount.toRat) := by
  unfold allocateLineComponent at h
  cases hq : quantize item.exactTax qp.rule with
  | error e => cases e <;> simp [hq, liftQuantize] at h
  | ok q =>
    simp only [hq, liftQuantize] at h
    obtain ⟨hqa, -, hqs, -, -⟩ := quantize_ok hx hq
    cases hqr : q.amount.toRational with
    | error e => simp [hqr, liftNum] at h
    | ok qa =>
      simp only [hqr, liftNum] at h
      obtain ⟨hqa_wf, hqa_rat⟩ := ExactDecimal.toRational_ok hqa hqr
      cases hres : item.exactTax.subtract qa with
      | error e => simp [hres] at h
      | ok res =>
        simp only [hres] at h
        obtain ⟨hres_wf, hres_rat⟩ := ExactRational.subtract_ok hx hqa_wf hres
        by_cases h1 : item.component.recoverableShare.equals one = true
        · simp only [h1, ↓reduceIte, Except.ok.injEq] at h
          subst h
          exact ⟨⟨rfl, rfl, hqa_wf, hqa, hres_wf, hqa_wf, ExactRational.zero_wf, hqs, hqa_rat.symm,
            hres_rat, by simp [ExactRational.zero_toRat], fun _ => ⟨rfl, rfl⟩,
            fun h' => absurd h1 (by simp [h'])⟩, ⟨q, rfl, rfl⟩, fun h' => absurd h1 (by simp [h'])⟩
        have h1f : item.component.recoverableShare.equals one = false := by simpa using h1
        by_cases h2 : item.component.recoverableShare.isZero = true
        · simp only [h1f, h2, Bool.false_eq_true, ↓reduceIte, Except.ok.injEq] at h
          subst h
          exact ⟨⟨rfl, rfl, hqa_wf, hqa, hres_wf, ExactRational.zero_wf, hqa_wf, hqs, hqa_rat.symm,
            hres_rat, by simp [ExactRational.zero_toRat], fun h' => absurd h' (by simp [h1f]),
            fun _ _ => ⟨rfl, rfl⟩⟩, ⟨q, rfl, rfl⟩, fun _ h' => absurd h2 (by simp [h'])⟩
        have h2f : item.component.recoverableShare.isZero = false := by simpa using h2
        simp only [h1f, h2f, Bool.false_eq_true, ↓reduceIte] at h
        cases hm : qa.multiply item.component.recoverableShare with
        | error e => simp [hm] at h
        | ok target =>
          simp only [hm] at h
          obtain ⟨ht_wf, ht_rat⟩ := ExactRational.multiply_ok hqa_wf hs hm
          cases hqr2 : quantize target qp.rule with
          | error e => cases e <;> simp [hqr2] at h
          | ok qRec =>
            simp only [hqr2] at h
            obtain ⟨hqra, -, -, -, -⟩ := quantize_ok ht_wf hqr2
            cases hrr : qRec.amount.toRational with
            | error e => simp [hrr] at h
            | ok rec =>
              simp only [hrr] at h
              obtain ⟨hrec_wf, hrec_rat⟩ := ExactDecimal.toRational_ok hqra hrr
              cases hnr : qa.subtract rec with
              | error e => simp [hnr] at h
              | ok nonRec =>
                simp only [hnr, Except.ok.injEq] at h
                subst h
                obtain ⟨hnr_wf, hnr_rat⟩ := ExactRational.subtract_ok hqa_wf hrec_wf hnr
                exact ⟨⟨rfl, rfl, hqa_wf, hqa, hres_wf, hrec_wf, hnr_wf, hqs, hqa_rat.symm,
                  hres_rat, by rw [hnr_rat]; ring, fun h' => absurd h' (by simp [h1f]),
                  fun _ h' => absurd h' (by simp [h2f])⟩, ⟨q, rfl, rfl⟩,
                  fun _ _ => ⟨target, qRec, ht_rat, hqr2, hrec_rat⟩⟩

/-- Line-level rounding of a line's components: one allocation a component, each as
`allocateLineComponent_ok` says. -/
theorem allocateLineComponents_ok (qp : QuantizationPolicy) :
    ∀ {items : List ComponentExactTax} {allocs : List AllocatedComponent},
      (∀ item ∈ items, item.exactTax.WF ∧ item.component.recoverableShare.WF) →
      allocateLineComponents qp items = .ok allocs →
      List.Forall₂ (fun item alloc => AllocationSpec qp.rule item alloc ∧
        ∃ q, quantize item.exactTax qp.rule = .ok q ∧ alloc.quantization.amount = q.amount)
        items allocs
  | [], allocs, _, h => by
    simp only [allocateLineComponents, Except.ok.injEq] at h
    subst h; exact List.Forall₂.nil
  | item :: rest, allocs, hw, h => by
    unfold allocateLineComponents at h
    cases ha : allocateLineComponent qp item with
    | error e => simp [ha] at h
    | ok a =>
      simp only [ha] at h
      cases hr : allocateLineComponents qp rest with
      | error e => simp [hr] at h
      | ok tail =>
        simp only [hr, Except.ok.injEq] at h
        subst h
        obtain ⟨spec, hq, -⟩ := allocateLineComponent_ok (hw item (by simp)).1
          (hw item (by simp)).2 ha
        exact List.Forall₂.cons ⟨spec, hq⟩
          (allocateLineComponents_ok qp (fun i hi => hw i (by simp [hi])) hr)

/-- An amount made by `ExactDecimal.of` at the rule's scale is its coefficient in units. -/
theorem decimal_of_toRat {c : Int} {rule : QuantizationRule} {d : ExactDecimal} {r : ExactRational}
    (hd : ExactDecimal.of c rule.targetScale = .ok d) (hr : d.toRational = .ok r) :
    d.WF ∧ r.WF ∧ d.scale = rule.targetScale ∧ r.toRat = d.toRat ∧ d.toRat = c * rule.unit := by
  obtain ⟨hdw, hc, hs⟩ := ExactDecimal.of_ok hd
  obtain ⟨hrw, hrr⟩ := ExactDecimal.toRational_ok hdw hr
  refine ⟨hdw, hrw, hs, hrr, ?_⟩
  unfold ExactDecimal.toRat QuantizationRule.unit
  rw [hc, hs]
  ring

/-- One document-level allocation (lines 1876 to 1909): the running exact total grows by the
occurrence's exact tax; the allocated amount is the rounded running total less the rounded total
before it, in units of the scale; the allocation satisfies `AllocationSpec`; and the running
allocated total stays constructible. -/
theorem allocateOccurrence_ok {cumExact cumAllocated : ExactRational} {prevCumCoeff prevCumRecCoeff : Int}
    {occ : OccurrenceRef} {ce ca : ExactRational} {pcc prc : Int} {alloc : AllocatedComponent}
    (hc : cumExact.WF) (ha : cumAllocated.WF) (hx : occ.exactTax.WF)
    (hs : occ.component.recoverableShare.WF)
    (h : allocateOccurrence cumExact prevCumCoeff cumAllocated prevCumRecCoeff occ =
      .ok (ce, pcc, ca, prc, alloc)) :
    ce.WF ∧ ce.toRat = cumExact.toRat + occ.exactTax.toRat ∧
      (∃ qCum, quantize ce occ.policy.quantizationPolicy.rule = .ok qCum ∧
        pcc = qCum.amount.coefficient) ∧
      alloc.quantizedAmount.toRat = (pcc - prevCumCoeff) * occ.policy.quantizationPolicy.rule.unit ∧
      AllocationSpec occ.policy.quantizationPolicy.rule ⟨occ.component, occ.exactTax⟩ alloc ∧
      ca.WF := by
  unfold allocateOccurrence at h
  cases hadd : cumExact.add occ.exactTax with
  | error e => simp [hadd, liftNum] at h
  | ok next =>
    simp only [hadd, liftNum] at h
    obtain ⟨hn_wf, hn_rat⟩ := ExactRational.add_ok hc hx hadd
    cases hq : quantize next occ.policy.quantizationPolicy.rule with
    | error e => cases e <;> simp [hq, liftQuantize] at h
    | ok qCum =>
      simp only [hq, liftQuantize] at h
      cases hd : ExactDecimal.of (qCum.amount.coefficient - prevCumCoeff)
          occ.policy.quantizationPolicy.targetScale with
      | error e => simp [hd] at h
      | ok dec =>
        simp only [hd] at h
        cases hdr : dec.toRational with
        | error e => simp [hdr] at h
        | ok amt =>
          simp only [hdr] at h
          obtain ⟨hdw, haw, hds, har, hdu⟩ :=
            decimal_of_toRat (rule := occ.policy.quantizationPolicy.rule) hd hdr
          cases hres : occ.exactTax.subtract amt with
          | error e => simp [hres] at h
          | ok res =>
            simp only [hres] at h
            obtain ⟨hres_wf, hres_rat⟩ := ExactRational.subtract_ok hx haw hres
            have hamt : amt.toRat = (qCum.amount.coefficient - prevCumCoeff) *
                occ.policy.quantizationPolicy.rule.unit := by
              rw [har, hdu]; push_cast; ring
            by_cases h1 : occ.component.recoverableShare.equals one = true
            · simp only [h1, ↓reduceIte, Except.ok.injEq, Prod.mk.injEq] at h
              obtain ⟨rfl, rfl, rfl, rfl, rfl⟩ := h
              exact ⟨hn_wf, hn_rat, ⟨qCum, hq, rfl⟩, hamt, ⟨rfl, rfl, haw, hdw, hres_wf, haw,
                ExactRational.zero_wf, hds, har.symm, hres_rat, by simp [ExactRational.zero_toRat],
                fun _ => ⟨rfl, rfl⟩, fun h' => absurd h1 (by simp [h'])⟩, ha⟩
            have h1f : occ.component.recoverableShare.equals one = false := by simpa using h1
            by_cases h2 : occ.component.recoverableShare.isZero = true
            · simp only [h1f, h2, Bool.false_eq_true, ↓reduceIte, Except.ok.injEq,
                Prod.mk.injEq] at h
              obtain ⟨rfl, rfl, rfl, rfl, rfl⟩ := h
              exact ⟨hn_wf, hn_rat, ⟨qCum, hq, rfl⟩, hamt, ⟨rfl, rfl, haw, hdw, hres_wf,
                ExactRational.zero_wf, haw, hds, har.symm, hres_rat,
                by simp [ExactRational.zero_toRat], fun h' => absurd h' (by simp [h1f]),
                fun _ _ => ⟨rfl, rfl⟩⟩, ha⟩
            have h2f : occ.component.recoverableShare.isZero = false := by simpa using h2
            simp only [h1f, h2f, Bool.false_eq_true, ↓reduceIte] at h
            cases hca : cumAllocated.add amt with
            | error e => simp [hca] at h
            | ok nca =>
              simp only [hca] at h
              obtain ⟨hnca_wf, -⟩ := ExactRational.add_ok ha haw hca
              cases hm : nca.multiply occ.component.recoverableShare with
              | error e => simp [hm] at h
              | ok target =>
                simp only [hm] at h
                obtain ⟨ht_wf, -⟩ := ExactRational.multiply_ok hnca_wf hs hm
                cases hqr : quantize target occ.policy.quantizationPolicy.rule with
                | error e => cases e <;> simp [hqr] at h
                | ok qRec =>
                  simp only [hqr] at h
                  cases hd2 : ExactDecimal.of (qRec.amount.coefficient - prevCumRecCoeff)
                      occ.policy.quantizationPolicy.targetScale with
                  | error e => simp [hd2] at h
                  | ok dRec =>
                    simp only [hd2] at h
                    cases hdr2 : dRec.toRational with
                    | error e => simp [hdr2] at h
                    | ok rec =>
                      simp only [hdr2] at h
                      obtain ⟨-, hrw, -, -, -⟩ :=
                        decimal_of_toRat (rule := occ.policy.quantizationPolicy.rule) hd2 hdr2
                      cases hnr : amt.subtract rec with
                      | error e => simp [hnr] at h
                      | ok nonRec =>
                        simp only [hnr, Except.ok.injEq, Prod.mk.injEq] at h
                        obtain ⟨rfl, rfl, rfl, rfl, rfl⟩ := h
                        obtain ⟨hnr_wf, hnr_rat⟩ := ExactRational.subtract_ok haw hrw hnr
                        exact ⟨hn_wf, hn_rat, ⟨qCum, hq, rfl⟩, hamt, ⟨rfl, rfl, haw, hdw, hres_wf,
                          hrw, hnr_wf, hds, har.symm, hres_rat, by rw [hnr_rat]; ring,
                          fun h' => absurd h' (by simp [h1f]),
                          fun _ h' => absurd h' (by simp [h2f])⟩, hnca_wf⟩

/-- Document-level rounding of one group (lines 1875 to 1910), from any running totals: one
allocation an occurrence, tagged with its line and component, each with `AllocationSpec`; and when
every occurrence is rounded by the same rule, the amounts allocated add up to the running exact
total at the end, rounded once, less the rounded total the group started from. -/
theorem allocateGroupAux_sum {rule : QuantizationRule} :
    ∀ {occs : List OccurrenceRef} {cumExact cumAllocated : ExactRational} {p0 r0 : Int}
      {pairs : List ((Nat × Nat) × AllocatedComponent)},
      cumExact.WF → cumAllocated.WF →
      (∀ occ ∈ occs, occ.exactTax.WF ∧ occ.component.recoverableShare.WF ∧
        occ.policy.quantizationPolicy.rule = rule) →
      allocateGroupAux cumExact p0 cumAllocated r0 occs = .ok pairs →
      pairs.map (·.1) = occs.map (fun o => (o.lineIdx, o.compIdx)) ∧
      List.Forall₂ (fun occ pair => AllocationSpec rule ⟨occ.component, occ.exactTax⟩ pair.2)
        occs pairs ∧
      (occs = [] ∨ ∃ total q, total.WF ∧
        total.toRat = cumExact.toRat + (occs.map (·.exactTax.toRat)).sum ∧
        quantize total rule = .ok q ∧
        (pairs.map (·.2.quantizedAmount.toRat)).sum = (q.amount.coefficient - p0) * rule.unit)
  | [], _, _, _, _, pairs, _, _, _, h => by
    simp only [allocateGroupAux, Except.ok.injEq] at h
    subst h
    exact ⟨rfl, List.Forall₂.nil, Or.inl rfl⟩
  | occ :: rest, cumExact, cumAllocated, p0, r0, pairs, hc, ha, hw, h => by
    unfold allocateGroupAux at h
    cases ho : allocateOccurrence cumExact p0 cumAllocated r0 occ with
    | error e => simp [ho] at h
    | ok res =>
      obtain ⟨ce, pcc, ca, prc, alloc⟩ := res
      simp only [ho] at h
      obtain ⟨hx, hs, hrule⟩ := hw occ (by simp)
      obtain ⟨hce_wf, hce_rat, ⟨qCum, hq, hpcc⟩, hamt, spec, hca_wf⟩ :=
        allocateOccurrence_ok hc ha hx hs ho
      rw [hrule] at hq hamt spec
      cases ht : allocateGroupAux ce pcc ca prc rest with
      | error e => simp [ht] at h
      | ok tail =>
        simp only [ht, Except.ok.injEq] at h
        subst h
        obtain ⟨hmap, hall, hsum⟩ :=
          allocateGroupAux_sum hce_wf hca_wf (fun o ho' => hw o (by simp [ho'])) ht
        refine ⟨by simp [hmap], List.Forall₂.cons spec hall, Or.inr ?_⟩
        rcases hsum with rfl | ⟨total, q, htw, htr, htq, hts⟩
        · cases tail with
          | cons _ _ => cases hall
          | nil =>
            refine ⟨ce, qCum, hce_wf, by simp [hce_rat], hq, ?_⟩
            simp [hamt, hpcc]
        · refine ⟨total, q, htw, ?_, htq, ?_⟩
          · rw [htr, hce_rat]; simp; ring
          · simp only [List.map_cons, List.sum_cons, hts, hamt, hpcc]
            ring

/-- Document-level rounding of one group from zero (lines 1870 to 1910): the amounts allocated to
its occurrences add up exactly to the group's total exact tax rounded once. -/
theorem allocateGroup_rounded_total {rule : QuantizationRule} {occs : List OccurrenceRef}
    {pairs : List ((Nat × Nat) × AllocatedComponent)} (hne : occs ≠ [])
    (hw : ∀ occ ∈ occs, occ.exactTax.WF ∧ occ.component.recoverableShare.WF ∧
      occ.policy.quantizationPolicy.rule = rule)
    (h : allocateGroupAux ExactRational.zero 0 ExactRational.zero 0 occs = .ok pairs) :
    ∃ total q, total.WF ∧ total.toRat = (occs.map (·.exactTax.toRat)).sum ∧
      quantize total rule = .ok q ∧
      (pairs.map (·.2.quantizedAmount.toRat)).sum = q.amount.toRat := by
  obtain ⟨-, -, hsum⟩ := allocateGroupAux_sum ExactRational.zero_wf ExactRational.zero_wf hw h
  rcases hsum with h0 | ⟨total, q, htw, htr, htq, hts⟩
  · exact absurd h0 hne
  · obtain ⟨-, -, hqs, -, -⟩ := quantize_ok htw htq
    refine ⟨total, q, htw, by rw [htr, ExactRational.zero_toRat, zero_add], htq, ?_⟩
    rw [hts]
    unfold ExactDecimal.toRat QuantizationRule.unit
    rw [hqs]
    push_cast
    ring

/-! ## The content hash -/

/-- The body that is hashed does not depend on the `contentHash` a determination carries. -/
theorem bodyValue_determination_contentHash (d : TaxDetermination) (h : ContentHash) :
    bodyValue { d with contentHash := h } = bodyValue d := rfl

/-- The determination's `contentHash` is `accountingHash("TaxDetermination", body)` of its own body:
every field but `contentHash` (identifier, book, tax point, source transaction, direction, line
results and derivation). -/
theorem determinationOf_contentHash (request : TaxRequest) (bookId : BookId)
    (lineResults : List TaxLineResult) :
    (determinationOf request bookId lineResults).contentHash =
      accountingBodyHash "TaxDetermination" (determinationOf request bookId lineResults) := rfl

/-- The effect a determination produces passes the kernel's own hash check
(`validateAccountingEffectHash`, `accounting.ts` line 2200). -/
theorem determinationOf_hash_valid (request : TaxRequest) (bookId : BookId)
    (lineResults : List TaxLineResult) :
    validateAccountingEffectHash
      (.taxDetermination (determinationOf request bookId lineResults)) = .ok true := by
  have hb : bodyValue (determinationOf request bookId lineResults) =
      bodyValue (determinationBody request bookId lineResults) := rfl
  have hc : (determinationOf request bookId lineResults).contentHash =
      accountingHash "TaxDetermination" (bodyValue (determinationBody request bookId lineResults)) :=
    rfl
  simp only [validateAccountingEffectHash, AccountingEffect.typeName, AccountingEffect.bodyValue,
    AccountingEffect.contentHash, hb, hc, beq_self_eq_true, Bool.and_self]
  rfl

/-! ## Balance -/

/-- The exact total of the entries. -/
def entriesSum (entries : List (AccountId × TaxEntry)) : ℚ :=
  (entries.map (·.2.amount.toRat)).sum

/-- Entries with one entry an account, constructible amounts, and orders at most `bound`. -/
structure EntriesOK (entries : List (AccountId × TaxEntry)) (bound : Nat) : Prop where
  nodup : (entries.map (·.1)).Nodup
  wf : ∀ e ∈ entries, e.2.amount.WF
  order_le : ∀ e ∈ entries, e.2.order ≤ bound

theorem EntriesOK.mono {entries : List (AccountId × TaxEntry)} {b b' : Nat}
    (h : EntriesOK entries b) (hb : b ≤ b') : EntriesOK entries b' :=
  ⟨h.nodup, h.wf, fun e he => le_trans (h.order_le e he) hb⟩

theorem entriesOK_nil (b : Nat) : EntriesOK [] b :=
  ⟨List.nodup_nil, (fun _ h => by cases h), (fun _ h => by cases h)⟩

/-- Replacing the value of a key that is present, among distinct keys, changes a sum over the
entries by the new value less the old. -/
theorem map_set_sum {κ ν : Type} [BEq κ] [LawfulBEq κ] (g : κ × ν → ℚ) (k : κ) (old new : ν) :
    ∀ entries : List (κ × ν), (entries.map Prod.fst).Nodup → assocGet entries k = some old →
      ((entries.map fun e => if e.1 == k then (k, new) else e).map g).sum =
        (entries.map g).sum - g (k, old) + g (k, new)
  | [], _, h => by simp [assocGet] at h
  | (k', v) :: rest, hnd, h => by
    simp only [List.map_cons, List.nodup_cons, List.mem_map] at hnd
    by_cases hk : k' = k
    · subst hk
      have hv : v = old := by simpa [assocGet] using h
      subst hv
      have hrest : (rest.map fun e => if e.1 == k' then (k', new) else e) = rest := by
        conv_rhs => rw [← List.map_id rest]
        apply List.map_congr_left
        intro e he
        have : e.1 ≠ k' := fun heq => hnd.1 ⟨e, he, heq⟩
        simp [this]
      simp only [List.map_cons, beq_self_eq_true, ↓reduceIte, List.sum_cons, hrest]
      ring
    · have h' : assocGet rest k = some old := by
        simpa [assocGet, List.find?_cons, beq_false_of_ne hk] using h
      simp only [List.map_cons, beq_false_of_ne hk, Bool.false_eq_true, ↓reduceIte, List.sum_cons,
        map_set_sum g k old new rest hnd.2 h']
      ring

/-- A key with a value is among the keys tested by `assocSet`. -/
theorem assocGet_some_any {κ ν : Type} [BEq κ] [LawfulBEq κ] {entries : List (κ × ν)} {k : κ}
    {v : ν} (h : assocGet entries k = some v) : entries.any (fun e => e.1 == k) = true := by
  have hm := assocGet_mem h
  exact List.any_eq_true.mpr ⟨(k, v), hm, by simp⟩

/-- Every entry after `assocSet` was there before or is the new one. -/
theorem mem_assocSet {κ ν : Type} [BEq κ] [LawfulBEq κ] {entries : List (κ × ν)} {k : κ}
    {v : ν} {e : κ × ν} (h : e ∈ assocSet entries k v) : e ∈ entries ∨ e = (k, v) := by
  unfold assocSet at h
  split_ifs at h
  · obtain ⟨e', he', rfl⟩ := List.mem_map.mp h
    split_ifs
    · exact Or.inr rfl
    · exact Or.inl he'
  · rcases List.mem_append.mp h with h | h
    · exact Or.inl h
    · exact Or.inr (List.mem_singleton.mp h)

/-- An account with no entry is not among the keys. -/
theorem assocGet_none_not_mem {entries : List (AccountId × TaxEntry)} {k : AccountId}
    (h : assocGet entries k = none) : k ∉ entries.map (·.1) := by
  intro hm
  obtain ⟨e, he, rfl⟩ := List.mem_map.mp hm
  have hf : entries.find? (fun x => x.1 == e.1) = none := by
    simpa [assocGet] using h
  exact absurd (List.find?_eq_none.mp hf e he) (by simp)

/-- `assocGet` of another key is unchanged by appending an entry. -/
theorem assocGet_append_ne {entries : List (AccountId × TaxEntry)} {k k' : AccountId} {v : TaxEntry}
    (hne : k ≠ k') : assocGet (entries ++ [(k', v)]) k = assocGet entries k := by
  simp only [assocGet, List.find?_append]
  cases hf : entries.find? (fun e => e.1 == k) with
  | some x => simp
  | none =>
    have : (k' == k) = false := beq_false_of_ne (Ne.symm hne)
    simp [this]

/-- A posting whose order is not smaller than the order of its account's entry adds its amount to
that entry, or starts one: the total of the entries grows by exactly its amount, and no other
account's entry changes. -/
theorem addPosting_ok {id : PostingId} {accountId : AccountId} {amount : ExactRational}
    {order bound : Nat} {entries entries' : List (AccountId × TaxEntry)}
    (hok : EntriesOK entries bound) (hamt : amount.WF)
    (hacc : ∀ prior, assocGet entries accountId = some prior → prior.order ≤ order)
    (h : addPosting id accountId amount order entries = .ok entries') :
    EntriesOK entries' (max bound order) ∧ entriesSum entries' = entriesSum entries + amount.toRat ∧
      ∀ k, k ≠ accountId → assocGet entries' k = assocGet entries k := by
  unfold addPosting at h
  cases hg : assocGet entries accountId with
  | none =>
    simp only [hg, Except.ok.injEq] at h
    subst h
    have hnot := assocGet_none_not_mem hg
    refine ⟨⟨?_, fun e he => ?_, fun e he => ?_⟩, by simp [entriesSum],
      fun k hk => assocGet_append_ne hk⟩
    · rw [List.map_append, List.nodup_append]
      exact ⟨hok.nodup, List.nodup_singleton _, fun a ha b hb heq => by
        simp only [List.map_cons, List.map_nil, List.mem_singleton] at hb
        subst hb heq; exact hnot ha⟩
    · rcases List.mem_append.mp he with he | he
      · exact hok.wf e he
      · rw [List.mem_singleton] at he; subst he; exact hamt
    · rcases List.mem_append.mp he with he | he
      · exact le_trans (hok.order_le e he) (le_max_left _ _)
      · rw [List.mem_singleton] at he; subst he; exact le_max_right _ _
  | some prior =>
    have hmem := assocGet_mem hg
    have hpo : prior.order ≤ order := hacc prior hg
    have hnlt : ¬ order < prior.order := by omega
    simp only [hg, hnlt, ↓reduceIte] at h
    cases hadd : prior.amount.add amount with
    | error e => simp [hadd, liftNum] at h
    | ok next =>
      simp only [hadd, liftNum, Except.ok.injEq] at h
      subst h
      obtain ⟨hnw, hnr⟩ := ExactRational.add_ok (hok.wf _ hmem) hamt hadd
      refine ⟨⟨assocSet_keys_nodup _ _ _ hok.nodup, fun e he => ?_, fun e he => ?_⟩, ?_,
        fun k hk => assocGet_assocSet_ne _ _ _ _ (Ne.symm hk)⟩
      · rcases mem_assocSet he with he | rfl
        · exact hok.wf e he
        · exact hnw
      · rcases mem_assocSet he with he | rfl
        · exact le_trans (hok.order_le e he) (le_max_left _ _)
        · show prior.order ≤ max bound order; omega
      · unfold entriesSum assocSet
        rw [ite_eq_left_iff.mpr (fun hn => absurd (assocGet_some_any hg) hn),
          map_set_sum (fun e => e.2.amount.toRat) accountId prior { prior with amount := next }
            entries hok.nodup hg]
        simp only [hnr]
        ring

/-- A posting whose order is not smaller than any order already entered: `addPosting_ok`. -/
theorem addPosting_ok_of_le {id : PostingId} {accountId : AccountId} {amount : ExactRational}
    {order bound : Nat} {entries entries' : List (AccountId × TaxEntry)}
    (hok : EntriesOK entries bound) (hamt : amount.WF) (hle : bound ≤ order)
    (h : addPosting id accountId amount order entries = .ok entries') :
    EntriesOK entries' order ∧ entriesSum entries' = entriesSum entries + amount.toRat := by
  obtain ⟨hok', hs, -⟩ := addPosting_ok hok hamt
    (fun prior hp => le_trans (hok.order_le _ (assocGet_mem hp)) hle) h
  exact ⟨by rwa [max_eq_right hle] at hok', hs⟩

/-- What `addPosting` does when the account's entry has a larger order (line 1949): the entry is
replaced, and the total of the entries loses the amount the entry held. This is the defect behind
the refusal of line 2019 on requests that balance. -/
theorem addPosting_overwrite {id : PostingId} {accountId : AccountId} {amount : ExactRational}
    {order : Nat} {entries : List (AccountId × TaxEntry)} {prior : TaxEntry}
    (hnd : (entries.map (·.1)).Nodup) (hg : assocGet entries accountId = some prior)
    (hlt : order < prior.order) :
    ∃ entries', addPosting id accountId amount order entries = .ok entries' ∧
      entriesSum entries' = entriesSum entries - prior.amount.toRat + amount.toRat := by
  refine ⟨assocSet entries accountId { id, amount, order },
    by simp only [addPosting, hg, hlt, ↓reduceIte], ?_⟩
  unfold entriesSum assocSet
  rw [ite_eq_left_iff.mpr (fun hn => absurd (assocGet_some_any hg) hn),
    map_set_sum (fun e => e.2.amount.toRat) accountId prior _ entries hnd hg]

/-- `taxPosting` returns only when its identifier is made and the posting is added. -/
theorem taxPosting_ok {requestId : TaxDeterminationId} {lineOrdinal index : Nat} {kind : String}
    {accountId : AccountId} {amount : ExactRational} {order : Nat}
    {entries entries' : List (AccountId × TaxEntry)}
    (h : taxPosting requestId lineOrdinal index kind accountId amount order entries = .ok entries') :
    ∃ pid, addPosting pid accountId amount order entries = .ok entries' := by
  unfold taxPosting at h
  cases hi : identifier "Posting" (taxPostingText requestId lineOrdinal index kind) with
  | error e => simp [hi, liftCanonical] at h
  | ok pid => simp only [hi, liftCanonical] at h; exact ⟨pid, h⟩

/-- The signed amount of a part: negated for a credit. -/
def signedPart (isCreditFlag : Bool) (part : ExactRational) : ℚ :=
  if isCreditFlag then -part.toRat else part.toRat

/-- A part posting that returns adds the signed part to the total of the entries (nothing when the
part is zero), changes no entry but its account's, and keeps the orders bounded. -/
theorem partPosting_ok {requestId : TaxDeterminationId} {isCreditFlag : Bool}
    {lineOrdinal index : Nat} {kind : String} {diag : SemanticDiagnostic} {part : ExactRational}
    {accountId? : Option AccountId} {order bound : Nat}
    {entries entries' : List (AccountId × TaxEntry)}
    (hok : EntriesOK entries bound) (hpart : part.WF)
    (hacc : ∀ a, accountId? = some a → ∀ prior, assocGet entries a = some prior →
      prior.order ≤ order)
    (h : partPosting requestId isCreditFlag lineOrdinal index kind diag part accountId? order
      entries = .ok (.inr entries')) :
    EntriesOK entries' (max bound order) ∧
      entriesSum entries' = entriesSum entries + signedPart isCreditFlag part ∧
      ∀ k, (part.isZero = false → accountId? ≠ some k) → assocGet entries' k = assocGet entries k := by
  unfold partPosting at h
  by_cases hz : part.isZero = true
  · simp only [hz, Bool.not_true, Bool.false_eq_true, ↓reduceIte, Except.ok.injEq,
      Sum.inr.injEq] at h
    subst h
    have h0 : part.toRat = 0 := (ExactRational.isZero_iff hpart).mp hz
    exact ⟨hok.mono (le_max_left _ _), by simp [signedPart, h0], fun _ _ => rfl⟩
  · have hzf : part.isZero = false := by simpa using hz
    simp only [hzf, Bool.not_false, ↓reduceIte] at h
    cases ha : accountId? with
    | none => simp [ha] at h
    | some a =>
      simp only [ha] at h
      cases ht : taxPosting requestId lineOrdinal index kind a
          (if isCreditFlag then part.negate else part) order entries with
      | error e => simp [ht] at h
      | ok es =>
        simp only [ht, Except.ok.injEq, Sum.inr.injEq] at h
        subst h
        obtain ⟨pid, hp⟩ := taxPosting_ok ht
        have hamt : (if isCreditFlag then part.negate else part).WF := by
          split_ifs
          · exact ExactRational.negate_wf hpart
          · exact hpart
        obtain ⟨hok', hs, hother⟩ := addPosting_ok hok hamt (hacc a ha) hp
        refine ⟨hok', ?_, fun k hk => hother k (fun hka => hk hzf (by rw [hka]))⟩
        rw [hs]
        unfold signedPart
        split_ifs
        · rw [ExactRational.negate_toRat]
        · rfl

/-- What the balance needs of a rounded component: constructible amounts, and the recoverable and
non-recoverable parts adding up to the amount (`AllocationSpec.split`). -/
structure AllocBalanced (alloc : AllocatedComponent) : Prop where
  quantized : alloc.quantizedAmount.WF
  recoverable : alloc.recoverable.WF
  nonRecoverable : alloc.nonRecoverable.WF
  split : alloc.recoverable.toRat + alloc.nonRecoverable.toRat = alloc.quantizedAmount.toRat

theorem AllocationSpec.balanced {rule : QuantizationRule} {item : ComponentExactTax}
    {alloc : AllocatedComponent} (h : AllocationSpec rule item alloc) : AllocBalanced alloc :=
  ⟨h.quantizedAmount_wf, h.recoverable_wf, h.nonRecoverable_wf, h.split⟩

/-- A reverse-charge component that does not name its liability account as its non-recoverable
account. Without it, the liability posting (order `2i + 1`) replaces the non-recoverable posting
(order `2i + 2`) of the same component when that account had no entry before it. -/
def ReverseChargeSeparate (c : TaxPolicyComponent) : Prop :=
  c.treatment = .reverseCharge → c.nonRecoverableAccountId ≠ some c.liabilityAccountId

/-- The liability amount of lines 1990 and 1994. -/
theorem liability_wf {isCreditFlag : Bool} {q : ExactRational} (hq : q.WF) :
    (if isCreditFlag then q else q.negate).WF := by
  split_ifs
  · exact hq
  · exact ExactRational.negate_wf hq

theorem liability_toRat (isCreditFlag : Bool) (q : ExactRational) :
    (if isCreditFlag then q else q.negate).toRat = if isCreditFlag then q.toRat else -q.toRat := by
  split_ifs <;> simp [ExactRational.negate_toRat]

/-- One component's postings (lines 1975 to 1997) keep the entries and the running counterparty
amount together constant: what is posted to the tax accounts is taken from, or added to, the
counterparty amount. -/
theorem componentPostings_ok {requestId : TaxDeterminationId} {isCreditFlag : Bool}
    {lineId : String} {lineOrdinal orderBase index : Nat} {alloc : AllocatedComponent}
    {comp : TaxPolicyComponent} {entries entries' : List (AccountId × TaxEntry)}
    {cp cp' : ExactRational}
    (hok : EntriesOK entries (orderBase + 2 * index)) (hcp : cp.WF) (ha : AllocBalanced alloc)
    (hrc : ReverseChargeSeparate comp)
    (h : componentPostings requestId isCreditFlag lineId lineOrdinal orderBase index alloc comp
      entries cp = .ok (.inr (entries', cp'))) :
    EntriesOK entries' (orderBase + 2 * (index + 1)) ∧ cp'.WF ∧
      entriesSum entries' + cp'.toRat = entriesSum entries + cp.toRat := by
  unfold componentPostings at h
  by_cases ht : (comp.treatment == .inputTax || comp.treatment == .reverseCharge) = true
  · simp only [ht, ↓reduceIte] at h
    cases h1 : partPosting requestId isCreditFlag lineOrdinal index "recoverable"
        (recoverableDiagnostic lineId) alloc.recoverable comp.recoverableAccountId
        (orderBase + index * 2 + 1) entries with
    | error e => simp [h1] at h
    | ok r1 =>
      cases r1 with
      | inl d => simp [h1] at h
      | inr entries1 =>
        simp only [h1] at h
        obtain ⟨hok1, hs1, -⟩ := partPosting_ok hok ha.recoverable
          (fun _ _ prior hp => le_trans (hok.order_le _ (assocGet_mem hp)) (by omega)) h1
        have hok1' : EntriesOK entries1 (orderBase + index * 2 + 1) := hok1.mono (by omega)
        cases h2 : partPosting requestId isCreditFlag lineOrdinal index "nonrecoverable"
            (nonRecoverableDiagnostic lineId) alloc.nonRecoverable comp.nonRecoverableAccountId
            (orderBase + index * 2 + 2) entries1 with
        | error e => simp [h2] at h
        | ok r2 =>
          cases r2 with
          | inl d => simp [h2] at h
          | inr entries2 =>
            simp only [h2] at h
            obtain ⟨hok2, hs2, ho2⟩ := partPosting_ok hok1' ha.nonRecoverable
              (fun _ _ prior hp => le_trans (hok1'.order_le _ (assocGet_mem hp)) (by omega)) h2
            have hok2' : EntriesOK entries2 (orderBase + 2 * (index + 1)) := hok2.mono (by omega)
            by_cases hin : (comp.treatment == .inputTax) = true
            · simp only [hin, ↓reduceIte] at h
              cases h3 : liftNum (if isCreditFlag then cp.add alloc.quantizedAmount
                  else cp.subtract alloc.quantizedAmount) with
              | error e => simp [h3] at h
              | ok cp1 =>
                simp only [h3, Except.ok.injEq, Sum.inr.injEq, Prod.mk.injEq] at h
                obtain ⟨rfl, rfl⟩ := h
                refine ⟨hok2', ?_⟩
                rw [hs2, hs1]
                have hsp := ha.split
                cases isCreditFlag with
                | true =>
                  obtain ⟨hw, hr⟩ := ExactRational.add_ok hcp ha.quantized (liftNum_ok h3)
                  exact ⟨hw, by simp only [signedPart, ↓reduceIte, hr]; linarith⟩
                | false =>
                  obtain ⟨hw, hr⟩ := ExactRational.subtract_ok hcp ha.quantized (liftNum_ok h3)
                  exact ⟨hw, by
                    simp only [signedPart, Bool.false_eq_true, ↓reduceIte, hr]; linarith⟩
            · simp only [hin, Bool.false_eq_true, ↓reduceIte] at h
              have hrev : comp.treatment = .reverseCharge := by
                revert ht hin; cases comp.treatment <;> simp
              cases h3 : taxPosting requestId lineOrdinal index "liability" comp.liabilityAccountId
                  (if isCreditFlag then alloc.quantizedAmount else alloc.quantizedAmount.negate)
                  (orderBase + index * 2 + 1) entries2 with
              | error e => simp [h3] at h
              | ok entries3 =>
                simp only [h3, Except.ok.injEq, Sum.inr.injEq, Prod.mk.injEq] at h
                obtain ⟨rfl, rfl⟩ := h
                obtain ⟨pid, hp⟩ := taxPosting_ok h3
                have hacc : ∀ prior, assocGet entries2 comp.liabilityAccountId = some prior →
                    prior.order ≤ orderBase + index * 2 + 1 := by
                  intro prior hp'
                  rw [ho2 _ (fun _ => hrc hrev)] at hp'
                  exact hok1'.order_le _ (assocGet_mem hp')
                obtain ⟨hok3, hs3, -⟩ := addPosting_ok hok2 (liability_wf ha.quantized) hacc hp
                refine ⟨hok3.mono (by omega), hcp, ?_⟩
                rw [hs3, hs2, hs1, liability_toRat]
                have hsp := ha.split
                cases isCreditFlag <;> simp only [signedPart, Bool.false_eq_true, ↓reduceIte] <;>
                  linarith
  · simp only [ht, Bool.false_eq_true, ↓reduceIte] at h
    cases h1 : taxPosting requestId lineOrdinal index "liability" comp.liabilityAccountId
        (if isCreditFlag then alloc.quantizedAmount else alloc.quantizedAmount.negate)
        (orderBase + index * 2 + 1) entries with
    | error e => simp [h1] at h
    | ok entries1 =>
      simp only [h1] at h
      obtain ⟨pid, hp⟩ := taxPosting_ok h1
      obtain ⟨hok1, hs1⟩ := addPosting_ok_of_le hok (liability_wf ha.quantized) (by omega) hp
      cases h2 : liftNum (if isCreditFlag then cp.subtract alloc.quantizedAmount
          else cp.add alloc.quantizedAmount) with
      | error e => simp [h2] at h
      | ok cp1 =>
        simp only [h2, Except.ok.injEq, Sum.inr.injEq, Prod.mk.injEq] at h
        obtain ⟨rfl, rfl⟩ := h
        refine ⟨hok1.mono (by omega), ?_⟩
        rw [hs1, liability_toRat]
        cases isCreditFlag with
        | true =>
          obtain ⟨hw, hr⟩ := ExactRational.subtract_ok hcp ha.quantized (liftNum_ok h2)
          exact ⟨hw, by simp only [↓reduceIte, hr]; ring⟩
        | false =>
          obtain ⟨hw, hr⟩ := ExactRational.add_ok hcp ha.quantized (liftNum_ok h2)
          exact ⟨hw, by simp only [Bool.false_eq_true, ↓reduceIte, hr]; ring⟩

/-- A line's component postings (lines 1974 to 1998) keep the entries and the running counterparty
amount together constant. -/
theorem applyComponentPostings_ok {requestId : TaxDeterminationId} {isCreditFlag : Bool}
    {lineId : String} {lineOrdinal orderBase : Nat} :
    ∀ {index : Nat} {pairs : List (AllocatedComponent × TaxPolicyComponent)}
      {entries entries' : List (AccountId × TaxEntry)} {cp cp' : ExactRational},
      EntriesOK entries (orderBase + 2 * index) → cp.WF →
      (∀ p ∈ pairs, AllocBalanced p.1 ∧ ReverseChargeSeparate p.2) →
      applyComponentPostings requestId isCreditFlag lineId lineOrdinal orderBase index pairs
        entries cp = .ok (.inr (entries', cp')) →
      EntriesOK entries' (orderBase + 2 * (index + pairs.length)) ∧ cp'.WF ∧
        entriesSum entries' + cp'.toRat = entriesSum entries + cp.toRat
  | index, [], entries, entries', cp, cp', hok, hcp, _, h => by
    simp only [applyComponentPostings, Except.ok.injEq, Sum.inr.injEq, Prod.mk.injEq] at h
    obtain ⟨rfl, rfl⟩ := h
    exact ⟨by simpa using hok, hcp, rfl⟩
  | index, (alloc, comp) :: rest, entries, entries', cp, cp', hok, hcp, hw, h => by
    unfold applyComponentPostings at h
    cases hc : componentPostings requestId isCreditFlag lineId lineOrdinal orderBase index alloc
        comp entries cp with
    | error e => simp [hc] at h
    | ok r =>
      cases r with
      | inl d => simp [hc] at h
      | inr ec =>
        obtain ⟨entries1, cp1⟩ := ec
        simp only [hc] at h
        obtain ⟨ha, hrc⟩ := hw (alloc, comp) (by simp)
        obtain ⟨hok1, hcp1, hs1⟩ := componentPostings_ok hok hcp ha hrc hc
        obtain ⟨hok2, hcp2, hs2⟩ :=
          applyComponentPostings_ok hok1 hcp1 (fun p hp => hw p (by simp [hp])) h
        refine ⟨by simpa [Nat.add_assoc, Nat.add_comm 1] using hok2, hcp2, by rw [hs2, hs1]⟩

/-- `sourceSign` is constructible. -/
theorem sourceSign_wf (direction : TaxDirection) : (sourceSign direction).WF := by
  unfold sourceSign
  split_ifs
  · exact one_wf
  · exact ⟨Int.one_pos, by decide, by rw [withinMagnitude_neg]; exact withinMagnitude_one,
      withinMagnitude_one⟩

/-- What the balance needs of a line and its rounded components: constructible stated and
exclusive amounts, and every component balanced and with `ReverseChargeSeparate`. -/
structure LineBalanced (pre : PreResolvedTaxLine) (allocs : List AllocatedComponent) : Prop where
  stated : pre.line.statedAmount.WF
  exclusive : pre.unroundedExclusive.WF
  comps : ∀ p ∈ allocs.zip pre.components, AllocBalanced p.1 ∧ ReverseChargeSeparate p.2

/-- The terms of `grossAllocatedTax` are constructible. -/
theorem grossAllocatedTerms_wf {allocs : List AllocatedComponent}
    {components : List TaxPolicyComponent}
    (h : ∀ p ∈ allocs.zip components, AllocBalanced p.1) :
    ∀ v ∈ grossAllocatedTerms allocs components, v.WF := by
  intro v hv
  simp only [grossAllocatedTerms, List.mem_filterMap] at hv
  obtain ⟨⟨c, comp⟩, hm, hv⟩ := hv
  split_ifs at hv
  cases hv
  exact (h _ hm).quantized

/-- The postings of all lines (lines 1954 to 2016) leave the total of the entries unchanged — so,
from no entries, the journal balances — when every line has at least as many components as the
line before it (each line's orders then start after the previous line's last order), every line
and component is as `LineBalanced` says, and the entries' orders are below the next line's first
order. -/
theorem buildPostings_balance {requestId : TaxDeterminationId} {isCreditFlag : Bool}
    {sign : ExactRational} (hsign : sign.WF) :
    ∀ {L : Nat} {lines : List (PreResolvedTaxLine × List AllocatedComponent)}
      {entries entries' : List (AccountId × TaxEntry)} {results : List TaxLineResult},
      (entries.map (·.1)).Nodup → (∀ e ∈ entries, e.2.amount.WF) →
      (∀ x, lines.head? = some x → ∀ e ∈ entries,
        e.2.order ≤ L * (x.1.components.length * 2 + 4)) →
      (lines.map (·.1.components.length)).IsChain (· ≤ ·) →
      (∀ x ∈ lines, LineBalanced x.1 x.2) →
      buildPostingsAndLineResults requestId isCreditFlag sign L lines entries =
        .ok (.inr (entries', results)) →
      (entries'.map (·.1)).Nodup ∧ (∀ e ∈ entries', e.2.amount.WF) ∧
        entriesSum entries' = entriesSum entries
  | L, [], entries, entries', results, hnd, hwf, _, _, _, h => by
    simp only [buildPostingsAndLineResults, Except.ok.injEq, Sum.inr.injEq, Prod.mk.injEq] at h
    obtain ⟨rfl, rfl⟩ := h
    exact ⟨hnd, hwf, rfl⟩
  | L, (pre, allocs) :: rest, entries, entries', results, hnd, hwf, hb, hchain, hlb, h => by
    have hok : EntriesOK entries (L * (pre.components.length * 2 + 4)) :=
      ⟨hnd, hwf, hb (pre, allocs) rfl⟩
    obtain ⟨hst, hex, hcomps⟩ := hlb (pre, allocs) (by simp)
    unfold buildPostingsAndLineResults at h
    cases hg : liftNum (accountingSum (grossAllocatedTerms allocs pre.components)) with
    | error e => simp [hg] at h
    | ok gross =>
      simp only [hg] at h
      obtain ⟨hgw, -⟩ := accountingSum_ok
        (grossAllocatedTerms_wf (fun p hp => (hcomps p hp).1)) (liftNum_ok hg)
      cases hle : lineExclusiveOf pre gross with
      | error e => simp [hle] at h
      | ok lineExclusive =>
        simp only [hle] at h
        have hlw : lineExclusive.WF := by
          unfold lineExclusiveOf at hle
          split_ifs at hle
          · exact (ExactRational.subtract_ok hst hgw (liftNum_ok hle)).1
          · cases hle; exact hex
        cases hm : liftNum (lineExclusive.multiply sign) with
        | error e => simp [hm] at h
        | ok src =>
          simp only [hm] at h
          obtain ⟨hsw, -⟩ := ExactRational.multiply_ok hlw hsign (liftNum_ok hm)
          cases h1 : addPosting pre.line.sourcePostingId pre.line.sourceAccountId src
              (L * (pre.components.length * 2 + 4)) entries with
          | error e => simp [h1] at h
          | ok entries1 =>
            simp only [h1] at h
            obtain ⟨hok1, hs1⟩ := addPosting_ok_of_le hok hsw le_rfl h1
            have hnext : (rest.map (·.1.components.length)).IsChain (· ≤ ·) ∧
                ∀ x, rest.head? = some x → pre.components.length ≤ x.1.components.length := by
              cases rest with
              | nil => exact ⟨by simp, fun x hx => by simp at hx⟩
              | cons y rest' =>
                simp only [List.map_cons, List.isChain_cons_cons] at hchain
                refine ⟨by simpa using hchain.2, fun x hx => ?_⟩
                simp only [List.head?_cons, Option.some.injEq] at hx
                subst hx
                exact hchain.1
            cases h2 : applyComponentPostings requestId isCreditFlag pre.line.lineId L
                (L * (pre.components.length * 2 + 4)) 0 (allocs.zip pre.components) entries1
                src.negate with
            | error e => simp [h2] at h
            | ok r2 =>
              cases r2 with
              | inl d => simp [h2] at h
              | inr ec =>
                obtain ⟨entries2, cp2⟩ := ec
                simp only [h2] at h
                obtain ⟨hok2, hcp2, hs2⟩ := applyComponentPostings_ok (by simpa using hok1)
                  (ExactRational.negate_wf hsw) hcomps h2
                dsimp only at hok2
                have hlen : (allocs.zip pre.components).length ≤ pre.components.length := by simp
                cases h3 : addPosting pre.line.counterpartyPostingId pre.line.payableAccountId cp2
                    (L * (pre.components.length * 2 + 4) + pre.components.length * 2 + 2)
                    entries2 with
                | error e => simp [h3] at h
                | ok entries3 =>
                  simp only [h3] at h
                  obtain ⟨hok3, hs3⟩ := addPosting_ok_of_le hok2 hcp2 (by omega) h3
                  cases h4 : buildPostingsAndLineResults requestId isCreditFlag sign (L + 1) rest
                      entries3 with
                  | error e => simp [h4] at h
                  | ok r4 =>
                    cases r4 with
                    | inl d => simp [h4] at h
                    | inr er =>
                      obtain ⟨entriesF, tail⟩ := er
                      simp only [h4, Except.ok.injEq, Sum.inr.injEq, Prod.mk.injEq] at h
                      obtain ⟨rfl, rfl⟩ := h
                      have hb' : ∀ x, rest.head? = some x → ∀ e ∈ entries3,
                          e.2.order ≤ (L + 1) * (x.1.components.length * 2 + 4) := by
                        intro x hx e he
                        have hn := hnext.2 x hx
                        have ho := hok3.order_le e he
                        have m1 : (L + 1) * (pre.components.length * 2 + 4) ≤
                            (L + 1) * (x.1.components.length * 2 + 4) :=
                          Nat.mul_le_mul_left _ (by omega)
                        have m2 : (L + 1) * (pre.components.length * 2 + 4) =
                            L * (pre.components.length * 2 + 4) +
                              (pre.components.length * 2 + 4) := by ring
                        omega
                      obtain ⟨hndF, hwfF, hsF⟩ := buildPostings_balance hsign hok3.nodup hok3.wf hb'
                        hnext.1 (fun x hx => hlb x (by simp [hx])) h4
                      refine ⟨hndF, hwfF, ?_⟩
                      rw [hsF, hs3]
                      rw [ExactRational.negate_toRat] at hs2
                      linarith

/-! ## The two rounding stages, line by line -/

/-- Line-level rounding (lines 1912 to 1944): one list of allocations a line, one allocation a
component, each with `AllocationSpec` under its line's policy and the exact tax rounded once. -/
theorem allocateLineLevel_ok :
    ∀ {preLines : List PreResolvedTaxLine} {allocated : List (List AllocatedComponent)},
      (∀ pre ∈ preLines, ∀ item ∈ pre.componentExactTaxes,
        item.exactTax.WF ∧ item.component.recoverableShare.WF) →
      allocateLineLevel preLines = .ok allocated →
      List.Forall₂ (fun pre allocs => List.Forall₂ (fun item alloc =>
        AllocationSpec pre.policy.quantizationPolicy.rule item alloc ∧
          ∃ q, quantize item.exactTax pre.policy.quantizationPolicy.rule = .ok q ∧
            alloc.quantization.amount = q.amount) pre.componentExactTaxes allocs)
        preLines allocated
  | [], allocated, _, h => by
    simp only [allocateLineLevel, Except.ok.injEq] at h
    subst h; exact List.Forall₂.nil
  | pre :: rest, allocated, hw, h => by
    unfold allocateLineLevel at h
    cases ha : allocateLineComponents pre.policy.quantizationPolicy pre.componentExactTaxes with
    | error e => simp [ha] at h
    | ok head =>
      simp only [ha] at h
      cases hr : allocateLineLevel rest with
      | error e => simp [hr] at h
      | ok tail =>
        simp only [hr, Except.ok.injEq] at h
        subst h
        exact List.Forall₂.cons
          (allocateLineComponents_ok _ (fun item hi => hw pre (by simp) item hi) ha)
          (allocateLineLevel_ok (fun p hp => hw p (by simp [hp])) hr)

/-- The occurrences of all groups, in order. -/
def groupOccurrences (groups : List (TaxGroupKey × List OccurrenceRef)) : List OccurrenceRef :=
  groups.flatMap (·.2)

/-- Inserting an occurrence adds it and keeps every other. -/
theorem mem_insertOccurrence {key : TaxGroupKey} {occ o : OccurrenceRef} :
    ∀ {groups : List (TaxGroupKey × List OccurrenceRef)},
      o ∈ groupOccurrences (insertOccurrence key occ groups) ↔
        o ∈ groupOccurrences groups ∨ o = occ
  | [] => by simp [insertOccurrence, groupOccurrences]
  | (k, occs) :: rest => by
    have ih := @mem_insertOccurrence key occ o rest
    unfold insertOccurrence
    split_ifs
    · simp only [groupOccurrences, List.flatMap_cons, List.mem_append, List.mem_singleton] at ih ⊢
      tauto
    · simp only [groupOccurrences, List.flatMap_cons, List.mem_append] at ih ⊢
      rw [ih]; tauto

/-- The occurrences of one line, from component `compIdx`: each item at position `j` becomes the
occurrence at component `compIdx + j`, with the line's policy, and every occurrence that was there
stays. -/
theorem mem_buildLineGroups {lineIdx : Nat} {policy : TaxPolicy} {o : OccurrenceRef} :
    ∀ {compIdx : Nat} {items : List ComponentExactTax}
      {groups : List (TaxGroupKey × List OccurrenceRef)},
      o ∈ groupOccurrences (buildLineGroups lineIdx policy compIdx items groups) ↔
        o ∈ groupOccurrences groups ∨
          ∃ j, ∃ item, items[j]? = some item ∧ o = OccurrenceRef.mk lineIdx (compIdx + j) policy item.component
            item.exactTax
  | compIdx, [], groups => by simp [buildLineGroups]
  | compIdx, item :: rest, groups => by
    simp only [buildLineGroups]
    rw [mem_buildLineGroups, mem_insertOccurrence]
    constructor
    · rintro ((h | h) | ⟨j, it, hj, rfl⟩)
      · exact Or.inl h
      · exact Or.inr ⟨0, item, rfl, by simpa using h⟩
      · exact Or.inr ⟨j + 1, it, by simpa using hj, by simp [Nat.add_assoc, Nat.add_comm 1]⟩
    · rintro (h | ⟨j, it, hj, rfl⟩)
      · exact Or.inl (Or.inl h)
      · cases j with
        | zero =>
          simp only [List.getElem?_cons_zero, Option.some.injEq] at hj
          subst hj
          exact Or.inl (Or.inr (by simp))
        | succ j =>
          refine Or.inr ⟨j, it, by simpa using hj, by simp [Nat.add_assoc, Nat.add_comm 1]⟩

/-- The occurrences of all lines from line `lineIdx`: the occurrence of each item `j` of each line
`L` is there, with that line's policy, and every occurrence that was there stays. -/
theorem mem_buildGroupsAux {o : OccurrenceRef} :
    ∀ {lineIdx : Nat} {preLines : List PreResolvedTaxLine}
      {groups : List (TaxGroupKey × List OccurrenceRef)},
      o ∈ groupOccurrences (buildGroupsAux lineIdx preLines groups) ↔
        o ∈ groupOccurrences groups ∨
          ∃ L pre j item, preLines[L]? = some pre ∧ pre.componentExactTaxes[j]? = some item ∧
            o = OccurrenceRef.mk (lineIdx + L) j pre.policy item.component item.exactTax
  | lineIdx, [], groups => by simp [buildGroupsAux]
  | lineIdx, pre :: rest, groups => by
    simp only [buildGroupsAux]
    rw [mem_buildGroupsAux, mem_buildLineGroups]
    constructor
    · rintro ((h | ⟨j, it, hj, rfl⟩) | ⟨L, p, j, it, hL, hj, rfl⟩)
      · exact Or.inl h
      · exact Or.inr ⟨0, pre, j, it, rfl, hj, by simp⟩
      · exact Or.inr ⟨L + 1, p, j, it, by simpa using hL, hj, by
          simp [Nat.add_assoc, Nat.add_comm 1]⟩
    · rintro (h | ⟨L, p, j, it, hL, hj, rfl⟩)
      · exact Or.inl (Or.inl h)
      · cases L with
        | zero =>
          simp only [List.getElem?_cons_zero, Option.some.injEq] at hL
          subst hL
          exact Or.inl (Or.inr ⟨j, it, hj, by simp⟩)
        | succ L =>
          exact Or.inr ⟨L, p, j, it, by simpa using hL, hj, by
            simp [Nat.add_assoc, Nat.add_comm 1]⟩

/-- A relation between two lists relates each member of the second to a member of the first. -/
theorem forall₂_mem_right {α β : Type} {R : α → β → Prop} :
    ∀ {l₁ : List α} {l₂ : List β}, List.Forall₂ R l₁ l₂ → ∀ b ∈ l₂, ∃ a ∈ l₁, R a b
  | _, _, List.Forall₂.nil => fun _ h => by cases h
  | _, _, List.Forall₂.cons hab hrest => fun b hb => by
    rcases List.mem_cons.mp hb with rfl | hb
    · exact ⟨_, by simp, hab⟩
    · obtain ⟨a, ha, hr⟩ := forall₂_mem_right hrest b hb
      exact ⟨a, by simp [ha], hr⟩

/-- A relation between two lists together with equal images of them. -/
theorem forall₂_and_map {α β γ : Type} {R : α → β → Prop} {f : β → γ} {g : α → γ} :
    ∀ {l₁ : List α} {l₂ : List β}, List.Forall₂ R l₁ l₂ → l₂.map f = l₁.map g →
      List.Forall₂ (fun a b => R a b ∧ f b = g a) l₁ l₂
  | _, _, List.Forall₂.nil, _ => List.Forall₂.nil
  | _, _, List.Forall₂.cons hab hrest, h => by
    simp only [List.map_cons, List.cons.injEq] at h
    exact List.Forall₂.cons ⟨hab, h.1⟩ (forall₂_and_map hrest h.2)

theorem mem_groupOccurrences_cons {o : OccurrenceRef} {k : TaxGroupKey}
    {occs : List OccurrenceRef} {rest : List (TaxGroupKey × List OccurrenceRef)} :
    o ∈ groupOccurrences ((k, occs) :: rest) ↔ o ∈ occs ∨ o ∈ groupOccurrences rest := by
  simp [groupOccurrences]

/-- Document-level rounding of all groups (lines 1869 to 1911): the allocations carry the line and
component of the occurrences of the groups, in order, and each has `AllocationSpec` for its
occurrence, when every occurrence is rounded by the same rule. -/
theorem allocateGroups_ok {rule : QuantizationRule} :
    ∀ {groups : List (TaxGroupKey × List OccurrenceRef)}
      {pairs : List ((Nat × Nat) × AllocatedComponent)},
      (∀ occ ∈ groupOccurrences groups, occ.exactTax.WF ∧ occ.component.recoverableShare.WF ∧
        occ.policy.quantizationPolicy.rule = rule) →
      allocateGroups groups = .ok pairs →
      pairs.map (·.1) = (groupOccurrences groups).map (fun o => (o.lineIdx, o.compIdx)) ∧
      ∀ p ∈ pairs, ∃ o ∈ groupOccurrences groups, p.1 = (o.lineIdx, o.compIdx) ∧
        AllocationSpec rule ⟨o.component, o.exactTax⟩ p.2
  | [], pairs, _, h => by
    simp only [allocateGroups, Except.ok.injEq] at h
    subst h
    exact ⟨rfl, fun _ h => by cases h⟩
  | (key, occs) :: rest, pairs, hw, h => by
    unfold allocateGroups at h
    cases ha : allocateGroupAux ExactRational.zero 0 ExactRational.zero 0 occs with
    | error e => simp [ha] at h
    | ok head =>
      simp only [ha] at h
      cases hr : allocateGroups rest with
      | error e => simp [hr] at h
      | ok tail =>
        simp only [hr, Except.ok.injEq] at h
        subst h
        have hw1 : ∀ occ ∈ occs, occ.exactTax.WF ∧ occ.component.recoverableShare.WF ∧
            occ.policy.quantizationPolicy.rule = rule :=
          fun o ho => hw o (mem_groupOccurrences_cons.mpr (Or.inl ho))
        obtain ⟨hmap, hall, -⟩ := allocateGroupAux_sum ExactRational.zero_wf
          ExactRational.zero_wf hw1 ha
        obtain ⟨hmap', hall'⟩ := allocateGroups_ok
          (fun o ho => hw o (mem_groupOccurrences_cons.mpr (Or.inr ho))) hr
        refine ⟨by simp only [List.map_append, hmap, hmap', groupOccurrences,
          List.flatMap_cons], fun p hp => ?_⟩
        rcases List.mem_append.mp hp with hp | hp
        · obtain ⟨o, ho, hspec, htag⟩ := forall₂_mem_right (forall₂_and_map hall hmap) p hp
          exact ⟨o, mem_groupOccurrences_cons.mpr (Or.inl ho), htag, hspec⟩
        · obtain ⟨o, ho, htag, hspec⟩ := hall' p hp
          exact ⟨o, mem_groupOccurrences_cons.mpr (Or.inr ho), htag, hspec⟩

/-- When an allocation with a tag is present, the lookup of line 1902's target finds one. -/
theorem find?_tag {pairs : List ((Nat × Nat) × AllocatedComponent)} {t : Nat × Nat}
    (h : ∃ p ∈ pairs, p.1 = t) :
    ∃ p ∈ pairs, pairs.find? (fun p => p.1 == t) = some p ∧ p.1 = t := by
  obtain ⟨p, hp, ht⟩ := h
  cases hf : pairs.find? (fun p => p.1 == t) with
  | none => exact absurd (List.find?_eq_none.mp hf p hp) (by simp [ht])
  | some q => exact ⟨q, List.mem_of_find?_eq_some hf, rfl, by simpa using List.find?_some hf⟩

/-- Reading back one line's allocations, from component `c`: when every component has an
allocation tagged with it and every such allocation is related to the component's item, the line
reads back one related allocation a component. -/
theorem collectLineAllocated_ok {R : ComponentExactTax → AllocatedComponent → Prop}
    {pairs : List ((Nat × Nat) × AllocatedComponent)} {L : Nat} :
    ∀ {c : Nat} {items : List ComponentExactTax},
      (∀ k item, items[k]? = some item → (∃ p ∈ pairs, p.1 = (L, c + k)) ∧
        ∀ p ∈ pairs, p.1 = (L, c + k) → R item p.2) →
      List.Forall₂ R items (collectLineAllocated pairs L c items)
  | c, [], _ => List.Forall₂.nil
  | c, item :: rest, h => by
    simp only [collectLineAllocated]
    obtain ⟨hex, hall⟩ := h 0 item rfl
    obtain ⟨p, hp, hf, ht⟩ := find?_tag hex
    refine List.Forall₂.cons ?_ (collectLineAllocated_ok fun k it hk => ?_)
    · simp only [Nat.add_zero] at hf ht hall
      rw [hf]
      exact hall p hp ht
    · have := h (k + 1) it (by simpa using hk)
      simpa [Nat.add_assoc, Nat.add_comm 1] using this

/-- Reading back every line's allocations, from line `L0`. -/
theorem collectAllAllocated_ok {R : PreResolvedTaxLine → ComponentExactTax → AllocatedComponent → Prop}
    {pairs : List ((Nat × Nat) × AllocatedComponent)} :
    ∀ {L0 : Nat} {preLines : List PreResolvedTaxLine},
      (∀ L pre k item, preLines[L]? = some pre → pre.componentExactTaxes[k]? = some item →
        (∃ p ∈ pairs, p.1 = (L0 + L, k)) ∧ ∀ p ∈ pairs, p.1 = (L0 + L, k) → R pre item p.2) →
      List.Forall₂ (fun pre allocs => List.Forall₂ (R pre) pre.componentExactTaxes allocs)
        preLines (collectAllAllocated pairs L0 preLines)
  | L0, [], _ => List.Forall₂.nil
  | L0, pre :: rest, h => by
    simp only [collectAllAllocated]
    refine List.Forall₂.cons (collectLineAllocated_ok fun k item hk => ?_)
      (collectAllAllocated_ok fun L p k item hL hk => ?_)
    · simpa using h 0 pre k item rfl hk
    · have := h (L + 1) p k item (by simpa using hL) hk
      simpa [Nat.add_assoc, Nat.add_comm 1] using this


/-- Document-level rounding read back line by line (lines 1845 to 1911): when every line's policy
rounds by the same rule, each line gets one allocation a component, with `AllocationSpec` for that
component's exact tax. -/
theorem allocateDocumentLevel_ok {rule : QuantizationRule} {preLines : List PreResolvedTaxLine}
    {allocated : List (List AllocatedComponent)}
    (hw : ∀ pre ∈ preLines, pre.policy.quantizationPolicy.rule = rule ∧
      ∀ item ∈ pre.componentExactTaxes, item.exactTax.WF ∧ item.component.recoverableShare.WF)
    (h : allocateDocumentLevel preLines = .ok allocated) :
    List.Forall₂ (fun pre allocs => List.Forall₂ (AllocationSpec rule) pre.componentExactTaxes allocs)
      preLines allocated := by
  unfold allocateDocumentLevel at h
  cases hg : allocateGroups (buildGroups preLines) with
  | error e => simp [hg] at h
  | ok pairs =>
    simp only [hg, Except.ok.injEq] at h
    subst h
    have hocc : ∀ o ∈ groupOccurrences (buildGroups preLines), ∃ L pre j item,
        preLines[L]? = some pre ∧ pre.componentExactTaxes[j]? = some item ∧
          o = OccurrenceRef.mk L j pre.policy item.component item.exactTax := by
      intro o ho
      rcases (mem_buildGroupsAux (lineIdx := 0)).mp ho with ho | ⟨L, pre, j, item, hL, hj, rfl⟩
      · simp [groupOccurrences] at ho
      · exact ⟨L, pre, j, item, hL, hj, by simp⟩
    obtain ⟨hmap, hall⟩ := allocateGroups_ok (rule := rule) (fun o ho => by
      obtain ⟨L, pre, j, item, hL, hj, rfl⟩ := hocc o ho
      have hpre := hw pre (List.mem_of_getElem? hL)
      exact ⟨(hpre.2 item (List.mem_of_getElem? hj)).1,
        (hpre.2 item (List.mem_of_getElem? hj)).2, hpre.1⟩) hg
    refine collectAllAllocated_ok (L0 := 0) fun L pre k item hL hk => ⟨?_, fun p hp ht => ?_⟩
    · have ho : OccurrenceRef.mk L k pre.policy item.component item.exactTax ∈
          groupOccurrences (buildGroups preLines) :=
        (mem_buildGroupsAux (lineIdx := 0)).mpr (Or.inr ⟨L, pre, k, item, hL, hk, by simp⟩)
      have : (L, k) ∈ pairs.map (·.1) := by
        rw [hmap]; exact List.mem_map.mpr ⟨_, ho, rfl⟩
      obtain ⟨p, hp, hpt⟩ := List.mem_map.mp this
      exact ⟨p, hp, by simpa using hpt⟩
    · obtain ⟨o, ho, hot, hspec⟩ := hall p hp
      obtain ⟨L', pre', j, item', hL', hj, rfl⟩ := hocc o ho
      simp only [Nat.zero_add, ht, Prod.mk.injEq] at hot
      obtain ⟨rfl, rfl⟩ := hot
      rw [hL] at hL'
      cases hL'
      rw [hk] at hj
      cases hj
      exact hspec

/-- A relation between two lists implies another that holds of the members of the first. -/
theorem forall₂_imp_mem {α β : Type} {R S : α → β → Prop} :
    ∀ {l₁ : List α} {l₂ : List β}, List.Forall₂ R l₁ l₂ → (∀ a ∈ l₁, ∀ b, R a b → S a b) →
      List.Forall₂ S l₁ l₂
  | _, _, List.Forall₂.nil, _ => List.Forall₂.nil
  | _, _, List.Forall₂.cons hab hrest, h =>
    List.Forall₂.cons (h _ (by simp) _ hab) (forall₂_imp_mem hrest fun a ha => h a (by simp [ha]))

/-- Rounding (line 1845), at either level: when every line's policy rounds by the same rule, each
line gets one allocation a component, with `AllocationSpec` for that component's exact tax. -/
theorem allocate_ok {rule : QuantizationRule} {common : CommonRounding}
    {preLines : List PreResolvedTaxLine} {allocated : List (List AllocatedComponent)}
    (hw : ∀ pre ∈ preLines, pre.policy.quantizationPolicy.rule = rule ∧
      ∀ item ∈ pre.componentExactTaxes, item.exactTax.WF ∧ item.component.recoverableShare.WF)
    (h : allocate common preLines = .ok allocated) :
    List.Forall₂ (fun pre allocs => List.Forall₂ (AllocationSpec rule) pre.componentExactTaxes allocs)
      preLines allocated := by
  unfold allocate at h
  split_ifs at h
  · exact allocateDocumentLevel_ok hw h
  · refine forall₂_imp_mem (allocateLineLevel_ok (fun pre hp => (hw pre hp).2) h) ?_
    intro pre hp allocs hr
    rw [← (hw pre hp).1]
    exact List.Forall₂.imp (fun _ _ h => h.1) hr


/-! ## `determineTax` is the composition of its stages -/

/-- Every result of `determineTax` comes from its stages, in order: the request is refused, or its
lines are, or a line is refused by its checks, or a component has no destination for a part, or
the stages all pass and `finish` decides (the balance test, then the draft). -/
theorem determineTax_stages {policies : List AccountingPolicy} {bookId : BookId}
    {commodityId : CommodityId} {request : TaxRequest} {r : AccountingCalculation}
    (h : determineTax policies bookId commodityId request = .ok r) :
    (requestRejected request = true ∧ r = .rejected [requestDiagnostic]) ∨
    (requestRejected request = false ∧ invalidTaxLines request.lines = true ∧
      r = .rejected [linesDiagnostic]) ∨
    (requestRejected request = false ∧ invalidTaxLines request.lines = false ∧
      ∃ d, preResolveLines policies bookId request.governedAt (isSale request.direction) none
        request.lines = .ok (.inl d) ∧ r = .rejected [d]) ∨
    (requestRejected request = false ∧ invalidTaxLines request.lines = false ∧
      ∃ common preLines allocated,
        preResolveLines policies bookId request.governedAt (isSale request.direction) none
          request.lines = .ok (.inr (common, preLines)) ∧
        allocate common preLines = .ok allocated ∧
        ((∃ d, buildPostingsAndLineResults request.id (isCredit request.direction)
            (sourceSign request.direction) 0 (preLines.zip allocated) [] = .ok (.inl d) ∧
            r = .rejected [d]) ∨
         (∃ entries lineResults, buildPostingsAndLineResults request.id
            (isCredit request.direction) (sourceSign request.direction) 0 (preLines.zip allocated)
            [] = .ok (.inr (entries, lineResults)) ∧
            finish request bookId commodityId entries lineResults = .ok r))) := by
  unfold determineTax at h
  by_cases h1 : requestRejected request = true
  · simp only [h1, ↓reduceIte, Except.ok.injEq] at h
    exact Or.inl ⟨h1, h.symm⟩
  have h1f : requestRejected request = false := by simpa using h1
  simp only [h1f, Bool.false_eq_true, ↓reduceIte] at h
  by_cases h2 : invalidTaxLines request.lines = true
  · simp only [h2, ↓reduceIte, Except.ok.injEq] at h
    exact Or.inr (Or.inl ⟨h1f, h2, h.symm⟩)
  have h2f : invalidTaxLines request.lines = false := by simpa using h2
  simp only [h2f, Bool.false_eq_true, ↓reduceIte] at h
  cases hp : preResolveLines policies bookId request.governedAt (isSale request.direction) none
      request.lines with
  | error e => simp [hp] at h
  | ok r1 =>
    cases r1 with
    | inl d =>
      simp only [hp, Except.ok.injEq] at h
      exact Or.inr (Or.inr (Or.inl ⟨h1f, h2f, d, rfl, h.symm⟩))
    | inr cp =>
      obtain ⟨common, preLines⟩ := cp
      simp only [hp] at h
      cases ha : allocate common preLines with
      | error e => simp [ha] at h
      | ok allocated =>
        simp only [ha] at h
        cases hb : buildPostingsAndLineResults request.id (isCredit request.direction)
            (sourceSign request.direction) 0 (preLines.zip allocated) [] with
        | error e => simp [hb] at h
        | ok r2 =>
          cases r2 with
          | inl d =>
            simp only [hb, Except.ok.injEq] at h
            exact Or.inr (Or.inr (Or.inr ⟨h1f, h2f, common, preLines, allocated, rfl, ha,
              Or.inl ⟨d, hb, h.symm⟩⟩))
          | inr er =>
            obtain ⟨entries, lineResults⟩ := er
            simp only [hb] at h
            exact Or.inr (Or.inr (Or.inr ⟨h1f, h2f, common, preLines, allocated, rfl, ha,
              Or.inr ⟨entries, lineResults, hb, h⟩⟩))

/-! ## Where each diagnostic comes from -/

/-- The diagnostics of the checks of a line (lines 1784 to 1811). -/
def LineCheckDiagnostic (d : SemanticDiagnostic) : Prop :=
  ∃ lineId, d = policyDiagnostic lineId ∨ d = groupingDiagnostic lineId ∨
    d = roundingDiagnostic lineId ∨ d = quantizationDiagnostic lineId ∨
    d = componentsDiagnostic lineId

/-- The diagnostics of the postings of a component (lines 1978 and 1983). -/
def DestinationDiagnostic (d : SemanticDiagnostic) : Prop :=
  ∃ lineId, d = recoverableDiagnostic lineId ∨ d = nonRecoverableDiagnostic lineId

/-- The checks of a line refuse only with their own diagnostics. -/
theorem lineCheck_inl {policies : List AccountingPolicy} {bookId : BookId} {governedAt : Instant}
    {isSaleFlag : Bool} {common : CommonRounding} {line : TaxableLine} {d : SemanticDiagnostic}
    (h : lineCheck policies bookId governedAt isSaleFlag common line = .inl d) :
    LineCheckDiagnostic d := by
  unfold lineCheck at h
  split at h
  · cases h; exact ⟨_, Or.inl rfl⟩
  · split_ifs at h <;> cases h
    · exact ⟨_, Or.inr (Or.inl rfl)⟩
    · exact ⟨_, Or.inr (Or.inr (Or.inl rfl))⟩
    · exact ⟨_, Or.inr (Or.inr (Or.inr (Or.inl rfl)))⟩
    · exact ⟨_, Or.inr (Or.inr (Or.inr (Or.inr rfl)))⟩

/-- The line loop refuses only with what one of its lines' passes refused with. -/
theorem preResolveLines_inl {policies : List AccountingPolicy} {bookId : BookId}
    {governedAt : Instant} {isSaleFlag : Bool} {d : SemanticDiagnostic} :
    ∀ {common : CommonRounding} {lines : List TaxableLine},
      preResolveLines policies bookId governedAt isSaleFlag common lines = .ok (.inl d) →
      ∃ line ∈ lines, ∃ c, preResolveLine policies bookId governedAt isSaleFlag c line =
        .ok (.inl d)
  | common, [], h => by simp [preResolveLines] at h
  | common, line :: rest, h => by
    unfold preResolveLines at h
    cases hl : preResolveLine policies bookId governedAt isSaleFlag common line with
    | error e => simp [hl] at h
    | ok r =>
      cases r with
      | inl d' =>
        simp only [hl, Except.ok.injEq, Sum.inl.injEq] at h
        subst h
        exact ⟨line, by simp, common, hl⟩
      | inr pre =>
        simp only [hl] at h
        cases hr : preResolveLines policies bookId governedAt isSaleFlag
            (nextCommon common pre.policy) rest with
        | error e => simp [hr] at h
        | ok r' =>
          cases r' with
          | inl d' =>
            simp only [hr, Except.ok.injEq, Sum.inl.injEq] at h
            subst h
            obtain ⟨l, hl', c, hc⟩ := preResolveLines_inl hr
            exact ⟨l, by simp [hl'], c, hc⟩
          | inr _ => simp [hr] at h

/-- A part posting refuses only with its own diagnostic. -/
theorem partPosting_inl {requestId : TaxDeterminationId} {isCreditFlag : Bool}
    {lineOrdinal index : Nat} {kind : String} {diag : SemanticDiagnostic} {part : ExactRational}
    {accountId? : Option AccountId} {order : Nat} {entries : List (AccountId × TaxEntry)}
    {d : SemanticDiagnostic}
    (h : partPosting requestId isCreditFlag lineOrdinal index kind diag part accountId? order
      entries = .ok (.inl d)) : d = diag := by
  unfold partPosting at h
  by_cases hz : part.isZero = true
  · simp [hz] at h
  · simp only [show (!part.isZero) = true by simpa using hz, ↓reduceIte] at h
    cases ha : accountId? with
    | none => simp only [ha, Except.ok.injEq, Sum.inl.injEq] at h; exact h.symm
    | some a =>
      simp only [ha] at h
      cases ht : taxPosting requestId lineOrdinal index kind a
          (if isCreditFlag then part.negate else part) order entries with
      | error e => simp [ht] at h
      | ok es => simp [ht] at h

/-- A component's postings refuse only for a part with no destination. -/
theorem componentPostings_inl {requestId : TaxDeterminationId} {isCreditFlag : Bool}
    {lineId : String} {lineOrdinal orderBase index : Nat} {alloc : AllocatedComponent}
    {comp : TaxPolicyComponent} {entries : List (AccountId × TaxEntry)} {cp : ExactRational}
    {d : SemanticDiagnostic}
    (h : componentPostings requestId isCreditFlag lineId lineOrdinal orderBase index alloc comp
      entries cp = .ok (.inl d)) :
    d = recoverableDiagnostic lineId ∨ d = nonRecoverableDiagnostic lineId := by
  unfold componentPostings at h
  by_cases ht : (comp.treatment == .inputTax || comp.treatment == .reverseCharge) = true
  · simp only [ht, ↓reduceIte] at h
    cases h1 : partPosting requestId isCreditFlag lineOrdinal index "recoverable"
        (recoverableDiagnostic lineId) alloc.recoverable comp.recoverableAccountId
        (orderBase + index * 2 + 1) entries with
    | error e => simp [h1] at h
    | ok r1 =>
      cases r1 with
      | inl d1 =>
        simp only [h1, Except.ok.injEq, Sum.inl.injEq] at h
        subst h
        exact Or.inl (partPosting_inl h1)
      | inr e1 =>
        simp only [h1] at h
        cases h2 : partPosting requestId isCreditFlag lineOrdinal index "nonrecoverable"
            (nonRecoverableDiagnostic lineId) alloc.nonRecoverable comp.nonRecoverableAccountId
            (orderBase + index * 2 + 2) e1 with
        | error e => simp [h2] at h
        | ok r2 =>
          cases r2 with
          | inl d2 =>
            simp only [h2, Except.ok.injEq, Sum.inl.injEq] at h
            subst h
            exact Or.inr (partPosting_inl h2)
          | inr e2 =>
            simp only [h2] at h
            by_cases hin : (comp.treatment == .inputTax) = true
            · simp only [hin, ↓reduceIte] at h
              cases h3 : liftNum (if isCreditFlag then cp.add alloc.quantizedAmount
                  else cp.subtract alloc.quantizedAmount) with
              | error e => simp [h3] at h
              | ok c => simp [h3] at h
            · simp only [hin, Bool.false_eq_true, ↓reduceIte] at h
              cases h3 : taxPosting requestId lineOrdinal index "liability" comp.liabilityAccountId
                  (if isCreditFlag then alloc.quantizedAmount else alloc.quantizedAmount.negate)
                  (orderBase + index * 2 + 1) e2 with
              | error e => simp [h3] at h
              | ok e3 => simp [h3] at h
  · simp only [ht, Bool.false_eq_true, ↓reduceIte] at h
    cases h1 : taxPosting requestId lineOrdinal index "liability" comp.liabilityAccountId
        (if isCreditFlag then alloc.quantizedAmount else alloc.quantizedAmount.negate)
        (orderBase + index * 2 + 1) entries with
    | error e => simp [h1] at h
    | ok e1 =>
      simp only [h1] at h
      cases h2 : liftNum (if isCreditFlag then cp.subtract alloc.quantizedAmount
          else cp.add alloc.quantizedAmount) with
      | error e => simp [h2] at h
      | ok c => simp [h2] at h

/-- A line's component postings refuse only for a part with no destination. -/
theorem applyComponentPostings_inl {requestId : TaxDeterminationId} {isCreditFlag : Bool}
    {lineId : String} {lineOrdinal orderBase : Nat} {d : SemanticDiagnostic} :
    ∀ {index : Nat} {pairs : List (AllocatedComponent × TaxPolicyComponent)}
      {entries : List (AccountId × TaxEntry)} {cp : ExactRational},
      applyComponentPostings requestId isCreditFlag lineId lineOrdinal orderBase index pairs
        entries cp = .ok (.inl d) →
      d = recoverableDiagnostic lineId ∨ d = nonRecoverableDiagnostic lineId
  | index, [], entries, cp, h => by simp [applyComponentPostings] at h
  | index, (alloc, comp) :: rest, entries, cp, h => by
    unfold applyComponentPostings at h
    cases hc : componentPostings requestId isCreditFlag lineId lineOrdinal orderBase index alloc
        comp entries cp with
    | error e => simp [hc] at h
    | ok r =>
      cases r with
      | inl d' =>
        simp only [hc, Except.ok.injEq, Sum.inl.injEq] at h
        subst h
        exact componentPostings_inl hc
      | inr ec =>
        obtain ⟨e1, c1⟩ := ec
        simp only [hc] at h
        exact applyComponentPostings_inl h

/-- The postings of the lines refuse only for a part with no destination. -/
theorem buildPostings_inl {requestId : TaxDeterminationId} {isCreditFlag : Bool}
    {sign : ExactRational} {d : SemanticDiagnostic} :
    ∀ {L : Nat} {lines : List (PreResolvedTaxLine × List AllocatedComponent)}
      {entries : List (AccountId × TaxEntry)},
      buildPostingsAndLineResults requestId isCreditFlag sign L lines entries = .ok (.inl d) →
      DestinationDiagnostic d
  | L, [], entries, h => by simp [buildPostingsAndLineResults] at h
  | L, (pre, allocs) :: rest, entries, h => by
    unfold buildPostingsAndLineResults at h
    cases hg : liftNum (accountingSum (grossAllocatedTerms allocs pre.components)) with
    | error e => simp [hg] at h
    | ok gross =>
      simp only [hg] at h
      cases hle : lineExclusiveOf pre gross with
      | error e => simp [hle] at h
      | ok le =>
        simp only [hle] at h
        cases hm : liftNum (le.multiply sign) with
        | error e => simp [hm] at h
        | ok src =>
          simp only [hm] at h
          cases h1 : addPosting pre.line.sourcePostingId pre.line.sourceAccountId src
              (L * (pre.components.length * 2 + 4)) entries with
          | error e => simp [h1] at h
          | ok e1 =>
            simp only [h1] at h
            cases h2 : applyComponentPostings requestId isCreditFlag pre.line.lineId L
                (L * (pre.components.length * 2 + 4)) 0 (allocs.zip pre.components) e1
                src.negate with
            | error e => simp [h2] at h
            | ok r2 =>
              cases r2 with
              | inl d2 =>
                simp only [h2, Except.ok.injEq, Sum.inl.injEq] at h
                subst h
                exact ⟨_, applyComponentPostings_inl h2⟩
              | inr ec =>
                obtain ⟨e2, c2⟩ := ec
                simp only [h2] at h
                cases h3 : addPosting pre.line.counterpartyPostingId pre.line.payableAccountId c2
                    (L * (pre.components.length * 2 + 4) + pre.components.length * 2 + 2) e2 with
                | error e => simp [h3] at h
                | ok e3 =>
                  simp only [h3] at h
                  cases h4 : buildPostingsAndLineResults requestId isCreditFlag sign (L + 1) rest
                      e3 with
                  | error e => simp [h4] at h
                  | ok r4 =>
                    cases r4 with
                    | inl d4 =>
                      simp only [h4, Except.ok.injEq, Sum.inl.injEq] at h
                      subst h
                      exact buildPostings_inl h4
                    | inr _ => simp [h4] at h

/-! ## The journal balances -/

theorem postingsOf_values (commodityId : CommodityId) (entries : List (AccountId × TaxEntry)) :
    (postingsOf commodityId entries).map (·.exactBookValue) = entries.map (·.2.amount) := by
  simp [postingsOf]

/-- `finish` (lines 2018 to 2022) refuses only for a total that is not zero, and otherwise drafts
the journal of the entries and the determination of the line results. -/
theorem finish_ok {request : TaxRequest} {bookId : BookId} {commodityId : CommodityId}
    {entries : List (AccountId × TaxEntry)} {lineResults : List TaxLineResult}
    {r : AccountingCalculation}
    (h : finish request bookId commodityId entries lineResults = .ok r) :
    ∃ total, accountingSum ((postingsOf commodityId entries).map (·.exactBookValue)) = .ok total ∧
      ((total.isZero = false ∧ r = .rejected [balanceDiagnostic]) ∨
       (total.isZero = true ∧ r = drafted [taxJournal request (postingsOf commodityId entries)]
          [.taxDetermination (determinationOf request bookId lineResults)])) := by
  unfold finish at h
  cases ht : accountingSum ((postingsOf commodityId entries).map (·.exactBookValue)) with
  | error e => simp [ht, liftNum] at h
  | ok total =>
    simp only [ht, liftNum] at h
    refine ⟨total, rfl, ?_⟩
    by_cases hz : total.isZero = true
    · simp only [hz, Bool.not_true, Bool.false_eq_true, ↓reduceIte, Except.ok.injEq] at h
      exact Or.inr ⟨hz, h.symm⟩
    · simp only [Bool.not_eq_true] at hz
      simp only [hz, Bool.not_false, ↓reduceIte, Except.ok.injEq] at h
      exact Or.inl ⟨hz, h.symm⟩

/-- When the entries are constructible and their total is zero, `finish` does not refuse. -/
theorem finish_balanced {request : TaxRequest} {bookId : BookId} {commodityId : CommodityId}
    {entries : List (AccountId × TaxEntry)} {lineResults : List TaxLineResult}
    {r : AccountingCalculation} (hwf : ∀ e ∈ entries, e.2.amount.WF)
    (hz : entriesSum entries = 0)
    (h : finish request bookId commodityId entries lineResults = .ok r) :
    r = drafted [taxJournal request (postingsOf commodityId entries)]
      [.taxDetermination (determinationOf request bookId lineResults)] := by
  obtain ⟨total, ht, hr⟩ := finish_ok h
  rw [postingsOf_values] at ht
  have hv : ∀ v ∈ entries.map (·.2.amount), v.WF := by
    intro v hv
    obtain ⟨e, he, rfl⟩ := List.mem_map.mp hv
    exact hwf e he
  obtain ⟨htw, htr⟩ := accountingSum_ok hv ht
  have : total.isZero = true := by
    rw [ExactRational.isZero_iff htw, htr, List.map_map]
    exact hz
  rcases hr with ⟨hf, -⟩ | ⟨-, hr⟩
  · rw [this] at hf; cases hf
  · exact hr

/-- The journal of a draft is the one the code found balanced: its exact book values add up to an
exact total that is zero, and to zero as rationals when they are constructible. -/
theorem finish_draft_balances {request : TaxRequest} {bookId : BookId} {commodityId : CommodityId}
    {entries : List (AccountId × TaxEntry)} {lineResults : List TaxLineResult}
    {dr : AccountingDraft}
    (h : finish request bookId commodityId entries lineResults = .ok (.draft dr)) :
    ∀ j ∈ dr.journals, ∃ total, accountingSum (j.postings.map (·.exactBookValue)) = .ok total ∧
      total.isZero = true ∧
      ((∀ p ∈ j.postings, p.exactBookValue.WF) → (j.postings.map (·.exactBookValue.toRat)).sum = 0) := by
  obtain ⟨total, ht, hr⟩ := finish_ok h
  rcases hr with ⟨-, hr⟩ | ⟨hz, hr⟩
  · cases hr
  · simp only [drafted, immutableAccountingValue, AccountingCalculation.draft.injEq] at hr
    subst hr
    intro j hj
    simp only [List.mem_singleton] at hj
    subst hj
    refine ⟨total, ht, hz, fun hw => ?_⟩
    obtain ⟨htw, htr⟩ := accountingSum_ok (fun v hv => by
      obtain ⟨p, hp, rfl⟩ := List.mem_map.mp hv
      exact hw p hp) ht
    rw [← (ExactRational.isZero_iff htw).mp hz, htr, List.map_map]
    rfl

/-- After the line loop and rounding: every line's policy rounds by one common rule (the scale and
mode of the first line's quantization policy), and every line gets one allocation a component,
with `AllocationSpec` under that rule. -/
theorem resolved_allocations {policies : List AccountingPolicy} {bookId : BookId}
    {governedAt : Instant} {isSaleFlag : Bool} {lines : List TaxableLine}
    {common : CommonRounding} {preLines : List PreResolvedTaxLine}
    {allocated : List (List AllocatedComponent)} (hpols : ∀ p ∈ policies, p.WF)
    (hlines : ∀ l ∈ lines, l.WF)
    (hp : preResolveLines policies bookId governedAt isSaleFlag none lines =
      .ok (.inr (common, preLines)))
    (ha : allocate common preLines = .ok allocated) :
    ∃ rule : QuantizationRule, (∀ pre ∈ preLines, pre.policy.quantizationPolicy.rule = rule) ∧
      List.Forall₂ (fun pre allocs => List.Forall₂ (AllocationSpec rule)
        pre.componentExactTaxes allocs) preLines allocated := by
  obtain ⟨hall, hfinal, hmis⟩ := preResolveLines_inr hpols hlines hp
  have hitems : ∀ pre ∈ preLines, ∀ item ∈ pre.componentExactTaxes,
      item.exactTax.WF ∧ item.component.recoverableShare.WF := by
    intro pre hpre item hitem
    obtain ⟨line, -, spec⟩ := forall₂_mem_right hall pre hpre
    refine ⟨spec.exact.exactTax_wf item hitem, (spec.components_wf item.component ?_).recoverableShare⟩
    rw [← spec.exact.components_eq]
    exact List.mem_map.mpr ⟨item, hitem, rfl⟩
  have hrule : ∃ rule : QuantizationRule,
      ∀ pre ∈ preLines, pre.policy.quantizationPolicy.rule = rule := by
    cases common with
    | none =>
      refine ⟨default, fun pre hpre => ?_⟩
      cases preLines with
      | nil => cases hpre
      | cons p ps => simp [nextCommon] at hfinal
    | some c =>
      obtain ⟨lvl, qp⟩ := c
      refine ⟨qp.rule, fun pre hpre => ?_⟩
      have hq := (hmis pre hpre).2
      simp only [quantizationMismatch, Bool.or_eq_false_iff, bne_eq_false_iff_eq] at hq
      simp [QuantizationPolicy.rule, hq.1, hq.2]
  obtain ⟨rule, hr⟩ := hrule
  exact ⟨rule, hr, allocate_ok (fun pre hpre => ⟨hr pre hpre, hitems pre hpre⟩) ha⟩


/-- A relation between two lists holds of each pair of their zip. -/
theorem forall₂_zip_mem {α β : Type} {R : α → β → Prop} :
    ∀ {l₁ : List α} {l₂ : List β}, List.Forall₂ R l₁ l₂ → ∀ x ∈ l₁.zip l₂, R x.1 x.2
  | _, _, List.Forall₂.nil => fun _ h => by cases h
  | _, _, List.Forall₂.cons hab hrest => fun x hx => by
    rcases List.mem_cons.mp hx with rfl | hx
    · exact hab
    · exact forall₂_zip_mem hrest x hx

/-- Two lists related member by member through equal images have equal images. -/
theorem forall₂_map_eq {α β γ : Type} {f : α → γ} {g : β → γ} :
    ∀ {l₁ : List α} {l₂ : List β}, List.Forall₂ (fun a b => f a = g b) l₁ l₂ →
      l₁.map f = l₂.map g
  | _, _, List.Forall₂.nil => rfl
  | _, _, List.Forall₂.cons hab hrest => by simp [hab, forall₂_map_eq hrest]

/-- The number of components of the policy `policyAt` selects for a line (zero when it selects
none). -/
def selectedComponentCount (policies : List AccountingPolicy) (governedAt : Instant)
    (line : TaxableLine) : Nat :=
  match policyAt TaxPolicy policies line.policyId line.policyVersion governedAt with
  | .selected p => p.components.length
  | .rejected _ => 0

/-- A draft's journal balances: the exact book values of its postings add up to an exact total
that is zero (line 2019), and to zero as rationals when they are constructible. -/
theorem determineTax_draft_balances {policies : List AccountingPolicy} {bookId : BookId}
    {commodityId : CommodityId} {request : TaxRequest} {dr : AccountingDraft}
    (h : determineTax policies bookId commodityId request = .ok (.draft dr)) :
    ∀ j ∈ dr.journals, ∃ total, accountingSum (j.postings.map (·.exactBookValue)) = .ok total ∧
      total.isZero = true ∧
      ((∀ p ∈ j.postings, p.exactBookValue.WF) →
        (j.postings.map (·.exactBookValue.toRat)).sum = 0) := by
  rcases determineTax_stages h with ⟨-, hr⟩ | ⟨-, -, hr⟩ | ⟨-, -, d, -, hr⟩ |
      ⟨-, -, common, preLines, allocated, -, -, ⟨d, -, hr⟩ | ⟨entries, lineResults, -, hf⟩⟩
  · cases hr
  · cases hr
  · cases hr
  · cases hr
  · exact finish_draft_balances hf


/-- The refusal of line 2019 never happens for a request whose journal does balance in exact
arithmetic, under the two conditions that keep `addPosting` from dropping an amount: every line's
selected policy has at least as many components as the policy of the line before it, and no
reverse-charge component sends its non-recoverable part to its liability account. (Without them the
TypeScript refuses balanced requests: see the header.) -/
theorem determineTax_never_unbalanced {policies : List AccountingPolicy} {bookId : BookId}
    {commodityId : CommodityId} {request : TaxRequest} (hpols : ∀ p ∈ policies, p.WF)
    (hreq : request.WF)
    (hrc : ∀ tp, AccountingPolicy.taxDetermination tp ∈ policies →
      ∀ c ∈ tp.components, ReverseChargeSeparate c)
    (hcount : (request.lines.map (selectedComponentCount policies request.governedAt)).IsChain
      (· ≤ ·)) :
    determineTax policies bookId commodityId request ≠ .ok (.rejected [balanceDiagnostic]) := by
  intro h
  rcases determineTax_stages h with ⟨-, hr⟩ | ⟨-, -, hr⟩ | ⟨-, -, d, hp, hr⟩ |
      ⟨-, -, common, preLines, allocated, hp, ha, ⟨d, hb, hr⟩ | ⟨entries, lineResults, hb, hf⟩⟩
  · have := congrArg (fun r => match r with | .rejected [d] => d.message | _ => "") hr
    simp [requestDiagnostic, balanceDiagnostic, diagnostic] at this
  · have := congrArg (fun r => match r with | .rejected [d] => d.message | _ => "") hr
    simp [linesDiagnostic, balanceDiagnostic, diagnostic] at this
  · simp only [AccountingCalculation.rejected.injEq, List.cons.injEq, and_true] at hr
    subst hr
    obtain ⟨line, hline, c, hc⟩ := preResolveLines_inl hp
    obtain ⟨id, hd⟩ := lineCheck_inl ((preResolveLine_inl_iff hpols (hreq.lines line hline)).mp hc)
    rcases hd with hd | hd | hd | hd | hd <;>
    · have := congrArg SemanticDiagnostic.message hd
      simp [balanceDiagnostic, policyDiagnostic, groupingDiagnostic, roundingDiagnostic,
        quantizationDiagnostic, componentsDiagnostic, diagnostic] at this
  · simp only [AccountingCalculation.rejected.injEq, List.cons.injEq, and_true] at hr
    subst hr
    obtain ⟨id, hd | hd⟩ := buildPostings_inl hb <;>
    · have := congrArg SemanticDiagnostic.message hd
      simp [balanceDiagnostic, recoverableDiagnostic, nonRecoverableDiagnostic, diagnostic] at this
  · obtain ⟨rule, -, hallocs⟩ := resolved_allocations hpols hreq.lines hp ha
    obtain ⟨hall, -, -⟩ := preResolveLines_inr hpols hreq.lines hp
    have hlen := hallocs.length_eq
    have hfst : (preLines.zip allocated).map Prod.fst = preLines := List.map_fst_zip (by omega)
    have hcounts : preLines.map (·.components.length) =
        request.lines.map (selectedComponentCount policies request.governedAt) := by
      symm
      apply forall₂_map_eq
      refine List.Forall₂.imp (fun line pre spec => ?_) hall
      simp only [selectedComponentCount, spec.selected, spec.components_eq]
      exact (sortComponents_perm _).length_eq.symm
    have hchain : ((preLines.zip allocated).map (·.1.components.length)).IsChain (· ≤ ·) := by
      have : (preLines.zip allocated).map (·.1.components.length) =
          ((preLines.zip allocated).map Prod.fst).map (·.components.length) := by
        simp [List.map_map]
      rw [this, hfst, hcounts]
      exact hcount
    have hlb : ∀ x ∈ preLines.zip allocated, LineBalanced x.1 x.2 := by
      intro x hx
      have hxa := forall₂_zip_mem hallocs x hx
      obtain ⟨line, hline, spec⟩ := forall₂_mem_right hall x.1 (List.of_mem_zip hx).1
      refine ⟨by rw [spec.line_eq]; exact (hreq.lines line hline).statedAmount,
        spec.exact.exclusive_wf, fun p hp => ⟨?_, ?_⟩⟩
      · obtain ⟨item, -, hs⟩ := forall₂_mem_right hxa p.1 (List.of_mem_zip hp).1
        exact hs.balanced
      · have hm := (List.of_mem_zip hp).2
        rw [spec.components_eq] at hm
        exact hrc _ spec.policy_mem p.2 ((sortComponents_perm _).mem_iff.mp hm)
    obtain ⟨-, hwf, hs⟩ := buildPostings_balance (sourceSign_wf _) (entries := [])
      (by simp) (by simp) (by simp) hchain hlb hb
    have := finish_balanced hwf (by rw [hs]; simp [entriesSum]) hf
    cases this

/-! ## Rejections: one law a reason -/

section LineCheck

variable {policies : List AccountingPolicy} {bookId : BookId} {governedAt : Instant}
  {isSaleFlag : Bool} {common : CommonRounding} {line : TaxableLine}

/-- Line 1784: a line is refused for its policy exactly when `policyAt` selects none. -/
theorem lineCheck_policy_iff :
    lineCheck policies bookId governedAt isSaleFlag common line =
        .inl (policyDiagnostic line.lineId) ↔
      ∃ ds, policyAt TaxPolicy policies line.policyId line.policyVersion governedAt =
        .rejected ds := by
  unfold lineCheck
  split
  · rename_i ds h; exact ⟨fun _ => ⟨ds, h⟩, fun _ => rfl⟩
  · rename_i p h
    simp only [h, reduceCtorEq, exists_false, iff_false]
    split_ifs <;> simp [policyDiagnostic, groupingDiagnostic, roundingDiagnostic,
      quantizationDiagnostic, componentsDiagnostic, diagnostic]

/-- Line 1787: a line is refused for its grouping marker exactly when its policy names one with an
algorithm version other than `1.1.0`. -/
theorem lineCheck_grouping_iff :
    lineCheck policies bookId governedAt isSaleFlag common line =
        .inl (groupingDiagnostic line.lineId) ↔
      ∃ p, policyAt TaxPolicy policies line.policyId line.policyVersion governedAt = .selected p ∧
        groupingUnsupported p = true := by
  unfold lineCheck
  split
  · rename_i ds h
    simp [h, policyDiagnostic, groupingDiagnostic, diagnostic]
  · rename_i p h
    simp only [h, AccountingPolicySelection.selected.injEq, exists_eq_left']
    split_ifs <;> simp_all [groupingDiagnostic, roundingDiagnostic,
      quantizationDiagnostic, componentsDiagnostic, diagnostic]

/-- Line 1796: a line is refused for its rounding level exactly when its policy passed the tests
before and its level differs from the first line's. -/
theorem lineCheck_rounding_iff :
    lineCheck policies bookId governedAt isSaleFlag common line =
        .inl (roundingDiagnostic line.lineId) ↔
      ∃ p, policyAt TaxPolicy policies line.policyId line.policyVersion governedAt = .selected p ∧
        groupingUnsupported p = false ∧ roundingMismatch common p = true := by
  unfold lineCheck
  split
  · rename_i ds h
    simp [h, policyDiagnostic, roundingDiagnostic, diagnostic]
  · rename_i p h
    simp only [h, AccountingPolicySelection.selected.injEq, exists_eq_left']
    split_ifs <;> simp_all [groupingDiagnostic, roundingDiagnostic,
      quantizationDiagnostic, componentsDiagnostic, diagnostic]

/-- Line 1802: a line is refused for its quantization policy exactly when its policy passed the
tests before and its scale or rounding mode differs from the first line's. -/
theorem lineCheck_quantization_iff :
    lineCheck policies bookId governedAt isSaleFlag common line =
        .inl (quantizationDiagnostic line.lineId) ↔
      ∃ p, policyAt TaxPolicy policies line.policyId line.policyVersion governedAt = .selected p ∧
        groupingUnsupported p = false ∧ roundingMismatch common p = false ∧
        quantizationMismatch common p = true := by
  unfold lineCheck
  split
  · rename_i ds h
    simp [h, policyDiagnostic, quantizationDiagnostic, diagnostic]
  · rename_i p h
    simp only [h, AccountingPolicySelection.selected.injEq, exists_eq_left']
    split_ifs <;> simp_all [groupingDiagnostic, roundingDiagnostic,
      quantizationDiagnostic, componentsDiagnostic, diagnostic]

/-- Line 1811: a line is refused for its components exactly when its policy passed the tests
before and its components sorted by ordinal are not `ValidComponents`. -/
theorem lineCheck_components_iff :
    lineCheck policies bookId governedAt isSaleFlag common line =
        .inl (componentsDiagnostic line.lineId) ↔
      ∃ p, policyAt TaxPolicy policies line.policyId line.policyVersion governedAt = .selected p ∧
        groupingUnsupported p = false ∧ roundingMismatch common p = false ∧
        quantizationMismatch common p = false ∧
        ¬ ValidComponents bookId isSaleFlag line.amountIncludesTax p (sortComponents p.components) := by
  unfold lineCheck
  split
  · rename_i ds h
    simp [h, policyDiagnostic, componentsDiagnostic, diagnostic]
  · rename_i p h
    simp only [h, AccountingPolicySelection.selected.injEq, exists_eq_left',
      ← invalidComponents_eq_false_iff, Bool.not_eq_false]
    split_ifs <;> simp_all [groupingDiagnostic, roundingDiagnostic,
      quantizationDiagnostic, componentsDiagnostic, diagnostic]

end LineCheck

/-- The diagnostics are told apart by their messages. -/
theorem diagnostics_distinct :
    requestDiagnostic ≠ linesDiagnostic ∧ requestDiagnostic ≠ balanceDiagnostic ∧
      linesDiagnostic ≠ balanceDiagnostic ∧
      (∀ d, LineCheckDiagnostic d → d ≠ requestDiagnostic ∧ d ≠ linesDiagnostic ∧
        d ≠ balanceDiagnostic ∧ ¬ DestinationDiagnostic d) ∧
      (∀ d, DestinationDiagnostic d → d ≠ requestDiagnostic ∧ d ≠ linesDiagnostic ∧
        d ≠ balanceDiagnostic) := by
  refine ⟨?_, ?_, ?_, ?_, ?_⟩
  · intro h; have := congrArg SemanticDiagnostic.message h
    simp [requestDiagnostic, linesDiagnostic, diagnostic] at this
  · intro h; have := congrArg SemanticDiagnostic.message h
    simp [requestDiagnostic, balanceDiagnostic, diagnostic] at this
  · intro h; have := congrArg SemanticDiagnostic.message h
    simp [linesDiagnostic, balanceDiagnostic, diagnostic] at this
  · rintro d ⟨id, hd⟩
    refine ⟨?_, ?_, ?_, ?_⟩
    all_goals first
      | (intro h; subst h)
      | (rintro ⟨id', h | h⟩ <;> subst h)
    all_goals rcases hd with hd | hd | hd | hd | hd <;>
      (have := congrArg SemanticDiagnostic.message hd
       simp [requestDiagnostic, linesDiagnostic, balanceDiagnostic, policyDiagnostic,
          groupingDiagnostic, roundingDiagnostic, quantizationDiagnostic, componentsDiagnostic,
          recoverableDiagnostic, nonRecoverableDiagnostic, diagnostic] at this)
  · rintro d ⟨id, hd⟩
    refine ⟨?_, ?_, ?_⟩
    all_goals intro h; subst h
    all_goals rcases hd with hd | hd <;>
      (have := congrArg SemanticDiagnostic.message hd
       simp [requestDiagnostic, linesDiagnostic, balanceDiagnostic, recoverableDiagnostic,
          nonRecoverableDiagnostic, diagnostic] at this)

/-- The test of line 1769, as a statement. -/
theorem requestRejected_iff (request : TaxRequest) :
    requestRejected request = true ↔
      validAccountingDerivation request.derivation = false ∨ request.lines = [] ∨
        accountingLimits.maxTaxLines < request.lines.length := by
  simp [requestRejected, List.isEmpty_iff, or_assoc]


/-- Where a refusal of `determineTax` comes from, for constructible inputs: the request, the lines,
a line's checks, a component's destinations, or the balance test. -/
theorem determineTax_rejected_origin {policies : List AccountingPolicy} {bookId : BookId}
    {commodityId : CommodityId} {request : TaxRequest} {ds : List SemanticDiagnostic}
    (hpols : ∀ p ∈ policies, p.WF) (hreq : request.WF)
    (h : determineTax policies bookId commodityId request = .ok (.rejected ds)) :
    (requestRejected request = true ∧ ds = [requestDiagnostic]) ∨
    (requestRejected request = false ∧ invalidTaxLines request.lines = true ∧
      ds = [linesDiagnostic]) ∨
    (requestRejected request = false ∧ invalidTaxLines request.lines = false ∧
      ∃ d, preResolveLines policies bookId request.governedAt (isSale request.direction) none
        request.lines = .ok (.inl d) ∧ LineCheckDiagnostic d ∧ ds = [d]) ∨
    (requestRejected request = false ∧ invalidTaxLines request.lines = false ∧
      ∃ common preLines allocated d,
        preResolveLines policies bookId request.governedAt (isSale request.direction) none
          request.lines = .ok (.inr (common, preLines)) ∧
        allocate common preLines = .ok allocated ∧
        buildPostingsAndLineResults request.id (isCredit request.direction)
          (sourceSign request.direction) 0 (preLines.zip allocated) [] = .ok (.inl d) ∧
        DestinationDiagnostic d ∧ ds = [d]) ∨
    (requestRejected request = false ∧ invalidTaxLines request.lines = false ∧
      ∃ common preLines allocated entries lineResults total,
        preResolveLines policies bookId request.governedAt (isSale request.direction) none
          request.lines = .ok (.inr (common, preLines)) ∧
        allocate common preLines = .ok allocated ∧
        buildPostingsAndLineResults request.id (isCredit request.direction)
          (sourceSign request.direction) 0 (preLines.zip allocated) [] =
            .ok (.inr (entries, lineResults)) ∧
        accountingSum ((postingsOf commodityId entries).map (·.exactBookValue)) = .ok total ∧
        total.isZero = false ∧ ds = [balanceDiagnostic]) := by
  rcases determineTax_stages h with ⟨h1, hr⟩ | ⟨h1, h2, hr⟩ | ⟨h1, h2, d, hp, hr⟩ |
      ⟨h1, h2, common, preLines, allocated, hp, ha, ⟨d, hb, hr⟩ | ⟨entries, lineResults, hb, hf⟩⟩
  · cases hr; exact Or.inl ⟨h1, rfl⟩
  · cases hr; exact Or.inr (Or.inl ⟨h1, h2, rfl⟩)
  · cases hr
    obtain ⟨line, hline, c, hc⟩ := preResolveLines_inl hp
    exact Or.inr (Or.inr (Or.inl ⟨h1, h2, d, hp,
      lineCheck_inl ((preResolveLine_inl_iff hpols (hreq.lines line hline)).mp hc), rfl⟩))
  · cases hr
    exact Or.inr (Or.inr (Or.inr (Or.inl ⟨h1, h2, common, preLines, allocated, d, hp, ha, hb,
      buildPostings_inl hb, rfl⟩)))
  · obtain ⟨total, ht, ⟨hz, hr⟩ | ⟨-, hr⟩⟩ := finish_ok hf
    · cases hr
      exact Or.inr (Or.inr (Or.inr (Or.inr ⟨h1, h2, common, preLines, allocated, entries,
        lineResults, total, hp, ha, hb, ht, hz, rfl⟩)))
    · cases hr

/-- Line 1769: `determineTax` refuses the request itself exactly when its lineage is not approved
(`validAccountingDerivation`), it has no line, or it has more than 100 lines. -/
theorem determineTax_request_iff {policies : List AccountingPolicy} {bookId : BookId}
    {commodityId : CommodityId} {request : TaxRequest} (hpols : ∀ p ∈ policies, p.WF)
    (hreq : request.WF) :
    determineTax policies bookId commodityId request = .ok (.rejected [requestDiagnostic]) ↔
      validAccountingDerivation request.derivation = false ∨ request.lines = [] ∨
        accountingLimits.maxTaxLines < request.lines.length := by
  rw [← requestRejected_iff]
  obtain ⟨d1, d2, -, d4, d5⟩ := diagnostics_distinct
  constructor
  · intro h
    rcases determineTax_rejected_origin hpols hreq h with ⟨h1, -⟩ | ⟨-, -, hd⟩ |
        ⟨-, -, d, -, hl, hd⟩ | ⟨-, -, -, -, -, d, -, -, -, hl, hd⟩ |
        ⟨-, -, -, -, -, -, -, -, -, -, -, -, -, hd⟩
    · exact h1
    · exact absurd (List.cons.inj hd).1 d1
    · exact absurd (List.cons.inj hd).1.symm (d4 d hl).1
    · exact absurd (List.cons.inj hd).1.symm (d5 d hl).1
    · exact absurd (List.cons.inj hd).1 d2
  · intro h
    simp [determineTax, h]

/-- Lines 1770 to 1772: `determineTax` refuses the lines exactly when the request passes line 1769
and two lines share an identifier, a source posting or a counterparty posting, or a line has a
blank identifier, the same source and counterparty posting, or a zero amount. -/
theorem determineTax_lines_iff {policies : List AccountingPolicy} {bookId : BookId}
    {commodityId : CommodityId} {request : TaxRequest} (hpols : ∀ p ∈ policies, p.WF)
    (hreq : request.WF) :
    determineTax policies bookId commodityId request = .ok (.rejected [linesDiagnostic]) ↔
      requestRejected request = false ∧ invalidTaxLines request.lines = true := by
  obtain ⟨d1, -, d3, d4, d5⟩ := diagnostics_distinct
  constructor
  · intro h
    rcases determineTax_rejected_origin hpols hreq h with ⟨-, hd⟩ | ⟨h1, h2, -⟩ |
        ⟨-, -, d, -, hl, hd⟩ | ⟨-, -, -, -, -, d, -, -, -, hl, hd⟩ |
        ⟨-, -, -, -, -, -, -, -, -, -, -, -, -, hd⟩
    · exact absurd (List.cons.inj hd).1.symm d1
    · exact ⟨h1, h2⟩
    · exact absurd (List.cons.inj hd).1.symm (d4 d hl).2.1
    · exact absurd (List.cons.inj hd).1.symm (d5 d hl).2.1
    · exact absurd (List.cons.inj hd).1 d3
  · rintro ⟨h1, h2⟩
    simp [determineTax, h1, h2]

/-- Lines 1784 to 1811: `determineTax` refuses with a line's check diagnostic exactly when the
request and its lines pass and the line loop refuses with it (`preResolveLines_inl_iff` says which
line: the first whose checks fail). -/
theorem determineTax_line_iff {policies : List AccountingPolicy} {bookId : BookId}
    {commodityId : CommodityId} {request : TaxRequest} {d : SemanticDiagnostic}
    (hpols : ∀ p ∈ policies, p.WF) (hreq : request.WF) (hd : LineCheckDiagnostic d) :
    determineTax policies bookId commodityId request = .ok (.rejected [d]) ↔
      requestRejected request = false ∧ invalidTaxLines request.lines = false ∧
        preResolveLines policies bookId request.governedAt (isSale request.direction) none
          request.lines = .ok (.inl d) := by
  obtain ⟨-, -, -, d4, d5⟩ := diagnostics_distinct
  constructor
  · intro h
    rcases determineTax_rejected_origin hpols hreq h with ⟨-, he⟩ | ⟨-, -, he⟩ |
        ⟨h1, h2, d', hp, -, he⟩ | ⟨-, -, -, -, -, d', -, -, -, hl, he⟩ |
        ⟨-, -, -, -, -, -, -, -, -, -, -, -, -, he⟩
    · exact absurd (List.cons.inj he).1 (d4 d hd).1
    · exact absurd (List.cons.inj he).1 (d4 d hd).2.1
    · rw [(List.cons.inj he).1]; exact ⟨h1, h2, hp⟩
    · rw [(List.cons.inj he).1] at hd; exact absurd hl (d4 d' hd).2.2.2
    · exact absurd (List.cons.inj he).1 (d4 d hd).2.2.1
  · rintro ⟨h1, h2, hp⟩
    simp [determineTax, h1, h2, hp]

/-- Lines 1978 and 1983: `determineTax` refuses for a missing destination exactly when the request,
its lines and every line's checks pass, and the postings stop at a part with no destination. -/
theorem determineTax_destination_iff {policies : List AccountingPolicy} {bookId : BookId}
    {commodityId : CommodityId} {request : TaxRequest} {d : SemanticDiagnostic}
    (hpols : ∀ p ∈ policies, p.WF) (hreq : request.WF) (hd : DestinationDiagnostic d) :
    determineTax policies bookId commodityId request = .ok (.rejected [d]) ↔
      requestRejected request = false ∧ invalidTaxLines request.lines = false ∧
        ∃ common preLines allocated,
          preResolveLines policies bookId request.governedAt (isSale request.direction) none
            request.lines = .ok (.inr (common, preLines)) ∧
          allocate common preLines = .ok allocated ∧
          buildPostingsAndLineResults request.id (isCredit request.direction)
            (sourceSign request.direction) 0 (preLines.zip allocated) [] = .ok (.inl d) := by
  obtain ⟨-, -, -, d4, d5⟩ := diagnostics_distinct
  constructor
  · intro h
    rcases determineTax_rejected_origin hpols hreq h with ⟨-, he⟩ | ⟨-, -, he⟩ |
        ⟨-, -, d', -, hl, he⟩ | ⟨h1, h2, common, preLines, allocated, d', hp, ha, hb, -, he⟩ |
        ⟨-, -, -, -, -, -, -, -, -, -, -, -, -, he⟩
    · exact absurd (List.cons.inj he).1 (d5 d hd).1
    · exact absurd (List.cons.inj he).1 (d5 d hd).2.1
    · rw [(List.cons.inj he).1] at hd; exact absurd hd (d4 d' hl).2.2.2
    · rw [(List.cons.inj he).1]; exact ⟨h1, h2, common, preLines, allocated, hp, ha, hb⟩
    · exact absurd (List.cons.inj he).1 (d5 d hd).2.2
  · rintro ⟨h1, h2, common, preLines, allocated, hp, ha, hb⟩
    simp [determineTax, h1, h2, hp, ha, hb]

/-- Line 2019: `determineTax` refuses for balance exactly when every earlier stage passes and the
exact total of the entries is not zero. -/
theorem determineTax_balance_iff {policies : List AccountingPolicy} {bookId : BookId}
    {commodityId : CommodityId} {request : TaxRequest} (hpols : ∀ p ∈ policies, p.WF)
    (hreq : request.WF) :
    determineTax policies bookId commodityId request = .ok (.rejected [balanceDiagnostic]) ↔
      requestRejected request = false ∧ invalidTaxLines request.lines = false ∧
        ∃ common preLines allocated entries lineResults total,
          preResolveLines policies bookId request.governedAt (isSale request.direction) none
            request.lines = .ok (.inr (common, preLines)) ∧
          allocate common preLines = .ok allocated ∧
          buildPostingsAndLineResults request.id (isCredit request.direction)
            (sourceSign request.direction) 0 (preLines.zip allocated) [] =
              .ok (.inr (entries, lineResults)) ∧
          accountingSum ((postingsOf commodityId entries).map (·.exactBookValue)) = .ok total ∧
          total.isZero = false := by
  obtain ⟨-, d2, d3, d4, d5⟩ := diagnostics_distinct
  constructor
  · intro h
    rcases determineTax_rejected_origin hpols hreq h with ⟨-, he⟩ | ⟨-, -, he⟩ |
        ⟨-, -, d', -, hl, he⟩ | ⟨-, -, -, -, -, d', -, -, -, hl, he⟩ |
        ⟨h1, h2, common, preLines, allocated, entries, lineResults, total, hp, ha, hb, ht, hz, -⟩
    · exact absurd (List.cons.inj he).1.symm d2
    · exact absurd (List.cons.inj he).1.symm d3
    · exact absurd (List.cons.inj he).1.symm (d4 d' hl).2.2.1
    · exact absurd (List.cons.inj he).1.symm (d5 d' hl).2.2
    · exact ⟨h1, h2, common, preLines, allocated, entries, lineResults, total, hp, ha, hb, ht, hz⟩
  · rintro ⟨h1, h2, common, preLines, allocated, entries, lineResults, total, hp, ha, hb, ht, hz⟩
    simp [determineTax, h1, h2, hp, ha, hb, finish, ht, liftNum, hz]

/-- A part posting refuses exactly when the part is not zero and the component names no account
for it. -/
theorem partPosting_inl_iff {requestId : TaxDeterminationId} {isCreditFlag : Bool}
    {lineOrdinal index : Nat} {kind : String} {diag : SemanticDiagnostic} {part : ExactRational}
    {accountId? : Option AccountId} {order : Nat} {entries : List (AccountId × TaxEntry)}
    {d : SemanticDiagnostic} :
    partPosting requestId isCreditFlag lineOrdinal index kind diag part accountId? order entries =
        .ok (.inl d) ↔ d = diag ∧ part.isZero = false ∧ accountId? = none := by
  constructor
  · intro h
    refine ⟨partPosting_inl h, ?_⟩
    unfold partPosting at h
    by_cases hz : part.isZero = true
    · simp [hz] at h
    · refine ⟨by simpa using hz, ?_⟩
      simp only [show (!part.isZero) = true by simpa using hz, ↓reduceIte] at h
      cases ha : accountId? with
      | none => rfl
      | some a =>
        simp only [ha] at h
        cases ht : taxPosting requestId lineOrdinal index kind a
            (if isCreditFlag then part.negate else part) order entries with
        | error e => simp [ht] at h
        | ok es => simp [ht] at h
  · rintro ⟨rfl, hz, ha⟩
    simp [partPosting, hz, ha]

/-- Line 1978: a component's postings refuse for its recoverable part exactly when it is input tax
or reverse charge, its recoverable part is not zero, and it names no recoverable account. -/
theorem componentPostings_recoverable_iff {requestId : TaxDeterminationId} {isCreditFlag : Bool}
    {lineId : String} {lineOrdinal orderBase index : Nat} {alloc : AllocatedComponent}
    {comp : TaxPolicyComponent} {entries : List (AccountId × TaxEntry)} {cp : ExactRational} :
    componentPostings requestId isCreditFlag lineId lineOrdinal orderBase index alloc comp entries
        cp = .ok (.inl (recoverableDiagnostic lineId)) ↔
      (comp.treatment = .inputTax ∨ comp.treatment = .reverseCharge) ∧
        alloc.recoverable.isZero = false ∧ comp.recoverableAccountId = none := by
  have hne : recoverableDiagnostic lineId ≠ nonRecoverableDiagnostic lineId := by
    intro h; have := congrArg SemanticDiagnostic.message h
    simp [recoverableDiagnostic, nonRecoverableDiagnostic, diagnostic] at this
  constructor
  · intro h
    have hcomp := h
    unfold componentPostings at h
    by_cases ht : (comp.treatment == .inputTax || comp.treatment == .reverseCharge) = true
    · simp only [ht, ↓reduceIte] at h
      have ht' : comp.treatment = .inputTax ∨ comp.treatment = .reverseCharge := by
        simpa using ht
      cases h1 : partPosting requestId isCreditFlag lineOrdinal index "recoverable"
          (recoverableDiagnostic lineId) alloc.recoverable comp.recoverableAccountId
          (orderBase + index * 2 + 1) entries with
      | error e => simp [h1] at h
      | ok r1 =>
        cases r1 with
        | inl d1 =>
          obtain ⟨-, hz, ha⟩ := partPosting_inl_iff.mp h1
          exact ⟨ht', hz, ha⟩
        | inr e1 =>
          simp only [h1] at h
          cases h2 : partPosting requestId isCreditFlag lineOrdinal index "nonrecoverable"
              (nonRecoverableDiagnostic lineId) alloc.nonRecoverable comp.nonRecoverableAccountId
              (orderBase + index * 2 + 2) e1 with
          | error e => simp [h2] at h
          | ok r2 =>
            cases r2 with
            | inl d2 =>
              simp only [h2, Except.ok.injEq, Sum.inl.injEq] at h
              exact absurd (h.symm.trans (partPosting_inl h2)) hne
            | inr e2 =>
              simp only [h2] at h
              by_cases hin : (comp.treatment == .inputTax) = true
              · simp only [hin, ↓reduceIte] at h
                cases h3 : liftNum (if isCreditFlag then cp.add alloc.quantizedAmount
                    else cp.subtract alloc.quantizedAmount) with
                | error e => simp [h3] at h
                | ok c => simp [h3] at h
              · simp only [hin, Bool.false_eq_true, ↓reduceIte] at h
                cases h3 : taxPosting requestId lineOrdinal index "liability"
                    comp.liabilityAccountId
                    (if isCreditFlag then alloc.quantizedAmount else alloc.quantizedAmount.negate)
                    (orderBase + index * 2 + 1) e2 with
                | error e => simp [h3] at h
                | ok e3 => simp [h3] at h
    · rcases componentPostings_inl hcomp with _ | _
      all_goals
        simp only [ht, Bool.false_eq_true, ↓reduceIte] at h
        cases h1 : taxPosting requestId lineOrdinal index "liability" comp.liabilityAccountId
            (if isCreditFlag then alloc.quantizedAmount else alloc.quantizedAmount.negate)
            (orderBase + index * 2 + 1) entries with
        | error e => simp [h1] at h
        | ok e1 =>
          simp only [h1] at h
          cases h2 : liftNum (if isCreditFlag then cp.subtract alloc.quantizedAmount
              else cp.add alloc.quantizedAmount) with
          | error e => simp [h2] at h
          | ok c => simp [h2] at h
  · rintro ⟨ht, hz, ha⟩
    have ht' : (comp.treatment == .inputTax || comp.treatment == .reverseCharge) = true := by
      rcases ht with h | h <;> simp [h]
    simp [componentPostings, ht', partPosting, hz, ha]


/-- Line 1983: a component's postings refuse for its non-recoverable part exactly when it is input
tax or reverse charge, its recoverable part was posted (or was zero), its non-recoverable part is
not zero, and it names no non-recoverable account. -/
theorem componentPostings_nonRecoverable_iff {requestId : TaxDeterminationId}
    {isCreditFlag : Bool} {lineId : String} {lineOrdinal orderBase index : Nat}
    {alloc : AllocatedComponent} {comp : TaxPolicyComponent}
    {entries : List (AccountId × TaxEntry)} {cp : ExactRational} :
    componentPostings requestId isCreditFlag lineId lineOrdinal orderBase index alloc comp entries
        cp = .ok (.inl (nonRecoverableDiagnostic lineId)) ↔
      (comp.treatment = .inputTax ∨ comp.treatment = .reverseCharge) ∧
        (∃ e1, partPosting requestId isCreditFlag lineOrdinal index "recoverable"
          (recoverableDiagnostic lineId) alloc.recoverable comp.recoverableAccountId
          (orderBase + index * 2 + 1) entries = .ok (.inr e1)) ∧
        alloc.nonRecoverable.isZero = false ∧ comp.nonRecoverableAccountId = none := by
  have hne : recoverableDiagnostic lineId ≠ nonRecoverableDiagnostic lineId := by
    intro h; have := congrArg SemanticDiagnostic.message h
    simp [recoverableDiagnostic, nonRecoverableDiagnostic, diagnostic] at this
  constructor
  · intro h
    have hcomp := h
    unfold componentPostings at h
    by_cases ht : (comp.treatment == .inputTax || comp.treatment == .reverseCharge) = true
    · simp only [ht, ↓reduceIte] at h
      have ht' : comp.treatment = .inputTax ∨ comp.treatment = .reverseCharge := by
        simpa using ht
      cases h1 : partPosting requestId isCreditFlag lineOrdinal index "recoverable"
          (recoverableDiagnostic lineId) alloc.recoverable comp.recoverableAccountId
          (orderBase + index * 2 + 1) entries with
      | error e => simp [h1] at h
      | ok r1 =>
        cases r1 with
        | inl d1 =>
          simp only [h1, Except.ok.injEq, Sum.inl.injEq] at h
          exact absurd ((partPosting_inl h1).symm.trans h) hne
        | inr e1 =>
          simp only [h1] at h
          cases h2 : partPosting requestId isCreditFlag lineOrdinal index "nonrecoverable"
              (nonRecoverableDiagnostic lineId) alloc.nonRecoverable comp.nonRecoverableAccountId
              (orderBase + index * 2 + 2) e1 with
          | error e => simp [h2] at h
          | ok r2 =>
            cases r2 with
            | inl d2 =>
              obtain ⟨-, hz, ha⟩ := partPosting_inl_iff.mp h2
              exact ⟨ht', ⟨e1, rfl⟩, hz, ha⟩
            | inr e2 =>
              simp only [h2] at h
              by_cases hin : (comp.treatment == .inputTax) = true
              · simp only [hin, ↓reduceIte] at h
                cases h3 : liftNum (if isCreditFlag then cp.add alloc.quantizedAmount
                    else cp.subtract alloc.quantizedAmount) with
                | error e => simp [h3] at h
                | ok c => simp [h3] at h
              · simp only [hin, Bool.false_eq_true, ↓reduceIte] at h
                cases h3 : taxPosting requestId lineOrdinal index "liability"
                    comp.liabilityAccountId
                    (if isCreditFlag then alloc.quantizedAmount else alloc.quantizedAmount.negate)
                    (orderBase + index * 2 + 1) e2 with
                | error e => simp [h3] at h
                | ok e3 => simp [h3] at h
    · simp only [ht, Bool.false_eq_true, ↓reduceIte] at h
      cases h1 : taxPosting requestId lineOrdinal index "liability" comp.liabilityAccountId
          (if isCreditFlag then alloc.quantizedAmount else alloc.quantizedAmount.negate)
          (orderBase + index * 2 + 1) entries with
      | error e => simp [h1] at h
      | ok e1 =>
        simp only [h1] at h
        cases h2 : liftNum (if isCreditFlag then cp.subtract alloc.quantizedAmount
            else cp.add alloc.quantizedAmount) with
        | error e => simp [h2] at h
        | ok c => simp [h2] at h
  · rintro ⟨ht, ⟨e1, h1⟩, hz, ha⟩
    have ht' : (comp.treatment == .inputTax || comp.treatment == .reverseCharge) = true := by
      rcases ht with h | h <;> simp [h]
    have h2 := partPosting_inl_iff (requestId := requestId) (isCreditFlag := isCreditFlag)
      (lineOrdinal := lineOrdinal) (index := index) (kind := "nonrecoverable")
      (diag := nonRecoverableDiagnostic lineId) (order := orderBase + index * 2 + 2)
      (entries := e1) (d := nonRecoverableDiagnostic lineId) |>.mpr ⟨rfl, hz, ha⟩
    simp [componentPostings, ht', h1, h2]

set_option linter.unusedSimpArgs false in
/-- The refusals of lines 1816 and 1830 never happen: the gross coefficient of a valid component
graph is at least one, and the inclusive amount is always reconstructed exactly. -/
theorem determineTax_never_inclusive_refusals {policies : List AccountingPolicy} {bookId : BookId}
    {commodityId : CommodityId} {request : TaxRequest} (hpols : ∀ p ∈ policies, p.WF)
    (hreq : request.WF) (lineId : String) :
    determineTax policies bookId commodityId request ≠ .ok (.rejected [graphDiagnostic lineId]) ∧
    determineTax policies bookId commodityId request ≠
      .ok (.rejected [reconstructionDiagnostic lineId]) := by
  constructor
  all_goals
    intro h
    rcases determineTax_rejected_origin hpols hreq h with ⟨-, he⟩ | ⟨-, -, he⟩ |
        ⟨-, -, d', -, ⟨id, hl⟩, he⟩ | ⟨-, -, -, -, -, d', -, -, -, ⟨id, hl⟩, he⟩ |
        ⟨-, -, -, -, -, -, -, -, -, -, -, -, -, he⟩
    all_goals
      have hm := congrArg SemanticDiagnostic.message (List.cons.inj he).1
      try (rcases hl with hl | hl | hl | hl | hl <;> subst hl)
      try (rcases hl with hl | hl <;> subst hl)
      all_goals
        simp [graphDiagnostic, reconstructionDiagnostic, requestDiagnostic, linesDiagnostic,
          balanceDiagnostic, policyDiagnostic, groupingDiagnostic, roundingDiagnostic,
          quantizationDiagnostic, componentsDiagnostic, recoverableDiagnostic,
          nonRecoverableDiagnostic, diagnostic] at hm

/-! ## Grouping -/

/-- Under the structural algorithm, two occurrences share a group exactly when their policies have
the same identifier and version and their components the same identifier. -/
theorem taxGroupKey_structural_iff {p q : TaxPolicy} {c d : TaxPolicyComponent}
    (hp : usesStructuralTaxGrouping p = true) (hq : usesStructuralTaxGrouping q = true) :
    taxGroupKey p c = taxGroupKey q d ↔ p.id = q.id ∧ p.version = q.version ∧ c.id = d.id := by
  simp [taxGroupKey, hp, hq]

/-- A structural group never holds an occurrence of a policy that does not use the structural
algorithm. -/
theorem taxGroupKey_kinds_disjoint {p q : TaxPolicy} {c d : TaxPolicyComponent}
    (hp : usesStructuralTaxGrouping p = true) (hq : usesStructuralTaxGrouping q = false) :
    taxGroupKey p c ≠ taxGroupKey q d := by
  simp [taxGroupKey, hp, hq]

/-- Under the legacy algorithm, two occurrences share a group exactly when
`${policy.id}:${component.id}` is the same text: the policy's version is not part of the key. -/
theorem taxGroupKey_legacy_iff {p q : TaxPolicy} {c d : TaxPolicyComponent}
    (hp : usesStructuralTaxGrouping p = false) (hq : usesStructuralTaxGrouping q = false) :
    taxGroupKey p c = taxGroupKey q d ↔
      p.id.value ++ ":" ++ c.id.value = q.id.value ++ ":" ++ d.id.value := by
  simp [taxGroupKey, hp, hq]

/-- A witness that the legacy key joins different policies and components: policy `a:b` with
component `c` and policy `a` with component `b:c` share the group `a:b:c`. -/
theorem taxGroupKey_legacy_collision :
    taxGroupKey { (default : TaxPolicy) with id := ⟨"a:b"⟩ }
        { (default : TaxPolicyComponent) with id := ⟨"c"⟩ } =
      taxGroupKey { (default : TaxPolicy) with id := ⟨"a"⟩ }
        { (default : TaxPolicyComponent) with id := ⟨"b:c"⟩ } := by
  simp [taxGroupKey, usesStructuralTaxGrouping]
  decide

/-- Every occurrence is in the group of its own key (lines 1863 to 1865). -/
theorem insertOccurrence_keys {key : TaxGroupKey} {occ : OccurrenceRef}
    (hocc : taxGroupKey occ.policy occ.component = key) :
    ∀ {groups : List (TaxGroupKey × List OccurrenceRef)},
      (∀ g ∈ groups, ∀ o ∈ g.2, taxGroupKey o.policy o.component = g.1) →
      ∀ g ∈ insertOccurrence key occ groups, ∀ o ∈ g.2, taxGroupKey o.policy o.component = g.1
  | [], _ => by
    intro g hg o ho
    simp only [insertOccurrence, List.mem_singleton] at hg
    subst hg
    simp only [List.mem_singleton] at ho
    subst ho
    exact hocc
  | (k, occs) :: rest, h => by
    intro g hg o ho
    unfold insertOccurrence at hg
    split_ifs at hg with hk
    · rcases List.mem_cons.mp hg with rfl | hg
      · rcases List.mem_append.mp ho with ho | ho
        · exact h (k, occs) (by simp) o ho
        · simp only [List.mem_singleton] at ho
          subst ho
          rw [hocc]; exact (beq_iff_eq.mp hk).symm
      · exact h g (by simp [hg]) o ho
    · rcases List.mem_cons.mp hg with rfl | hg
      · exact h (k, occs) (by simp) o ho
      · exact insertOccurrence_keys hocc (fun g' hg' => h g' (by simp [hg'])) g hg o ho

/-- The total allocated to a group does not depend on the order of its occurrences: it is the
group's exact total rounded once (`allocateGroup_rounded_total`), and the exact total is a sum. -/
theorem allocateGroup_total_perm {rule : QuantizationRule} {occs occs' : List OccurrenceRef}
    {pairs pairs' : List ((Nat × Nat) × AllocatedComponent)} (hperm : occs.Perm occs')
    (hne : occs ≠ [])
    (hw : ∀ occ ∈ occs, occ.exactTax.WF ∧ occ.component.recoverableShare.WF ∧
      occ.policy.quantizationPolicy.rule = rule)
    (h : allocateGroupAux ExactRational.zero 0 ExactRational.zero 0 occs = .ok pairs)
    (h' : allocateGroupAux ExactRational.zero 0 ExactRational.zero 0 occs' = .ok pairs') :
    (pairs.map (·.2.quantizedAmount.toRat)).sum = (pairs'.map (·.2.quantizedAmount.toRat)).sum := by
  obtain ⟨t, q, htw, htr, htq, hs⟩ := allocateGroup_rounded_total hne hw h
  obtain ⟨t', q', htw', htr', htq', hs'⟩ := allocateGroup_rounded_total
    (fun h0 => hne (List.Perm.eq_nil (h0 ▸ hperm))) (fun o ho => hw o (hperm.mem_iff.mpr ho)) h'
  have htt : t = t' := ExactRational.eq_of_toRat_eq htw htw' (by
    rw [htr, htr']; exact (hperm.map _).sum_eq)
  subst htt
  rw [htq] at htq'
  cases htq'
  rw [hs, hs']

/-! ## The line results -/

/-- What the line result of a line says (lines 1958 to 1969 and 2002 to 2015): the line's
identifier and policy, its rounded components, and its exclusive basis: the stated amount less the
rounded gross tax for an inclusive line, the exact exclusive amount otherwise. -/
def LineResultSpec (x : PreResolvedTaxLine × List AllocatedComponent) (r : TaxLineResult) : Prop :=
  r.lineId = x.1.line.lineId ∧ r.policyId = x.1.policy.id ∧
    r.components = x.2.map toComponentResult ∧
    ∃ gross, accountingSum (grossAllocatedTerms x.2 x.1.components) = .ok gross ∧
      (x.1.line.amountIncludesTax = true → x.1.line.statedAmount.subtract gross = .ok r.exclusiveBasis) ∧
      (x.1.line.amountIncludesTax = false → r.exclusiveBasis = x.1.unroundedExclusive)

/-- The postings stage gives one line result a line, in order, as `LineResultSpec` says. -/
theorem buildPostings_results {requestId : TaxDeterminationId} {isCreditFlag : Bool}
    {sign : ExactRational} :
    ∀ {L : Nat} {lines : List (PreResolvedTaxLine × List AllocatedComponent)}
      {entries entries' : List (AccountId × TaxEntry)} {results : List TaxLineResult},
      buildPostingsAndLineResults requestId isCreditFlag sign L lines entries =
        .ok (.inr (entries', results)) →
      List.Forall₂ LineResultSpec lines results
  | L, [], entries, entries', results, h => by
    simp only [buildPostingsAndLineResults, Except.ok.injEq, Sum.inr.injEq, Prod.mk.injEq] at h
    obtain ⟨-, rfl⟩ := h
    exact List.Forall₂.nil
  | L, (pre, allocs) :: rest, entries, entries', results, h => by
    unfold buildPostingsAndLineResults at h
    cases hg : liftNum (accountingSum (grossAllocatedTerms allocs pre.components)) with
    | error e => simp [hg] at h
    | ok gross =>
      simp only [hg] at h
      cases hle : lineExclusiveOf pre gross with
      | error e => simp [hle] at h
      | ok le =>
        simp only [hle] at h
        cases hm : liftNum (le.multiply sign) with
        | error e => simp [hm] at h
        | ok src =>
          simp only [hm] at h
          cases h1 : addPosting pre.line.sourcePostingId pre.line.sourceAccountId src
              (L * (pre.components.length * 2 + 4)) entries with
          | error e => simp [h1] at h
          | ok e1 =>
            simp only [h1] at h
            cases h2 : applyComponentPostings requestId isCreditFlag pre.line.lineId L
                (L * (pre.components.length * 2 + 4)) 0 (allocs.zip pre.components) e1
                src.negate with
            | error e => simp [h2] at h
            | ok r2 =>
              cases r2 with
              | inl d2 => simp [h2] at h
              | inr ec =>
                obtain ⟨e2, c2⟩ := ec
                simp only [h2] at h
                cases h3 : addPosting pre.line.counterpartyPostingId pre.line.payableAccountId c2
                    (L * (pre.components.length * 2 + 4) + pre.components.length * 2 + 2) e2 with
                | error e => simp [h3] at h
                | ok e3 =>
                  simp only [h3] at h
                  cases h4 : buildPostingsAndLineResults requestId isCreditFlag sign (L + 1) rest
                      e3 with
                  | error e => simp [h4] at h
                  | ok r4 =>
                    cases r4 with
                    | inl d4 => simp [h4] at h
                    | inr er =>
                      obtain ⟨eF, tail⟩ := er
                      simp only [h4, Except.ok.injEq, Sum.inr.injEq, Prod.mk.injEq] at h
                      obtain ⟨-, rfl⟩ := h
                      refine List.Forall₂.cons ⟨rfl, rfl, rfl, gross, liftNum_ok hg, ?_, ?_⟩
                        (buildPostings_results h4)
                      · intro hi
                        dsimp only at hi ⊢
                        simp only [lineExclusiveOf, hi, ↓reduceIte] at hle
                        exact liftNum_ok hle
                      · intro hi
                        dsimp only at hi ⊢
                        simp only [lineExclusiveOf, hi, Bool.false_eq_true, ↓reduceIte,
                          Except.ok.injEq] at hle
                        exact hle.symm

/-- Net plus tax is gross after rounding (lines 1958 to 1969): for an inclusive line, the exclusive
basis the result reports and the rounded input and output tax of its components add up exactly
to the stated amount. -/
theorem lineResult_inclusive_exact {x : PreResolvedTaxLine × List AllocatedComponent}
    {r : TaxLineResult} (hspec : LineResultSpec x r) (hst : x.1.line.statedAmount.WF)
    (hw : ∀ p ∈ x.2.zip x.1.components, p.1.quantizedAmount.WF)
    (hi : x.1.line.amountIncludesTax = true) :
    r.exclusiveBasis.toRat + ((grossAllocatedTerms x.2 x.1.components).map (·.toRat)).sum =
      x.1.line.statedAmount.toRat := by
  obtain ⟨-, -, -, gross, hg, hinc, -⟩ := hspec
  have hv : ∀ v ∈ grossAllocatedTerms x.2 x.1.components, v.WF := by
    intro v hv
    simp only [grossAllocatedTerms, List.mem_filterMap] at hv
    obtain ⟨⟨c, comp⟩, hm, hv⟩ := hv
    split_ifs at hv
    cases hv
    exact hw _ hm
  obtain ⟨hgw, hgr⟩ := accountingSum_ok hv hg
  obtain ⟨-, hr⟩ := ExactRational.subtract_ok hst hgw (hinc hi)
  rw [hr, ← hgr]
  ring

/-! ## Where the tax goes -/

/-- The accounts with entries. -/
def entryAccounts (entries : List (AccountId × TaxEntry)) : List AccountId := entries.map (·.1)

/-- A posting adds at most its own account. -/
theorem addPosting_keys {id : PostingId} {accountId : AccountId} {amount : ExactRational}
    {order : Nat} {entries entries' : List (AccountId × TaxEntry)}
    (h : addPosting id accountId amount order entries = .ok entries') :
    ∀ k ∈ entryAccounts entries', k ∈ entryAccounts entries ∨ k = accountId := by
  intro k hk
  obtain ⟨e, he, rfl⟩ := List.mem_map.mp hk
  have hset : ∀ v, e ∈ assocSet entries accountId v →
      e.1 ∈ entryAccounts entries ∨ e.1 = accountId := by
    intro v hv
    rcases mem_assocSet hv with hv | rfl
    · exact Or.inl (List.mem_map.mpr ⟨e, hv, rfl⟩)
    · exact Or.inr rfl
  unfold addPosting at h
  split at h
  · simp only [Except.ok.injEq] at h
    subst h
    rcases List.mem_append.mp he with he | he
    · exact Or.inl (List.mem_map.mpr ⟨e, he, rfl⟩)
    · simp only [List.mem_singleton] at he; subst he; exact Or.inr rfl
  · split_ifs at h
    · cases h; exact hset _ he
    · split at h
      · cases h
      · cases h; exact hset _ he

/-- A part posting adds at most the account the component names for that part. -/
theorem partPosting_keys {requestId : TaxDeterminationId} {isCreditFlag : Bool}
    {lineOrdinal index : Nat} {kind : String} {diag : SemanticDiagnostic} {part : ExactRational}
    {accountId? : Option AccountId} {order : Nat} {entries entries' : List (AccountId × TaxEntry)}
    (h : partPosting requestId isCreditFlag lineOrdinal index kind diag part accountId? order
      entries = .ok (.inr entries')) :
    ∀ k ∈ entryAccounts entries', k ∈ entryAccounts entries ∨ accountId? = some k := by
  unfold partPosting at h
  by_cases hz : part.isZero = true
  · simp only [hz, Bool.not_true, Bool.false_eq_true, ↓reduceIte, Except.ok.injEq,
      Sum.inr.injEq] at h
    subst h
    exact fun k hk => Or.inl hk
  · simp only [show (!part.isZero) = true by simpa using hz, ↓reduceIte] at h
    cases ha : accountId? with
    | none => simp [ha] at h
    | some a =>
      simp only [ha] at h
      cases ht : taxPosting requestId lineOrdinal index kind a
          (if isCreditFlag then part.negate else part) order entries with
      | error e => simp [ht] at h
      | ok es =>
        simp only [ht, Except.ok.injEq, Sum.inr.injEq] at h
        subst h
        obtain ⟨pid, hp⟩ := taxPosting_ok ht
        intro k hk
        rcases addPosting_keys hp k hk with hk | rfl
        · exact Or.inl hk
        · exact Or.inr rfl

/-- The accounts a component's treatment sends its tax to (lines 1976 to 1997): input tax to its
recoverable and non-recoverable accounts; reverse charge to those and its liability account;
output tax and withholding to its liability account. -/
def TreatmentAccount (comp : TaxPolicyComponent) (k : AccountId) : Prop :=
  ((comp.treatment = .inputTax ∨ comp.treatment = .reverseCharge) ∧
      (comp.recoverableAccountId = some k ∨ comp.nonRecoverableAccountId = some k)) ∨
    (comp.treatment ≠ .inputTax ∧ k = comp.liabilityAccountId)

/-- A component's postings add only the accounts its treatment names (`TreatmentAccount`). -/
theorem componentPostings_keys {requestId : TaxDeterminationId} {isCreditFlag : Bool}
    {lineId : String} {lineOrdinal orderBase index : Nat} {alloc : AllocatedComponent}
    {comp : TaxPolicyComponent} {entries entries' : List (AccountId × TaxEntry)}
    {cp cp' : ExactRational}
    (h : componentPostings requestId isCreditFlag lineId lineOrdinal orderBase index alloc comp
      entries cp = .ok (.inr (entries', cp'))) :
    ∀ k ∈ entryAccounts entries', k ∈ entryAccounts entries ∨ TreatmentAccount comp k := by
  unfold componentPostings at h
  by_cases ht : (comp.treatment == .inputTax || comp.treatment == .reverseCharge) = true
  · simp only [ht, ↓reduceIte] at h
    have ht' : comp.treatment = .inputTax ∨ comp.treatment = .reverseCharge := by simpa using ht
    cases h1 : partPosting requestId isCreditFlag lineOrdinal index "recoverable"
        (recoverableDiagnostic lineId) alloc.recoverable comp.recoverableAccountId
        (orderBase + index * 2 + 1) entries with
    | error e => simp [h1] at h
    | ok r1 =>
      cases r1 with
      | inl d => simp [h1] at h
      | inr e1 =>
        simp only [h1] at h
        cases h2 : partPosting requestId isCreditFlag lineOrdinal index "nonrecoverable"
            (nonRecoverableDiagnostic lineId) alloc.nonRecoverable comp.nonRecoverableAccountId
            (orderBase + index * 2 + 2) e1 with
        | error e => simp [h2] at h
        | ok r2 =>
          cases r2 with
          | inl d => simp [h2] at h
          | inr e2 =>
            simp only [h2] at h
            have k2 : ∀ k ∈ entryAccounts e2, k ∈ entryAccounts entries ∨ TreatmentAccount comp k := by
              intro k hk
              rcases partPosting_keys h2 k hk with hk | hk
              · rcases partPosting_keys h1 k hk with hk | hk
                · exact Or.inl hk
                · exact Or.inr (Or.inl ⟨ht', Or.inl hk⟩)
              · exact Or.inr (Or.inl ⟨ht', Or.inr hk⟩)
            by_cases hin : (comp.treatment == .inputTax) = true
            · simp only [hin, ↓reduceIte] at h
              cases h3 : liftNum (if isCreditFlag then cp.add alloc.quantizedAmount
                  else cp.subtract alloc.quantizedAmount) with
              | error e => simp [h3] at h
              | ok c =>
                simp only [h3, Except.ok.injEq, Sum.inr.injEq, Prod.mk.injEq] at h
                obtain ⟨rfl, -⟩ := h
                exact k2
            · simp only [hin, Bool.false_eq_true, ↓reduceIte] at h
              cases h3 : taxPosting requestId lineOrdinal index "liability" comp.liabilityAccountId
                  (if isCreditFlag then alloc.quantizedAmount else alloc.quantizedAmount.negate)
                  (orderBase + index * 2 + 1) e2 with
              | error e => simp [h3] at h
              | ok e3 =>
                simp only [h3, Except.ok.injEq, Sum.inr.injEq, Prod.mk.injEq] at h
                obtain ⟨rfl, -⟩ := h
                obtain ⟨pid, hp⟩ := taxPosting_ok h3
                intro k hk
                rcases addPosting_keys hp k hk with hk | rfl
                · exact k2 k hk
                · exact Or.inr (Or.inr ⟨by simpa using hin, rfl⟩)
  · simp only [ht, Bool.false_eq_true, ↓reduceIte] at h
    have hnin : comp.treatment ≠ .inputTax := fun he => ht (by simp [he])
    cases h1 : taxPosting requestId lineOrdinal index "liability" comp.liabilityAccountId
        (if isCreditFlag then alloc.quantizedAmount else alloc.quantizedAmount.negate)
        (orderBase + index * 2 + 1) entries with
    | error e => simp [h1] at h
    | ok e1 =>
      simp only [h1] at h
      cases h2 : liftNum (if isCreditFlag then cp.subtract alloc.quantizedAmount
          else cp.add alloc.quantizedAmount) with
      | error e => simp [h2] at h
      | ok c =>
        simp only [h2, Except.ok.injEq, Sum.inr.injEq, Prod.mk.injEq] at h
        obtain ⟨rfl, -⟩ := h
        obtain ⟨pid, hp⟩ := taxPosting_ok h1
        intro k hk
        rcases addPosting_keys hp k hk with hk | rfl
        · exact Or.inl hk
        · exact Or.inr (Or.inr ⟨hnin, rfl⟩)


/-- A line's component postings add only accounts the components' treatments name. -/
theorem applyComponentPostings_keys {requestId : TaxDeterminationId} {isCreditFlag : Bool}
    {lineId : String} {lineOrdinal orderBase : Nat} :
    ∀ {index : Nat} {pairs : List (AllocatedComponent × TaxPolicyComponent)}
      {entries entries' : List (AccountId × TaxEntry)} {cp cp' : ExactRational},
      applyComponentPostings requestId isCreditFlag lineId lineOrdinal orderBase index pairs
        entries cp = .ok (.inr (entries', cp')) →
      ∀ k ∈ entryAccounts entries', k ∈ entryAccounts entries ∨
        ∃ p ∈ pairs, TreatmentAccount p.2 k
  | index, [], entries, entries', cp, cp', h => by
    simp only [applyComponentPostings, Except.ok.injEq, Sum.inr.injEq, Prod.mk.injEq] at h
    obtain ⟨rfl, -⟩ := h
    exact fun k hk => Or.inl hk
  | index, (alloc, comp) :: rest, entries, entries', cp, cp', h => by
    unfold applyComponentPostings at h
    cases hc : componentPostings requestId isCreditFlag lineId lineOrdinal orderBase index alloc
        comp entries cp with
    | error e => simp [hc] at h
    | ok r =>
      cases r with
      | inl d => simp [hc] at h
      | inr ec =>
        obtain ⟨e1, c1⟩ := ec
        simp only [hc] at h
        intro k hk
        rcases applyComponentPostings_keys h k hk with hk | ⟨p, hp, hpk⟩
        · rcases componentPostings_keys hc k hk with hk | hk
          · exact Or.inl hk
          · exact Or.inr ⟨(alloc, comp), by simp, hk⟩
        · exact Or.inr ⟨p, by simp [hp], hpk⟩

/-- Where the tax goes: every account of the journal is a line's source or payable account, or an
account a component of a line names for its treatment (`TreatmentAccount`). -/
theorem buildPostings_keys {requestId : TaxDeterminationId} {isCreditFlag : Bool}
    {sign : ExactRational} :
    ∀ {L : Nat} {lines : List (PreResolvedTaxLine × List AllocatedComponent)}
      {entries entries' : List (AccountId × TaxEntry)} {results : List TaxLineResult},
      buildPostingsAndLineResults requestId isCreditFlag sign L lines entries =
        .ok (.inr (entries', results)) →
      ∀ k ∈ entryAccounts entries', k ∈ entryAccounts entries ∨ ∃ x ∈ lines,
        k = x.1.line.sourceAccountId ∨ k = x.1.line.payableAccountId ∨
          ∃ c ∈ x.1.components, TreatmentAccount c k
  | L, [], entries, entries', results, h => by
    simp only [buildPostingsAndLineResults, Except.ok.injEq, Sum.inr.injEq, Prod.mk.injEq] at h
    obtain ⟨rfl, -⟩ := h
    exact fun k hk => Or.inl hk
  | L, (pre, allocs) :: rest, entries, entries', results, h => by
    unfold buildPostingsAndLineResults at h
    cases hg : liftNum (accountingSum (grossAllocatedTerms allocs pre.components)) with
    | error e => simp [hg] at h
    | ok gross =>
      simp only [hg] at h
      cases hle : lineExclusiveOf pre gross with
      | error e => simp [hle] at h
      | ok le =>
        simp only [hle] at h
        cases hm : liftNum (le.multiply sign) with
        | error e => simp [hm] at h
        | ok src =>
          simp only [hm] at h
          cases h1 : addPosting pre.line.sourcePostingId pre.line.sourceAccountId src
              (L * (pre.components.length * 2 + 4)) entries with
          | error e => simp [h1] at h
          | ok e1 =>
            simp only [h1] at h
            cases h2 : applyComponentPostings requestId isCreditFlag pre.line.lineId L
                (L * (pre.components.length * 2 + 4)) 0 (allocs.zip pre.components) e1
                src.negate with
            | error e => simp [h2] at h
            | ok r2 =>
              cases r2 with
              | inl d2 => simp [h2] at h
              | inr ec =>
                obtain ⟨e2, c2⟩ := ec
                simp only [h2] at h
                cases h3 : addPosting pre.line.counterpartyPostingId pre.line.payableAccountId c2
                    (L * (pre.components.length * 2 + 4) + pre.components.length * 2 + 2) e2 with
                | error e => simp [h3] at h
                | ok e3 =>
                  simp only [h3] at h
                  cases h4 : buildPostingsAndLineResults requestId isCreditFlag sign (L + 1) rest
                      e3 with
                  | error e => simp [h4] at h
                  | ok r4 =>
                    cases r4 with
                    | inl d4 => simp [h4] at h
                    | inr er =>
                      obtain ⟨eF, tail⟩ := er
                      simp only [h4, Except.ok.injEq, Sum.inr.injEq, Prod.mk.injEq] at h
                      obtain ⟨rfl, -⟩ := h
                      have here : ∀ k, (k = pre.line.sourceAccountId ∨
                          k = pre.line.payableAccountId ∨
                          ∃ c ∈ pre.components, TreatmentAccount c k) →
                          ∃ x ∈ (pre, allocs) :: rest, k = x.1.line.sourceAccountId ∨
                            k = x.1.line.payableAccountId ∨
                            ∃ c ∈ x.1.components, TreatmentAccount c k :=
                        fun k hk => ⟨(pre, allocs), by simp, hk⟩
                      intro k hk
                      rcases buildPostings_keys h4 k hk with hk | ⟨x, hx, hxk⟩
                      · rcases addPosting_keys h3 k hk with hk | rfl
                        · rcases applyComponentPostings_keys h2 k hk with hk | ⟨p, hp, hpk⟩
                          · rcases addPosting_keys h1 k hk with hk | rfl
                            · exact Or.inl hk
                            · exact Or.inr (here _ (Or.inl rfl))
                          · exact Or.inr (here _ (Or.inr (Or.inr
                              ⟨p.2, (List.of_mem_zip hp).2, hpk⟩)))
                        · exact Or.inr (here _ (Or.inr (Or.inl rfl)))
                      · exact Or.inr ⟨x, by simp [hx], hxk⟩

/-! ## What throws -/

/-- The error of the size limit (`representation_limit_exceeded`). -/
def limitErr : TaxErr := .exactNumber .representationLimitExceeded

theorem liftNum_error_limit {α : Type} {x : Except NumErr α} {e : TaxErr}
    (hx : ∀ c, x = .error c → c = .representationLimitExceeded) (h : liftNum x = .error e) :
    e = limitErr := by
  obtain ⟨c, hc, rfl⟩ := liftNum_eq_error_iff.mp h
  rw [hx c hc]; rfl

theorem add_error_limit {a b : ExactRational} (ha : a.WF) (hb : b.WF) :
    ∀ c, a.add b = .error c → c = .representationLimitExceeded := by
  intro c hc
  rcases ExactRational.add_ok_or_limit ha hb with ⟨r, hr⟩ | hr <;> rw [hr] at hc <;> cases hc
  rfl

theorem multiply_error_limit {a b : ExactRational} (ha : a.WF) (hb : b.WF) :
    ∀ c, a.multiply b = .error c → c = .representationLimitExceeded := by
  intro c hc
  rcases ExactRational.multiply_ok_or_limit ha hb with ⟨r, hr⟩ | hr <;> rw [hr] at hc <;> cases hc
  rfl

/-- The coefficients of line 1814 throw only for the size limit. -/
theorem computeCoefficients_error :
    ∀ {components : List TaxPolicyComponent} {coeffs : List (PolicyId × ExactRational)} {e : TaxErr},
      (∀ c ∈ components, c.rate.WF) → (∀ kv ∈ coeffs, kv.2.WF) →
      computeCoefficients coeffs components = .error e → e = limitErr
  | [], coeffs, e, _, _, h => by simp [computeCoefficients] at h
  | c :: rest, coeffs, e, hr, hc, h => by
    unfold computeCoefficients at h
    have hterms : ∀ v ∈ c.compoundsOn.map (fun id => (assocGet coeffs id).getD ExactRational.zero),
        v.WF := by
      intro v hv
      obtain ⟨id, -, rfl⟩ := List.mem_map.mp hv
      exact assocGet_wf hc id
    cases hs : accountingSum (c.compoundsOn.map fun id =>
        (assocGet coeffs id).getD ExactRational.zero) with
    | error c0 =>
      simp [hs, liftNum] at h
      subst h
      rw [accountingSum_error_is_limit hterms hs]; rfl
    | ok s =>
      simp only [hs, liftNum] at h
      obtain ⟨hsw, -⟩ := accountingSum_ok hterms hs
      cases ha : one.add s with
      | error c0 =>
        simp [ha] at h
        subst h
        rw [add_error_limit one_wf hsw c0 ha]; rfl
      | ok b =>
        simp only [ha] at h
        obtain ⟨hbw, -⟩ := ExactRational.add_ok one_wf hsw ha
        cases hm : b.multiply c.rate with
        | error c0 =>
          simp [hm] at h
          subst h
          rw [multiply_error_limit hbw (hr c (by simp)) c0 hm]; rfl
        | ok m =>
          simp only [hm] at h
          obtain ⟨hmw, -⟩ := ExactRational.multiply_ok hbw (hr c (by simp)) hm
          refine computeCoefficients_error (fun c' hc' => hr c' (by simp [hc'])) ?_ h
          intro kv hkv
          rcases mem_assocSet hkv with hkv | rfl
          · exact hc kv hkv
          · exact hmw


/-- The exact taxes of lines 1822 to 1827 throw only for the size limit. -/
theorem computeExactTaxes_error {exclusive : ExactRational} (hx : exclusive.WF) :
    ∀ {components : List TaxPolicyComponent} {seen : List (PolicyId × ExactRational)} {e : TaxErr},
      (∀ c ∈ components, c.rate.WF) → (∀ kv ∈ seen, kv.2.WF) →
      computeExactTaxes exclusive seen components = .error e → e = limitErr
  | [], seen, e, _, _, h => by simp [computeExactTaxes] at h
  | c :: rest, seen, e, hr, hc, h => by
    unfold computeExactTaxes at h
    have hterms : ∀ v ∈ c.compoundsOn.map (fun id => (assocGet seen id).getD ExactRational.zero),
        v.WF := by
      intro v hv
      obtain ⟨id, -, rfl⟩ := List.mem_map.mp hv
      exact assocGet_wf hc id
    cases hs : accountingSum (c.compoundsOn.map fun id =>
        (assocGet seen id).getD ExactRational.zero) with
    | error c0 =>
      simp [hs, liftNum] at h
      subst h
      rw [accountingSum_error_is_limit hterms hs]; rfl
    | ok s =>
      simp only [hs, liftNum] at h
      obtain ⟨hsw, -⟩ := accountingSum_ok hterms hs
      cases ha : exclusive.add s with
      | error c0 =>
        simp [ha] at h
        subst h
        rw [add_error_limit hx hsw c0 ha]; rfl
      | ok b =>
        simp only [ha] at h
        obtain ⟨hbw, -⟩ := ExactRational.add_ok hx hsw ha
        cases hm : b.multiply c.rate with
        | error c0 =>
          simp [hm] at h
          subst h
          rw [multiply_error_limit hbw (hr c (by simp)) c0 hm]; rfl
        | ok m =>
          simp only [hm] at h
          obtain ⟨hmw, -⟩ := ExactRational.multiply_ok hbw (hr c (by simp)) hm
          cases ht : computeExactTaxes exclusive (assocSet seen c.id m) rest with
          | error e' =>
            simp only [ht] at h
            cases h
            refine computeExactTaxes_error hx (fun c' hc' => hr c' (by simp [hc'])) ?_ ht
            intro kv hkv
            rcases mem_assocSet hkv with hkv | rfl
            · exact hc kv hkv
            · exact hmw
          | ok tail => simp [ht] at h

/-- The arithmetic of a line (lines 1813 to 1830) on valid components throws only for the size
limit: the gross coefficient is positive when it divides, so the division never meets zero. -/
theorem lineExact_error {line : TaxableLine} {components : List TaxPolicyComponent} {e : TaxErr}
    (hline : line.WF) (hwf : ∀ c ∈ components, c.WF) (hnodup : (components.map (·.id)).Nodup)
    (hgraph : ValidComponentGraph [] none line.amountIncludesTax components)
    (h : lineExact line components = .error e) : e = limitErr := by
  have hrates : ∀ c ∈ components, c.rate.WF := fun c hc => (hwf c hc).rate
  unfold lineExact at h
  cases hcc : computeCoefficients [] components with
  | error e' =>
    simp only [hcc] at h; cases h
    exact computeCoefficients_error hrates (fun _ h => by cases h) hcc
  | ok coeffs =>
    simp only [hcc] at h
    obtain ⟨-, hcoeff_inv, -, hcoeff_eq⟩ := computeCoefficients_ok components [] none
      line.amountIncludesTax [] coeffs hwf hnodup hgraph (fun _ hk => by cases hk) List.nodup_nil
      (fun _ _ hm => by cases hm) hcc
    have hterms : ∀ v ∈ grossCoefficientTerms coeffs components, v.WF := by
      intro v hv
      simp only [grossCoefficientTerms, List.mem_map] at hv
      obtain ⟨c, -, rfl⟩ := hv
      exact assocGet_wf (fun kv hkv => (hcoeff_inv kv hkv).2.1) c.id
    cases hts : accountingSum (grossCoefficientTerms coeffs components) with
    | error c0 =>
      simp [hts, liftNum] at h; subst h
      rw [accountingSum_error_is_limit hterms hts]; rfl
    | ok tcs =>
      simp only [hts, liftNum] at h
      obtain ⟨htw, -⟩ := accountingSum_ok hterms hts
      cases hgc : one.add tcs with
      | error c0 =>
        simp [hgc] at h; subst h
        rw [add_error_limit one_wf htw c0 hgc]; rfl
      | ok gc =>
        simp only [hgc] at h
        obtain ⟨hgw, -⟩ := ExactRational.add_ok one_wf htw hgc
        by_cases hpos : positive gc = true
        · simp only [hpos, Bool.not_true, Bool.false_eq_true, ↓reduceIte] at h
          have hgn : gc.numerator ≠ 0 := by
            intro h0
            have := (positive_iff hgw).mp hpos
            simp [ExactRational.toRat, h0] at this
          cases hexc : exclusiveOf line gc with
          | error e' =>
            simp only [hexc] at h; cases h
            unfold exclusiveOf at hexc
            split_ifs at hexc
            · rcases ExactRational.divide_ok_or_error (b := gc) hline.statedAmount with
                ⟨r, hr⟩ | ⟨h0, -⟩ | ⟨-, hr⟩
              · simp [hr, liftNum] at hexc
              · exact absurd h0 hgn
              · simp [hr, liftNum] at hexc; subst hexc; rfl
          | ok exclusive =>
            simp only [hexc] at h
            have hexw : exclusive.WF := by
              unfold exclusiveOf at hexc
              split_ifs at hexc
              · exact (ExactRational.divide_ok hline.statedAmount hgw (liftNum_ok hexc)).1
              · cases hexc; exact hline.statedAmount
            cases het : computeExactTaxes exclusive [] components with
            | error e' =>
              simp only [het] at h; cases h
              exact computeExactTaxes_error hexw hrates (fun _ h => by cases h) het
            | ok items =>
              simp only [het] at h
              obtain ⟨-, hiw, -⟩ := computeExactTaxes_ok exclusive coeffs components [] none
                line.amountIncludesTax [] items hexw hwf hnodup hgraph
                (fun _ hid => by cases hid) (fun _ hkv => by cases hkv) List.nodup_nil
                (fun _ _ hm => by cases hm)
                (fun c hc => by
                  obtain ⟨cf, hcf1, _, _, hcf2⟩ := hcoeff_eq c hc
                  exact ⟨cf, hcf1, hcf2⟩) het
              have hgt : ∀ v ∈ grossTaxTerms items, v.WF := by
                intro v hv
                simp only [grossTaxTerms, List.mem_map, List.mem_filter] at hv
                obtain ⟨item, ⟨hm, -⟩, rfl⟩ := hv
                exact hiw item hm
              cases hg : accountingSum (grossTaxTerms items) with
              | error c0 =>
                simp [hg] at h; subst h
                rw [accountingSum_error_is_limit hgt hg]; rfl
              | ok gt =>
                simp only [hg] at h
                obtain ⟨hgtw, -⟩ := accountingSum_ok hgt hg
                split_ifs at h
                · cases hr : exclusive.add gt with
                  | error c0 =>
                    simp [hr] at h; subst h
                    rw [add_error_limit hexw hgtw c0 hr]; rfl
                  | ok r => simp only [hr] at h; split_ifs at h
        · simp only [Bool.not_eq_true] at hpos
          simp [hpos] at h

/-- One pass of the line loop throws only for the size limit. -/
theorem preResolveLine_error {policies : List AccountingPolicy} {bookId : BookId}
    {governedAt : Instant} {isSaleFlag : Bool} {common : CommonRounding} {line : TaxableLine}
    {e : TaxErr} (hpols : ∀ p ∈ policies, p.WF) (hline : line.WF)
    (h : preResolveLine policies bookId governedAt isSaleFlag common line = .error e) :
    e = limitErr := by
  unfold preResolveLine at h
  cases hc : lineCheck policies bookId governedAt isSaleFlag common line with
  | inl d => simp [hc] at h
  | inr policy =>
    simp only [hc] at h
    obtain ⟨-, -, hvalid, hcwf⟩ := lineCheck_components hpols hc
    cases he : lineExact line (sortComponents policy.components) with
    | error e' =>
      simp only [he] at h; cases h
      exact lineExact_error hline hcwf hvalid.2.2.1 hvalid.2.2.2.1 he
    | ok r => cases r <;> simp [he] at h

/-- The line loop (lines 1782 to 1833) throws only for the size limit. -/
theorem preResolveLines_error {policies : List AccountingPolicy} {bookId : BookId}
    {governedAt : Instant} {isSaleFlag : Bool} (hpols : ∀ p ∈ policies, p.WF) :
    ∀ {common : CommonRounding} {lines : List TaxableLine} {e : TaxErr},
      (∀ l ∈ lines, l.WF) →
      preResolveLines policies bookId governedAt isSaleFlag common lines = .error e →
      e = limitErr
  | common, [], e, _, h => by simp [preResolveLines] at h
  | common, line :: rest, e, hw, h => by
    unfold preResolveLines at h
    cases hl : preResolveLine policies bookId governedAt isSaleFlag common line with
    | error e' =>
      simp only [hl] at h; cases h
      exact preResolveLine_error hpols (hw line (by simp)) hl
    | ok r =>
      cases r with
      | inl d => simp [hl] at h
      | inr pre =>
        simp only [hl] at h
        cases hr : preResolveLines policies bookId governedAt isSaleFlag
            (nextCommon common pre.policy) rest with
        | error e' =>
          simp only [hr] at h; cases h
          exact preResolveLines_error hpols (fun l hl' => hw l (by simp [hl'])) hr
        | ok r' => cases r' <;> simp [hr] at h

/-- Line-level rounding of a component (lines 1916 to 1940) throws for the size limit, or with the
`RangeError` of `quantize` exactly when the policy's scale is outside 0 to 1000. -/
theorem allocateLineComponent_error {qp : QuantizationPolicy} {item : ComponentExactTax}
    {e : TaxErr} (hx : item.exactTax.WF) (hs : item.component.recoverableShare.WF)
    (h : allocateLineComponent qp item = .error e) :
    e = limitErr ∨ (e = .scaleOutOfRange ∧ (qp.targetScale < 0 ∨ maxDecimalScale < qp.targetScale)) := by
  by_cases hsc : qp.targetScale < 0 ∨ maxDecimalScale < qp.targetScale
  · have hq : quantize item.exactTax qp.rule = .error .scaleOutOfRange := by
      have hc' : qp.targetScale < 0 ∨ qp.targetScale > maxDecimalScale := by
        simpa [gt_iff_lt] using hsc
      simp [quantize, QuantizationPolicy.rule, hc']
    simp [allocateLineComponent, hq, liftQuantize] at h
    exact Or.inr ⟨h.symm, hsc⟩
  · left
    have h0 : 0 ≤ qp.rule.targetScale := by simp [QuantizationPolicy.rule]; omega
    have h1 : qp.rule.targetScale ≤ maxDecimalScale := by simp [QuantizationPolicy.rule]; omega
    unfold allocateLineComponent at h
    cases hq : quantize item.exactTax qp.rule with
    | error e' =>
      have := quantize_error hx h0 h1 hq
      subst this
      simp [hq, liftQuantize] at h; subst h; rfl
    | ok q =>
      simp only [hq, liftQuantize] at h
      obtain ⟨hqa, -⟩ := quantize_ok hx hq
      obtain ⟨qa, hqr, -⟩ := ExactDecimal.toRational_isOk hqa
      simp only [hqr, liftNum] at h
      obtain ⟨hqaw, -⟩ := ExactDecimal.toRational_ok hqa hqr
      cases hres : item.exactTax.subtract qa with
      | error c0 =>
        simp [hres] at h; subst h
        rcases ExactRational.subtract_ok_or_limit hx hqaw with ⟨r, hr⟩ | hr <;> rw [hr] at hres <;>
          cases hres
        rfl
      | ok res =>
        simp only [hres] at h
        split_ifs at h
        cases hm : qa.multiply item.component.recoverableShare with
        | error c0 =>
          simp [hm] at h; subst h
          rw [multiply_error_limit hqaw hs c0 hm]; rfl
        | ok t =>
          simp only [hm] at h
          obtain ⟨htw, -⟩ := ExactRational.multiply_ok hqaw hs hm
          cases hq2 : quantize t qp.rule with
          | error e' =>
            have := quantize_error htw h0 h1 hq2
            subst this
            simp [hq2] at h; subst h; rfl
          | ok q2 =>
            simp only [hq2] at h
            obtain ⟨hq2a, -⟩ := quantize_ok htw hq2
            obtain ⟨r2, hr2, -⟩ := ExactDecimal.toRational_isOk hq2a
            simp only [hr2] at h
            obtain ⟨hr2w, -⟩ := ExactDecimal.toRational_ok hq2a hr2
            cases hn : qa.subtract r2 with
            | error c0 =>
              simp [hn] at h; subst h
              rcases ExactRational.subtract_ok_or_limit hqaw hr2w with ⟨r, hr⟩ | hr <;>
                rw [hr] at hn <;> cases hn
              rfl
            | ok n => simp [hn] at h


/-- The size limit is not the only error: line-level rounding throws the `RangeError` of
`quantize` for a policy whose scale is outside 0 to 1000 (`quantization.ts` line 124). -/
theorem allocateLineComponent_scale {qp : QuantizationPolicy} (item : ComponentExactTax)
    (hsc : qp.targetScale < 0 ∨ maxDecimalScale < qp.targetScale) :
    allocateLineComponent qp item = .error .scaleOutOfRange := by
  have hc' : qp.targetScale < 0 ∨ qp.targetScale > maxDecimalScale := by
    simpa [gt_iff_lt] using hsc
  simp [allocateLineComponent, quantize, QuantizationPolicy.rule, hc', liftQuantize]

/-- At the level of `determineTax`: when the stages reach line-level rounding and the first line
with a component has a policy whose scale is outside 0 to 1000, `determineTax` throws the
`RangeError`, not a size-limit error. -/
theorem determineTax_scale_error {policies : List AccountingPolicy} {bookId : BookId}
    {commodityId : CommodityId} {request : TaxRequest} {lvlQp : TaxRoundingLevel × QuantizationPolicy}
    {pre : PreResolvedTaxLine} {rest : List PreResolvedTaxLine} {item : ComponentExactTax}
    {items : List ComponentExactTax}
    (h1 : requestRejected request = false) (h2 : invalidTaxLines request.lines = false)
    (hp : preResolveLines policies bookId request.governedAt (isSale request.direction) none
      request.lines = .ok (.inr (some lvlQp, pre :: rest)))
    (hlvl : lvlQp.1 = .lineLevel) (hitems : pre.componentExactTaxes = item :: items)
    (hsc : pre.policy.quantizationPolicy.targetScale < 0 ∨
      maxDecimalScale < pre.policy.quantizationPolicy.targetScale) :
    determineTax policies bookId commodityId request = .error .scaleOutOfRange := by
  obtain ⟨lvl, qp⟩ := lvlQp
  simp only at hlvl
  subst hlvl
  simp [determineTax, h1, h2, hp, allocate, allocateLineLevel, hitems, allocateLineComponents,
    allocateLineComponent_scale item hsc]

/-- Line level: each component's rounded tax is less than one unit of the scale from its exact tax
(at most half a unit in the two half modes), and its residual is the difference. -/
theorem lineLevel_within_unit {rule : QuantizationRule} {item : ComponentExactTax}
    {alloc : AllocatedComponent} (hx : item.exactTax.WF)
    (h : AllocationSpec rule item alloc ∧
      ∃ q, quantize item.exactTax rule = .ok q ∧ alloc.quantization.amount = q.amount) :
    |alloc.quantizedAmount.toRat - item.exactTax.toRat| < rule.unit ∧
      ((rule.roundingMode = .halfEven ∨ rule.roundingMode = .halfAwayFromZero) →
        |alloc.quantizedAmount.toRat - item.exactTax.toRat| ≤ rule.unit / 2) ∧
      alloc.quantization.residual.toRat = item.exactTax.toRat - alloc.quantizedAmount.toRat := by
  obtain ⟨spec, q, hq, hamt⟩ := h
  have he : alloc.quantizedAmount.toRat = q.amount.toRat := by
    rw [← spec.amount_toRat, hamt]
  rw [he]
  exact ⟨quantize_within_one_unit hx hq, quantize_within_half_unit hx hq,
    by rw [spec.residual_toRat, he]⟩

end Tax

end Rastrata.Kernel
