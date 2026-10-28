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
    conditions, permissions, durations, variant_sets, effects, actions = {}, {}, {}, {}, {}, []
    codes = {"p": {}, "m": {}, "d": {}, "v": {}, "e": {}}

    def intern(prefix, table, value):
        signature = json.dumps(value, ensure_ascii=False, sort_keys=True, separators=(",", ":"))
        if signature not in codes[prefix]:
            key = prefix + str(len(codes[prefix]) + 1)
            codes[prefix][signature], table[key] = key, deepcopy(value)
        return codes[prefix][signature]

    for row in rows:
        need = row.get("requires", {})
        condition = intern("p", conditions, need)
        duration = {key: deepcopy(value) for key, value in row.get("durationContract", {}).items()
                    if key in {"mode", "sourceSeconds", "minimumSeconds", "entrySeconds", "startSeconds", "endSeconds",
                               "loopSeconds", "returnSeconds", "settleSeconds", "continuation", "conditionalPreparation"}}
        # Exact defaults are stated once. No geometric or timing precision is
        # reduced; source/minimum seconds remain in-row when not equal to seconds.
        for key in ("sourceSeconds", "minimumSeconds"):
            if duration.get(key) == row.get("duration"):
                duration.pop(key, None)
        if duration.get("returnSeconds") == 0:
            duration.pop("returnSeconds")
        variants = {}
        for name, variant in row.get("variants", {}).items():
            # Describe the permission without duplicating source geometry or
            # private asset provenance in each planner request.
            item = {key: deepcopy(value) for key, value in variant.items()
                    if key in {"meaning", "kind", "heldPreserved", "freeHands", "effects"}}
            if "requires" in variant:
                item["requires"] = intern("p", conditions, variant["requires"])
            if variant.get("phaseIds"):
                item["loop_seconds"] = sum(part["duration"] for part in row.get("phaseData", [])
                                           if part["id"] in variant["phaseIds"])
            variants[name] = item
        permission = deepcopy(row.get("performanceContract", {}))
        if set(permission.get("variant_set", [])) == set(variants):
            permission["variant_set"] = "listed_variants"
        actions.append([row["id"], row.get("label", row["id"]), condition,
                        row.get("duration"), intern("e", effects, row.get("effects", EFFECTS.get(row.get("name"), "unchanged"))),
                        intern("m", permissions, permission),
                        intern("d", durations, duration), intern("v", variant_sets, variants)])
    return {"columns": ["id", "meaning", "requires", "seconds", "expected_result", "performance_permission",
                        "duration_contract", "variants"],
            "conditions": conditions, "performance_permissions": permissions, "duration_contracts": durations,
            "variant_sets": variant_sets, "effects": effects, "actions": actions,
            "unchanged": "保持原支撑与持物；实际结果以回执为准",
            "semantics": {
                "references": "p/m/d/v/e分别引用conditions/performance_permissions/duration_contracts/variant_sets/effects；都是输入目录引用，输出仍使用原工具和完整动作ID。listed_variants表示该行v引用中列出的变体，不额外开放变体。",
                "duration": "total_seconds是整个动作的目标时长或允许区间，包含实际进入、原速起势、原速中段、原速收势、returnSeconds及最终收稳settleSeconds。whole-source-cycles只用完整源循环，数字目标按可达圈数实现，区间必须容纳完整路线，不能把额外衔接排除在区间外。省略sourceSeconds/minimumSeconds时使用本行seconds，省略returnSeconds为0；全部保留原速起收，现场衔接与可达时长由执行器校验并回执。",
                "effects": "expected_result引用的是预期状态，不是完成事实。attachment.onlyAfter=measured-grip表示成功握取后才能更新为手持；measured-surface-contact表示实际放置成立后才能更新为桌面。held/support/root=preserve保持当前事实。",
                "permission": "performance_permissions是该项可开放的上限，不是已授权执行；只有本次动作显式performance字段才授权相应时长、变体或微动作。省略保持原动作单次，不补动作、不加速起收、不修改身体幅度。",
                "variants": "variant_set只允许所列的同义实现；默认exact。support-preserving保持实测站/坐支撑、持物和根位置，只动获准交流部位，按该变体requires检查，不会先站起或放下物品。近脸/近物接触仍须实际校验。",
                "control": "control:pause_activity/resume_activity/finish_activity必须operation=append。activity_token从character_state.actor原样读取：暂停/结束用activityToken，恢复用resumeToken。unknown/null/旧令牌不可用；等待实际状态，不能自造令牌。暂停稳定后可交流，交流结束不自动恢复；恢复接续原进度，结束走实际收势，均不代表后台业务完成。",
            },
            "policy": "全部合法能力可见。条件暂不满足时模型可规划前置动作；执行前仍核验。动作数量、顺序、重复及不做均由模型决定，没有次数或冷却限制。"}


def actor_view(actor):
    result = {key: deepcopy(actor.get(key, "unknown")) for key in
              ("support", "hands", "seatSupported", "contacts", "phase", "executor", "canYield", "root", "freeHands",
               "capabilities", "activityToken", "resumeToken")}
    objects = {}
    for name, prop in actor.get("props", {}).items():
        if not isinstance(prop, dict) or prop.get("visible") is not True:
            continue
        objects[name] = {"attachment": prop.get("attachment", "unknown")}
        # Small measured facts let the model distinguish an open book/laptop
        # and plan around furniture. No bone palette or private source data.
        for key in ("openness", "pageTurn", "scale"):
            if key in prop:
                objects[name][key] = deepcopy(prop[key])
        frame = prop.get("worldTransform") or {}
        for key in ("position", "quaternion"):
            value = frame.get(key, prop.get(key))
            if value is not None:
                objects[name][key] = deepcopy(value)
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
