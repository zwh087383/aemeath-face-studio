"""Experimental compact wire codec; decoded commands use the original validators.

Numbers refer to a versioned request catalogue, never a fresh implicit mapping.
No selection, scheduling, model call, math-state write or tool execution here.
"""
from copy import deepcopy
import hashlib
import importlib.util
import json
import math
from pathlib import Path

spec = importlib.util.spec_from_file_location("compact_original_protocol", Path(__file__).with_name("protocol.py"))
original = importlib.util.module_from_spec(spec)
spec.loader.exec_module(original)

OPERATIONS = ("keep", "append", "replace", "clear")
REVIEWS = ("on_finish", "on_failure", "wait")
MODES = ("attitude", "reaction", "clear")
KINDS = tuple(dict.fromkeys(original.ATTITUDES + original.REACTIONS))
ANCHORS = ("immediate", "voice")
LATE = ("start_if_speaking", "skip", "reconsider")


def enum_at(values, number):
    if type(number) is not int or not 0 <= number < len(values):
        raise ValueError("invalid_compact_index")
    return values[number]


class Codec:
    def __init__(self, catalog=None):
        self.catalog = original.load_catalog(catalog)
        self.ids = tuple(row["id"] for row in self.catalog)
        serialized = json.dumps(self.catalog, ensure_ascii=False, sort_keys=True, separators=(",", ":"))
        self.version = hashlib.sha256(serialized.encode()).hexdigest()

    def payload(self, value):
        result = deepcopy(value)
        table = result["available_actions"]
        if table["columns"][0] != "id" or tuple(row[0] for row in table["actions"]) != self.ids:
            raise ValueError("catalogue_order_mismatch")
        # Both comparison arms get the identical numbered table and original IDs.
        table["columns"].insert(0, "n")
        table["actions"] = [[index, *row] for index, row in enumerate(table["actions"])]
        result["action_codebook_version"] = self.version
        return result

    def decode(self, raw, payload):
        if payload.get("action_codebook_version") != self.version:
            raise ValueError("stale_compact_codebook")
        value = original.strict_json(raw)
        if (not isinstance(value, dict) or not value or set(value) - {"f", "a", "o", "r", "g"}):
            raise ValueError("invalid_compact_fields")
        commands = []
        if "f" in value:
            face = value["f"]
            if not isinstance(face, list) or len(face) not in (3, 4, 6):
                raise ValueError("invalid_compact_face")
            mode, kind, strength = face[:3]
            if type(strength) not in (int, float) or not math.isfinite(strength):
                raise ValueError("invalid_compact_strength")
            reference = face[3] if len(face) >= 4 else 0
            command = {"mode": enum_at(MODES, mode), "kind": enum_at(KINDS, kind),
                "strength": strength, "evidenceRef": enum_at(payload["evidence_refs"], reference)}
            if len(face) == 6:
                command["secondary"] = {"kind": enum_at(KINDS, face[4]), "strength": face[5]}
            commands.append(("set_expression", original.parse_expression(json.dumps(command))))
        if set(value) & {"a", "o", "r", "g"}:
            actions = value.get("a", [])
            if not isinstance(actions, list):
                raise ValueError("invalid_compact_actions")
            rows = []
            for item in actions:
                if not isinstance(item, list) or not 1 <= len(item) <= 4:
                    raise ValueError("invalid_compact_action_tuple")
                options = item[3] if len(item) == 4 else {}
                if not isinstance(options, dict) or set(options) - {"p", "t"}:
                    raise ValueError("invalid_compact_action_options")
                rows.append({"action": enum_at(self.ids, item[0]),
                    "anchor": enum_at(ANCHORS, item[1] if len(item) > 1 else 0),
                    **({"late": enum_at(LATE, item[2])} if len(item) > 2 else {}),
                    **({"performance": options["p"]} if "p" in options else {}),
                    **({"activity_token": options["t"]} if "t" in options else {})})
            command = {"operation": enum_at(OPERATIONS, value.get("o", 1)), "actions": rows}
            if "r" in value:
                command["review"] = enum_at(REVIEWS, value["r"])
            if "g" in value:
                command["goal"] = value["g"]
            commands.append(("perform_actions", original.parse_actions(json.dumps(command), self.catalog)))
        # Decode atomically: a malformed sibling cannot partially change the face.
        return commands

    def tools(self):
        return [{"type": "function", "function": {"name": "p",
            "description": "紧凑表达通知；仅选脸、仅选身体或同时选择。保持原语义、独立控制，不等待执行回执。",
            "parameters": {"type": "object", "additionalProperties": False, "properties": {
                "f": {"type": "array", "minItems": 3, "maxItems": 6, "items": {"type": "number"},
                    "description": "[mode,kind,strength,evidence_index=0]；次态度时使用完整6项[mode,kind,strength,evidence_index,secondary_kind,secondary_strength]。模式/表情/依据必须整数，强度0至1。"},
                "a": {"type": "array", "items": {"type": "array", "minItems": 1, "maxItems": 4,
                    "items": {"anyOf": [{"type": "integer", "minimum": 0},
                        {"type": "object", "additionalProperties": False, "properties": {
                            "p": deepcopy(original.tools(self.catalog)[1]["function"]["parameters"]["properties"]["actions"]["items"]["properties"]["performance"]),
                            "t": {"type": "string", "minLength": 1, "maxLength": 160}}}]}},
                    "description": "每项[n,anchor=0,late=0,options]；n取目录n列。options可省略，p为原performance，t为真实activity_token。只有第四位可为对象。"},
                "o": {"type": "integer", "enum": [0, 1, 2, 3], "description": "0keep/1append/2replace/3clear，省略为append。keep/clear必须无动作。"},
                "r": {"type": "integer", "enum": [0, 1, 2], "description": "0on_finish/1on_failure/2wait，省略保留原on_finish语义。"},
                "g": {"type": "string", "maxLength": 160, "description": "自选目标，仅目标改变时给出；省略沿用。"}}}}}]

    def rules(self):
        # Only wire names/encoding change. The semantic and protection rules stay.
        rules = original.RULES.replace(
            "使用set_expression选择持续态度、短反应或清除态度；用perform_actions选择已列出的动作，二者互相独立。",
            "只调用p：用f选择持续态度、短反应或清除态度；用a/o/r/g选择身体，二者互相独立。")
        rules = rules.replace("可以多次调用两个工具", "可以多次调用p")
        return rules + "\n" + "\n".join([
            "【仅改变线上编码】上文英文名称描述语义，实际输出用下列短字段；不要输出旧工具或长字段名。",
            "f=[mode,kind,strength,evidence_index]，第四项仅在不是0时需要；不更新脸就省略f。",
            "若明确选择次态度，f必须完整六项[mode,kind,strength,evidence_index,secondary_kind,secondary_strength]；共享同一evidence，禁止reaction/clear带次态度。",
            "mode编号：" + ",".join(f"{i}={x}" for i, x in enumerate(MODES)),
            "kind编号：" + ",".join(f"{i}={x}" for i, x in enumerate(KINDS)),
            "strength保持0到1的原精度；依据从当前evidence_refs按零基索引选择，不编造。",
            "a=[[n,anchor,late,options],...]；n是available_actions的n列；anchor=0immediate/1voice；late=0start_if_speaking/1skip/2reconsider。",
            "options仅第四位对象，可用p传完整performance及t传真实activity_token，其字段和权限与原工具完全相同。控制动作必须o=1且options.t来自实际状态；未传p不授予额外表现许可。",
            "anchor和late尾部为0可省略，所以[n]等同[n,0,0]。不要改变动作本身的原速、幅度、收势。",
            "o=0keep/1append/2replace/3clear；缺省1。r=0on_finish/1on_failure/2wait；缺省0。",
            "g是目标，只在目标改变时输出；缺省沿用。无动作可o=0；脸和身体都不改变可p({\"o\":0})。",
            "可以只给f；可以只给身体字段；同一次也能同时给。多个动作及不同语音锚均保留，不能省略改变含义的非默认值。",
            "不输出说明，不复述可省略的默认值；以完整合法p参数作为独立通知，不能把半截JSON当成指令。",
        ])
