"""Execution capacity, separate from immutable stimuli and aggregate ceilings."""
from copy import deepcopy


def effective_case(case, multi_listener_limit=None):
    value = deepcopy(case)
    if multi_listener_limit is None:
        return value
    if type(multi_listener_limit) is not int or not 8 <= multi_listener_limit <= 20:
        raise ValueError("invalid_multi_listener_limit")
    if value["kind"] != "single":
        value["limits"]["listener"] = max(value["limits"]["listener"], multi_listener_limit)
        value["executionPolicy"] = {
            "reason": "one_spoken_fixture_can_produce_multiple_transcription_responses",
            "multiListenerLimit": multi_listener_limit,
            "aggregateCeilingsUnchanged": True,
            "stimuliAndActionsUnchanged": True,
        }
    return value
