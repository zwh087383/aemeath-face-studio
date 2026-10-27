"""Small semantic input views. Full geometry and provenance stay authoritative locally.

No provider call, memory write or candidate picking occurs in this module.
Every registered behavior remains visible, including temporarily unmet prerequisites.
"""
from copy import deepcopy
import json


def encoded(value):
    return json.dumps(value, ensure_ascii=False, separators=(",", ":"))


# Capability descriptions, not a choreography. Runtime receipts must confirm effects.
EFFECTS = {
    "sit_down": "坐稳，支撑变为坐姿；手中物品不凭空改变",
    "take_book_seated": "成功握取后书离开桌面并由双手持有",
    "read_seated": "读书动作结束，仍坐着持书",
    "page_turn_seated": "翻页动作结束，仍坐着持书",
    "read_look_up": "短暂抬眼回应后仍坐着持书",
    "close_book": "合书后仍由手持有，不等于放回桌面",
    "put_book_seated": "放置回执成立后书在桌面，双手空闲",
    "stand_up_from_desk": "退椅后站立；椅子位置已改变，不保证可以直接再次落座",
}


def compact_catalog(rows):
    conditions, codes, actions = {}, {}, []
    for row in rows:
        need = row.get("requires", {})
        signature = encoded(need)
        if signature not in codes:
            key = "p" + str(len(codes) + 1)
            codes[signature], conditions[key] = key, deepcopy(need)
        actions.append([row["id"], row.get("label", row["id"]), codes[signature],
                        row.get("duration"), EFFECTS.get(row.get("name"), "unchanged")])
    return {"columns": ["id", "meaning", "requires", "seconds", "expected_result"],
            "conditions": conditions, "actions": actions, "unchanged": "保持原支撑与持物；实际结果以回执为准",
            "policy": "全部合法能力可见。条件不满足可由模型规划前置动作；执行前仍核验。原速单次，不自动循环。"}


def actor_view(actor):
    result = {key: deepcopy(actor.get(key, "unknown")) for key in
              ("support", "hands", "seatSupported", "contacts", "phase", "executor", "canYield")}
    objects = {}
    for name, prop in actor.get("props", {}).items():
        if not isinstance(prop, dict) or prop.get("visible") is not True:
            continue
        objects[name] = {"attachment": prop.get("attachment", "unknown")}
        contact = prop.get("contact")
        if isinstance(contact, dict):
            objects[name]["contact"] = {k: contact[k] for k in ("valid", "confirmed", "attached") if k in contact}
    result["objects"] = objects
    # A compact summary is not permission to execute; detailed checks remain local.
    result["geometry_checked_at_execution"] = True
    return result


def state_view(state):
    return {"emotion": deepcopy(state.get("emotion", {})),
            "effectiveEnergy": state.get("effectiveEnergy"), "authority": "mathematical_read_only",
            "actor": actor_view(state.get("actorState", {})), "stateError": state.get("stateError")}


def context_view(messages, current_text):
    # Preserve complete selected utterances, including negation and quoted requests.
    # Do not label an arbitrary system-prompt prefix as retrieved memory.
    history = [{"role": m["role"], "content": m["content"]} for m in messages
               if m.get("role") in {"user", "assistant"} and isinstance(m.get("content"), str)]
    if history and history[-1] == {"role": "user", "content": current_text}:
        history.pop()
    selected, count = [], 0
    for item in reversed(history):
        if selected and count + len(item["content"]) > 1800:
            break
        selected.append(item); count += len(item["content"])
        if len(selected) == 4:
            break
    # System text is not safely separable into memory/prose here. The voice retains
    # it all; action reasoning must not invent unprovided personal facts.
    return {"delivered_context": list(reversed(selected)),
            "context_policy": "只据提供的话语和真实状态选择表达；未提供的记忆不推测。语音仍使用完整受保护上下文。"}


def activity_view(snapshot):
    keys = ("id", "activityId", "version", "kind", "label", "status", "actualWorkRunning",
            "actualModelRequestRunning", "foreground", "artifactId", "artifactSummary", "summary")
    value = {key: deepcopy(snapshot[key]) for key in keys if key in snapshot}
    if isinstance(snapshot.get("persistedArtifact"), dict):
        value["artifact"] = {key: snapshot["persistedArtifact"].get(key) for key in ("id", "title")}
    value["presentation"] = "这是网页阅读。可自主选择站立或使用场景书作为阅读姿态载体；不声称实体书含网页内容。"
    return value


def metrics(payload):
    return {"characters": len(encoded(payload)), "utf8Bytes": len(encoded(payload).encode()),
            "fields": {k: len(encoded(v)) for k, v in payload.items()},
            "tokenCount": None, "tokenCountSource": "provider_usage_only"}
