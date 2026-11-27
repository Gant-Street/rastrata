#!/usr/bin/env python3
"""Fail-closed SysIDE push diagnostics, verified by real negative controls."""

from __future__ import annotations

import argparse
import glob
import json
import os
from pathlib import Path
import queue
import shutil
import subprocess
import sys
import threading
import tempfile
import uuid
import time


def find_syside(explicit: str | None) -> str:
    if explicit:
        return explicit
    installed = shutil.which("syside")
    if installed:
        return installed
    candidates = glob.glob(str(Path.home() / ".vscode/extensions/sensmetry.syside-editor-*-darwin-arm64/dist/Syside.app/Contents/MacOS/syside"))
    if candidates:
        def version(path: str) -> tuple[int, ...]:
            folder = Path(path).parents[4].name
            return tuple(int(part) for part in folder.split("editor-")[1].split("-")[0].split("."))
        return max(candidates, key=version)
    raise RuntimeError("SysIDE executable not found; pass --syside or install the SysIDE editor extension")


def write_message(process: subprocess.Popen[bytes], payload: object) -> None:
    encoded = json.dumps(payload, separators=(",", ":")).encode()
    assert process.stdin is not None
    process.stdin.write(f"Content-Length: {len(encoded)}\r\n\r\n".encode() + encoded)
    process.stdin.flush()


def read_message(process: subprocess.Popen[bytes]) -> dict[str, object]:
    assert process.stdout is not None
    headers: dict[str, str] = {}
    while True:
        line = process.stdout.readline()
        if not line:
            raise RuntimeError("SysIDE language server exited before publishing complete diagnostics")
        if line in (b"\r\n", b"\n"):
            break
        key, value = line.decode().split(":", 1)
        headers[key.lower()] = value.strip()
    message = json.loads(process.stdout.read(int(headers["content-length"])))
    if not isinstance(message, dict):
        raise RuntimeError("Malformed SysIDE JSON-RPC message")
    return message


def published_diagnostics(executable: str, model: Path, timeout: float = 60,
                          source_text: str | None = None,
                          required_marker: str | None = None) -> tuple[list[dict[str, object]], object]:
    original = model.read_text()
    text = original if source_text is None else source_text
    root = model.parent
    uri = model.as_uri()
    process = subprocess.Popen(
        [executable, "server", "--stdio", "--log-level", "error", "--edit", "all", "--crash-reports", "ignore"],
        cwd=root, stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=subprocess.PIPE,
    )
    messages: queue.Queue[dict[str, object] | Exception] = queue.Queue()
    stderr: list[bytes] = []

    def receive() -> None:
        try:
            while True:
                messages.put(read_message(process))
        except Exception as error:
            messages.put(error)

    def drain_stderr() -> None:
        assert process.stderr is not None
        for line in process.stderr:
            stderr.append(line)
            if len(stderr) > 100:
                stderr.pop(0)

    reader = threading.Thread(target=receive, daemon=True)
    errors = threading.Thread(target=drain_stderr, daemon=True)
    reader.start()
    errors.start()
    deadline = time.monotonic() + timeout
    diagnostics: list[dict[str, object]] | None = None
    initialized = False
    server_info: object = None
    try:
        write_message(process, {
            "jsonrpc": "2.0", "id": 1, "method": "initialize",
            "params": {
                "processId": os.getpid(), "rootUri": root.as_uri(),
                "workspaceFolders": [{"uri": root.as_uri(), "name": root.name}],
                "capabilities": {"textDocument": {"publishDiagnostics": {"versionSupport": True}}},
            },
        })
        while not initialized or diagnostics is None:
            remaining = deadline - time.monotonic()
            if remaining <= 0:
                raise RuntimeError(f"Timed out waiting for SysIDE diagnostics for {model.name}")
            try:
                message = messages.get(timeout=remaining)
            except queue.Empty as error:
                raise RuntimeError(f"Timed out waiting for SysIDE diagnostics for {model.name}") from error
            if isinstance(message, Exception):
                raise message
            if message.get("id") == 1 and not initialized:
                result = message.get("result")
                if "error" in message or not isinstance(result, dict) or not isinstance(result.get("capabilities"), dict):
                    raise RuntimeError(f"SysIDE initialization failed: {message}")
                initialized = True
                server_info = result.get("serverInfo")
                write_message(process, {"jsonrpc": "2.0", "method": "initialized", "params": {}})
                write_message(process, {
                    "jsonrpc": "2.0", "method": "textDocument/didOpen",
                    "params": {"textDocument": {"uri": uri, "languageId": "sysml", "version": 1, "text": text}},
                })
            elif message.get("method") == "textDocument/publishDiagnostics":
                params = message.get("params")
                if isinstance(params, dict) and params.get("uri") == uri:
                    items = params.get("diagnostics")
                    if not isinstance(items, list) or not all(isinstance(item, dict) and isinstance(item.get("message"), str) and item.get("severity") in (1, 2, 3, 4) for item in items):
                        raise RuntimeError("Malformed or incomplete SysIDE diagnostic publication")
                    if required_marker is None or any(required_marker in item["message"] for item in items):
                        diagnostics = items
            elif message.get("method") == "window/showMessage":
                params = message.get("params")
                if isinstance(params, dict) and params.get("type") == 1:
                    raise RuntimeError(f"SysIDE reported an error: {params.get('message')}")
        if model.read_text() != original:
            raise RuntimeError("Model changed while SysIDE was checking it")
        return diagnostics, server_info
    except Exception as error:
        detail = b"".join(stderr).decode(errors="replace").strip()
        raise RuntimeError(f"{error}" + (f"\nSysIDE stderr: {detail}" if detail else "")) from error
    finally:
        # Bounded cleanup even if the server never answered a request.
        if process.poll() is None:
            process.terminate()
            try:
                process.wait(timeout=2)
            except subprocess.TimeoutExpired:
                process.kill()
                process.wait(timeout=2)
        reader.join(timeout=1)
        errors.join(timeout=1)



def diagnose_source(executable: str, text: str) -> tuple[list[dict[str, object]], object]:
    # Editor diagnostics are asynchronous, and an initially valid file need not
    # publish an empty report. Add one isolated unresolved-reference canary to
    # an exact saved copy, so even a valid model must produce a semantic report.
    # Never edit the real model or treat an empty unsupported pull as success.
    name = "KernelAuditMissingType" + uuid.uuid4().hex
    prefix = text + "\n"
    canary_line = prefix.count("\n")
    with tempfile.TemporaryDirectory(prefix="rastrata-syside-check-") as directory:
        staged = Path(directory) / "model.sysml"
        staged.write_text(prefix + f"package KernelAuditCanary {{ part sentinel : {name}; }}\n")
        diagnostics, server = published_diagnostics(executable, staged)
    canaries = [item for item in diagnostics if item.get("code") == "reference-error" and
                name in item["message"] and item.get("range", {}).get("start", {}).get("line") == canary_line]
    if len(canaries) != 1:
        # Syntax errors can prevent reference resolution altogether. They still
        # fail the gate, but cannot be presented as a successful semantic check.
        if diagnostics:
            return diagnostics, server
        raise RuntimeError("SysIDE returned no semantic canary: validation was not demonstrated")
    return [item for item in diagnostics if item is not canaries[0]], server


def verify_controls(executable: str) -> None:
    for label, source, expected_code in [
        ("valid", "package DiagnosticControl { part def Known; part value : Known; }", None),
        ("syntax", "package DiagnosticControl { part invalid : ; }", "syntax-error"),
        ("semantic", "package DiagnosticControl { part invalid : DeliberatelyUndefinedAuditType; }", "reference-error"),
    ]:
        diagnostics, _ = diagnose_source(executable, source)
        if (expected_code is None and diagnostics) or (expected_code is not None and not any(item.get("severity") == 1 and item.get("code") == expected_code for item in diagnostics)):
            raise RuntimeError(f"SysIDE {label} control failed: {diagnostics}")


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--syside")
    parser.add_argument("--model", default="packages/kernel/spec/rastrata-accounting-backend.sysml")
    parser.add_argument("--dependency", action="append", default=[],
                        help="Additional first-party model, loaded before the checked model")
    parser.add_argument("--workspace", action="store_true",
                        help="Also verify cross-file imports in the original editor workspace")
    arguments = parser.parse_args()
    root = Path(__file__).resolve().parents[3]
    model = (root / arguments.model).resolve()
    executable = find_syside(arguments.syside)
    verify_controls(executable)
    original_text = model.read_text()
    dependencies = [(root / name).resolve() for name in arguments.dependency]
    dependency_sources = [(path, path.read_text()) for path in dependencies]
    prefix = "".join(source + "\n" for _, source in dependency_sources)
    diagnostics, server_info = diagnose_source(executable, prefix + original_text)
    workspace_diagnostics = None
    if arguments.workspace:
        marker = "WorkspaceAuditMissingType" + uuid.uuid4().hex
        source = original_text + f"\npackage WorkspaceAuditCanary {{ part sentinel : {marker}; }}\n"
        workspace_diagnostics, _ = published_diagnostics(executable, model,
            source_text=source, required_marker=marker)
        canaries = [item for item in workspace_diagnostics if item.get("code") == "reference-error" and marker in item["message"]]
        if len(canaries) != 1:
            raise RuntimeError("Original workspace semantic canary was not demonstrated")
        workspace_diagnostics = [item for item in workspace_diagnostics if item is not canaries[0]]
    if model.read_text() != original_text or any(path.read_text() != source for path, source in dependency_sources):
        raise RuntimeError("Model changed while SysIDE was checking it")
    counts = {name: sum(item["severity"] == severity for item in diagnostics) for name, severity in [("errors", 1), ("warnings", 2), ("information", 3), ("hints", 4)]}
    counts["total"] = len(diagnostics)
    print(json.dumps({
        "model": str(model.relative_to(root)) if model.is_relative_to(root) else str(model),
        "dependencies": arguments.dependency,
        "modelLineOffset": prefix.count("\n"),
        "workspaceDiagnostics": workspace_diagnostics,
        "server": server_info, "controls": "valid, syntax-error, and unresolved-reference controls passed",
        "transport": "saved-copy semantic canary and textDocument/publishDiagnostics",
        "counts": counts, "diagnostics": diagnostics,
    }, indent=2))
    return 0 if not diagnostics and not workspace_diagnostics else 1


if __name__ == "__main__":
    try:
        raise SystemExit(main())
    except Exception as error:
        print(f"SysIDE diagnostic check failed: {error}", file=sys.stderr)
        raise SystemExit(2)
