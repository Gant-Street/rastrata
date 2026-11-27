#!/usr/bin/env python3
"""Move what a browser spec tests about the screens to the screens' tests (tests/dom, Bun and happy-dom).

Run from apps/web:

  python3 tooling/browser-to-dom.py port <name>            tests/browser/<name>.spec.ts -> tests/dom/<name>.test.ts
  bun test --conditions browser --preload ./tests/support/dom-preload.ts ./tests/dom/<name>.test.ts > /tmp/<name>.txt
  python3 tooling/browser-to-dom.py split <name> /tmp/<name>.txt
  python3 tooling/browser-to-dom.py prune tests/browser/<name>.spec.ts tests/dom/<name>.test.ts
  python3 tooling/browser-to-dom.py drop-project <project> <port>   when the browser file is left with no tests

`split` keeps in tests/dom each top-level test that passed there, and in tests/browser each that failed or that
measures the layout (a size, a position, a scroll: on happy-dom nothing has one, so such a test passes without
meaning it). When the browser keeps any, it keeps the file's first test too, which usually makes the book. Run the
browser half after: a test there that needed what a moved test made fails, and then the browser file goes back
whole (git checkout) and the moved tests stay in tests/dom only if they replace it (docs/reference/ci-cd.md).
`prune` removes the helpers each half no longer uses, checking after each removal that the file still parses.
"""
import re
import sys
from pathlib import Path

WEB = Path.cwd()  # apps/web
START = re.compile(r"^(test\(|test\.(skip|fixme|only)\(|for \(|test\.describe(\.\w+)?\(|test\.(beforeAll|beforeEach|afterAll|afterEach)\()")


def blocks(text: str):
    lines = text.split("\n")
    starts = [i for i, line in enumerate(lines) if START.match(line)]
    if not starts:
        return [("shared", "\n".join(lines))]
    out = []
    # a block runs from its start (with the comment lines just above it) to the line before the next top-level code
    def comment_start(i: int) -> int:
        j = i
        while j > 0 and (lines[j - 1].startswith("//") or lines[j - 1].startswith("/*") or lines[j - 1].startswith(" *") or lines[j - 1].startswith("*/")):
            j -= 1
        return j

    offsets = [0]
    for line in lines:
        offsets.append(offsets[-1] + len(line) + 1)

    def line_of(offset: int) -> int:
        lo, hi = 0, len(offsets) - 1
        while lo < hi:
            mid = (lo + hi + 1) // 2
            if offsets[mid] <= offset:
                lo = mid
            else:
                hi = mid - 1
        return lo

    def end_of(i: int) -> int:
        return line_of(statement_end(text, offsets[i]))

    cursor = 0
    for i in starts:
        if i < cursor:
            continue
        begin = comment_start(i)
        if begin > cursor:
            out.append(("shared", "\n".join(lines[cursor:begin])))
        end = end_of(i)
        out.append(("test", "\n".join(lines[begin : end + 1])))
        cursor = end + 1
    if cursor < len(lines):
        out.append(("shared", "\n".join(lines[cursor:])))
    return out


def statement_end(text: str, at: int) -> int:
    """The offset of the last character of the statement that starts at `at`: brackets matched, strings, template
    literals, comments and regular expressions skipped; it ends at a `;` with every bracket closed, or at a closing
    brace that closes the statement's last bracket and is followed by a new line."""
    depth = 0
    opened = False
    i = at
    n = len(text)
    last_significant = ""
    while i < n:
        c = text[i]
        if c == "/" and i + 1 < n and text[i + 1] == "/":
            i = text.find("\n", i)
            if i < 0:
                return n - 1
            continue
        if c == "/" and i + 1 < n and text[i + 1] == "*":
            i = text.find("*/", i + 2) + 2
            continue
        if c in "\"'":
            j = i + 1
            while j < n and text[j] != c:
                j += 2 if text[j] == "\\" else 1
            i = j + 1
            last_significant = c
            continue
        if c == "`":
            i = template_end(text, i) + 1
            last_significant = "`"
            continue
        if c == "/" and (last_significant == "" or last_significant in "(,=:[!&|?{};+-*%<>~^"):
            j = i + 1
            in_class = False
            while j < n:
                d = text[j]
                if d == "\\":
                    j += 2
                    continue
                if d == "[":
                    in_class = True
                elif d == "]":
                    in_class = False
                elif d == "/" and not in_class:
                    break
                elif d == "\n":
                    break
                j += 1
            i = j + 1
            while i < n and text[i].isalpha():
                i += 1
            last_significant = "/"
            continue
        if c in "([{":
            depth += 1
            opened = True
        elif c in ")]}":
            depth -= 1
            if depth == 0 and c == "}" and opened:
                k = i + 1
                while k < n and text[k] in " \t":
                    k += 1
                if k >= n or text[k] == "\n":
                    return i
        elif c == ";" and depth == 0:
            return i
        if not c.isspace():
            last_significant = c
        i += 1
    return n - 1


def template_end(text: str, at: int) -> int:
    i = at + 1
    n = len(text)
    while i < n:
        c = text[i]
        if c == "\\":
            i += 2
            continue
        if c == "`":
            return i
        if c == "$" and i + 1 < n and text[i + 1] == "{":
            depth = 1
            i += 2
            while i < n and depth:
                d = text[i]
                if d == "`":
                    i = template_end(text, i) + 1
                    continue
                if d in "\"'":
                    j = i + 1
                    while j < n and text[j] != d:
                        j += 2 if text[j] == "\\" else 1
                    i = j + 1
                    continue
                if d == "{":
                    depth += 1
                elif d == "}":
                    depth -= 1
                i += 1
            continue
        i += 1
    return n - 1


LAYOUT = re.compile(r"getBoundingClientRect|scrollWidth|scrollHeight|clientWidth|clientHeight|offsetWidth|offsetHeight|offsetTop|boundingBox\(|innerWidth|innerHeight|elementFromPoint|scrollIntoView\(|scrollTop|scrollY|toHaveCSS|toHaveScreenshot")


def names(block: str):
    return [m.group(2) for m in re.finditer(r"test(?:\.skip|\.fixme|\.only)?\(\s*([\"`'])((?:\\.|(?!\1).)*)\1", block, re.S)]


def port(name: str):
    source = (WEB / "tests/browser" / f"{name}.spec.ts").read_text()
    text = source.replace('from "@playwright/test";', 'from "./support/playwright";', 1)
    text = text.replace('from "../support/', 'from "../support/')
    (WEB / "tests/dom" / f"{name}.test.ts").write_text(text)


def to_regex(template: str) -> re.Pattern:
    parts = re.split(r"\$\{[^}]*\}", template)
    return re.compile("^" + ".+?".join(re.escape(part) for part in parts) + "$")


def split(name: str, results_path: str):
    results = Path(results_path).read_text()
    passed = set(re.findall(r"^\(pass\) (?:.* > )?(.+?) \[[0-9.]+m?s\]$", results, re.M))
    failed = set(re.findall(r"^\(fail\) (?:.* > )?(.+?) \[[0-9.]+m?s\]$", results, re.M))
    dom_path = WEB / "tests/dom" / f"{name}.test.ts"
    browser_path = WEB / "tests/browser" / f"{name}.spec.ts"
    dom, browser = [], []
    report = []
    # Helpers at the top level that measure the layout: a test that calls one measures it too.
    measuring = set()
    for kind, text in blocks(browser_path.read_text()):
        if kind != "shared":
            continue
        for match in re.finditer(r"^(?:export\s+)?(?:async\s+)?(?:function\s+(\w+)|(?:const|let)\s+(\w+)\s*=)", text, re.M):
            name = match.group(1) or match.group(2)
            body = text[match.start() : statement_end(text, match.start()) + 1]
            if LAYOUT.search(body):
                measuring.add(name)
    helper_call = re.compile(r"\b(" + "|".join(map(re.escape, sorted(measuring))) + r")\(") if measuring else None
    for kind_dom, kind_browser in zip(blocks(dom_path.read_text()), blocks(browser_path.read_text())):
        kind, text_dom = kind_dom
        _, text_browser = kind_browser
        if kind == "shared":
            dom.append(text_dom)
            browser.append(text_browser)
            continue
        titles = names(text_dom)
        hooks = not titles
        if hooks:
            dom.append(text_dom)
            browser.append(text_browser)
            continue
        patterns = [to_regex(title) for title in titles]
        # A test that measures the layout passes on happy-dom without meaning it (nothing has a size there): it stays
        # with the browser whatever happy-dom said.
        if LAYOUT.search(text_dom) or (helper_call and helper_call.search(text_dom)):
            browser.append(text_browser)
            report.append(("browser*", titles[0]))
            continue
        ok = [any(p.match(t) for t in passed) for p in patterns]
        bad = [any(p.match(t) for t in failed) for p in patterns]
        if all(ok) and not any(bad):
            dom.append(text_dom)
            report.append(("dom", titles[0]))
        else:
            browser.append(text_browser)
            report.append(("browser", titles[0]))
    # The browser's tests still need the book the file's first test makes: when any stay there, the first test stays too.
    kept = [where for where, _ in report]
    if kept and kept[0] == "dom" and any(where.startswith("browser") for where in kept[1:]):
        first_browser = next(text for kind, text in blocks(browser_path.read_text()) if kind == "test" and names(text))
        at = next(i for i, text in enumerate(browser) if names(text) or START.match(text.lstrip("\n").split("\n")[0] if text.strip() else ""))
        # put it before the first test the browser keeps
        index = next((i for i, text in enumerate(browser) if names(text)), len(browser))
        browser.insert(index, first_browser)
        report[0] = ("both", report[0][1])
    dom_path.write_text("\n".join(dom).rstrip("\n") + "\n")
    browser_path.write_text("\n".join(browser).rstrip("\n") + "\n")
    for where, title in report:
        print(f"{where:8} {title}")


if __name__ == "__main__":
    command = sys.argv[1]
    if command == "port":
        port(sys.argv[2])
    elif command == "split":
        split(sys.argv[2], sys.argv[3])
    elif command == "blocks":
        for kind, text in blocks((WEB / sys.argv[2]).read_text()):
            first = text.strip().split("\n")[0][:100] if text.strip() else ""
            print(kind, "|", first, "|", names(text)[:2])


def parses(path) -> bool:
    import subprocess
    return subprocess.run(["bun", "build", "--no-bundle", str(path)], capture_output=True).returncode == 0


def prune(path: str):
    """Remove the top-level declarations biome says are unused, until there are none (removing one can leave another
    unused), and the unused imports with biome's own fix."""
    import json
    import subprocess

    root = Path.cwd()
    while root != root.parent and not (root / "biome.json").exists() and not (root / "biome.jsonc").exists():
        root = root.parent
    target = Path(path).resolve()
    for _ in range(20):
        subprocess.run(["bun", "x", "biome", "lint", "--write", "--unsafe", "--only=correctness/noUnusedImports", str(target)], cwd=root, capture_output=True)
        out = subprocess.run(["bun", "x", "biome", "lint", "--reporter=json", "--only=correctness/noUnusedVariables", "--only=correctness/noUnusedFunctionParameters", str(target)], cwd=root, capture_output=True, text=True).stdout
        start = out.find("{")
        report = json.loads(out[start:]) if start >= 0 else {"diagnostics": []}
        text = target.read_text()
        lines = text.split("\n")
        offsets = [0]
        for line in lines:
            offsets.append(offsets[-1] + len(line) + 1)
        removals = []
        renames: set[str] = set()
        for diagnostic in report.get("diagnostics", []):
            if "noUnusedVariables" not in diagnostic.get("category", ""):
                continue
            start = diagnostic.get("location", {}).get("start")
            if not start:
                continue
            line_index = start["line"] - 1
            line = lines[line_index]
            if line[:1].isspace() or not line:
                continue  # only declarations at the top level
            begin = line_index
            while begin > 0 and (lines[begin - 1].startswith("//") or lines[begin - 1].startswith("/*") or lines[begin - 1].startswith(" *")):
                begin -= 1
            end_offset = statement_end(text, offsets[line_index])
            end_line = max(i for i, o in enumerate(offsets) if o <= end_offset)
            declared = re.match(r"(?:export\s+)?(?:async\s+)?(?:function\*?\s+(\w+)|(?:const|let|var)\s+(\w+))", line)
            name = (declared.group(1) or declared.group(2)) if declared else None
            rest = "\n".join(lines[:begin] + lines[end_line + 1 :])
            if name and re.search(rf"\b{re.escape(name)}\b", rest):
                # still assigned somewhere (a `let` a test sets and no test here reads): kept, named as unused
                renames.add(name)
                continue
            removals.append((begin, end_line))
        if renames:
            renamed = text
            for name in renames:
                # an identifier, never a word inside a string ("dialog" in getByRole("dialog") is not the variable)
                renamed = re.sub(rf"(?<![\w$.\"'`/-]){re.escape(name)}(?![\w$\"'`])", f"_{name}", renamed)
            target.write_text(renamed)
            if not parses(target):
                target.write_text(text)
            text = target.read_text()
            lines = text.split("\n")
        if not removals:
            if renames:
                continue
            break
        # one removal at a time, each kept only if the file still parses
        changed = False
        for begin, end in sorted(set(removals), reverse=True):
            trial = lines[:begin] + lines[end + 1 :]
            target.write_text(re.sub(r"\n{3,}", "\n\n", "\n".join(trial)))
            if parses(target):
                lines = trial
                changed = True
            else:
                target.write_text(re.sub(r"\n{3,}", "\n\n", "\n".join(lines)))
        if not changed:
            break
    subprocess.run(["bun", "x", "biome", "format", "--write", str(target)], cwd=root, capture_output=True)


if __name__ == "__main__" and sys.argv[1] == "prune":
    for path in sys.argv[2:]:
        prune(path)


def object_span(text: str, inside: int):
    """The offsets of the `{ ... }` object literal around `inside`, with its trailing comma and the comment lines
    right above it."""
    depth = 0
    i = inside
    while i >= 0:
        c = text[i]
        if c == "}":
            depth += 1
        elif c == "{":
            if depth == 0:
                break
            depth -= 1
        i -= 1
    start = i
    end = statement_end_object(text, start)
    if end + 1 < len(text) and text[end + 1] == ",":
        end += 1
    # back over the indentation and the comment lines above
    line_start = text.rfind("\n", 0, start) + 1
    while True:
        prev_end = line_start - 1
        prev_start = text.rfind("\n", 0, prev_end) + 1
        if prev_end > 0 and text[prev_start:prev_end].strip().startswith("//"):
            line_start = prev_start
        else:
            break
    line_end = text.find("\n", end)
    return line_start, (line_end if line_end >= 0 else len(text))


def statement_end_object(text: str, start: int) -> int:
    depth = 0
    i = start
    while i < len(text):
        c = text[i]
        if c in "\"'":
            j = i + 1
            while text[j] != c:
                j += 2 if text[j] == "\\" else 1
            i = j + 1
            continue
        if c == "`":
            i = template_end(text, i) + 1
            continue
        if c == "{":
            depth += 1
        elif c == "}":
            depth -= 1
            if depth == 0:
                return i
        i += 1
    return len(text) - 1


def drop_project(name: str, port: int):
    path = Path.cwd() / "playwright.config.ts"
    text = path.read_text()
    marker = f'name: "{name}"'
    at = text.find(marker)
    if at < 0:
        raise SystemExit(f"no project {name}")
    begin, end = object_span(text, at)
    text = text[:begin] + text[end + 1:]
    for p in (port, port + 1):
        while True:
            at = text.find(f"url: `http://127.0.0.1:${{port({p})}}")
            if at < 0:
                break
            begin, end = object_span(text, at)
            text = text[:begin] + text[end + 1:]
    path.write_text(text)


if __name__ == "__main__" and sys.argv[1] == "drop-project":
    drop_project(sys.argv[2], int(sys.argv[3]))
