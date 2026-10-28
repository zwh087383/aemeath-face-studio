"""Optional performance permission. No defaults silently authorize variation."""
import math


def validate_performance(value, definition):
    if not isinstance(value, dict) or set(value) - {"total_seconds", "variant_set", "micro_set"}:
        raise ValueError("invalid_performance")
    contract = definition.get("performanceContract", {})
    if "total_seconds" in value:
        target = value["total_seconds"]
        bounds = target if isinstance(target, list) else [target, target]
        if (len(bounds) != 2 or any(isinstance(n, bool) or not isinstance(n, (int, float))
                or not math.isfinite(n) or n <= 0 for n in bounds) or bounds[0] > bounds[1]):
            raise ValueError("invalid_performance_duration")
        # Matching declared capability bounds is checked in the generated catalogue
        # validator and again against the actual loaded phase durations at execution.
        if not contract.get("total_seconds"):
            raise ValueError("unsupported_performance_duration")
        if definition.get("durationContract", {}).get("mode") != "whole-source-cycles" and bounds[1] < definition.get("durationContract", {}).get("minimumSeconds", definition.get("duration", 0)):
            raise ValueError("invalid_total_seconds")
    for key in ("variant_set", "micro_set"):
        if key not in value:
            continue
        allowed = contract.get(key, [])
        if not isinstance(value[key], list) or any(not isinstance(x, str) or x not in allowed for x in value[key]):
            raise ValueError("unsupported_performance_" + key)
        if key == "variant_set" and not value[key]:
            raise ValueError("invalid_variant_set")
        if len(set(value[key])) != len(value[key]):
            raise ValueError("duplicate_performance_" + key)
    return value
