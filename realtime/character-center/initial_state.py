"""Explicit initial conditions for the four approved emotion trials only.

These initialise the real isolated mathematical system; they never supply an
answer, an expression selection, a joint target, or a new emotion calculator.
"""
import json
import time
from pathlib import Path
from tools.voice_avatar.duplex_transport import save_json

INITIAL = {
    "emotion-happy": [0.65, 0.50, 0.60, 0.08],
    "emotion-sad": [-0.55, 0.22, 0.30, 0.30],
    "emotion-serious": [-0.25, 0.72, 0.35, 0.72],
    "emotion-uncertain": [0.15, 0.18, 0.55, 0.08],
}


def initialise_math(main, output, fixture_id):
    if fixture_id not in INITIAL:
        raise ValueError("unknown_initial_condition")
    path = Path(output) / "initial-conditions.json"
    rows = json.loads(path.read_text(encoding="utf-8")) if path.exists() else {}
    if fixture_id in rows:
        return {"alreadyApplied": True, **rows[fixture_id]}
    system = main.emotion_system
    with system._emotion_lock:
        before = system.dynamics.get_state()
        relationship = system.dynamics.R.copy()
        system.dynamics.reset(E0=INITIAL[fixture_id], R0=relationship)
        system._sync_state_and_check_spike()
        system.save_state()
        row = {"fixtureId": fixture_id, "at": time.time(), "before": before,
               "after": system.dynamics.get_state(), "source": "explicit_experimental_initial_condition",
               "ongoingDynamics": "unchanged_WAI_math_at_real_time"}
    rows[fixture_id] = row
    save_json(path, rows)
    return row
