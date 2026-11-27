#!/usr/bin/env python3
"""Probe Beancount's direct and caller-specified-via valuation behavior."""

from __future__ import annotations

from decimal import Decimal
import json
from pathlib import Path
import sys

from beancount import loader
from beancount.core.amount import Amount
from beancount.core import convert, prices


def amount_json(amount: Amount) -> dict[str, str]:
    return {"number": str(amount.number), "currency": amount.currency}


def main() -> int:
    path = Path(sys.argv[1]).resolve()
    number, base, target = sys.argv[2:5]
    via = tuple(sys.argv[5:])
    entries, errors, _ = loader.load_file(path)
    price_map = prices.build_price_map(entries)
    original = Amount(Decimal(number), base)
    direct = convert.convert_amount(original, target, price_map)
    result = {
        "input": path.name,
        "original": amount_json(original),
        "target": target,
        "via": list(via),
        "direct_result": amount_json(direct),
        "via_result": amount_json(convert.convert_amount(original, target, price_map, via=via)),
        "loader_error_count": len(errors),
    }
    print(json.dumps(result, indent=2, sort_keys=True))
    return 1 if errors else 0


if __name__ == "__main__":
    sys.exit(main())
