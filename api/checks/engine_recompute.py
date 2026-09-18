"""
The Python verifier pack, deployed as a Vercel Python function.

Why a second language at all: `engine_recompute` asks whether the numbers a row
claims recompute from the inputs it cited. If the recomputation is the same code
that produced the numbers, it agrees with itself by construction and the check
proves nothing. This file is an independent implementation of the same four
engines, written from the formulas rather than from the TypeScript, so a mistake
in one of them shows up as a disagreement instead of being confirmed.

It is a pure function of its request: the cited inputs go in, the recomputed
values come out. It reads no database, holds no state and takes no credentials,
which is what lets it run outside the application's boundary.

Vercel's Python runtime invokes `handler`, a BaseHTTPRequestHandler subclass.
That is a standard library class, so `scripts/serve_python_checks.py` serves this
exact file locally and the tests drive the real function over a real socket.
"""

import json
import math
from http.server import BaseHTTPRequestHandler

CHECK_ID = "engine_recompute_python"


def js_round(value, places=2):
    """JavaScript's Math.round, which rounds a half away from zero towards
    positive infinity. Python's round() rounds a half to even, so 2.5 becomes 2
    and every headroom ending in a half would disagree with the engine for a
    reason that has nothing to do with the numbers."""
    if value is None or not math.isfinite(value):
        return float("nan")
    factor = 10 ** places
    return math.floor(value * factor + 0.5) / factor


def number(facts, name):
    """A cited input's value, or NaN when the row did not cite it."""
    fact = facts.get(name)
    if fact is None:
        return float("nan")
    value = fact.get("value")
    if isinstance(value, bool) or not isinstance(value, (int, float)):
        return float("nan")
    return float(value)


def covenant_tests(facts):
    leverage = number(facts, "leverage")
    coverage = number(facts, "coverage")
    leverage_max = number(facts, "covenant_leverage_max")
    coverage_min = number(facts, "covenant_coverage_min")

    leverage_headroom = js_round(leverage_max - leverage)
    coverage_headroom = js_round(coverage - coverage_min)

    return {
        "leverage": leverage,
        "leverage_covenant": leverage_max,
        "leverage_headroom": leverage_headroom,
        "coverage": coverage,
        "coverage_covenant": coverage_min,
        "coverage_headroom": coverage_headroom,
        "leverage_breach": leverage_headroom < 0 if math.isfinite(leverage_headroom) else False,
        "coverage_breach": coverage_headroom < 0 if math.isfinite(coverage_headroom) else False,
        "any_breach_risk": leverage_headroom < 0.5 if math.isfinite(leverage_headroom) else False,
    }


def basket_capacity(facts):
    def or_zero(name):
        value = number(facts, name)
        return 0 if math.isnan(value) else value

    general = or_zero("basket_general")
    restricted = or_zero("basket_restricted_payments")
    investments = or_zero("basket_investments")

    return {
        "basket_general": general,
        "basket_restricted_payments": restricted,
        "basket_investments": investments,
        "total_permitted": general + restricted + investments,
    }


def headroom(facts):
    liquidity = number(facts, "liquidity")
    ebitda = number(facts, "ebitda")
    months = js_round(liquidity / (ebitda / 12), 1) if ebitda > 0 else float("nan")

    return {
        "liquidity": liquidity,
        "ebitda": ebitda,
        "months_of_ebitda": months if math.isfinite(months) else None,
    }


def mandate_fit(facts):
    leverage = number(facts, "leverage")
    commitment = number(facts, "commitment")

    rules = [
        leverage < 6 if math.isfinite(leverage) else None,
        (50_000_000 <= commitment <= 400_000_000) if math.isfinite(commitment) else None,
    ]

    return {
        "leverage": leverage,
        "commitment": commitment,
        "rules_passed": len([r for r in rules if r is True]),
        "rules_failed": len([r for r in rules if r is False]),
        "rules_unknown": len([r for r in rules if r is None]),
        # An unknown is not a pass, which is the whole point of counting them.
        "fit": all(r is True for r in rules),
    }


ENGINES = {
    "covenant_tests": covenant_tests,
    "basket_capacity": basket_capacity,
    "headroom": headroom,
    "mandate_fit": mandate_fit,
}


def latest(evidence, kind):
    """Evidence is append only and accumulates across attempts, so the newest
    match is the one that belongs with the outputs on the row now."""
    found = [item for item in evidence if item.get("kind") == kind]
    return found[-1] if found else None


def agrees(claimed, recomputed, tolerance):
    """A number is within tolerance; anything else must be equal. A boolean is
    compared as a boolean, because in Python False equals 0 and a breach flag
    would otherwise agree with a headroom of zero."""
    if isinstance(claimed, bool) or isinstance(recomputed, bool):
        return claimed is recomputed
    claimed_number = isinstance(claimed, (int, float))
    recomputed_number = isinstance(recomputed, (int, float))
    if claimed_number and recomputed_number:
        if math.isnan(claimed) or math.isnan(recomputed):
            return math.isnan(claimed) and math.isnan(recomputed)
        return abs(claimed - recomputed) <= tolerance
    # A value the engine could not compute serialises out of JavaScript as null,
    # and arrives here as None. NaN on this side means the same thing.
    if claimed is None and recomputed_number and math.isnan(recomputed):
        return True
    if recomputed is None and claimed_number and math.isnan(claimed):
        return True
    return claimed == recomputed


def jsonable(value):
    if isinstance(value, float) and not math.isfinite(value):
        return None
    return value


def run(payload):
    params = payload.get("params") or {}
    tolerance = params.get("tolerance", 0)
    try:
        tolerance = float(tolerance)
    except (TypeError, ValueError):
        tolerance = 0.0

    evidence = payload.get("evidence") or []
    item = latest(evidence, "engine_trace")
    body = (item or {}).get("body") or {}

    claimed = body.get("values")
    if not isinstance(claimed, dict) or not claimed:
        return {"passed": False, "details": {"reason": "no engine trace is attached"}}

    inputs = body.get("inputs")
    if not isinstance(inputs, list) or not inputs:
        return {"passed": False, "details": {"reason": "the trace cites no inputs"}}
    if any(not entry.get("factId") for entry in inputs):
        return {"passed": False, "details": {"reason": "an input is not cited by fact id"}}

    engine = body.get("engine")
    compute = ENGINES.get(engine)
    if compute is None:
        # Refusing is the safe answer. A verifier that shrugs at an engine it does
        # not know would pass every row computed by an engine nobody wrote a
        # verifier for.
        return {
            "passed": False,
            "details": {"reason": "no verifier for this engine", "engine": engine, "known": sorted(ENGINES)},
        }

    facts = {entry.get("attribute"): entry for entry in inputs if entry.get("attribute")}
    recomputed = compute(facts)

    disagreements = [
        {
            "key": key,
            "claimed": jsonable(value),
            "recomputed": jsonable(recomputed.get(key)),
        }
        for key, value in claimed.items()
        if not agrees(value, recomputed.get(key), tolerance)
    ]

    return {
        "passed": len(disagreements) == 0,
        "details": {
            "verifier": "python",
            "engine": engine,
            "tolerance": tolerance,
            "inputs": len(inputs),
            "disagreements": [d["key"] for d in disagreements],
            "detail": disagreements,
            "recomputed": {key: jsonable(value) for key, value in recomputed.items()},
        },
    }


MANIFEST = {
    "checks": [
        {
            "id": CHECK_ID,
            "pack": "credit",
            "description": "An independent Python recomputation of the engine agrees with the values the row claims.",
        }
    ]
}


def send(request, status, body):
    """Module level rather than a method, so the local router in
    scripts/serve_python_checks.py can dispatch to these handlers by path without
    having to inherit from each of them."""
    encoded = json.dumps(body).encode("utf-8")
    request.send_response(status)
    request.send_header("content-type", "application/json")
    request.send_header("content-length", str(len(encoded)))
    request.end_headers()
    request.wfile.write(encoded)


class handler(BaseHTTPRequestHandler):
    def do_GET(self):
        send(self, 200, MANIFEST)

    def do_POST(self):
        try:
            length = int(self.headers.get("content-length") or 0)
            payload = json.loads(self.rfile.read(length) or b"{}")
        except (ValueError, TypeError) as error:
            send(self, 400, {"error": f"the request body is not JSON: {error}"})
            return
        try:
            send(self, 200, run(payload))
        except Exception as error:  # noqa: BLE001
            # The adapter turns any non result into a failed check, but saying why
            # here means the reason reaches the row's details rather than a log.
            send(self, 500, {"error": f"{type(error).__name__}: {error}"})

    def log_message(self, *args):
        pass
