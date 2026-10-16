/** A small, stateless Chinese subtitle classifier. It never schedules or plays cues.
 * Input is ordinary assistant speech, not a command language. Complex or ambiguous
 * language may deliberately produce no cue. The caller owns playback and cooldowns.
 */
const LIMIT = 512;
const PROFILE_OFFSET = Object.freeze({ gentle: -.12, balanced: 0, lively: .1 });
const SELF = /我|咱|人家|本喵/;
const ACTOR = /我们|我|咱|人家|本喵|他们|她们|它们|他|她|它|你们|你|您|大家|别人|用户|玩家|角色|朋友|老师|同事/;
const ACTIONS = Object.freeze([
  ['action', 'nod', /点(?:了点|一下|两下|三下|一个|个|点|了)?头|颔首/],
  ['action', 'shake', /摇(?:了摇|一下|两下|三下|摇|了)?头/],
  ['action', 'tilt', /歪(?:了歪|一下|了)?头|侧(?:一下)?头/],
  ['action', 'glance', /看(?:了)?你一眼|瞥(?:了)?你?一眼|移开视线|望向一旁/],
  ['action', 'blink', /眨(?:了眨|一下|了)?眼(?:睛)?/],
  ['gesture', 'wave', /挥(?:了挥|一下|两下|三下|挥|了)?手|招(?:了招|一下|招|了)?手/],
  ['gesture', 'explain', /摊开手(?:解释|说明)|抬手(?:解释|说明|比划)|用手势(?:解释|说明)|一边说一边比划/],
  ['gesture', 'shrug', /耸(?:了耸|一下|了)?肩|摊(?:了摊|一下|开)?手/],
  ['gesture', 'chest', /手(?:放|按|贴)(?:在|到)?胸(?:口|前)|抚住?胸(?:口)?|拍拍胸口/],
]);
const EXPRESSIONS = Object.freeze([
  ['neutral', /平静下来|恢复平静|放松下来|我很平静/, .4, 20],
  ['smile', /微笑|笑了笑|谢谢你|谢谢啦|谢谢|你好|早上好|晚上好|很高兴见到你/, .45, 30],
  ['happy', /太好了|太棒[了啦]|好开心|很开心|真开心|好高兴|很高兴|开心极了|高兴极了|开心|高兴/, .6, 60],
  ['curious', /很好奇|有点好奇|想知道|为什么|怎么回事|这是什么|我不明白/, .45, 40],
  ['focus', /认真想一想|认真想想|认真想一下|仔细想想|仔细分析|仔细看看|我在思考|我想一想/, .45, 35],
  ['surprise', /吓我一跳|没想到|真没想到|出乎意料|太意外了|好惊讶|很惊讶/, .55, 65],
  ['shy', /有点害羞|好害羞|很害羞|我会害羞|我害羞了|不好意思|脸都红了/, .45, 55],
  ['playful', /嘿嘿|逗你玩|开个玩笑|开玩笑啦|骗你的啦/, .5, 50],
]);
const DIALOGUE = Object.freeze([
  ['action', 'nod', /我明白了|我知道了|我记住了|我答应你|我同意|我赞成|你说得对|交给我|当然可以|没问题|嗯嗯/, .45, 'agreement', 60],
  ['action', 'shake', /我不同意|我不赞成|我拒绝|不能答应|(?:这样|这个|那样|这)?不行|不可以|不对/, .45, 'disagreement', 70],
  ['gesture', 'wave', /你好|嗨|早上好|晚上好|早安|晚安|再见|拜拜|下次见/, .45, 'greeting', 50],
  ['gesture', 'chest', /我喜欢你|最喜欢你|我爱你|有你真好|你对我真好|很感动|好感动/, .5, 'affection', 65],
  ['gesture', 'explain', /我来解释|我来说明|简单来说|原因是|因为|首先|分成.{0,4}步|步骤是/, .4, 'explanation', 30],
  ['gesture', 'shrug', /我也不知道|我不确定|暂时不确定|我拿不准/, .35, 'uncertainty', 35],
]);
const DIRECT_REQUEST_PREFIX = /^(?:(?:请|麻烦|劳驾|帮我|给我|为我|你|您|能不能|能|可以|现在|轻轻|用力|稍微|小幅度|小幅|先|再|就|向我|朝我|对我)\s*)*$/;
const DIRECT_REQUEST_SUFFIX = /^(?:(?:一下|一次|两下|三下|吧|好吗|可以吗|吗|呢|呀|啊|好不好|给我看看|给我看|看看|谢谢)\s*)*$/;
const PURE_ACK = /^(?:(?:好的|好呀|好啊|好哒|好吧|好|可以|行|没问题|收到|明白了|明白|嗯嗯|嗯|遵命|这就来|马上|当然可以)[，,。.!！\s]*)+$/;
const META = /词语|这句话|这几个字|这个词|台词|例子|示例|代码|动作指令|关键词|教程|意思是|什么意思|讨论|比如|例如|所谓|翻译|念出|读出|复述/;
const CONDITIONAL = /如果|假如|要是|假设|想象|万一|假装|打算|准备|差点|可能会/;
const HISTORICAL = /刚才|之前|昨天|上次|曾经|以前|当时|刚刚/;
const NOW = /^(?:现在|此刻|这次|如今)/;
const SPEAKER_PREFIX = /^(?:真的|真是|太|好|很|有点|嗯|啊|哇|呀|这下|实在|非常|特别|那|那么|其实|当然|现在|此刻|这次|如今|先|再|就|所以|于是|然后|随后|接着|刚好|确实|的确)*$/;

function empty(reason) { return { cues: [], suppressedReason: reason, fallbackEligible: false }; }

function plainText(input) {
  if (typeof input !== 'string') return { reason: 'invalid_text' };
  // Reject instead of truncating: the tail may revoke an earlier action.
  if (input.length > LIMIT) return { reason: 'input_too_long' };
  if (/[`{}]|^\s*>|<\/?[a-z][^>]*>/imu.test(input)) return { reason: 'structured_text' };
  const pairs = new Map([['(', ')'], ['（', '）'], ['[', ']'], ['【', '】'], ['「', '」'], ['『', '』'], ['“', '”'], ['‘', '’'], ['"', '"']]);
  const stack = [];
  let text = '', removed = false;
  for (const character of input) {
    if (stack.length && character === stack[stack.length - 1]) { stack.pop(); continue; }
    if (pairs.has(character)) { stack.push(pairs.get(character)); removed = true; text += stack.length === 1 ? '。' : ''; continue; }
    if (!stack.length) text += character;
  }
  return { text: text.trim(), removed };
}

function strength(text, base, profile) {
  const explicit = /轻轻|微微|稍微|小幅|温柔|缓缓/.test(text) ? -.15
    : /用力|坚定|大幅|兴奋|特别|非常/.test(text) ? .12 : 0;
  return Math.round(Math.max(.2, Math.min(.8, base + explicit + PROFILE_OFFSET[profile])) * 100) / 100;
}

function negated(text, match) {
  const before = text.slice(Math.max(0, match.index - 14), match.index);
  const after = text.slice(match.index + match[0].length);
  return /(?:不|没|别|未|无|停止|取消|拒绝|避免)[^，,。！？!?；;]{0,12}$/.test(before)
    || /^(?:了|这件事|这个动作|什么的|我|是|才|一下|两下|三下|头|手|眼睛|眼|肩|\s)*(?:不做|不会做|不想做|不可能|算了|取消|才怪|个鬼)/.test(after);
}

function cue(kind, id, value, reason) {
  return { kind, [kind === 'expression' ? 'preset' : kind]: id, strength: value, reason };
}

function directRequest(text) {
  if (!text || META.test(text) || CONDITIONAL.test(text) || HISTORICAL.test(text)) return null;
  const request = text.replace(/[，,。.!！?？]/gu, '').trim();
  for (const [kind, id, pattern] of ACTIONS) {
    const match = pattern.exec(request);
    if (match && DIRECT_REQUEST_PREFIX.test(request.slice(0, match.index))
      && DIRECT_REQUEST_SUFFIX.test(request.slice(match.index + match[0].length)) && !negated(request, match)) {
      return { kind, id };
    }
  }
  return null;
}

/** Select at most one face cue and one head/body cue from a complete subtitle unit.
 * `fallbackEligible` only grants the host permission to consider a cooled-down
 * conversation gesture. It never represents an instruction to play immediately.
 */
export function selectSubtitleCues(text, { userText = '', profile = 'balanced' } = {}) {
  const clean = plainText(text), user = plainText(userText);
  if (clean.reason) return empty(clean.reason);
  if (user.reason) return empty(user.reason);
  if (!Object.hasOwn(PROFILE_OFFSET, profile)) profile = 'balanced';
  text = clean.text;
  if (!/[\p{L}\p{N}]/u.test(text)) return empty(clean.removed ? 'annotation_only' : 'empty_text');
  if (/(?:算了|取消|撤回|收回|不做了|还是别)(?:吧|了|这个动作|刚才的话)?[。！!\s]*$/.test(text)) return empty('revoked');

  const candidates = [], lastMention = new Map();
  let actor = '', context = null, suppressedReason = null, index = 0;
  const add = (kind, id, match, clause, base, priority, reason) => {
    const key = `${kind}:${id}`, blocked = negated(clause, match);
    lastMention.set(key, { index, blocked });
    if (blocked) { suppressedReason ||= 'negated'; return; }
    candidates.push({ key, index, priority, cue: cue(kind, id, strength(clause, base, profile), reason) });
  };
  for (const clause of text.split(/([，,。！？!?；;\n]|但是|不过|可是|然而|而是|但)/u)) {
    index++;
    if (!clause.trim()) continue;
    if (/^[。！？!?；;\n]$/.test(clause)) { actor = ''; context = null; continue; }
    if (/^(?:[，,]|但是|不过|可是|然而|而是|但)$/.test(clause)) continue;
    if (NOW.test(clause)) { actor = ''; context = null; }
    const subject = ACTOR.exec(clause);
    const subjectPrefix = subject && clause.slice(0, subject.index).trim();
    if (subject && !/(?:朝|向|对|给|看|看到|见到|望向|瞥|谢谢)$/.test(subjectPrefix)) {
      actor = SELF.test(subject[0]) && SPEAKER_PREFIX.test(subjectPrefix) ? 'self' : 'other';
    }
    if (/^(?:你好[呀啊]?|你说得对|你对我真好|有你真好|谢谢你|吓我一跳)$/.test(clause.trim())) actor = 'self';
    // A report about somebody else is not the speaker's emotion or movement.
    if (/我(?:看到|听说|记得)|我(?:觉得|发现).{0,8}(?:他|她|它|别人|朋友)/.test(clause)) actor = 'other';
    if (META.test(clause)) context = 'discussion';
    else if (CONDITIONAL.test(clause)) context = 'hypothetical';
    else if (HISTORICAL.test(clause)) context = 'historical';
    if (context || actor === 'other') { suppressedReason ||= context || 'third_party'; continue; }
    const actionMention = ACTIONS.some(([, , pattern]) => pattern.test(clause));
    if (actionMention && /如何|怎么|怎样|教你|教我|讲解|解释|说明/.test(clause)
      && !/抬手(?:解释|说明)|摊开手(?:解释|说明)|用手势(?:解释|说明)/.test(clause)) {
      suppressedReason ||= 'action_discussion'; continue;
    }
    if (actionMention && /要不要|能不能|是否|该不该|吗|么|呢|可不可以|能否/.test(clause)) {
      suppressedReason ||= 'action_question'; continue;
    }
    for (const [kind, id, pattern] of ACTIONS) {
      for (const match of clause.matchAll(new RegExp(pattern.source, 'gu'))) {
        if (actor !== 'self') { suppressedReason ||= 'no_self_action'; continue; }
        add(kind, id, match, clause, .5, id === 'explain' ? 110 : 100, 'explicit_self_action');
      }
    }
    for (const [id, pattern, base, priority] of EXPRESSIONS) {
      for (const match of clause.matchAll(new RegExp(pattern.source, 'gu'))) {
        const prefix = clause.slice(0, match.index).trim();
        if (!actor && prefix && !SPEAKER_PREFIX.test(prefix)) continue;
        add('expression', id, match, clause, base, priority, 'speech_emotion');
      }
    }
    for (const [kind, id, pattern, base, reason, priority] of DIALOGUE) {
      const match = pattern.exec(clause);
      if (match && (actor === 'self' || SPEAKER_PREFIX.test(clause.slice(0, match.index).trim()))) {
        add(kind, id, match, clause, base, priority, reason);
      }
    }
  }

  if (PURE_ACK.test(text)) {
    const requested = directRequest(user.text);
    if (requested) candidates.push({ key: 'confirmed_request', index: ++index, priority: 90,
      cue: cue(requested.kind, requested.id, strength(user.text, .45, profile), 'confirmed_user_request') });
  }
  const available = candidates.filter(item => {
    const last = lastMention.get(item.key);
    return !last || !last.blocked || last.index < item.index;
  }).sort((a, b) => b.priority - a.priority || b.index - a.index);
  const expression = available.find(item => item.cue.kind === 'expression');
  const motion = available.find(item => item.cue.kind !== 'expression');
  const cues = [expression?.cue, motion?.cue].filter(Boolean);
  const fallbackEligible = !motion && !suppressedReason && !clean.removed
    && /[\u3400-\u9fff]/u.test(text) && text.length >= 8 && !/[？?不没别]/.test(text) && !PURE_ACK.test(text);
  return { cues, suppressedReason: cues.length ? null : suppressedReason, fallbackEligible };
}
