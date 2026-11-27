#!/usr/bin/env python3
"""Execute the deliberately small scalar/transition subset of the ledger model.

Not a general SysML interpreter or production implementation conformance proof.
SysIDE separately checks the full model and resolves imported kernel definitions.
Unsupported syntax, uncovered definitions and malformed fixtures fail closed.
"""

from __future__ import annotations

import argparse
import ast
import hashlib
import json
from pathlib import Path
import re


SPEC = Path(__file__).resolve().parent.parent / "spec"


def require(condition: bool, message: str) -> None:
    if not condition:
        raise ValueError(message)


def unique_object(pairs: list[tuple[str, object]]) -> dict[str, object]:
    result: dict[str, object] = {}
    for key, value in pairs:
        require(key not in result, f"Duplicate JSON key: {key}")
        result[key] = value
    return result


def evaluate(node: ast.AST, values: dict[str, object]) -> object:
    if isinstance(node, ast.Expression):
        return evaluate(node.body, values)
    if isinstance(node, ast.Name):
        require(node.id in values, f"Unknown scalar: {node.id}")
        return values[node.id]
    if isinstance(node, ast.Constant) and type(node.value) in (int, bool, str):
        return node.value
    if isinstance(node, ast.UnaryOp) and isinstance(node.op, ast.Not):
        value = evaluate(node.operand, values)
        require(type(value) is bool, "not requires Boolean")
        return not value
    if isinstance(node, ast.BoolOp) and isinstance(node.op, (ast.And, ast.Or)):
        operands = [evaluate(value, values) for value in node.values]
        require(all(type(value) is bool for value in operands), "Boolean operands required")
        return all(operands) if isinstance(node.op, ast.And) else any(operands)
    if isinstance(node, ast.BinOp) and isinstance(node.op, ast.Add):
        left, right = evaluate(node.left, values), evaluate(node.right, values)
        require(type(left) is int and type(right) is int, "Exact integer addition required")
        return left + right
    if isinstance(node, ast.Compare) and len(node.ops) == len(node.comparators) == 1:
        left, right = evaluate(node.left, values), evaluate(node.comparators[0], values)
        require(type(left) is type(right), "Comparison types differ")
        operator = node.ops[0]
        if isinstance(operator, ast.Eq):
            return left == right
        if isinstance(operator, ast.NotEq):
            return left != right
        if isinstance(operator, ast.LtE):
            require(type(left) is int, "Ordering requires exact integers")
            return left <= right
    raise ValueError(f"Unsupported scalar expression: {ast.dump(node)}")


def model_parts(source: str):
    source = re.sub(r"/\*.*?\*/", "", source, flags=re.S)
    constraints = {}
    for match in re.finditer(r"constraint def (\w+)\s*\{([^{}]*)\}", source):
        name, body = match.groups()
        declarations = re.findall(r"in (\w+)\s*:\s*(Boolean|Natural|String)\s*;", body)
        parameters = dict(declarations)
        require(len(parameters) == len(declarations), "Duplicate constraint parameter")
        expression = re.sub(r"in \w+\s*:\s*(?:Boolean|Natural|String)\s*;", "", body).strip()
        require(name not in constraints and bool(parameters), f"Invalid constraint: {name}")
        constraints[name] = (parameters, ast.parse(expression, mode="eval"))
    require(len(constraints) == len(re.findall(r"\bconstraint def\b", source)), "Unparsed constraint definition")
    machines = {}
    for definition in re.finditer(r"state def (\w+)\s*\{([^{}]*)\}", source):
        machine, lifecycle = definition.groups()
        require(machine not in machines, "Duplicate state-machine name")
        states = set(re.findall(r"\bstate (\w+);", lifecycle))
        guards = set(re.findall(r"attribute (\w+) : Boolean;", lifecycle))
        require(len(states) == len(re.findall(r"\bstate \w+;", lifecycle)), "Duplicate state name")
        require(len(guards) == len(re.findall(r"attribute \w+ : Boolean;", lifecycle)), "Duplicate guard name")
        initial_match = re.search(r"entry; then (\w+);", lifecycle)
        require(initial_match is not None, "Missing lifecycle initial state")
        initial = initial_match.group(1)
        transitions = {}
        transition_names = set()
        for match in re.finditer(r"transition (\w+) first (\w+) accept (\w+)(?: if (\w+))? then (\w+);", lifecycle):
            name, start, event, guard, end = match.groups()
            require(name not in transition_names, "Duplicate transition name")
            transition_names.add(name)
            require(start in states and end in states, f"Unknown state: {name}")
            require(guard is None or guard in guards, f"Unknown guard: {name}")
            require((start, event) not in transitions, f"Nondeterministic transition: {name}")
            transitions[start, event] = (name, guard, end)
        require(len(transitions) == len(re.findall(r"\btransition\b", lifecycle)), "Unparsed transition")
        remainder = re.sub(r"\bdoc\b|attribute \w+ : Boolean;|entry; then \w+;|\bstate \w+;|transition \w+ first \w+ accept \w+(?: if \w+)? then \w+;", "", lifecycle)
        require(not remainder.strip(), f"Unsupported lifecycle syntax in {machine}")
        require(initial in states and bool(transitions), "Missing lifecycle")
        machines[machine] = (initial, states, guards, transitions)
    require(bool(machines) and len(machines) == len(re.findall(r"\bstate def\b", source)), "Unparsed state-machine definition")
    requirements = set(re.findall(r"requirement def <'(PL-\d+)'>", source))
    verifications = set(re.findall(r"verification def (L\d+\w+)", source))
    definition_ids = {name: identifier for identifier, name in re.findall(r"requirement def <'(PL-\d+)'> (\w+)", source)}
    usage_ids = {name: definition_ids[definition] for name, definition in re.findall(r"requirement (\w+) : (\w+);", source)}
    verification_bindings = {}
    for name, objective in re.findall(r"verification def (L\d+\w+)\s*\{[^{}]*objective\s*\{([^{}]*)\}", source):
        verification_bindings[name] = {usage_ids[usage] for usage in re.findall(r"verify Requirements::(\w+);", objective)}
    require(set(verification_bindings) == verifications, "Unparsed verification objectives")
    return constraints, machines, requirements, verification_bindings


def check(source: str, fixture: dict[str, object]) -> dict[str, object]:
    require(set(fixture) == {"schema", "constraints", "lifecycle", "obligations"}, "Unknown fixture fields")
    require(fixture["schema"] == "rastrata-ledger-design-v2", "Unsupported fixture version")
    constraints, machines, requirements, verification_bindings = model_parts(source)
    verifications = set(verification_bindings)
    polarities = {name: set() for name in constraints}
    identifiers = set()
    for case in fixture["constraints"]:
        require(set(case) == {"id", "constraint", "inputs", "expected"}, "Invalid constraint fixture")
        require(case["id"] not in identifiers, "Duplicate fixture ID")
        identifiers.add(case["id"])
        name = case["constraint"]
        require(name in constraints and type(case["expected"]) is bool, f"Invalid case {case['id']}")
        parameters, expression = constraints[name]
        require(set(case["inputs"]) == set(parameters), f"Wrong inputs for {case['id']}")
        values = {}
        for parameter, kind in parameters.items():
            value = case["inputs"][parameter]
            if kind == "Natural":
                require(type(value) is str and re.fullmatch(r"0|[1-9][0-9]{0,63}", value) is not None, "Noncanonical Natural")
                value = int(value)
            else:
                require(type(value) is (bool if kind == "Boolean" else str), f"Wrong type for {parameter}")
            values[parameter] = value
        actual = evaluate(expression, values)
        require(type(actual) is bool and actual == case["expected"], f"Constraint counterexample: {case['id']}")
        polarities[name].add(actual)
    require(all(values == {False, True} for values in polarities.values()), "Each scalar constraint needs both polarities")

    coverage = {name: {"transitions": set(), "guards": set(), "states": {parts[0]}} for name, parts in machines.items()}
    for case in fixture["lifecycle"]:
        require(set(case) == {"id", "machine", "steps"}, "Invalid lifecycle fixture")
        require(case["id"] not in identifiers, "Duplicate fixture ID")
        identifiers.add(case["id"])
        require(case["machine"] in machines, "Unknown state machine")
        initial, states, guards, transitions = machines[case["machine"]]
        covered = coverage[case["machine"]]["transitions"]
        blocked_guards = coverage[case["machine"]]["guards"]
        visited = coverage[case["machine"]]["states"]
        state = initial
        for step in case["steps"]:
            require(set(step) == {"event", "facts", "expectedState", "allowed"}, "Invalid lifecycle step")
            require(type(step["allowed"]) is bool, "Expected disposition must be Boolean")
            require(set(step["facts"]) <= guards and all(type(value) is bool for value in step["facts"].values()), "Invalid guard facts")
            edge = transitions.get((state, step["event"]))
            allowed = False
            if edge:
                name, guard, end = edge
                require(guard is None or guard in step["facts"], f"Missing guard value: {guard}")
                allowed = guard is None or step["facts"][guard]
                if allowed:
                    covered.add(name)
                    state = end
                    visited.add(state)
                elif guard:
                    blocked_guards.add(guard)
            require(allowed == step["allowed"] and state == step["expectedState"], f"Lifecycle counterexample: {case['id']} / {step['event']}")
    for machine, (_, states, guards, transitions) in machines.items():
        covered = coverage[machine]
        require(covered["transitions"] == {edge[0] for edge in transitions.values()}, f"Untested transitions in {machine}: {set(edge[0] for edge in transitions.values()) - covered['transitions']}")
        require(covered["states"] == states, "Unreachable or untested states")
        require(covered["guards"] == guards, f"Unguarded negative paths in {machine}: {guards - covered['guards']}")

    mapped_requirements = set()
    mapped_verifications = set()
    for obligation in fixture["obligations"]:
        require(set(obligation) == {"verification", "requirements", "given", "when", "then", "runtimeStatus"}, "Invalid obligation")
        require(obligation["verification"] in verifications, "Unknown SysML verification")
        require(obligation["verification"] not in mapped_verifications, "Duplicate verification obligation")
        require(set(obligation["requirements"]) <= requirements, "Unknown requirement")
        require(set(obligation["requirements"]) == verification_bindings[obligation["verification"]], "Verification objective mapping differs from SysML")
        require(obligation["runtimeStatus"] == "not-closed", "Design fixtures cannot certify production")
        require(all(type(obligation[key]) is list and len(obligation[key]) > 0 for key in ("given", "when", "then")), "Empty obligation")
        mapped_verifications.add(obligation["verification"])
        mapped_requirements.update(obligation["requirements"])
    require(mapped_requirements == requirements and mapped_verifications == verifications, "Incomplete design obligation catalog")
    return {"constraints": len(constraints), "scalarCases": len(fixture["constraints"]),
            "stateMachines": len(machines),
            "states": sum(len(parts[1]) for parts in machines.values()),
            "transitions": sum(len(parts[3]) for parts in machines.values()),
            "guardNegativeControls": sum(len(parts[2]) for parts in machines.values()),
            "lifecycleCases": len(fixture["lifecycle"]), "requirements": len(requirements),
            "runtimeObligations": len(mapped_verifications)}


def negative_controls(source: str, fixtures: dict[str, object]) -> int:
    mutants = [
        source.replace("resulting == before + 1", "resulting == before", 1),
        source.replace("not acknowledged or durable", "acknowledged or durable", 1),
        source.replace("if durabilityConfirmed then ready", "then ready", 1),
        source.replace("then awaitingDurability;", "then ready;", 1),
        source.replace("and protocolMatches", "", 1),
        source.replace("profileSupported and ", "", 1),
        source.replace("and completeCatalog", "", 1),
        source.replace("and projectionVerified", "", 1),
        re.sub(r"\band\s+completeReadSet\b", "", source, count=1),
        source.replace("and sourceRowsVerified", "", 1),
        source.replace("and absenceAndRangesVerified", "", 1),
        re.sub(r"\band\s+pinnedHeadMatches\b", "", source, count=1),
        source.replace("and publicationFenceMatches", "", 1),
        source.replace("and requiredEvidenceAvailable", "", 1),
        source.replace("archiveCanonical and payloadVerified", "payloadVerified", 1),
        source.replace("and conditionalWriteSucceeded", "", 1),
        source.replace("and fenceReplacementConfirmed", "", 1),
        source.replace("and catalogFenceMatches", "", 1),
        source.replace("previousFence + 1 <= resultingFence", "previousFence <= resultingFence", 1),
        source.replace("if archivePublicationConfirmed then archiveCommitted", "then archiveCommitted", 1),
        source.replace('archivePhase == "idle" and not pendingSelection', 'archivePhase == "idle"', 1),
        source.replace("and exactPopulationsVerified", "", 1),
        source.replace("and tailPreserved", "", 1),
        source.replace("and expectedHeadDigest == beforeHeadDigest", "", 1),
        source.replace("and beforeHeadDigest == afterHeadDigest", "", 1),
        source.replace("and not pinRetired", "", 1),
        source.replace("and noProtectedReferences", "", 1),
        source.replace("and referenceBarrierHeld", "", 1),
        source.replace("and not locationReusable", "", 1),
    ]
    for mutant in mutants:
        require(mutant != source, "Negative control did not modify the model")
        try:
            check(mutant, fixtures)
        except (ValueError, SyntaxError):
            continue
        raise ValueError("Design checker accepted an unsafe model control")
    return len(mutants)


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--model", type=Path, default=SPEC / "rastrata-production-ledger.sysml")
    parser.add_argument("--fixtures", type=Path, default=SPEC / "verification-cases.json")
    args = parser.parse_args()
    source = args.model.read_text()
    raw = args.fixtures.read_text()
    fixtures = json.loads(raw, object_pairs_hook=unique_object)
    report = check(source, fixtures)
    report["negativeControls"] = negative_controls(source, fixtures)
    report["modelSha256"] = hashlib.sha256(source.encode()).hexdigest()
    report["fixturesSha256"] = hashlib.sha256(raw.encode()).hexdigest()
    report["claim"] = "bounded design checks; not production conformance or general SysML execution"
    print(json.dumps(report, indent=2))


if __name__ == "__main__":
    main()
