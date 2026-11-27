#!/usr/bin/env python3
"""Execute the pinned accounting-engine fixture corpus without mutating it."""

from __future__ import annotations

import argparse
import hashlib
import json
import os
from pathlib import Path
import shutil
import subprocess
import sys


LAB_DIR = Path(__file__).resolve().parent


def executable(env_name: str, fallback: str) -> str:
    value = os.environ.get(env_name, fallback)
    resolved = shutil.which(value) if not Path(value).is_absolute() else value
    if not resolved or not Path(resolved).exists():
        raise SystemExit(f"{env_name} does not resolve to an executable: {value}")
    # Do not resolve a virtual-environment Python symlink: doing so bypasses the
    # environment's pyvenv.cfg and silently drops its installed packages.
    return os.path.abspath(resolved)


def run(argv: list[str], cwd: Path) -> dict[str, object]:
    completed = subprocess.run(argv, cwd=cwd, text=True, capture_output=True, check=False)
    return {
        "argv": argv,
        "exit_status": completed.returncode,
        "stdout": completed.stdout,
        "stderr": completed.stderr,
    }


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--output", type=Path, required=True)
    parser.add_argument("--case", action="append", dest="cases")
    args = parser.parse_args()

    output = args.output.resolve()
    if output.exists():
        raise SystemExit(f"output already exists; choose a fresh path: {output}")
    output.mkdir(parents=True)

    binaries = {
        "beancount_python": executable("BEANCOUNT_PYTHON", "python3"),
        "hledger": executable("HLEDGER_BIN", "hledger"),
        "ledger": executable("LEDGER_BIN", "ledger"),
    }
    config = json.loads((LAB_DIR / "lab.json").read_text())
    selected = set(args.cases or [])
    unknown = selected - {case["id"] for case in config["cases"]}
    if unknown:
        raise SystemExit(f"unknown cases: {', '.join(sorted(unknown))}")

    context = {
        **binaries,
        "lab": str(LAB_DIR),
        "beancount_probe": str(LAB_DIR / "beancount_probe.py"),
        "beancount_valuation_probe": str(LAB_DIR / "beancount_valuation_probe.py"),
    }
    manifest: dict[str, object] = {
        "schema": 1,
        "corpus": config["corpus"],
        "binaries": {},
        "cases": [],
    }
    version_commands = {
        "beancount": [binaries["beancount_python"], "-c", "import beancount; print(beancount.__version__)"],
        "hledger": [binaries["hledger"], "--version"],
        "ledger": [binaries["ledger"], "--version"],
    }
    for engine, argv in version_commands.items():
        manifest["binaries"][engine] = run(argv, LAB_DIR)

    for case in config["cases"]:
        if selected and case["id"] not in selected:
            continue
        case_dir = LAB_DIR / "fixtures" / case["id"]
        case_output = output / case["id"]
        case_output.mkdir()
        case_result: dict[str, object] = {"id": case["id"], "probes": []}
        for probe in case["probes"]:
            argv = [part.format(**context, case=str(case_dir)) for part in probe["argv"]]
            result = run(argv, case_dir)
            result.update({"name": probe["name"], "engine": probe["engine"]})
            fixture = probe.get("fixture")
            if fixture:
                fixture_path = case_dir / fixture
                result["fixture"] = fixture
                result["fixture_sha256"] = hashlib.sha256(fixture_path.read_bytes()).hexdigest()
            probe_path = case_output / f"{probe['name']}.json"
            probe_path.write_text(json.dumps(result, indent=2, sort_keys=True) + "\n")
            case_result["probes"].append({
                "name": probe["name"],
                "engine": probe["engine"],
                "exit_status": result["exit_status"],
                "result": str(probe_path.relative_to(output)),
            })
        manifest["cases"].append(case_result)

    (output / "manifest.json").write_text(json.dumps(manifest, indent=2, sort_keys=True) + "\n")
    print(output / "manifest.json")
    return 0


if __name__ == "__main__":
    sys.exit(main())
