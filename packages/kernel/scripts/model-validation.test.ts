import { expect, test } from "bun:test";
import { fileURLToPath } from "node:url";

test("model validation distinguishes implemented identity from pending inventory design and refuses false coverage", () => {
  const result = Bun.spawnSync([
    "python3",
    "-c",
    String.raw`
import copy, hashlib, json, runpy, sys
ns = runpy.run_path(sys.argv[1])
model = ns["MODEL_PATH"].read_text(encoding="utf-8")
catalog = json.loads(ns["DESIGN_CASES_PATH"].read_text(encoding="utf-8"))
trace = ns["validate_traceability"](model)
oracles = ns["validate_design_cases"](catalog, model)
assert trace["designed_not_implemented_requirements"] == 0
assert trace["atomic_requirements"] == 58
assert oracles["atomic_requirements_with_dual_oracles"] == 58
assert oracles["design_pending_atomic_requirements_without_command_oracles"] == 0

def rejected(action, message):
    try:
        action()
    except AssertionError as error:
        assert message in str(error), str(error)
    else:
        raise AssertionError("Negative control was accepted")

def rehash(case):
    body = {key: value for key, value in case.items() if key != "case_hash"}
    case["case_hash"] = "sha256:" + hashlib.sha256(json.dumps(body, ensure_ascii=False, separators=(",", ":"), sort_keys=True).encode("utf-8")).hexdigest()

# Rehash mutated catalogs so these controls reach coverage admission, not an
# unrelated checksum failure. Original fixture/model/manifest files stay intact.
for mode in ["drop_existing", "drop_terminal"]:
    changed = copy.deepcopy(catalog)
    case = next(case for case in changed["cases"] if case["outcome"] == "admit" and "ACC-039" in case["requirements"])
    if mode == "drop_existing":
        case["atomic_requirements"].remove("ACC-039.1")
    else:
        case["atomic_requirements"].remove("ACC-039.9")
    rehash(case)
    rejected(lambda: ns["validate_design_cases"](changed, model), "must cover every implemented atomic child")

# The explicit pending set must agree with the independent release-blocking
# trace; it is not a general exemption for arbitrary missing implementations.
globals_ = ns["validate_traceability"].__globals__
reopened = globals_["REOPENED_KERNEL_REQUIREMENT_IDS"]
globals_["REOPENED_KERNEL_REQUIREMENT_IDS"] = {"ACC-038"}
rejected(lambda: ns["validate_traceability"](model), "must exactly match the release-blocking semantic trace")
globals_["REOPENED_KERNEL_REQUIREMENT_IDS"] = reopened
globals_["DESIGN_PENDING_ATOMIC_REQUIREMENT_IDS"] = {"ACC-039.7"}
rejected(lambda: ns["validate_traceability"](model), "must exactly match the release-blocking semantic trace")
print("positive contract and four negative controls passed")
`,
    fileURLToPath(new URL("./validate-spec.py", import.meta.url)),
  ]);
  expect(result.exitCode, new TextDecoder().decode(result.stderr)).toBe(0);
  expect(new TextDecoder().decode(result.stdout).trim()).toBe(
    "positive contract and four negative controls passed",
  );
});

test("owned inventory model preserves ordered zero-journal topology without weakening legacy allocations", () => {
  const result = Bun.spawnSync([
    "python3",
    "-c",
    String.raw`
import runpy, sys
ns = runpy.run_path(sys.argv[1])
model = ns["MODEL_PATH"].read_text(encoding="utf-8")
validate = ns["validate_design_architecture"]
result = validate(model)
assert result["typed_command_variants"] == 18
assert result["design_pending_command_variants"] == 1
controls = [
    ("item operation : OwnedInventoryOperationInput[1..*] ordered;", "item operation : OwnedInventoryOperationInput[1..*];", "nonempty and ordered"),
    ("item resolvedJournal : ResolvedTransaction[0..*] ordered;", "item resolvedJournal : ResolvedTransaction[1..*] ordered;", "permit no journal"),
    ("item :>> resolvedTransaction : ResolvedTransaction[0];", "item :>> resolvedTransaction : ResolvedTransaction[0..1];", "ambiguous second journal"),
    ("item def InventoryQuantityAllocation {", "item def InventoryQuantityAllocation {\n            item reducingSource : CanonicalPostingReference;", "cannot require a posting"),
    ("item reducingSource : CanonicalPostingReference;", "item reducingSource : CanonicalPostingReference[0..1];", "legacy allocation shape"),
]
for original, replacement, message in controls:
    assert model.count(original) == 1, original
    changed = model.replace(original, replacement)
    try:
        validate(changed)
    except AssertionError as error:
        assert message in str(error), str(error)
    else:
        raise AssertionError("Negative control was accepted")
print("owned inventory topology and five declaration controls passed")
`,
    fileURLToPath(new URL("./validate-spec.py", import.meta.url)),
  ]);
  expect(result.exitCode, new TextDecoder().decode(result.stderr)).toBe(0);
  expect(new TextDecoder().decode(result.stdout).trim()).toBe(
    "owned inventory topology and five declaration controls passed",
  );
});
