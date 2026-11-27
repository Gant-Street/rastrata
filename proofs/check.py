#!/usr/bin/env python3
"""Checks the proofs: they build, nothing is left unproved, nothing forbidden is used, and no
declaration that was already committed has been changed (only its proof may be).

    python3 check.py                 # everything, against HEAD
    python3 check.py --allow-sorry   # work in progress: report what is unproved, do not fail on it
    python3 check.py --base <ref>    # compare committed declarations against another commit
"""
import pathlib
import re
import subprocess
import sys

HERE = pathlib.Path(__file__).resolve().parent
FORBIDDEN = [
    (r"(?m)^\s*(?:private\s+|protected\s+)?axiom\b", "axiom"),
    (r"\bnative_decide\b", "native_decide"),
    (r"\bsorryAx\b", "sorryAx"),
    (r"(?m)^\s*admit\b", "admit"),
    (r"\bimplemented_by\b", "implemented_by"),
    (r"@\[\s*extern\b", "extern"),
    (r"(?m)^\s*(?:private\s+|protected\s+)?(?:unsafe|partial)\s+def\b", "unsafe or partial def"),
    (r"\bdebug\.skipKernelTC\b", "debug.skipKernelTC"),
    (r"(?m)^import Mathlib\s*$", "import of all of Mathlib"),
]


def strip_comments(text: str) -> str:
    out, depth, i = [], 0, 0
    while i < len(text):
        if text.startswith("/-", i):
            depth += 1
            i += 2
        elif depth and text.startswith("-/", i):
            depth -= 1
            i += 2
        elif depth:
            i += 1
        elif text.startswith("--", i):
            while i < len(text) and text[i] != "\n":
                i += 1
        else:
            out.append(text[i])
            i += 1
    return "".join(out)


DECL = re.compile(
    r"(?m)^(?:@\[[^\]]*\]\s*)*(?:private\s+|protected\s+|noncomputable\s+)*"
    r"(theorem|lemma|def|abbrev|structure|inductive|instance|class)\b"
)


def declarations(text: str) -> list[str]:
    """Every top-level declaration, a theorem cut at the start of its proof, whitespace collapsed."""
    text = strip_comments(text)
    starts = [m.start() for m in DECL.finditer(text)]
    found = []
    for index, start in enumerate(starts):
        end = starts[index + 1] if index + 1 < len(starts) else len(text)
        chunk = text[start:end]
        chunk = re.split(r"(?m)^(?:end|namespace|section|open|variable)\b", chunk)[0]
        if re.match(r"(?:@\[[^\]]*\]\s*)*(?:private\s+|protected\s+)*(theorem|lemma)\b", chunk):
            chunk = chunk.split(":=", 1)[0]
        found.append(" ".join(chunk.split()))
    return found


def main() -> int:
    allow_sorry = "--allow-sorry" in sys.argv
    base = sys.argv[sys.argv.index("--base") + 1] if "--base" in sys.argv else "HEAD"
    failures: list[str] = []

    build = subprocess.run(["lake", "build"], cwd=HERE, capture_output=True, text=True)
    output = build.stdout + build.stderr
    if build.returncode != 0:
        print(output[-6000:])
        failures.append("the build fails")
    unproved = re.findall(r"warning: (\S+?:\d+):\d+: declaration uses `?'?sorry", output)
    if unproved:
        print(f"{len(unproved)} declarations are not proved:")
        for where in unproved:
            print(f"  {where}")
        if not allow_sorry:
            failures.append(f"{len(unproved)} declarations use sorry")

    sources = sorted(p for p in HERE.rglob("*.lean") if ".lake" not in p.parts)
    for source in sources:
        text = strip_comments(source.read_text())
        for pattern, name in FORBIDDEN:
            if re.search(pattern, text):
                failures.append(f"{source.relative_to(HERE)} uses {name}")

    root = subprocess.run(["git", "rev-parse", "--show-toplevel"], cwd=HERE, capture_output=True, text=True).stdout.strip()
    listed = subprocess.run(["git", "ls-tree", "-r", "--name-only", base, "--", "proofs"], cwd=root, capture_output=True, text=True)
    for name in listed.stdout.split():
        if not name.endswith(".lean"):
            continue
        before = subprocess.run(["git", "show", f"{base}:{name}"], cwd=root, capture_output=True, text=True).stdout
        path = pathlib.Path(root) / name
        if not path.exists():
            failures.append(f"{name} was committed and is gone")
            continue
        now = " ".join(strip_comments(path.read_text()).split())
        for declaration in declarations(before):
            if declaration not in now:
                failures.append(f"{name}: a committed declaration was changed: {declaration[:140]}")

    def module_path(module: str) -> pathlib.Path:
        return HERE / (module.replace(".", "/") + ".lean")

    reachable: set[str] = set()
    pending = ["Rastrata"]
    while pending:
        module = pending.pop()
        if module in reachable:
            continue
        reachable.add(module)
        path = module_path(module)
        if path.exists():
            for dependency in re.findall(r"(?m)^import (Rastrata[\w.]*)\s*$", path.read_text()):
                pending.append(dependency)
    for source in sources:
        relative = source.relative_to(HERE)
        if relative.parts[0] != "Rastrata" or len(relative.parts) == 1:
            continue
        module = ".".join(relative.with_suffix("").parts)
        if module not in reachable:
            failures.append(f"{relative} is not imported, directly or not, by Rastrata.lean, so it is not built")

    for failure in failures:
        print(f"FAIL: {failure}")
    print("proofs: " + ("ok" if not failures else f"{len(failures)} failures"))
    return 1 if failures else 0


if __name__ == "__main__":
    sys.exit(main())
