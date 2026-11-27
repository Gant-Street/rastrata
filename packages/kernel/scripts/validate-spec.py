#!/usr/bin/env python3
"""Validate the bounded SysML contract and its one golden-company fixture."""

from __future__ import annotations

import json
import hashlib
import re
import sys
from fractions import Fraction
from pathlib import Path


ROOT = Path(__file__).resolve().parent.parent / "spec"
MODEL_PATH = ROOT / "rastrata-accounting-backend.sysml"
FIXTURE_PATH = ROOT / "golden-company.json"
VERIFICATION_CASES_PATH = ROOT / "kernel-v1-verification-cases.json"
DESIGN_CASES_PATH = ROOT / "kernel-design-verification-cases.json"

BASELINE_KERNEL_REQUIREMENT_IDS = {
    "ACC-001", "ACC-002", "ACC-003", "ACC-004", "ACC-005", "ACC-006",
    "ACC-007", "ACC-008", "ACC-009", "ACC-010", "ACC-011", "ACC-012",
    "ACC-013", "ACC-014", "ACC-017", "ACC-018", "ACC-019", "ACC-021",
    "ACC-022", "ACC-023", "ACC-026", "ACC-027", "ACC-028", "ACC-029",
    "ACC-030", "ACC-031", "ACC-032", "ACC-034",
    "ACC-037", "ACC-038",
}
ACCOUNTING_EXTENSION_REQUIREMENT_IDS = {f"ACC-{number:03d}" for number in range(39, 48)}
REOPENED_KERNEL_REQUIREMENT_IDS: set[str] = set()
IMPLEMENTED_KERNEL_REQUIREMENT_IDS = (
    BASELINE_KERNEL_REQUIREMENT_IDS | ACCOUNTING_EXTENSION_REQUIREMENT_IDS
) - REOPENED_KERNEL_REQUIREMENT_IDS
ATOMIC_REQUIREMENT_COUNTS = {
    "039": 9,
    "040": 5,
    "041": 6,
    "042": 6,
    "043": 6,
    "044": 6,
    "045": 7,
    "046": 8,
    "047": 5,
}
KERNEL_REQUIREMENT_IDS = (
    IMPLEMENTED_KERNEL_REQUIREMENT_IDS | REOPENED_KERNEL_REQUIREMENT_IDS
)
PROOF_REQUIREMENT_IDS = {"ACC-015", "ACC-016", "ACC-024", "ACC-033"}
BOUNDARY_REQUIREMENT_IDS = {"ACC-020", "ACC-025", "ACC-035", "ACC-036"}
DESIGN_PENDING_ATOMIC_REQUIREMENT_IDS: set[str] = set()


def require(condition: bool, message: str) -> None:
    if not condition:
        raise AssertionError(message)


def validate_design_architecture(model: str) -> dict[str, int]:
    for obsolete_token in ("Kernel" + "V2", "K2" + "-", "kernel-" + "v2"):
        require(obsolete_token not in model,
                f"The unified kernel model must not contain {obsolete_token}")

    require(model.count("out item intent : Domain::BookCommitIntent;") == 1,
            "Exactly one action may output a BookCommitIntent")
    command_variants = {
        "activateBook": ("ActivateBookCommand", "AccountingCommandPayload[0]"),
        "postJournal": ("PostJournalCommand", "AccountingCommandPayload[0]"),
        "correctJournal": ("CorrectJournalCommand", "AccountingCommandPayload[0]"),
        "closePeriod": ("ClosePeriodCommand", "AccountingCommandPayload[0]"),
        "reopenPeriod": ("ReopenPeriodCommand", "AccountingCommandPayload[0]"),
        "replaceConfiguration": ("ReplaceConfigurationCommand", "PolicyAdoptionPayload[1]"),
        "postInventoryTransaction": ("PostInventoryTransactionCommand", "InventoryCostPayload[1]"),
        "postOwnedInventoryTransaction": ("PostOwnedInventoryTransactionCommand", "OwnedInventoryPayload[1]"),
        "recostProvisionalInventory": ("RecostProvisionalInventoryCommand", "InventoryCostPayload[1]"),
        "adjustInventoryValue": ("AdjustInventoryValueCommand", "InventoryValueAdjustmentPayload[1]"),
        "recognizeOpenItem": ("RecognizeOpenItemCommand", "OpenItemRecognitionPayload[1]"),
        "applySettlement": ("ApplySettlementCommand", "SettlementPayload[1]"),
        "postCurrencyRemeasurement": ("PostCurrencyRemeasurementCommand", "RemeasurementPayload[1]"),
        "createAllocationSchedule": ("CreateAllocationScheduleCommand", "AllocationSchedulePayload[1]"),
        "recognizeScheduledAllocation": ("RecognizeScheduledAllocationCommand", "AllocationRecognitionPayload[1]"),
        "reviseAllocationSchedule": ("ReviseAllocationScheduleCommand", "AllocationScheduleRevisionPayload[1]"),
        "postTaxedTransaction": ("PostTaxedTransactionCommand", "TaxPayload[1]"),
        "compileConsolidation": ("CompileConsolidationCommand", "ConsolidationPayload[1]"),
    }
    command_kind_block = model.split("enum def BookCommandKind {", 1)[1].split("}", 1)[0]
    declared_command_kinds = set(re.findall(
        r"^\s*([a-z][A-Za-z0-9_]*)\s*;", command_kind_block, re.MULTILINE
    ))
    require(declared_command_kinds == set(command_variants),
            "Every and only declared BookCommandKind must have a typed variant")
    for command_kind, (variant_name, payload_type) in command_variants.items():
        match = re.search(
            rf"item def {variant_name} :> BookCommand \{{(?P<body>.*?)\n        \}}",
            model,
            re.DOTALL,
        )
        require(match is not None, f"Missing typed command variant {variant_name}")
        body = match.group("body")
        require(f"BookCommandKind::{command_kind};" in body,
                f"{variant_name} must fix command kind {command_kind}")
        require(f"item :>> accountingPayload : {payload_type};" in body,
                f"{variant_name} must fix its exact payload type and multiplicity")
    # Bounded declaration checks, not command execution or conformance evidence.
    # The new topology is deliberately counted as design-pending until the
    # production command, codecs, complete source closure and replay are tested.
    owned_request = model.split("item def OwnedInventoryTransactionRequest {", 1)[1].split("\n        }", 1)[0]
    require("item operation : OwnedInventoryOperationInput[1..*] ordered;" in owned_request,
            "Owned inventory operations must be nonempty and ordered")
    require("item resolvedJournal : ResolvedTransaction[0..*] ordered;" in owned_request,
            "Owned inventory must permit no journal and preserve real journal order")
    owned_command = model.split("item def PostOwnedInventoryTransactionCommand :> BookCommand {", 1)[1].split("\n        }", 1)[0]
    require("item :>> resolvedTransaction : ResolvedTransaction[0];" in owned_command,
            "Owned inventory must not inherit an ambiguous second journal input")
    quantity_allocation = model.split("item def InventoryQuantityAllocation {", 1)[1].split("\n        }", 1)[0]
    require("CanonicalPostingReference" not in quantity_allocation,
            "Quantity-only economic allocations cannot require a posting reference")
    legacy_allocation = model.split("item def LotAllocation {", 1)[1].split("\n        }", 1)[0]
    require("item reducingSource : CanonicalPostingReference;" in legacy_allocation,
            "Owned allocation design must not weaken the legacy allocation shape")
    evaluate_book_command = model.split("action def EvaluateBookCommand {", 1)[1].split(
        "action def EvaluateInventoryCost {", 1
    )[0]
    require("out item intent : Domain::BookCommitIntent;" in evaluate_book_command,
            "EvaluateBookCommand must be the sole BookCommitIntent factory")
    require("in item bookState : Domain::BookStateSnapshot;" in evaluate_book_command
            and "in item command : Domain::BookCommand;" in evaluate_book_command,
            "EvaluateBookCommand must consume the complete snapshot and typed command")

    calculator_names = (
        "EvaluateInventoryCost",
        "EvaluateInventoryValueAdjustment",
        "EvaluateOpenItemRecognition",
        "EvaluateSettlement",
        "CompileCurrencyRemeasurement",
        "CompileAllocationSchedule",
        "RecognizeScheduledAllocation",
        "ReviseAllocationSchedule",
        "DetermineTax",
        "CompileConsolidation",
    )
    for name in calculator_names:
        match = re.search(
            rf"action def {name} \{{(?P<body>.*?)\n        \}}",
            model,
            re.DOTALL,
        )
        require(match is not None, f"Missing specialized calculator {name}")
        body = match.group("body")
        require("Domain::BookStateSnapshot" in body and "Domain::BookCommand" in body,
                f"{name} must consume canonical state and a typed command")
        require("out item draft : Domain::BookEffectDraft;" in body,
                f"{name} must output only a noncanonical BookEffectDraft")
        require("BookCommitIntent" not in body and "ValidatedBookedJournal" not in body,
                f"{name} must not create canonical intent or journals")

    projection = model.split("action def ProjectAccountingBasis {", 1)[1].split(
        "action def CompileCurrencyRemeasurement {", 1
    )[0]
    require("in item readSnapshot : Domain::AccountingReadSnapshot;" in projection
            and "out item projection : Domain::AccountingBasisProjection;" in projection,
            "Accounting-basis projection must be a pinned read-side computation")
    require("BookCommitIntent" not in projection and "BookEffectDraft" not in projection,
            "Read-side basis projection must not create canonical effects")

    state_snapshot = model.split("item def BookStateSnapshot {", 1)[1].split(
        "item def BookingPolicy {", 1
    )[0]
    policy_types = (
        "InventoryCostPolicy",
        "InventoryValueAdjustmentPolicy",
        "AccountingBasisPolicy",
        "MonetaryClassificationPolicy",
        "RemeasurementPolicy",
        "AllocationSchedulePolicy",
        "TaxPolicy",
        "ConsolidationPolicy",
    )
    for policy_type in policy_types:
        require(f": {policy_type}[0..*];" in state_snapshot,
                f"BookStateSnapshot must contain canonical {policy_type}")
    for field in (
        "attribute configurationRevision : Natural;",
        "attribute configurationHash : Semantics::ContentHash;",
        "item configurationSnapshot : BookConfigurationSnapshot[1..*];",
        "item activeConfigurationSnapshot : BookConfigurationSnapshot;",
    ):
        require(field in state_snapshot,
                f"BookStateSnapshot must pin complete configuration state: {field}")
    require(model.count("item featureCapability : AccountingFeatureCapability;") == 8,
            "Every accounting policy family must pin executable capability evidence")

    policy_adoption = model.split("item def AccountingPolicyAdoption {", 1)[1].split(
        "item def AccountingCommandPayload {", 1
    )[0]
    for field in (
        "attribute expectedConfigurationRevision : Natural;",
        "attribute nextConfigurationRevision : Natural;",
        "attribute previousConfigurationHash : Semantics::ContentHash;",
        "attribute resultingConfigurationHash : Semantics::ContentHash;",
        "item previousSnapshot : BookConfigurationSnapshot;",
        "item resultingSnapshot : BookConfigurationSnapshot;",
    ):
        require(field in policy_adoption,
                f"Accounting policy adoption must be an ordered configuration effect: {field}")

    close_checkpoint = model.split("item def CloseCheckpoint {", 1)[1].split(
        "item def ClosePackage {", 1
    )[0]
    for field in (
        "attribute configurationRevision : Natural;",
        "attribute configurationSnapshotHash : Semantics::ContentHash;",
        "attribute bookStateSnapshotHash : Semantics::ContentHash;",
        "item configurationSnapshot : BookConfigurationSnapshot;",
    ):
        require(field in close_checkpoint,
                f"Close checkpoint must pin configuration and replay state: {field}")

    immutable_effects = (
        "ProvisionalInventoryLayer",
        "InventoryRecosting",
        "InventoryValueAdjustment",
        "OpenItem",
        "Settlement",
        "SettlementAllocation",
        "AllocationSchedule",
        "AllocationRecognition",
        "AllocationScheduleRevision",
        "TaxDetermination",
        "RemeasurementResult",
        "RemeasurementReversal",
        "ConsolidationCompilation",
    )
    commit_intent = model.split("item def BookCommitIntent {", 1)[1].split(
        "item def AtomicBookCommit {", 1
    )[0]
    for effect_type in immutable_effects:
        require(effect_type in state_snapshot and effect_type in commit_intent,
                f"{effect_type} must be replayable canonical state and a commit effect")
        effect_body = model.split(f"item def {effect_type} {{", 1)[1].split("\n        }", 1)[0]
        require("attribute contentHash : Semantics::ContentHash;" in effect_body,
                f"{effect_type} must have independently verifiable immutable identity")
        require("DerivationRecord" in effect_body,
                f"{effect_type} must carry explicit source and policy lineage")

    forbidden_second_truths = (
        "attribute outstandingBookValue",
        "item originalBookValue : BookValue",
        "item settledBookValue : BookValue",
        "item issuedQuantity : Quantity",
        "item provisionalTotalBasis : CostBasis",
        "item resolvedQuantity : Quantity",
        "item finalTotalBasis : CostBasis",
        "Semantics::ProvisionalCostStatus",
        "item generatedJournal : ValidatedBookedJournal",
        "item adjustmentJournal : ValidatedBookedJournal",
        "item reversalJournal : ValidatedBookedJournal",
    )
    for token in forbidden_second_truths:
        require(token not in model,
                f"Mutable or alternate accounting truth is forbidden: {token}")

    required_explicit_inputs = (
        "item def InventoryRecostingSource",
        "item def InventoryValueAdjustmentAllocation",
        "item def CanonicalPostingReference",
        "item def GeneratedPostingDimensionSelection",
        "item def AccountingBasisReconciliation",
        "item def AccountingBasisSourceEvent",
        "item def TaxBasisInput",
        "item def ConsolidationRelationship",
        "item def ConsolidationTranslationRule",
        "item classificationRule : MonetaryClassificationRule;",
        "item valuationPath : ValuationPath[0..*];",
    )
    for token in required_explicit_inputs:
        require(token in model, f"Missing explicit accounting input: {token}")

    enterprise_foundation_contracts = (
        "item allocatedOpenItemBookValue : BookValue;",
        "item allocatedSettlementBookValue : BookValue;",
        "item realizedExchangeDifference : QuantizationResult[0..1];",
        "item exactReversalOf : ValidatedBookedJournal;",
        "item source : CanonicalPostingReference;",
        "item reconciliation : AccountingBasisReconciliation;",
        "item generatedPostingDimensionSelection : GeneratedPostingDimensionSelection[0..*];",
        "item inventoryValueAdjustment : InventoryValueAdjustment[0..*];",
        "item allocationScheduleRevision : AllocationScheduleRevision[0..*];",
    )
    for token in enterprise_foundation_contracts:
        require(token in model, f"Missing enterprise-foundation contract: {token}")

    return {
        "typed_command_variants": len(command_variants),
        "design_pending_command_variants": 1,
        "canonical_intent_factories": 1,
        "pure_accounting_calculators": len(calculator_names),
        "canonical_accounting_policies": len(policy_types),
        "replayable_accounting_effect_types": len(immutable_effects),
        "explicit_cross_cutting_input_guards": len(required_explicit_inputs),
        "enterprise_foundation_contracts": len(enterprise_foundation_contracts),
    }


def validate_diagnostic_catalogs(model: str, *catalogs: dict) -> dict[str, int]:
    diagnostic_block = model.split("enum def SemanticDiagnosticCode {", 1)[1].split(
        "}", 1
    )[0]
    declared_codes = set(re.findall(
        r"^\s*([a-z][A-Za-z0-9_]*)\s*;",
        diagnostic_block,
        re.MULTILINE,
    ))
    used_codes = set()
    for catalog in catalogs:
        for case in catalog["cases"]:
            if case["outcome"] != "reject":
                continue
            instances = case.get("scenarios", [case])
            used_codes.update(instance["expect"]["diagnostic"] for instance in instances)
    require(used_codes <= declared_codes,
            f"Verification catalogs use undeclared diagnostics: {sorted(used_codes - declared_codes)}")
    return {
        "declared_codes": len(declared_codes),
        "rejection_codes_in_cases": len(used_codes),
    }


def validate_traceability(model: str) -> dict[str, int]:
    requirements_package = model.split("package Requirements {", 1)[1].split(
        "package Behavior {", 1
    )[0]
    requirement_ids = re.findall(r"requirement def <'ACC-(\d{3})'>", model)
    require(len(requirement_ids) == 47,
            "The accounting-kernel model must contain exactly 47 classified ACC requirements")
    require(len(set(requirement_ids)) == 47, "ACC requirement IDs must be unique")
    require(requirement_ids == [f"{number:03d}" for number in range(1, 48)],
            "ACC requirement IDs must be contiguous from ACC-001 through ACC-047")

    atomic_requirement_ids = re.findall(
        r"requirement def <'ACC-(\d{3})\.(\d+)'>",
        model,
    )
    require(len(atomic_requirement_ids) == sum(ATOMIC_REQUIREMENT_COUNTS.values()),
            "The nine designed parents must have the complete atomic decomposition")
    require(len(atomic_requirement_ids) == len(set(atomic_requirement_ids)),
            "Atomic requirement IDs must be unique")
    for parent, count in ATOMIC_REQUIREMENT_COUNTS.items():
        children = [int(child) for candidate, child in atomic_requirement_ids
                    if candidate == parent]
        require(children == list(range(1, count + 1)),
                f"ACC-{parent} atomic child IDs must be contiguous from 1 through {count}")
    declared_atomic_ids = {f"ACC-{parent}.{child}" for parent, child in atomic_requirement_ids}
    require(DESIGN_PENDING_ATOMIC_REQUIREMENT_IDS <= declared_atomic_ids,
            "Every design-pending atomic ID must be defined in the model")
    trace = json.loads((ROOT / "kernel-code-trace-manifest.json").read_text(encoding="utf-8"))
    traced_pending = {key for key, value in trace["requirements"].items()
                      if value["disposition"] == "design-pending"}
    require(traced_pending == DESIGN_PENDING_ATOMIC_REQUIREMENT_IDS | REOPENED_KERNEL_REQUIREMENT_IDS,
            "Design-pending oracle scope must exactly match the release-blocking semantic trace")

    full_requirement_ids = {f"ACC-{identifier}" for identifier in requirement_ids}
    scoped_ids = KERNEL_REQUIREMENT_IDS | PROOF_REQUIREMENT_IDS | BOUNDARY_REQUIREMENT_IDS
    require(scoped_ids == full_requirement_ids,
            "Kernel, proof, and boundary requirement scopes must partition every ACC ID")
    require(not (KERNEL_REQUIREMENT_IDS & PROOF_REQUIREMENT_IDS)
            and not (KERNEL_REQUIREMENT_IDS & BOUNDARY_REQUIREMENT_IDS)
            and not (PROOF_REQUIREMENT_IDS & BOUNDARY_REQUIREMENT_IDS),
            "Requirement scopes must not overlap")

    usages = re.findall(r"^\s*requirement\s+([a-z][A-Za-z0-9]*)\s*:\s*[A-Z][A-Za-z0-9]*;",
                        requirements_package, re.MULTILINE)
    expected_usage_count = 47 + len(atomic_requirement_ids)
    require(len(usages) == expected_usage_count,
            "Every parent and atomic ACC definition must have one requirement usage")
    require(len(set(usages)) == expected_usage_count,
            "Requirement usage names must be unique")

    satisfies = re.findall(r"satisfy Requirements::([a-z][A-Za-z0-9]*)\s+by", model)
    verifies = re.findall(r"verify Requirements::([a-z][A-Za-z0-9]*);", model)

    atomic_usages = usages[47:]
    for usage in usages:
        required_satisfactions = 1
        require(satisfies.count(usage) >= required_satisfactions,
                f"Requirement {usage} must have an architectural satisfaction")
        require(usage in verifies, f"Requirement {usage} has no verification objective")
    for usage in atomic_usages:
        require(satisfies.count(usage) == 1,
                f"Atomic requirement {usage} must have exactly one responsible owner")
        require(verifies.count(usage) == 1,
                f"Atomic requirement {usage} must have exactly one verification objective")

    derived_children = re.findall(r"end #derive ::> ([a-z][A-Za-z0-9]*);", requirements_package)
    require(len(derived_children) == len(atomic_usages),
            "Every atomic requirement must have one parent derivation")
    require(set(derived_children) == set(atomic_usages),
            "Atomic derivations must cover every and only atomic requirement usage")

    require(set(satisfies) == set(usages), "Satisfaction relations reference an unknown requirement")
    require(set(verifies) == set(usages), "Verification objectives reference an unknown requirement")

    semantic_packages = model.split("package Architecture", 1)[0]
    for platform_token in ("Cloudflare", "Durable Object", "SQLite", "PostgreSQL"):
        require(platform_token not in semantic_packages,
                f"Semantic packages must remain deployment-neutral: found {platform_token}")

    required_verifications = {
        "GoldenCompanyYearCase",
        "AdversarialKernelCase",
        "CommandReplayAndAtomicCommitCase",
        "PeriodCloseReopenCase",
        "ProjectionRebuildCase",
        "CrossBookRecoveryCase",
        "StorageParityCase",
        "EmptyBookActivationCase",
        "CanonicalJournalStructureCase",
        "CorrectionTopologyCase",
        "ChartAndCalendarIntegrityCase",
        "DownstreamCloseImpactCase",
        "PolicyAndQuantizationAdmissionCase",
        "DimensionalIntegrityCase",
        "CanonicalIdentityCase",
    }
    present_verifications = set(re.findall(r"verification def\s+([A-Za-z][A-Za-z0-9]*)", model))
    missing = required_verifications - present_verifications
    require(not missing, f"Missing kernel closure verifications: {sorted(missing)}")

    return {
        "requirements": len(requirement_ids),
        "atomic_requirements": len(atomic_requirement_ids),
        "kernel_requirements": len(KERNEL_REQUIREMENT_IDS),
        "proof_requirements": len(PROOF_REQUIREMENT_IDS),
        "boundary_requirements": len(BOUNDARY_REQUIREMENT_IDS),
        "satisfactions": len(satisfies),
        "verification_definitions": len(present_verifications),
        "verification_objectives": len(verifies),
        "implemented_kernel_requirements": len(IMPLEMENTED_KERNEL_REQUIREMENT_IDS),
        "designed_not_implemented_requirements": len(REOPENED_KERNEL_REQUIREMENT_IDS) + len(DESIGN_PENDING_ATOMIC_REQUIREMENT_IDS),
    }


def add_postings(balances: dict[str, int], postings: dict[str, int]) -> None:
    for account, amount in postings.items():
        balances[account] += amount


def validate_golden_company(fixture: dict) -> dict[str, int]:
    require(fixture["version"] == "rastrata-kernel-golden-company-v1",
            "Unexpected golden-company version")
    require(fixture["sign_convention"] == "debit positive, credit negative",
            "Fixture sign convention changed")

    accounts = fixture["accounts"]
    journals = fixture["journals"]
    allowed_journal_kinds = {
        "opening", "ordinary", "adjustment", "reversing", "closing",
    }
    require(all(journal["kind"] in allowed_journal_kinds for journal in journals),
            "Golden company contains a journal kind outside the SysML vocabulary")
    require(journals[0]["kind"] == "opening",
            "Golden company must begin with its opening journal")
    require(journals[-1]["kind"] == "closing",
            "Golden company must end with its closing journal")
    journal_ids = [journal["id"] for journal in journals]
    command_ids = [journal["command_id"] for journal in journals]
    require(len(journal_ids) == len(set(journal_ids)), "Journal IDs must be unique")
    require(len(command_ids) == len(set(command_ids)), "Committed command IDs must be unique")

    posting_sequences = [journal["posting_sequence"] for journal in journals]
    require(posting_sequences == list(range(1, len(journals) + 1)),
            "Journal posting sequence must be gap-free")

    revisions = [journal["revision"] for journal in journals]
    require(revisions == sorted(revisions), "Journal revisions must increase")
    all_revisions = revisions + [row["revision"] for row in fixture["non_journal_revisions"]]
    require(sorted(all_revisions) == list(range(1, max(all_revisions) + 1)),
            "Book revisions must be gap-free across journal and non-journal effects")

    by_id = {journal["id"]: journal for journal in journals}
    pre_close: dict[str, int] = {account: 0 for account in accounts}
    post_close: dict[str, int] = {account: 0 for account in accounts}

    for journal in journals:
        postings = journal["postings"]
        require(len(postings) >= 2, f"{journal['id']} must have at least two postings")
        require(all(account in accounts for account in postings),
                f"{journal['id']} references an unknown account")
        require(all(isinstance(amount, int) and amount != 0 for amount in postings.values()),
                f"{journal['id']} contains a zero or non-integer booked value")
        require(sum(postings.values()) == 0, f"{journal['id']} is not exactly balanced")
        add_postings(post_close, postings)
        if journal["kind"] != "closing":
            add_postings(pre_close, postings)

    reversal = by_id["J013"]
    original = by_id[reversal["reverses"]]
    require(set(reversal["postings"]) == set(original["postings"]),
            "Reversal must use the original accounts")
    for account, amount in original["postings"].items():
        require(reversal["postings"][account] == -amount,
                f"Reversal does not exactly negate {account}")
    require(by_id["J014"]["replaces"] == original["id"],
            "Replacement must retain the corrected journal identity")

    expected_pre = fixture["expected_pre_close_balances"]
    expected_post = fixture["expected_post_close_balances"]
    require(dict(pre_close) == expected_pre, "Pre-close account balances changed")
    require(dict(post_close) == expected_post, "Post-close account balances changed")
    require(sum(pre_close.values()) == 0, "Pre-close trial balance does not balance")
    require(sum(post_close.values()) == 0, "Post-close trial balance does not balance")

    lot_ids = [lot["id"] for lot in fixture["lots"]]
    require(len(lot_ids) == len(set(lot_ids)), "Lots must have stable distinct identities")
    require(len({(lot["acquired_at"], lot["label"]) for lot in fixture["lots"]}) == 1,
            "Golden lots must prove identity does not derive from date and label")

    for lot in fixture["lots"]:
        original_quantity = Fraction(lot["original_quantity"])
        consumed_quantity = Fraction(lot["consumed_quantity"])
        remaining_quantity = Fraction(lot["remaining_quantity"])
        original_basis = Fraction(lot["original_basis"])
        consumed_basis = Fraction(lot["consumed_basis"])
        remaining_basis = Fraction(lot["remaining_basis"])
        require(original_quantity == consumed_quantity + remaining_quantity,
                f"{lot['id']} quantity is not conserved")
        require(original_basis == consumed_basis + remaining_basis,
                f"{lot['id']} basis is not conserved")

    repeating = fixture["repeating_basis_case"]
    require(Fraction(repeating["original_quantity"])
            == Fraction(repeating["allocated_quantity"])
            + Fraction(repeating["remaining_quantity"]),
            "Repeating-basis quantity is not conserved")
    require(Fraction(repeating["original_basis"])
            == Fraction(repeating["allocated_basis"])
            + Fraction(repeating["remaining_basis"]),
            "Repeating total basis is not conserved exactly")

    fx = fixture["fx"]
    require(fx["settlement_book_value"] - fx["initial_book_value"] == fx["realized_gain"],
            "FX realized gain does not bridge carrying and settlement value")

    reports = fixture["expected_reports"]
    pnl_roles = {"income", "expense", "gain"}
    net_income = -sum(
        pre_close[account]
        for account, definition in accounts.items()
        if definition["role"] in pnl_roles
    )
    assets = sum(
        pre_close[account]
        for account, definition in accounts.items()
        if definition["role"] == "asset"
    )
    liabilities = -sum(
        pre_close[account]
        for account, definition in accounts.items()
        if definition["role"] == "liability"
    )
    require(net_income == reports["net_income"], "Profit and loss net income changed")
    require(assets == reports["assets"], "Balance-sheet assets changed")
    require(liabilities == reports["liabilities"], "Balance-sheet liabilities changed")
    require(-pre_close["3000"] == reports["contributed_capital"],
            "Contributed capital changed")
    require(net_income == reports["current_earnings"], "Current earnings changed")
    require(assets == liabilities + reports["contributed_capital"] + net_income,
            "Balance-sheet equation does not hold")

    cash_flow = {"operating": 0, "investing": 0, "financing": 0}
    require(by_id["J001"]["postings"]["1000"] == reports["opening_cash"],
            "Opening cash does not derive from the opening journal")
    for journal in journals:
        cash_movement = journal["postings"].get("1000", 0)
        activity = journal.get("cash_flow_activity")
        if journal["kind"] == "opening":
            require(activity == "opening", "Opening cash must be classified as opening")
            continue
        if cash_movement:
            require(activity in cash_flow,
                    f"{journal['id']} has unclassified period cash movement")
            cash_flow[activity] += cash_movement
        else:
            require(activity is None,
                    f"{journal['id']} classifies cash flow but has no cash movement")
    require(cash_flow["operating"] == reports["operating_cash_change"],
            "Operating cash flow does not derive from journals")
    require(cash_flow["investing"] == reports["investing_cash_change"],
            "Investing cash flow does not derive from journals")
    require(cash_flow["financing"] == reports["financing_cash_change"],
            "Financing cash flow does not derive from journals")
    require(reports["ending_cash"] == reports["opening_cash"] + sum(cash_flow.values()),
            "Cash-flow statement does not reconcile")
    require(reports["ending_cash"] == pre_close["1000"],
            "Cash-flow ending cash does not tie to the ledger")
    require(post_close["3100"] == -net_income,
            "Year close did not transfer current earnings to retained earnings")

    population = fixture["report_population"]
    required_reports = {
        "journalRegister", "generalLedger", "trialBalance",
        "profitAndLoss", "balanceSheet", "cashFlow",
    }
    require(set(population["report_kinds"]) == required_reports
            and len(population["report_kinds"]) == len(required_reports),
            "Report population must contain each of the six core reports exactly once")
    require(population["reporting_policy_snapshot_hash"],
            "Report population must pin its complete reporting policy")
    require(population["through_book_revision"] == 16,
            "Pre-close report population must include the latest non-journal revision")
    require(population["through_posting_sequence"] == 14,
            "Pre-close report population must exclude the closing journal")
    require(by_id["J015"].get("closes_period") == "2026",
            "Closing journal must identify the fiscal period it closes")

    replay_expectations = {case["expected"] for case in fixture["command_replay_cases"]}
    require(replay_expectations == {"replayed", "rejected", "rejected_stale"},
            "Golden fixture must cover replay, content conflict, and stale revision")

    extension = fixture["accounting_kernel_extension"]
    require(extension["configuration_revision"] == 1,
            "Golden accounting extension must pin its first immutable configuration revision")
    require(set(extension["policy_families"]) == {
        "inventoryCost", "accountingBasis", "monetaryClassification",
        "currencyRemeasurement", "allocationSchedule", "taxDetermination", "consolidation",
    } and len(extension["policy_families"]) == 7,
            "Golden accounting extension must exercise all seven policy families")
    require(set(extension["command_kinds"]) == {
        "postInventoryTransaction", "recostProvisionalInventory", "recognizeOpenItem",
        "applySettlement", "postCurrencyRemeasurement", "createAllocationSchedule",
        "recognizeScheduledAllocation", "postTaxedTransaction", "compileConsolidation",
    } and len(extension["command_kinds"]) == 9,
            "Golden accounting extension must exercise every specialized command")
    require(set(extension["immutable_effect_families"]) == {
        "provisionalInventoryLayer", "inventoryRecosting", "openItem", "settlement",
        "settlementAllocation", "remeasurementResult", "remeasurementReversal",
        "allocationSchedule", "allocationRecognition", "taxDetermination",
        "consolidationCompilation",
    } and len(extension["immutable_effect_families"]) == 11,
            "Golden accounting extension must exercise all immutable effect families")
    require(len(extension["executable_oracles"]) == 9
            and all(extension[field] is True for field in (
                "durable_round_trip", "replay_stable", "derived_lifecycle_rebuilt_from_effects",
            )), "Golden accounting extension must pin executable, replay, and rebuild evidence")

    return {
        "journals": len(journals),
        "book_revisions": max(all_revisions),
        "accounts": len(accounts),
        "lots": len(fixture["lots"]),
        "net_income": net_income,
        "accounting_policy_families": len(extension["policy_families"]),
        "accounting_command_kinds": len(extension["command_kinds"]),
        "accounting_effect_families": len(extension["immutable_effect_families"]),
    }


def validate_verification_cases(catalog: dict) -> dict[str, int]:
    require(catalog["version"] == "rastrata-kernel-v1-verification-cases-v2",
            "Unexpected Kernel v1 verification-case catalog version")
    cases = catalog["cases"]
    case_ids = [case["id"] for case in cases]
    require(len(case_ids) == len(set(case_ids)), "Verification case IDs must be unique")

    coverage = {
        requirement_id: {"admit": 0, "reject": 0}
        for requirement_id in BASELINE_KERNEL_REQUIREMENT_IDS
    }
    for case in cases:
        outcome = case["outcome"]
        require(outcome in {"admit", "reject"},
                f"{case['id']} has an unknown outcome")
        requirements = set(case["requirements"])
        require(requirements and requirements <= BASELINE_KERNEL_REQUIREMENT_IDS,
                f"{case['id']} must reference only implemented kernel requirements")
        for requirement_id in requirements:
            coverage[requirement_id][outcome] += 1
        if outcome == "reject":
            expected = case["expect"]
            require(expected.get("diagnostic"),
                    f"{case['id']} rejection must name a typed diagnostic")
            require(expected.get("revision_delta") == 0,
                    f"{case['id']} rejection must consume no revision")
            require(expected.get("posting_sequence_delta") == 0,
                    f"{case['id']} rejection must consume no posting sequence")

    for requirement_id, outcomes in coverage.items():
        require(outcomes["admit"] > 0,
                f"{requirement_id} has no valid design oracle")
        require(outcomes["reject"] > 0,
                f"{requirement_id} has no invalid design oracle")
    return {
        "cases": len(cases),
        "admit_cases": sum(case["outcome"] == "admit" for case in cases),
        "reject_cases": sum(case["outcome"] == "reject" for case in cases),
        "kernel_requirements_with_dual_oracles": len(coverage),
    }


def validate_design_cases(catalog: dict, model: str) -> dict[str, int]:
    require(catalog["version"] == "rastrata-kernel-design-verification-cases-v1",
            "Unexpected kernel design-case catalog version")
    require(catalog["status"] == "implemented-and-executable",
            "Accounting extension cases must reflect executable support")
    require(catalog["fixture_contract"] == {
        "hash_algorithm": "sha256",
        "canonicalization": "fixture-json-sorted-keys-v1",
        "posting_sign": "debit positive, credit negative",
        "hash_scope": "Each case hash covers its id, polarity, parent and atomic requirements, fixture, input or scenarios, and expected result, excluding case_hash",
    }, "Kernel design fixture hash contract changed")
    cases = catalog["cases"]
    case_ids = [case["id"] for case in cases]
    require(len(case_ids) == len(set(case_ids)),
            "Kernel design case IDs must be unique")
    scenario_ids: list[str] = []
    coverage = {
        requirement_id: {"admit": 0, "reject": 0}
        for requirement_id in ACCOUNTING_EXTENSION_REQUIREMENT_IDS
    }
    atomic_coverage = {
        f"ACC-{parent}.{child}": {"admit": 0, "reject": 0}
        for parent, count in ATOMIC_REQUIREMENT_COUNTS.items()
        for child in range(1, count + 1)
        if f"ACC-{parent}.{child}" not in DESIGN_PENDING_ATOMIC_REQUIREMENT_IDS
    }
    atomic_rejection_scenarios = {requirement_id: 0 for requirement_id in atomic_coverage}
    diagnostic_block = model.split("enum def SemanticDiagnosticCode {", 1)[1].split("}", 1)[0]
    diagnostic_codes = set(re.findall(r"^\s*([a-z][A-Za-z0-9_]*)\s*;", diagnostic_block,
                                      re.MULTILINE))
    for case in cases:
        case_for_hash = dict(case)
        declared_case_hash = case_for_hash.pop("case_hash", None)
        calculated_case_hash = "sha256:" + hashlib.sha256(
            json.dumps(
                case_for_hash,
                ensure_ascii=False,
                separators=(",", ":"),
                sort_keys=True,
            ).encode("utf-8")
        ).hexdigest()
        require(declared_case_hash == calculated_case_hash,
                f"{case['id']} case hash does not cover its complete fixture")

        def validate_hash_values(value: object) -> None:
            if isinstance(value, dict):
                for nested in value.values():
                    validate_hash_values(nested)
            elif isinstance(value, list):
                for nested in value:
                    validate_hash_values(nested)
            elif isinstance(value, str) and value.startswith("sha256:"):
                require(re.fullmatch(r"sha256:[0-9a-f]{64}", value) is not None,
                        f"{case['id']} contains a noncanonical SHA-256 value")

        validate_hash_values(case)
        fixture = case.get("fixture")
        require(isinstance(fixture, dict) and fixture,
                f"{case['id']} must contain a complete fixture contract")
        state_before = fixture.get("state_before")
        require(isinstance(state_before, dict)
                and isinstance(state_before.get("book_revision"), int)
                and isinstance(state_before.get("posting_sequence"), int)
                and re.fullmatch(r"sha256:[0-9a-f]{64}", state_before.get("content_hash", "")),
                f"{case['id']} must pin its complete input state")

        outcome = case["outcome"]
        require(outcome in {"admit", "reject"},
                f"{case['id']} has an unknown outcome")
        requirements = set(case["requirements"])
        require(requirements and requirements <= ACCOUNTING_EXTENSION_REQUIREMENT_IDS,
                f"{case['id']} must reference only implemented accounting-extension requirements")
        for requirement_id in requirements:
            coverage[requirement_id][outcome] += 1
        parent = next(iter(requirements)).removeprefix("ACC-")
        expected_atomic = {
            f"ACC-{parent}.{child}"
            for child in range(1, ATOMIC_REQUIREMENT_COUNTS[parent] + 1)
        } - DESIGN_PENDING_ATOMIC_REQUIREMENT_IDS
        atomic_requirements = set(case.get("atomic_requirements", []))
        require(atomic_requirements == expected_atomic,
                f"{case['id']} must cover every implemented atomic child of ACC-{parent}; pending children require future command oracles")
        for requirement_id in atomic_requirements:
            atomic_coverage[requirement_id][outcome] += 1
        if outcome == "admit":
            require(isinstance(case.get("input"), dict) and case["input"],
                    f"{case['id']} must provide concrete typed input")
            require(isinstance(case.get("expect"), dict) and case["expect"],
                    f"{case['id']} must provide concrete expected output")
            require("scenarios" not in case,
                    f"{case['id']} admitting oracle must be one deterministic scenario")
            commands = fixture.get("commands", [])
            query = fixture.get("query")
            require(bool(commands) != bool(query),
                    f"{case['id']} must be either a canonical command fixture or read-side query")
            if commands:
                expected_revision = state_before["book_revision"]
                for command in commands:
                    require(command.get("expected_book_revision") == expected_revision,
                            f"{case['id']} commands must form a gap-free expected-revision chain")
                    expected_revision += 1
            expected_transactions = fixture.get("expected_transactions")
            require(isinstance(expected_transactions, list),
                    f"{case['id']} must declare its exact prepared transactions")
            posting_count = 0
            for transaction in expected_transactions:
                postings = transaction.get("postings")
                require(isinstance(postings, list) and len(postings) >= 2,
                        f"{case['id']} prepared transaction must have at least two postings")
                ordinals = [posting["ordinal"] for posting in postings]
                require(ordinals == list(range(1, len(postings) + 1)),
                        f"{case['id']} prepared posting ordinals must be gap-free")
                require(all(isinstance(posting.get("book_value_cents"), int)
                            and posting["book_value_cents"] != 0
                            and isinstance(posting.get("units"), str)
                            for posting in postings),
                        f"{case['id']} prepared postings must have exact nonzero values and units")
                require(sum(posting["book_value_cents"] for posting in postings) == 0,
                        f"{case['id']} prepared transaction must balance exactly")
                posting_count += len(postings)
            require(fixture.get("expected_diagnostics") == [],
                    f"{case['id']} admitting fixture must expect no diagnostic")
            state_delta = fixture.get("state_delta")
            require(isinstance(state_delta, dict)
                    and state_delta.get("book_revision") == len(commands)
                    and state_delta.get("posting_sequence") == len(expected_transactions),
                    f"{case['id']} state deltas must match its commands and transactions")
            scenario_ids.append(case["id"])
            continue

        scenarios = case.get("scenarios")
        require(isinstance(scenarios, list) and scenarios,
                f"{case['id']} rejection matrix must contain isolated scenarios")
        require(len(scenarios) >= 2,
                f"{case['id']} must isolate more than one material rejection mode")
        require("input" not in case and "expect" not in case,
                f"{case['id']} rejection matrix must not bundle defects in one input")
        rejection_contract = fixture.get("rejection_contract")
        require(rejection_contract == {
            "expected_transactions": [],
            "book_revision_delta": 0,
            "posting_sequence_delta": 0,
            "resulting_state_hash": "unchanged",
        }, f"{case['id']} rejection fixture must preserve canonical state exactly")
        for scenario in scenarios:
            scenario_id = scenario.get("id")
            require(isinstance(scenario_id, str) and scenario_id,
                    f"{case['id']} contains an unnamed rejection scenario")
            scenario_ids.append(scenario_id)
            require(isinstance(scenario.get("input"), dict) and scenario["input"],
                    f"{scenario_id} must provide one concrete invalid input")
            scenario_atomic = set(scenario.get("atomic_requirements", []))
            require(scenario_atomic and scenario_atomic <= atomic_requirements,
                    f"{scenario_id} must identify the atomic requirements it falsifies")
            for requirement_id in scenario_atomic:
                atomic_rejection_scenarios[requirement_id] += 1
            expected = scenario.get("expect")
            require(isinstance(expected, dict) and expected,
                    f"{scenario_id} must provide a concrete rejection result")
            require(expected.get("diagnostic") in diagnostic_codes,
                    f"{scenario_id} rejection must name a typed diagnostic")
            require(expected.get("revision_delta") == 0,
                    f"{scenario_id} rejection must consume no revision")
            require(expected.get("posting_sequence_delta") == 0,
                    f"{scenario_id} rejection must consume no posting sequence")
    for requirement_id, outcomes in coverage.items():
        require(outcomes["admit"] > 0,
                f"{requirement_id} has no valid design oracle")
        require(outcomes["reject"] > 0,
                f"{requirement_id} has no invalid design oracle")
    for requirement_id, outcomes in atomic_coverage.items():
        require(outcomes == {"admit": 1, "reject": 1},
                f"{requirement_id} must have exactly one admit group and one reject matrix")
        require(atomic_rejection_scenarios[requirement_id] > 0,
                f"{requirement_id} has no isolated rejection scenario")
    require(len(scenario_ids) == len(set(scenario_ids)),
            "Every design scenario ID must be unique")
    return {
        "cases": len(cases),
        "scenarios": len(scenario_ids),
        "admit_cases": sum(case["outcome"] == "admit" for case in cases),
        "reject_cases": sum(case["outcome"] == "reject" for case in cases),
        "implemented_requirements_with_dual_oracles": len(coverage),
        "atomic_requirements_with_dual_oracles": len(atomic_coverage),
        "design_pending_atomic_requirements_without_command_oracles": len(DESIGN_PENDING_ATOMIC_REQUIREMENT_IDS),
    }


def validate_design_oracle_arithmetic(catalog: dict) -> dict[str, int]:
    cases = {case["id"]: case for case in catalog["cases"]}

    inventory = cases["D01-deterministic-inventory-costing"]
    acquisitions = {
        row["lot"]: (
            Fraction(row["quantity"]),
            Fraction(row["total_basis_cents"]),
        )
        for row in inventory["input"]["acquisitions"]
    }
    total_quantity = sum((row[0] for row in acquisitions.values()), Fraction(0))
    total_basis = sum((row[1] for row in acquisitions.values()), Fraction(0))
    disposal_quantity = Fraction(inventory["input"]["disposal_quantity"])
    expected_basis = inventory["expect"]["basis_by_method_cents"]
    for scenario in inventory["input"]["method_scenarios"]:
        calculated = sum(
            Fraction(selected_quantity) * acquisitions[lot_id][1] / acquisitions[lot_id][0]
            for lot_id, selected_quantity in zip(
                scenario["selected_lots"], scenario["selected_quantities"], strict=True
            )
        )
        require(calculated == Fraction(expected_basis[scenario["method"]]),
                f"D01 {scenario['method']} expected basis is arithmetically wrong")
    weighted_disposal = total_basis * disposal_quantity / total_quantity
    require(weighted_disposal == Fraction(expected_basis["weightedAverage"]),
            "D01 weighted-average disposal is arithmetically wrong")
    require(total_quantity - disposal_quantity
            == Fraction(inventory["expect"]["weighted_average_remaining_quantity"]),
            "D01 remaining weighted-average quantity is wrong")
    require(total_basis - weighted_disposal
            == Fraction(inventory["expect"]["weighted_average_remaining_basis_cents"]),
            "D01 remaining weighted-average basis is wrong")

    recosting = cases["D03-provisional-inventory-recosting"]
    provisional_quantity = (
        Fraction(recosting["input"]["issue_quantity"])
        - Fraction(recosting["input"]["on_hand_quantity"])
    )
    provisional_basis = (
        provisional_quantity
        * Fraction(recosting["input"]["provisional_rate_cents_per_unit"])
    )
    final_basis = sum(
        (Fraction(row["total_basis_cents"]) for row in recosting["input"]["later_receipts"]),
        Fraction(0),
    )
    require(provisional_quantity == Fraction(recosting["expect"]["provisional_quantity_opened"])
            and provisional_basis == Fraction(recosting["expect"]["provisional_basis_cents"])
            and final_basis == Fraction(recosting["expect"]["final_basis_cents"])
            and final_basis - provisional_basis == recosting["expect"]["recosting_adjustment_cents"],
            "D03 provisional recosting arithmetic is wrong")

    settlement = cases["D05-many-to-many-open-item-settlement"]
    open_value = {row["id"]: row["book_value_cents"] for row in settlement["input"]["open_items"]}
    open_quantity = {row["id"]: Fraction(row["quantity"]) for row in settlement["input"]["open_items"]}
    settlement_value = {row["id"]: row["book_value_cents"] for row in settlement["input"]["settlements"]}
    for edge in settlement["input"]["allocations"]:
        open_value[edge["open_item"]] -= edge["book_value_cents"]
        open_quantity[edge["open_item"]] -= Fraction(edge["open_quantity"])
        settlement_value[edge["settlement"]] -= edge["book_value_cents"]
    require(open_value == settlement["expect"]["outstanding_book_value_cents"],
            "D05 outstanding book values do not conserve")
    require({key: f"{value.numerator}/{value.denominator}"
             for key, value in open_quantity.items()}
            == settlement["expect"]["outstanding_quantity"],
            "D05 outstanding quantities do not conserve")
    require(settlement_value == settlement["expect"]["unapplied_settlement_cents"],
            "D05 settlement values do not conserve")

    basis = cases["D07-tied-accounting-basis-projections"]
    accrual_net = sum(row["book_value_cents"] for row in basis["input"]["entries"])
    ratio = Fraction(
        sum(edge["allocated_open_item_book_value_cents"]
            for edge in basis["input"]["settlement"]["allocations"]),
        basis["input"]["open_item"]["book_value_cents"],
    )
    cash_net = Fraction(0)
    for row in basis["input"]["entries"]:
        treatment = basis["input"]["cash_rules"][row["event"]]
        if treatment == "allocateBySettlementRatio":
            cash_net += row["book_value_cents"] * ratio
        elif treatment == "carryThrough":
            cash_net += row["book_value_cents"]
        elif treatment != "exclude":
            raise AssertionError(f"D07 contains unsupported oracle treatment {treatment}")
    require(accrual_net == basis["expect"]["accrual_net_cents"]
            and cash_net == basis["expect"]["cash_net_cents"],
            "D07 basis-projection arithmetic is wrong")

    currency = cases["D09-currency-settlement-and-period-remeasurement"]
    settled = currency["input"]["settled_position"]
    opened = currency["input"]["open_position"]
    require(settled["id"] != opened["id"],
            "D09 realized and unrealized FX must use distinct positions")
    settlement_value_cents = (
        Fraction(settled["quantity"])
        * Fraction(currency["input"]["settlement_rate_usd_per_eur"])
        * 100
    )
    closing_value_cents = (
        Fraction(opened["quantity"])
        * Fraction(currency["input"]["closing_rate_usd_per_eur"])
        * 100
    )
    require(settlement_value_cents == currency["expect"]["settlement_book_value_cents"]
            and settlement_value_cents - settled["carrying_book_value_cents"]
            == currency["expect"]["realized_gain_cents"]
            and closing_value_cents == currency["expect"]["closing_book_value_cents"]
            and closing_value_cents - opened["carrying_book_value_cents"]
            == currency["expect"]["unrealized_gain_cents"]
            and -currency["expect"]["unrealized_gain_cents"]
            == currency["expect"]["next_period_reversal_cents"],
            "D09 currency remeasurement arithmetic is wrong")

    allocation = cases["D11-exact-allocation-schedule"]
    allocable = (
        allocation["input"]["source_basis_cents"]
        - allocation["input"]["residual_value_cents"]
    )
    installments = allocation["expect"]["installment_book_values_cents"]
    require(len(installments) == allocation["expect"]["installment_count"]
            and sum(installments) == allocable
            and Fraction(allocation["expect"]["exact_total_cents"]) == allocable,
            "D11 allocation schedule does not conserve source basis")

    tax = cases["D13-versioned-tax-determination"]
    taxable_line = tax["input"]["taxable_lines"][0]
    require(not taxable_line["amount_includes_tax"],
            "D13 arithmetic fixture expects an exclusive taxable line")
    starting_basis = Fraction(taxable_line["stated_amount_cents"])
    component_amounts: dict[str, Fraction] = {}
    recoverable_amounts: dict[str, Fraction] = {}
    nonrecoverable_amounts: dict[str, Fraction] = {}
    for component in sorted(tax["input"]["components"], key=lambda row: row["compound_ordinal"]):
        component_basis = starting_basis + sum(
            (component_amounts[dependency] for dependency in component["compounds_on"]),
            Fraction(0),
        )
        amount = component_basis * Fraction(component["rate"])
        component_amounts[component["id"]] = amount
        recoverable_amounts[component["id"]] = amount * Fraction(component["recoverable_share"])
        nonrecoverable_amounts[component["id"]] = amount - recoverable_amounts[component["id"]]
    require({key: int(value) for key, value in component_amounts.items()}
            == tax["expect"]["component_tax_cents"],
            "D13 compound tax amounts are wrong")
    require(starting_basis + sum(component_amounts.values()) == tax["expect"]["gross_cents"]
            and recoverable_amounts["TAX-A"] == tax["expect"]["tax_a_recoverable_cents"]
            and recoverable_amounts["TAX-B"] == tax["expect"]["tax_b_recoverable_cents"]
            and nonrecoverable_amounts["TAX-B"] == tax["expect"]["tax_b_nonrecoverable_cents"],
            "D13 tax recovery or gross arithmetic is wrong")

    consolidation = cases["D15-reproducible-consolidation"]
    for source in consolidation["input"]["sources"]:
        require(sum(source["balances_cents"].values()) == 0,
                f"D15 source {source['book']} is not balanced")
        require(set(source["balances_cents"]) <= set(consolidation["input"]["mapping"]),
                f"D15 source {source['book']} contains an unmapped account")
    require(sum(consolidation["expect"]["elimination_postings_cents"].values()) == 0,
            "D15 eliminations are not balanced")
    consolidated_cash = sum(
        amount
        for source in consolidation["input"]["sources"]
        for account, amount in source["balances_cents"].items()
        if account.startswith("CASH-")
    )
    minority_source = next(
        source for source in consolidation["input"]["sources"]
        if Fraction(source["relationship"]["ownership_share"]) < 1
    )
    minority_net_assets = -minority_source["balances_cents"]["EQUITY-B"]
    nci = -minority_net_assets * (
        1 - Fraction(minority_source["relationship"]["ownership_share"])
    )
    total_equity = sum(
        amount
        for source in consolidation["input"]["sources"]
        for account, amount in source["balances_cents"].items()
        if account.startswith("EQUITY-")
    )
    parent_equity = total_equity - nci
    require(consolidated_cash == consolidation["expect"]["consolidated_cash_cents"]
            and nci == consolidation["expect"]["non_controlling_interest_cents"]
            and parent_equity == consolidation["expect"]["parent_attributable_equity_cents"]
            and consolidated_cash + nci + parent_equity == 0,
            "D15 consolidation or non-controlling-interest arithmetic is wrong")

    authority = cases["D17-workflow-independent-command"]
    require(authority["expect"].get("intent_hashes_identical") is True
            and authority["expect"].get("intent_factory") == "EvaluateBookCommand"
            and authority["expect"].get("commit_authority") == "SerializedBookAuthority",
            "D17 identical canonical commands must produce one intent hash")

    return {"admitting_oracles_recomputed": 9}


def main() -> int:
    model = MODEL_PATH.read_text(encoding="utf-8")
    fixture = json.loads(FIXTURE_PATH.read_text(encoding="utf-8"))
    verification_cases = json.loads(VERIFICATION_CASES_PATH.read_text(encoding="utf-8"))
    design_cases = json.loads(DESIGN_CASES_PATH.read_text(encoding="utf-8"))
    result = {
        "design_architecture": validate_design_architecture(model),
        "diagnostics": validate_diagnostic_catalogs(
            model, verification_cases, design_cases
        ),
        "model": validate_traceability(model),
        "golden_company": validate_golden_company(fixture),
        "verification_cases": validate_verification_cases(verification_cases),
        "kernel_design_cases": validate_design_cases(design_cases, model),
        "kernel_design_oracles": validate_design_oracle_arithmetic(design_cases),
    }
    print(json.dumps(result, indent=2, sort_keys=True))
    return 0


if __name__ == "__main__":
    try:
        raise SystemExit(main())
    except (AssertionError, KeyError, TypeError, ValueError) as error:
        print(f"kernel validation failed: {error}", file=sys.stderr)
        raise SystemExit(1)
