#!/usr/bin/env python3
"""Load and book a Beancount fixture, emitting deterministic typed JSON."""

from __future__ import annotations

import datetime
from decimal import Decimal
import hashlib
import io
import json
from pathlib import Path
import sys

from beancount import loader
from beancount.parser import printer


def encode(value):
    if isinstance(value, Decimal):
        return {"type": "Decimal", "value": str(value)}
    if isinstance(value, (datetime.date, datetime.datetime)):
        return {"type": type(value).__name__, "value": value.isoformat()}
    if isinstance(value, frozenset):
        return [encode(item) for item in sorted(value)]
    if isinstance(value, (list, tuple)) and not hasattr(value, "_fields"):
        return [encode(item) for item in value]
    if isinstance(value, dict):
        return {str(key): encode(item) for key, item in sorted(value.items(), key=lambda pair: str(pair[0]))}
    if hasattr(value, "_fields"):
        return {
            "type": type(value).__name__,
            **{field: encode(getattr(value, field)) for field in value._fields},
        }
    if isinstance(value, (str, int, bool)) or value is None:
        return value
    return {"type": type(value).__name__, "repr": repr(value)}


def main() -> int:
    path = Path(sys.argv[1]).resolve()
    entries, errors, options = loader.load_file(path)
    rendered_errors = io.StringIO()
    printer.print_errors(errors, file=rendered_errors)
    result = {
        "schema": 1,
        "input": path.name,
        "input_sha256": hashlib.sha256(path.read_bytes()).hexdigest(),
        "booking_method": str(options.get("booking_method")),
        "entries": encode(entries),
        "errors": encode(errors),
        "errors_rendered": rendered_errors.getvalue(),
    }
    print(json.dumps(result, indent=2, sort_keys=True))
    return 1 if errors else 0


if __name__ == "__main__":
    sys.exit(main())
