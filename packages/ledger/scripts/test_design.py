"""Adversarial controls for the bounded model checker, not ledger runtime tests."""
import ast
import copy
import importlib.util
import json
from pathlib import Path
import unittest

module_spec = importlib.util.spec_from_file_location("ledger_design", Path(__file__).with_name("check-design.py"))
checker = importlib.util.module_from_spec(module_spec)
module_spec.loader.exec_module(checker)


class DesignControls(unittest.TestCase):
    def setUp(self):
        self.source = (checker.SPEC / "rastrata-production-ledger.sysml").read_text()
        self.cases = json.loads((checker.SPEC / "verification-cases.json").read_text())

    def test_valid_model_and_unsafe_model_controls(self):
        self.assertGreater(checker.check(self.source, self.cases)["scalarCases"], 0)
        self.assertEqual(checker.negative_controls(self.source, self.cases), 29)

    def test_missing_negative_scalar_cases(self):
        self.cases["constraints"] = [case for case in self.cases["constraints"] if case["expected"]]
        with self.assertRaisesRegex(ValueError, "both polarities"):
            checker.check(self.source, self.cases)

    def test_natural_cannot_be_float_or_noncanonical(self):
        for value in (9007199254740993, 1.0, "01", "-1", "1e3", "1" * 65):
            cases = copy.deepcopy(self.cases)
            case = next(case for case in cases["constraints"] if case["constraint"] == "OutcomeAdvance")
            case["inputs"]["before"] = value
            with self.assertRaisesRegex(ValueError, "Noncanonical Natural"):
                checker.check(self.source, cases)

    def test_unknown_input_fields(self):
        self.cases["constraints"][0]["inputs"]["unused"] = True
        with self.assertRaisesRegex(ValueError, "Wrong inputs"):
            checker.check(self.source, self.cases)

    def test_unknown_expression_is_not_silently_skipped(self):
        with self.assertRaisesRegex(ValueError, "Unsupported scalar expression"):
            checker.evaluate(ast.parse("dangerous()", mode="eval"), {})

    def test_duplicate_fixture_and_json_keys(self):
        self.cases["constraints"].append(self.cases["constraints"][0])
        with self.assertRaisesRegex(ValueError, "Duplicate fixture"):
            checker.check(self.source, self.cases)
        with self.assertRaisesRegex(ValueError, "Duplicate JSON key"):
            json.loads('{"x":true,"x":false}', object_pairs_hook=checker.unique_object)

    def test_wrong_verification_binding(self):
        self.cases["obligations"][0]["requirements"] = ["PL-002"]
        with self.assertRaisesRegex(ValueError, "mapping differs"):
            checker.check(self.source, self.cases)

    def test_missing_obligation(self):
        self.cases["obligations"].pop()
        with self.assertRaisesRegex(ValueError, "Incomplete design obligation"):
            checker.check(self.source, self.cases)

    def test_no_production_completion_from_design_fixture(self):
        self.cases["obligations"][0]["runtimeStatus"] = "complete"
        with self.assertRaisesRegex(ValueError, "cannot certify production"):
            checker.check(self.source, self.cases)

    def test_duplicate_transition_is_not_a_valid_nondeterministic_choice(self):
        broken = self.source.replace("state ready;", "state ready; transition duplicate first recovering accept HistoryVerified if recoveryVerified then ready;")
        with self.assertRaisesRegex(ValueError, "Nondeterministic transition"):
            checker.check(broken, self.cases)

    def test_changed_initial_state(self):
        broken = self.source.replace("entry; then recovering;", "entry; then ready;")
        with self.assertRaises(ValueError):
            checker.check(broken, self.cases)

    def test_new_constraint_requires_fixtures(self):
        broken = self.source.replace("package Invariants {", "package Invariants { constraint def Forgotten { in value : Boolean; value }")
        with self.assertRaisesRegex(ValueError, "both polarities"):
            checker.check(broken, self.cases)

    def test_archive_machine_cannot_be_silently_uncovered(self):
        self.cases["lifecycle"] = [case for case in self.cases["lifecycle"] if case["machine"] == "BookLifecycle"]
        with self.assertRaisesRegex(ValueError, "Untested transitions in ArchivePublicationLifecycle"):
            checker.check(self.source, self.cases)

    def test_unknown_machine_and_wrong_schema_fail(self):
        self.cases["lifecycle"][0]["machine"] = "InventedMachine"
        with self.assertRaisesRegex(ValueError, "Unknown state machine"):
            checker.check(self.source, self.cases)
        self.cases["schema"] = "rastrata-ledger-design-v1"
        with self.assertRaisesRegex(ValueError, "Unsupported fixture version"):
            checker.check(self.source, self.cases)

    def test_unparsed_nested_state_machine_fails(self):
        broken = self.source + "\nstate def NotSupported { state nested { state inside; } }"
        with self.assertRaisesRegex(ValueError, "Unparsed state-machine"):
            checker.check(broken, self.cases)

    def test_duplicate_transition_names_fail_even_for_different_events(self):
        broken = self.source.replace("transition upload first selected", "transition select first selected")
        with self.assertRaisesRegex(ValueError, "Duplicate transition name"):
            checker.check(broken, self.cases)

    def test_unsupported_lifecycle_statement_and_duplicate_declarations_fail(self):
        for added, message in (
            ("do action hidden;", "Unsupported lifecycle syntax"),
            ("state ready;", "Duplicate state name"),
            ("attribute recoveryVerified : Boolean;", "Duplicate guard name"),
        ):
            broken = self.source.replace("state ready;", "state ready; " + added)
            with self.assertRaisesRegex(ValueError, message):
                checker.check(broken, self.cases)

    def test_duplicate_constraint_parameter_fails(self):
        broken = self.source.replace("in retained : Boolean;", "in retained : Boolean; in retained : Boolean;", 1)
        with self.assertRaisesRegex(ValueError, "Duplicate constraint parameter"):
            checker.check(broken, self.cases)


if __name__ == "__main__":
    unittest.main()
