"""Read-only analysis of resumed real-model runs; never generates or replays actions.

The report keeps digital output silence, source disposal, rendered pose pause and
formal server cancellation separate. All timing clocks are named explicitly.
"""
import argparse
from collections import Counter
import hashlib
import json
from pathlib import Path
import statistics


ROOT = Path(__file__).resolve().parents[2]
TERMINAL = {"completed", "failed", "rejected", "expired", "cancelled"}


def read(path, default=None):
    return json.loads(path.read_text(encoding="utf-8-sig")) if path.exists() else default


def number(value):
    return isinstance(value, (int, float)) and not isinstance(value, bool)


def difference(end, start):
    return round(end - start, 3) if number(end) and number(start) else None


def stats(values):
    values = [v for v in values if number(v)]
    return ({"n": len(values), "median": round(statistics.median(values), 3),
             "mean": round(statistics.mean(values), 3), "min": round(min(values), 3),
             "max": round(max(values), 3)} if values else {"n": 0})


def resets(values):
    values = [v for v in values if number(v)]
    return sum(b < a - .01 for a, b in zip(values, values[1:]))


def audio_silence(probe, onset, pause):
    """Bound the first sustained exact-silence interval on a single audio clock.

    512-frame aggregate blocks cannot identify the exact last audible sample.
    A pre-existing inter-word pause is explicitly not credited to cancellation.
    """
    result = {"clock": "AudioContext seconds", "physicalSpeakerMeasured": False,
              "silenceThresholdPeak": 1e-7, "sustainedSilenceRequiredMs": 80,
              "firstFullSilentBlockMs": None, "digitalStopIntervalMs": None}
    blocks = probe.get("audioBlocks", [])
    if not blocks or not number(onset.get("contextTime")):
        return {**result, "status": "missing_audio_observation"}
    # Legacy probe has no context ID. A reset makes cross-context subtraction
    # unsafe, so decline a latency result rather than silently mixing contexts.
    if (resets([b[0] for b in blocks]) or
            resets([r.get("contextTime") for r in probe.get("inputs", [])]) or
            resets([f[1] for f in probe.get("frames", [])])):
        return {**result, "status": "audio_context_reset_without_identity"}
    at = onset["contextTime"]
    before = [b for b in blocks if b[0] <= at < b[0] + b[1] or at - .05 <= b[0] < at]
    recent_voice = [b for b in before if b[2] > 1e-5]
    result["audibleOutputWithin50msBeforeInput"] = bool(recent_voice)
    result["audioBlockDurationMs"] = stats([b[1] * 1000 for b in blocks[:100]])
    candidates = [(i, b) for i, b in enumerate(blocks)
                  if at <= b[0] <= at + .5 and b[2] <= 1e-7]
    for i, first in candidates:
        end, valid = first[0], True
        for block in blocks[i:]:
            if block[0] - end > .002 or block[2] > 1e-7:
                valid = False
                break
            end = block[0] + block[1]
            if end - first[0] >= .08 - 1e-8:
                break
        if not valid or end - first[0] < .08 - 1e-8:
            continue
        result.update(firstFullSilentBlockContextSeconds=first[0],
                      sustainedSilenceObservedMs=round((end - first[0]) * 1000, 3),
                      inputToFirstFullSilentBlockMs=round((first[0] - at) * 1000, 3))
        if not recent_voice:
            return {**result, "status": "already_quiet_before_pause_no_causal_stop_latency"}
        preceding = [b for b in blocks[:i] if b[2] > 1e-7 and b[0] + b[1] > at - .05]
        lower = max(0, (preceding[-1][0] - at) * 1000) if preceding else 0
        upper = max(0, (first[0] - at) * 1000)
        result.update(status="measured_sustained_digital_silence", firstFullSilentBlockMs=round(upper, 3),
                      digitalStopIntervalMs=[round(min(lower, upper), 3), round(upper, 3)])
        return result
    return {**result, "status": "no_contiguous_silence_blocks_within_500ms"}


def pose_equal(a, b):
    return bool(a and b and len(a) == len(b) and all(abs(x - y) <= 1e-7 for x, y in zip(a, b)))


def interrupt_results(probe):
    results = []
    frames = probe.get("frames", [])
    for pause in probe.get("clientEvents", []):
        if (pause.get("type") != "provisional_pause" or pause.get("reason") != "local_voice_activity"
                or not pause.get("accepted")):
            continue
        candidates = [r for r in probe.get("inputs", []) if r.get("accepted") and r.get("rms", 0) > .015
                      and r.get("previousTurnId") == pause.get("turnId")
                      and r["at"] <= pause["wallMs"] and pause["wallMs"] - r["at"] < 100]
        if not candidates:
            results.append({"turnId": pause.get("turnId"), "status": "missing_matching_input_packet"})
            continue
        onset = candidates[-1]
        at = onset["at"]
        previous = next((f for f in reversed(frames) if f[0] < at), None)
        paused = next((f for f in frames if f[0] >= at and f[2] and f[4] == 0), None)
        cancellation = next((e for e in probe.get("clientEvents", [])
                             if e.get("type") == "cancel" and e.get("turnId") == pause.get("turnId")
                             and e["wallMs"] >= pause["wallMs"]), None)
        window = [f for f in frames if paused and paused[0] <= f[0] <= paused[0] + 120]
        frozen = bool(previous and len(window) >= 2 and window[-1][0] - window[0][0] >= 80
                      and all(f[2] and pose_equal(f[6], previous[6]) for f in window))
        active = bool(onset.get("bodyBefore") and previous and previous[3])
        preframes = [f for f in frames if previous and at - 150 <= f[0] < at and f[3] == previous[3]]
        moving = len(preframes) >= 2 and any(not pose_equal(a[6], b[6]) for a, b in zip(preframes, preframes[1:]))
        started = [e for e in probe.get("bodyEvents", []) if e.get("type") == "action_started"
                   and previous and e.get("id") == previous[3] and e.get("wallMs", at + 1) <= at]
        cancelled = [e for e in probe.get("bodyEvents", []) if e.get("type") == "action_cancelled"
                     and previous and e.get("id") == previous[3] and e.get("wallMs", 0) >= at]
        results.append({
            "turnId": pause.get("turnId"), "clock": "browser performance.now milliseconds",
            "reference": "first audible user PCM packet passed into unmodified sendAudio",
            "inputPacketMs": 100, "inputAtMs": at, "inputContextSeconds": onset.get("contextTime"),
            "firstThresholdFrameWithinInputPacket": onset.get("firstThresholdFrame"),
            "localSourceClearMs": difference(pause["wallMs"], at),
            "sourcesBefore": pause.get("sourceBefore"), "sourcesAfter": pause.get("sourceAfter"),
            "firstPausedRenderFrameMs": difference(paused[0], at) if paused else None,
            "sampledPoseUnchangedForAtLeast80ms": frozen,
            "frozenObservationSpanMs": difference(window[-1][0], window[0][0]) if window else None,
            "activeActionBefore": onset.get("bodyBefore"), "activeActionId": previous[3] if previous else None,
            "modelActionActiveAtInput": active, "sampledBonesMovingWithin150msBeforeInput": moving,
            "actionStartedReceiptObserved": bool(started),
            "activeActionPauseMs": difference(paused[0], at) if active and moving and frozen and paused else None,
            "formalRevocationMs": difference(cancellation.get("at", cancellation["wallMs"]), at) if cancellation else None,
            "formalRevocationReason": cancellation.get("reason") if cancellation else None,
            "activeActionCancelledEventMs": difference(cancelled[0].get("wallMs"), at) if cancelled else None,
            "audioOutput": audio_silence(probe, onset, pause),
            "limits": ["Digital PCM injection and WebAudio observation; no physical microphone or speaker measurement.",
                       "Pose freeze covers seven sampled world bones, not every vertex, hair physics or a natural recovery trajectory.",
                       "The input reference is packet delivery, not a physical acoustic onset; do not add the in-packet threshold offset."]})
    return results


def compact_body(event):
    return {k: event.get(k) for k in ("type", "id", "action", "index", "reason", "wallMs", "atMs", "executor")
            if k in event}


def body_only_inputs(probe, records):
    """User speech can arrive after voice finishes while a gesture is still active.

    These are separate from the intended simultaneous voice/action barge-in. An
    action ending naturally before any cancellation is not called a fast stop.
    """
    results = []
    frames = probe.get("frames", [])
    for record in records:
        start, end = record.get("at"), record.get("finishedAt")
        if not number(start) or not number(end):
            continue
        onset = next((r for r in probe.get("inputs", []) if r.get("accepted") and r.get("rms", 0) > .015
                      and start <= r["at"] <= end), None)
        if not onset or not onset.get("bodyBefore") or onset.get("sourcesBefore", 0) > 0:
            continue
        previous = next((f for f in reversed(frames) if f[0] < onset["at"]), None)
        if not previous or not previous[3]:
            continue
        terminal = next((e for e in probe.get("bodyEvents", []) if e.get("id") == previous[3]
                         and e.get("type", "").removeprefix("action_") in TERMINAL
                         and e.get("wallMs", -1) >= onset["at"]), None)
        first_changed = next((f for f in frames if f[0] >= onset["at"] and f[3] != previous[3]), None)
        paused = next((f for f in frames if f[0] >= onset["at"] and f[2]), None)
        window = [f for f in frames if paused and paused[0] <= f[0] <= paused[0] + 120]
        frozen = bool(previous and len(window) >= 2 and window[-1][0]-window[0][0] >= 80
                      and all(f[2] and pose_equal(f[6], previous[6]) for f in window))
        preframes = [f for f in frames if onset["at"]-150 <= f[0] < onset["at"] and f[3] == previous[3]]
        moving = len(preframes) >= 2 and any(not pose_equal(a[6], b[6]) for a,b in zip(preframes, preframes[1:]))
        pause_event = next((e for e in probe.get("clientEvents", []) if e.get("type") == "body_provisional_pause"
                           and onset["at"] <= e.get("wallMs", -1) <= onset["at"]+100), None)
        old_starts = [compact_body(e) for e in probe.get("bodyEvents", [])
                      if e.get("type") == "action_started" and onset["at"] <= e.get("wallMs", -1) <= end
                      and e.get("owner", {}).get("turnId") == onset.get("previousTurnId")]
        results.append({"fixture": record.get("id"), "activeActionBefore": onset["bodyBefore"],
                        "inputAtMs": onset["at"], "sourcesBefore": onset.get("sourcesBefore"),
                        "oldActionTerminal": compact_body(terminal) if terminal else None,
                        "inputToOldActionTerminalMs": difference(terminal.get("wallMs"), onset["at"]) if terminal else None,
                        "inputToOldActionNoLongerActiveFrameMs": difference(first_changed[0], onset["at"]) if first_changed else None,
                        "terminalWasNaturalCompletion": bool(terminal and terminal.get("type") == "action_completed"),
                        "localBodyPauseEventMs": difference(pause_event.get("wallMs"), onset["at"]) if pause_event else None,
                        "firstPausedRenderFrameMs": difference(paused[0], onset["at"]) if paused else None,
                        "activeActionPauseMs": difference(paused[0], onset["at"]) if paused and frozen and moving and paused[3] == previous[3] and pause_event else None,
                        "sampledPoseUnchangedForAtLeast80ms": frozen,
                        "sampledBonesMovingWithin150msBeforeInput": moving,
                        "priorTurnActionsStartedDuringInput": old_starts,
                        "limit": "Body-only input, not simultaneous audible speech interruption; terminal/active-slot timings do not prove all bones physically stopped."})
    return results


def continuation_results(events, body_events):
    feedback = [e for e in events if e.get("type") == "character_execution_feedback"]
    requests = [e for e in events if e.get("type") == "character_semantic_request"]
    commands = [e for e in events if e.get("type") == "character_actions"]
    result = []
    for request in requests:
        references = [r for r in request.get("evidenceRefs", []) if str(r).startswith("execution:")]
        for reference in references:
            try:
                reference_index = int(reference.split(":", 1)[1])
                if reference_index < 1:
                    raise IndexError("execution_reference_must_be_positive")
                source = feedback[reference_index - 1]
            except (ValueError, IndexError):
                result.append({"requestId": request.get("requestId"), "evidenceRef": reference,
                               "status": "feedback_reference_not_resolvable"})
                continue
            action_result = source.get("result", {})
            command_id = source.get("commandId")
            issued = next((c for c in commands if c.get("commandId") == command_id), None)
            settled = [e for e in feedback if e.get("commandId") == command_id
                       and e.get("serverMs", float("inf")) <= request.get("serverMs", -1)]
            actual = next((b for b in body_events if b.get("owner", {}).get("requestId") == command_id
                           and b.get("index") == source.get("index")
                           and b.get("type") == "action_" + str(action_result.get("status"))), None)
            chosen = [c for c in commands if c.get("requestId") == request.get("requestId")]
            request_events = [e for e in events if e.get("requestId") == request.get("requestId")]
            expressions = [{"command": e.get("command"), "browserAt": e.get("browserAt")}
                           for e in request_events if e.get("type") == "character_expression"]
            terminal = next((e for e in request_events if e.get("type") == "character_semantic_done"), None)
            rejections = [{"reason": e.get("reason"), "browserAt": e.get("browserAt")}
                          for e in request_events if e.get("type") == "character_command_rejected"]
            decisions = []
            for decision in chosen:
                body = [b for b in body_events if b.get("owner", {}).get("requestId") == decision.get("commandId")]
                decisions.append({"operation": decision.get("command", {}).get("operation"),
                    "goal": decision.get("command", {}).get("goal"),
                    "actions": decision.get("command", {}).get("actions", []),
                    "review": decision.get("command", {}).get("review"),
                    "commandId": decision.get("commandId"),
                    "feedbackReceivedToCommandDeliveredMs": difference(decision.get("browserAt"), source.get("browserAt")),
                    "requestToCommandDeliveredMs": difference(decision.get("browserAt"), request.get("browserAt")),
                    "actualExecution": [compact_body(b) for b in body]})
            result.append({
                "requestId": request.get("requestId"), "evidenceRef": reference,
                "provider": request.get("plannerProvider"), "futureReplyAvailable": request.get("futureReplyAvailable"),
                "triggerFeedback": {k: action_result.get(k) for k in ("action", "status", "commandId", "index", "reason")},
                "triggerBodyEvent": compact_body(actual) if actual else None,
                "allIssuedStepsTerminalAtRequest": (len({e.get("index") for e in settled}) == len(issued["command"].get("actions", []))) if issued else None,
                "settledPlanResults": [{k: e.get("result", {}).get(k) for k in ("action", "status", "index", "reason")} for e in settled],
                "feedbackReceivedToRequestMs": difference(request.get("browserAt"), source.get("browserAt")),
                "actualBodyTerminalToRequestMs": difference(request.get("browserAt"), actual.get("wallMs")) if actual else None,
                "modelDecisions": decisions,
                "modelExpressionDecisions": expressions,
                "modelTerminalStatus": terminal.get("status") if terminal else None,
                "rejectedCommands": rejections,
                "status": ("received_body_decision" if decisions else "expression_only_with_rejected_command" if expressions and rejections
                           else "received_expression_only" if expressions else "model_cancelled" if terminal and terminal.get("status") == "cancelled"
                           else "requested_without_delivered_body_decision")})
    return result


def analyze_case(folder):
    observations = read(folder / "campaign-observations.json")
    if not observations:
        return {"case": folder.name, "status": "no_final_observations", "progress": read(folder / "progress.json", {}).get("phase")}
    files = list(folder.glob("client-live-*.json"))
    client = read(max(files, key=lambda p: p.stat().st_mtime_ns), {}) if files else {}
    events = client.get("events", [])
    probe = observations.get("liveProbe", {})
    body = probe.get("bodyEvents") or observations.get("bodyEvents", [])
    turns = observations.get("finalTurns", [])
    ledger = read(folder / "ledger.json", {})
    response_rows = ledger.get("responses", [])
    interrupt = interrupt_results(probe)
    continuations = continuation_results(events, body)
    input_records = observations.get("finalInputs", client.get("inputRecords", []))
    input_ids = list(dict.fromkeys(r.get("id") for r in input_records if r.get("id")))
    driver_interruptions = []
    for row in observations.get("interruptions", []):
        before = row.get("before", {})
        driver_interruptions.append({k: row.get(k) for k in ("kind", "at", "targetTurn")})
        driver_interruptions[-1].update(
            audioBefore={k: before.get("audio", {}).get(k) for k in ("status", "sourceCount", "time")},
            activeActionBefore={k: (before.get("body", {}).get("active") or {}).get(k) for k in ("id", "action", "status")})
    return {
        "case": folder.name, "status": observations.get("phase"),
        "inputFixtures": len(input_ids), "inputFixtureIds": input_ids,
        "inputAttempts": observations.get("inputAttempts", []),
        "interruptionDriverObservations": driver_interruptions,
        "systemTurns": len(turns),
        "voiceResponseAttempts": sum(r.get("channel") == "voice" and r.get("state") != "unused" for r in response_rows),
        "listenerResponseAttempts": sum(r.get("channel") == "listener" and r.get("state") != "unused" for r in response_rows),
        "responsesWithVoice": sum(number(t.get("voiceAt")) or number(t.get("metrics", {}).get("requestToVoiceMs")) for t in turns),
        "latencyMs": {key: stats([t.get("metrics", {}).get(key) for t in turns]) for key in (
            "lastSpeechToVoiceMs", "requestToVoiceMs", "commandLeadMs", "bodyStartLeadMs", "visibleBodyLeadMs", "visibleFaceLeadMs")},
        "turns": [{"id": t.get("id"), "text": t.get("text"), "transcript": t.get("transcript"),
                   "metrics": t.get("metrics"), "revoked": t.get("revoked"), "historySettled": t.get("historySettled")} for t in turns],
        "actionRequests": sum(e.get("type") == "character_semantic_request" for e in events),
        "actionCommands": sum(e.get("type") == "character_actions" for e in events),
        "actionsStarted": dict(Counter(e.get("action") for e in body if e.get("type") == "action_started")),
        "bodyEventCounts": dict(Counter(e.get("type") for e in body)),
        "cancellationReasons": dict(Counter(e.get("reason") for e in body if e.get("type") == "action_cancelled")),
        "actionsRetained": [compact_body(e) for e in body if e.get("type") == "action_retained"],
        "autonomousContinuations": continuations,
        "continuationCount": len(continuations),
        "continuationDecisionsReceived": sum(bool(r.get("modelDecisions")) for r in continuations),
        "continuationLatencyMs": {
            "feedbackReceivedToRequest": stats([r.get("feedbackReceivedToRequestMs") for r in continuations]),
            "requestToBodyDecision": stats([d.get("requestToCommandDeliveredMs") for r in continuations for d in r.get("modelDecisions", [])]),
            "feedbackReceivedToBodyDecision": stats([d.get("feedbackReceivedToCommandDeliveredMs") for r in continuations for d in r.get("modelDecisions", [])])},
        "allRequestsHadNoFutureReply": all(e.get("futureReplyAvailable") is False for e in events if e.get("type") == "character_semantic_request"),
        "interruptions": interrupt,
        "bodyOnlyInputResponses": body_only_inputs(probe, input_records),
        "historySettled": sum(bool(t.get("historySettled")) for t in turns),
        "revokedAndHistorySettled": sum(bool(t.get("revoked") and t.get("historySettled")) for t in turns),
        "skippedPlannerReasons": dict(Counter(e.get("reason") for e in events if e.get("type") == "character_semantic_skipped")),
        "browserErrors": observations.get("errors", []), "observationErrors": probe.get("errors", []),
        "renderPerformance": observations.get("renderPerformance"), "renderPreflight": observations.get("renderPreflight"),
        "audioEnvironment": probe.get("audioEnvironment"), "renderFrames": len(probe.get("frames", [])),
        "audioBlocks": len(probe.get("audioBlocks", [])), "video": observations.get("video"),
        "usage": {"channels": dict(Counter(r.get("channel") for r in response_rows if r.get("state") != "unused")),
                  "states": dict(Counter(r.get("state") for r in response_rows)),
                  "reportedTokens": sum((r.get("usage") or {}).get("total_tokens", 0) for r in response_rows),
                  "unknown": [{"channel": r.get("channel"), "reason": r.get("unknownReason"),
                               "terminalObserved": r.get("terminalObserved")} for r in response_rows if r.get("state") == "unknown"],
                  "frozenChannels": ledger.get("frozenChannels"), "pcmSeconds": ledger.get("pcmBytes", 0) / 32000}}


def self_test():
    base = {"inputs": [{"contextTime": 1}], "frames": [[0, .99], [10, 1.01]],
            "audioBlocks": [[.98, .01, .2], [.99, .01, .2], [1, .01, .1]] + [[1.01 + n * .01, .01, 0] for n in range(12)]}
    r = audio_silence(base, {"contextTime": 1}, {})
    assert r["status"] == "measured_sustained_digital_silence" and r["digitalStopIntervalMs"] == [0, 10]
    base["audioBlocks"] = [[.98 + n * .01, .01, 0] for n in range(18)]
    assert audio_silence(base, {"contextTime": 1}, {})["firstFullSilentBlockMs"] is None
    base["audioBlocks"].append([.1, .01, 0])
    assert audio_silence(base, {"contextTime": 1}, {})["status"] == "audio_context_reset_without_identity"
    events = [
        {"type": "character_actions", "commandId": "c1", "requestId": "r1", "command": {"actions": [{"action": "gesture:nod"}]}},
        {"type": "character_execution_feedback", "commandId": "c1", "index": 0, "serverMs": 10, "browserAt": 100,
         "result": {"action": "gesture:nod", "status": "completed", "commandId": "c1", "index": 0}},
        {"type": "character_semantic_request", "requestId": "r2", "serverMs": 20, "browserAt": 110, "evidenceRefs": ["execution:1"]},
        {"type": "character_actions", "commandId": "c2", "requestId": "r2", "browserAt": 200,
         "command": {"operation": "keep", "actions": []}},
        {"type": "character_semantic_request", "requestId": "r3", "evidenceRefs": ["subtitle:1"]}]
    continuation = continuation_results(events, [])
    assert len(continuation) == 1 and continuation[0]["allIssuedStepsTerminalAtRequest"]
    assert continuation[0]["modelDecisions"][0]["operation"] == "keep"
    print("4 analysis checks passed: silence bounds, already-silent exclusion, clock-reset rejection, explicit feedback linkage")


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--output", type=Path, default=ROOT / "outputs/action-preservation-live-20261029")
    parser.add_argument("--self-test", action="store_true")
    args = parser.parse_args()
    if args.self_test:
        self_test()
        return
    out = args.output.resolve()
    protected = read(out / "protected-before.json", {})
    scope = read(out / "scope.json", {})
    case_names = scope.get("cases", ["short-03", "short-08"])
    if not case_names or any(name not in {"short-03", "short-08"} for name in case_names):
        raise ValueError("analysis_scope_must_name_the_two_authorized_scenarios")
    changed = [name for name, digest in protected.items()
               if not (ROOT / name).is_file() or hashlib.sha256((ROOT / name).read_bytes()).hexdigest() != digest]
    result = {"experimental": True, "manualActions": False, "physicalAudioAcceptance": False,
              "protectedFilesUnchanged": len(protected) - len(changed), "protectedFilesChanged": changed,
              "cases": [analyze_case(out / "cases" / name) for name in case_names],
              "scope": scope,
              "audioTimingPolicy": "512-frame passive digital mix blocks; exact zeros for at least 80 ms; no claim when already quiet or clocks reset",
              "feedbackPolicy": "execution:N references index accepted terminal feedback only; linked model requestId and actual commandId, not temporal adjacency"}
    # This tool only writes a derived report under the supplied evidence root.
    target = out / "resumed-analysis.json"
    target.write_text(json.dumps(result, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    print(json.dumps({"report": str(target), "protectedFilesChanged": changed,
        "cases": [{k: c.get(k) for k in ("case", "status", "responsesWithVoice", "actionRequests", "continuationCount", "continuationDecisionsReceived")}
                  for c in result["cases"]]}, ensure_ascii=False))


if __name__ == "__main__":
    main()
