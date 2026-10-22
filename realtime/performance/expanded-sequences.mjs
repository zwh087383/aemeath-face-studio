/** Authored local performances. Seconds use the director clock, never timers.
 * delay is before a step; rest is after full recovery; duration is a minimum
 * beat length (also used for face-only beats). A face/action cue can have its
 * own offset and duration. The final gesture always finishes before looping.
 * Duration hints round measured complete playback (2026-10-22, 60 fps,
 * speed 1, seed 724, initially relaxed). Live entry poses and speed can vary.
 */
const face = (preset, intensity = .6, duration = 3, offset = 0) => ({ preset, intensity, duration, offset });
const action = (action, intensity = .55, offset = 0) => ({ action, intensity, offset });
const beat = (gesture, preset, rest = .3, extra = {}) => ({ gesture, rest,
  ...(preset ? { face: face(preset) } : {}), ...extra });
const quiet = (duration, preset = 'neutral', micro = 'glance') => ({ duration,
  face: face(preset, .45, duration), ...(micro ? { action: action(micro, .35, Math.min(.7, duration / 3)) } : {}) });
const scene = (name, description, category, durationHint, steps) => Object.freeze({
  name, description, category, durationHint, maxCycles: 2,
  gestures: Object.freeze(steps.filter(step => step.gesture).map(step => step.gesture)),
  steps: Object.freeze(steps.map(step => Object.freeze(step))),
});

export const EXPANDED_STORIES = Object.freeze({
  first_meeting: scene('从招呼到交谈', '认出你后利落招呼，留出你开口的空隙，再倾听、思考和回应。', '交流', 31, [
    beat('greet', 'smile', .5, { delay: .35 }), quiet(1.8, 'smile', null), beat('offer_turn', 'attentive', .6),
    beat('listen', 'attentive', 1), beat('micro_ack', 'acknowledge_soft', .5), quiet(1.4, 'neutral'),
    beat('think', 'considering', .25), beat('clarify', 'understanding', 0), beat('agree', 'smile', .8),
  ]),
  quiet_comfort: scene('先听，再安慰', '担忧只出现片刻，安静听完后才伸手安慰，最后把空间还给对方。', '陪伴', 34, [
    beat('concerned', 'concerned', .6), beat('listen', 'empathy', 1.5), quiet(3, 'empathy', 'listen_dip'),
    beat('comfort', 'encouraging', 1), quiet(2.4, 'smile', null), beat('reassure', 'encouraging', .8),
    beat('invite_continue', 'neutral', 1.3), quiet(3.5, 'smile', 'blink'),
  ]),
  playful_misunderstanding: scene('误会后笑出来', '疑惑、核对、反应过来，然后笑一下；没有连续夸张的惊讶和挥手。', '情绪', 31, [
    beat('doubtful_tilt', 'puzzled', .4), quiet(1.4, 'puzzled', null), beat('ask_check', 'curious', .5),
    beat('surprise', 'surprise', .1, { face: face('surprise', .42, 1.2) }),
    beat('amused', 'amused', .5), beat('laugh', 'happy', .7), quiet(1.8, 'mischievous', 'glance_right'),
    beat('gently_decline', 'teasing', .6), beat('agree', 'smile', .6),
  ]),
  explain_three_points: scene('把三件事说清楚', '视线先到、手势跟上；列点、对比、勾勒范围，每个段落之间都有收势和停顿。', '连续表达', 33, [
    beat('refocus', 'focus', .3), beat('enumerate_two', 'focus', .5), quiet(1.2, 'neutral', null),
    beat('present_left', 'smile', 0), beat('compare_options', 'focus', .6),
    quiet(1.5, 'neutral', 'nod'), beat('outline_space', 'focus', 0), beat('explain_firm', 'focus', .6),
    beat('ask_check', 'curious', .9), quiet(2.5, 'smile', null),
  ]),
  excited_discovery: scene('想明白的新发现', '先发现线索，再思考，惊喜带动胸肩，解释完才轻轻庆祝。', '情绪', 37, [
    beat('recall_up', 'recollecting', .4), quiet(1.3, 'curious', null), beat('think', 'considering', .4),
    beat('delighted', 'realizing', .35), beat('explain_sequence', 'smile', .6),
    quiet(1.5, 'smile', 'acknowledge'), beat('celebration_compact', 'delighted', .65),
    beat('breath_settle', 'smile', .8), quiet(2.2, 'smile', null),
  ]),
  lingering_goodbye: scene('舍不得的告别', '认真回应，停下来再看一眼，挥手清楚利落，手臂完整收回。', '交流', 32, [
    beat('grateful', 'grateful', .7), quiet(1.8, 'smile', 'nod'), beat('chest', 'shy', .4),
    beat('farewell_linger', 'smile', .9), quiet(2.2, 'smile', 'glance'),
    beat('greet', 'happy', .8, { waitForRecovery: true }),
    beat('breath_settle', 'smile', 1.2), quiet(3.2, 'neutral', null),
  ]),
  quiet_company: scene('什么都不急着说', '长一点的静处中偶尔确认目光、松开手指、调整重心；小动作之间留白。', '安静', 42, [
    { ...quiet(4.5, 'serene', 'blink'), delay: .6 }, beat('refocus', 'smile', 1.8), quiet(4, 'serene', null),
    beat('finger_release', 'neutral', 2), quiet(4.3, 'neutral', 'glance_left'), beat('weight_settle', 'neutral', 1.4),
    quiet(4.6, 'smile', 'nod'), beat('listening_pause', 'neutral', 1.6), quiet(4, 'smile', null),
  ]),
  careful_disagreement: scene('温和地表达不同意见', '先让对方说完，轻轻否认，再解释理由，最后核对理解。', '交流', 30, [
    beat('listen', 'attentive', .9), quiet(1.4, 'unconvinced', null), beat('small_no', 'focus', .6),
    beat('gently_decline', 'neutral', .6), quiet(1.1, 'neutral', 'blink'),
    beat('clarify', 'focus', 0), beat('compare_options', 'focus', .6),
    beat('ask_check', 'curious', 1), quiet(2.5, 'smile', null),
  ]),
  remember_together: scene('一起回忆', '目光离开去搜索记忆，想起后回到你，再把想法交给对方补充。', '交流', 33, [
    beat('thinking_glance', 'recollecting', .5), quiet(2.2, 'considering', null), beat('recall_up', 'recollecting', .7),
    beat('micro_ack', 'realizing', .5), beat('storytelling_arc', 'smile', .7),
    beat('offer_turn', 'curious', 1), quiet(3.4, 'neutral', 'nod'), beat('agree', 'smile', .6),
  ]),
  reassurance_after_mistake: scene('失误以后重新来过', '短暂失落，呼气收住，然后解释、承担、重新提出下一步。', '情绪', 36, [
    beat('disappointed', 'disappointed', .8), quiet(2.1, 'apologetic', null), beat('breath_settle', 'neutral', .4),
    beat('chest', 'apologetic', .5), beat('clarify', 'focus', .6), quiet(1.4, 'neutral', 'head_settle'),
    beat('reset_and_resolve', 'determined', .9), beat('reassure', 'encouraging', .8), quiet(2, 'smile', null),
  ]),
  warm_reunion: scene('熟人重逢', '身体先迎上去，短促挥手后收臂，仔细看看对方，再笑着交谈。', '连续表达', 33, [
    beat('warm_welcome', 'delighted', .6), beat('greet', 'smile', .5, { waitForRecovery: true }),
    quiet(1.8, 'smile', null), beat('curious', 'curious', .8), beat('listen', 'smile', 1.1),
    beat('amused', 'smile', .4), beat('laugh', 'happy', .8), quiet(2.3, 'smile', 'nod'),
  ]),
  narrate_a_small_adventure: scene('讲一段小经历', '勾勒场景、指明两边、制造一个小悬念，反应之后回到讲述。', '连续表达', 50, [
    beat('storytelling_arc', 'smile', .4), quiet(1.5, 'neutral', 'glance'),
    beat('present_left', 'focus', 0), beat('present_right', 'focus', .5), beat('curious', 'curious', .6),
    quiet(2.1, 'curious', null), beat('surprise', 'surprise', .4, { face: face('surprise', .4, 1.6) }),
    beat('explain_sequence', 'smile', .6), beat('amused', 'smile', .6),
    quiet(1.8, 'smile', 'nod'), beat('offer_turn', 'smile', 1), quiet(3, 'neutral', null),
  ]),
  accept_a_compliment: scene('被夸奖以后', '先不好意思地躲一下，确认你是认真的，再道谢和露出一点小得意。', '情绪', 28, [
    beat('embarrassed', 'embarrassed', .5), quiet(1.7, 'awkward', 'look_down'), beat('ask_check', 'curious', .5),
    beat('grateful', 'grateful', .7), beat('proud_soft', 'proud', .6),
    quiet(2, 'smile', null), beat('offer_turn', 'smile', .6), quiet(2.4, 'neutral', 'blink'),
  ]),
  thinking_out_loud: scene('边想边把问题拆开', '疑惑停顿与解释交替，有推进，也有停下来重新检查的过程。', '连续表达', 38, [
    beat('doubtful_tilt', 'hesitant', .6), beat('think', 'considering', .7), quiet(1.8, 'considering', null),
    beat('enumerate_two', 'focus', .5), beat('compare_options', 'curious', .4),
    quiet(2.3, 'neutral', 'glance'), beat('thinking_glance', 'focus', .4),
    beat('determined', 'determined', .5), beat('explain_firm', 'confident', .7), quiet(2.2, 'smile', 'tiny_agree'),
  ]),
  listen_to_a_long_story: scene('耐心听完整段话', '安静倾听占大部分，只在合适位置点头、探身和确认，不抢着挥动双手。', '安静', 40, [
    beat('listen', 'neutral', 1.5), quiet(4, 'neutral', 'blink'), beat('micro_ack', 'smile', .8),
    quiet(3.8, 'neutral', null), beat('attentive_tilt', 'curious', 1.1), quiet(4.2, 'neutral', null),
    beat('double_ack', 'smile', .8), quiet(3.6, 'smile', 'glance'),
    beat('invite_continue', 'smile', 1.2), quiet(4.1, 'neutral', null),
  ]),
  from_doubt_to_resolution: scene('从犹豫到达成共识', '完整的倾听、质疑、分析、让步和确认，最后收势安静下来。', '连续表达', 55, [
    beat('listen', 'attentive', .8), beat('skeptical', 'skeptical', .7), quiet(1.5, 'neutral', null),
    beat('ask_check', 'curious', .6), beat('think', 'focus', .5),
    beat('compare_options', 'focus', 0), beat('outline_space', 'focus', .7), quiet(1.8, 'neutral', 'nod'),
    beat('relieved', 'relieved', .5), beat('reset_and_resolve', 'confident', .7),
    beat('agree', 'smile', .8), quiet(2.5, 'smile', null), beat('breath_settle', 'neutral', .9),
  ]),
});
