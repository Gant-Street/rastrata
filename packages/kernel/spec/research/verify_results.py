#!/usr/bin/env python3
"""Verify the lab's semantic observations against captured raw results."""

from __future__ import annotations

import argparse
import json
from pathlib import Path
import sys


LAB_DIR = Path(__file__).resolve().parent


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("results", type=Path)
    args = parser.parse_args()
    root = args.results.resolve()
    specification = json.loads((LAB_DIR / "expectations.json").read_text())
    failures: list[str] = []

    for expected in specification["expectations"]:
        path = root / expected["result"]
        if not path.exists():
            failures.append(f"missing result: {expected['result']}")
            continue
        actual = json.loads(path.read_text())
        if actual["exit_status"] != expected["exit_status"]:
            failures.append(
                f"{expected['result']}: exit {actual['exit_status']} != {expected['exit_status']}"
            )
        for stream in ("stdout", "stderr"):
            for needle in expected.get(f"{stream}_contains", []):
                if needle not in actual[stream]:
                    failures.append(f"{expected['result']}: {stream} lacks {needle!r}")
            for needle in expected.get(f"{stream}_excludes", []):
                if needle in actual[stream]:
                    failures.append(f"{expected['result']}: {stream} contains forbidden {needle!r}")

    for pair in specification.get("equal_stdout", []):
        left = json.loads((root / pair[0]).read_text())["stdout"]
        right = json.loads((root / pair[1]).read_text())["stdout"]
        if left != right:
            failures.append(f"stdout differs: {pair[0]} != {pair[1]}")

    if failures:
        print("\n".join(f"FAIL: {failure}" for failure in failures), file=sys.stderr)
        return 1
    print(f"verified {len(specification['expectations'])} observations and "
          f"{len(specification.get('equal_stdout', []))} equivalence pairs")
    return 0


if __name__ == "__main__":
    sys.exit(main())
