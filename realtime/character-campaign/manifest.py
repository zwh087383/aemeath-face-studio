"""Reproducible business/user fixtures. Contains no character action commands."""
from collections import Counter
import hashlib
import json
from pathlib import Path
import random

SEED = 20261027
EMOTIONS = {
    "high_sad": {"label": "高度悲伤", "E": [-.90, .32, .20, .54]},
    "high_excited": {"label": "高度兴奋", "E": [.92, .88, .75, .08]},
    "mild_sad": {"label": "略微悲伤", "E": [-.28, .30, .44, .18]},
    "happy": {"label": "较为高兴", "E": [.55, .52, .62, .08]},
}
SINGLES = {
"high_sad": [
 "我认真准备的比赛还是落选了，现在特别难受，你能陪我说两句吗？",
 "陪伴我很久的宠物去世了，我暂时不想听建议，只想有人理解我。",
 "我和很重要的朋友彻底失联了，我真的很舍不得这段关系。",
 "花了几个月做的作品意外损坏了，我感觉自己的努力都白费了。",
 "我错过了向亲人道别的机会，这件事让我一直很难受。",
 "今天得知自己期待很久的机会取消了，我现在不知道该说什么。",
 "我刚刚哭过，暂时不想振作，你安静温柔地陪我一会儿好吗？",
 "最信任的朋友离开了这座城市，今天回家突然觉得空空的。"],
"high_excited": [
 "我拿到梦寐以求的录取通知了！快跟我分享这个好消息！",
 "我第一次参加比赛就得奖了，真的太开心了，你也为我高兴吗？",
 "我们的作品终于发布了，而且很多人喜欢，我现在特别兴奋！",
 "我终于完成了坚持一年的目标，想和你一起庆祝一下！",
 "我抽中了期待很久的演唱会门票，简直不敢相信！",
 "一直担心的考试拿了最高分，今天我真的开心得停不下来！",
 "好久不见的朋友明天就回来了，我已经开始期待见面的那一刻了！",
 "我们的实验成功了！之前那些失败终于有意义了，跟我说句庆祝的话！"],
"mild_sad": [
 "今天下雨，原定的散步取消了，有点失落，你建议我做什么？",
 "刚泡好的茶凉了，工作也没做完，感觉今天有点不顺。",
 "我画画练习没有明显进步，你能给我一点具体的鼓励吗？",
 "朋友今天很忙，没空陪我聊天，我有点孤单。",
 "我刚看完一个略伤感的故事，你喜欢怎样的结尾？",
 "今天计划没完成，但也没有大事，你觉得该怎么收尾？",
 "读了两页书就走神了，怎样才能轻松一点找回注意力？",
 "我错过了喜欢的日落，你能用两句话安慰我吗？",
 "今天状态一般，读书和听音乐哪个更适合放松？",
 "我把一件小事做砸了，现在总在反复想它。",
 "最近练习吉他总弹错，有点泄气，应该怎么安排练习？",
 "昨天约好的活动取消了，我想重新安排一个安静的晚上。",
 "我今天不太想说话，你觉得两个人安静待着也算陪伴吗？",
 "刚才吃的东西不合口味，心情也跟着有点低落。",
 "我的小盆栽叶子发黄了，有点担心，先观察哪些方面？",
 "我在犹豫要不要继续这幅画，你能帮我比较修改和重画吗？",
 "天快黑了还有一点工作没做完，怎样减少那种拖延后的烦躁？",
 "我今天有些想家，你能聊聊什么东西会让人感到安心吗？",
 "朋友回复得很简短，我有点失落，但可能只是他太忙了。",
 "我想找一本温柔一点的书，不用推荐具体书名，告诉我选什么类型。",
 "刚整理旧照片，有些事情已经回不去了，你会怎么看待这种感觉？",
 "我努力做的饭只是普普通通，有点失望，下一次从哪一点改起？",
 "我今天只有十分钟空闲，怎么让自己稍微舒服一点？",
 "你还记得我在星桥咖啡店喜欢喝什么吗？今天我想喝点熟悉的。",
 "我的星桥读书会预约是几点、座位几号？我今天有点记不清了。",
 "我桌上的蓝色笔记本有几本，哪本记天文？今天有点心不在焉。",
 "画角色表情草图的那个练习项目叫什么，我原本准备画几张？",
 "我今天不想被催着开心，可以只是陪我聊一件小事吗？",
 "我想知道你在听我说话时会留意什么，不用讲复杂技术。",
 "今天做事情总被打断，你觉得先完成一件小事会有帮助吗？",
 "我纠正一下，星桥咖啡店我现在最喜欢的是热桂花茶，不是无糖柠檬水。",
 "如果一个人今天只能做到平时的一半，你觉得这算失败吗？"],
"happy": [
 "今天阳光很好，我刚散步回来，跟我打个招呼吧。",
 "我学会做一道新菜了，虽然简单，但心情很好。",
 "刚读到一个有趣的段落，阅读为什么会给人这种小小的快乐？",
 "今天任务提前完成了，你觉得剩下时间怎么安排比较舒服？",
 "我想挑一个轻松的小爱好，你帮我比较画画和写短日记吧。",
 "我终于把桌面整理好了，看着真舒服，你喜欢有秩序的环境吗？",
 "今天听到一首喜欢的歌，想知道音乐为什么能影响心情。",
 "我把窗边的植物照顾得很好，又长出新叶子了。",
 "今晚准备做一顿简单的饭，你觉得先计划还是边做边想更好？",
 "我今天帮助了一个朋友，心里有点暖暖的。",
 "我想给未来的自己留一句话，你会建议写什么？",
 "今天我想尝试新的画法，你能给我一个小练习目标吗？",
 "我发现一条安静的小路，下次散步想再去，你喜欢探索吗？",
 "周末有半天空闲，读书、散步和整理照片怎么选？",
 "我给自己泡了喜欢的饮料，你还记得我在星桥喜欢喝什么吗？",
 "我的读书会预约几点，座位几号？我已经开始期待了。",
 "第二本蓝色笔记本是记什么的？今天想继续写一点。",
 "星桥练习项目接下来要画几张草图？我准备开始了。",
 "我回来了，轻快地跟我挥挥手打个招呼吧。",
 "你觉得一个小小的进步也值得认真庆祝吗？",
 "我刚收到了朋友的明信片，想回一段不夸张的感谢。",
 "今天学会了一个新词，学习怎样才能一直保留新鲜感？",
 "我想把一天里开心的小事记下来，记几条比较合适？",
 "刚做完拉伸感觉舒服多了，你平时会怎样描述放松？",
 "我今天想做一件平时不会做的小事，你帮我出个温和的主意。",
 "如果把今天的心情比作一种天气，你会怎么说？",
 "我想听你用两句话描述一个安静又明亮的午后。",
 "朋友夸我最近进步了，我有点不好意思，但还是很高兴。",
 "你能比较一下独处和与朋友相处各自的乐趣吗？",
 "我想给读书计划起一个可爱的名字，给我两个建议就好。",
 "今天发现自己终于不再害怕犯小错了，这是不是一种进步？",
 "我准备休息了，跟我说句简短自然的晚安吧。"],
}

MULTI = [
 ["我准备很久的作品落选了，真的很难过，先听我说说好吗？", "最难受的是觉得所有努力都没有被看见。", "等一下，不要急着劝我重新开始，我只是想被理解。", "现在好一点了，如果重新看这件事，你觉得哪一点值得保留？", "谢谢你。你还记得我刚才最难受的原因吗？"],
 ["我终于拿到录取通知了，开心得不知道先做什么！", "我想先告诉家人，再谢谢帮助过我的朋友，你觉得好吗？", "先别列那么多，一句话陪我庆祝一下！", "平静一点之后，我想记录这一天，你建议记哪两件事？", "你还记得刚才是什么让我这么兴奋吗？"],
 ["我最近练画总觉得进步很慢，想和你聊聊。", "主要是画人物表情时，总觉得生硬。", "先等等，我说的是表情自然度，不是画得像不像。", "如果只做一个十分钟练习，你会选什么？", "帮我回顾一下刚才确定的那个小目标。"],
 ["今天原定的散步取消了，我有点扫兴。", "外面一直下雨，在家又不知道做什么。", "不需要很多选项，你更倾向读书还是整理照片？", "如果我选读书，怎么避免强迫自己一定读完？", "你还记得我们为什么改成在家活动吗？"],
 ["我今天做事总走神，有点烦自己。", "其实不是事情太难，而是同时想做太多。", "先停一下，把问题说简单一点。", "那我先完成最小的一件，之后再决定下一步，好吗？", "请用一句话提醒我刚才决定的做法。"],
 ["朋友今天很忙，我觉得有点孤单。", "我知道不是他不在乎，只是情绪上还会失落。", "不要替他解释太多，你先陪我聊聊吧。", "聊完之后，我可能想做一点自己的事。", "你觉得我刚才真正需要的是建议还是陪伴？"],
 ["我把桌面整理好了，今天心情挺好。", "最开心的是找到了以前写的小卡片。", "先等等，我不是想扔掉它，而是想保存好。", "你觉得按日期还是按主题整理更合适？", "我刚才找到了什么，让我觉得很开心？"],
 ["今天完成了一个小目标，想聊聊下一步。", "我想每天画一张很小的速写，重在坚持。", "先不要把计划排满，给我留一点自由吧。", "如果哪天没完成，怎样自然地接着做？", "总结一下我们刚才定下的原则。"],
 ["我今天做了一道新菜，感觉还不错。", "其实味道只是普通，但过程很开心。", "等一下，不用给复杂菜谱，聊聊这个感觉就好。", "你觉得享受过程和追求成果怎么平衡？", "刚才是什么让我开心，成品还是过程？"],
 ["我想安排一个轻松的周末，今天挺期待。", "我有一本想读的书，也想出门走走。", "先别继续列选项，帮我在这两个之间选一个开头。", "剩下时间不安排得太满，感觉会更轻松。", "你还记得我原本的两个选择吗？"],
]

def build():
    rng = random.Random(SEED)
    scenarios = []
    for emotion, texts in SINGLES.items():
        for text in texts:
            identity = f"single-{len(scenarios)+1:03}"
            scenarios.append({"id":identity,"kind":"single","emotion":emotion,
                "turns":[{"id":identity+"-t1","text":text}],"gapsSeconds":[],"interruptions":[]})
    for kind in ("short", "long"):
        for i, texts in enumerate(MULTI):
            identity = f"{kind}-{i+1:02}"
            emotion = "high_sad" if i==0 else "high_excited" if i==1 else "mild_sad" if i<6 else "happy"
            # Distinct long-session wording; it retains referents across real idle time.
            rows = [{"id":f"{identity}-t{j+1}","text":text} for j,text in enumerate(texts)]
            if kind=="long":
                rows[1]["text"]="我回来了。"+rows[1]["text"]
                rows[3]["text"]="刚才离开了一会儿，我们接着聊。"+rows[3]["text"]
            gaps = [rng.randint(2,6) for _ in range(4)] if kind=="short" else [rng.randint(165,190),rng.randint(85,105),rng.randint(165,190),rng.randint(75,150)]
            row={"id":identity,"kind":kind,"emotion":emotion,"turns":rows,"gapsSeconds":gaps,
                 "interruptions":[{("beforeTurn" if kind=="short" else "cancelTurn"):2,"voiceAgeMs":rng.randint(450,1400)}] if i%2==0 else []}
            if kind=="long":
                row["activities"]=[{"id":f"bg-{2*i+1:02}","caseId":"reading-complete","expected":"complete","afterTurn":0},
                    {"id":f"bg-{2*i+2:02}","caseId":"reading-inflight" if i<5 else "reading-revoke" if i==8 else "reading-failure",
                     "expected":"interrupted" if i<5 else "failed","afterTurn":1,
                     "fault":None if i<5 else ["fetch_denied","fetch_timeout","empty_source","source_revoked","worker_exception"][i-5]}]
                # The five interrupted activities must meet a spoken input at gap end.
                if i<5: row["activityInterruptBeforeTurn"]=2
            scenarios.append(row)
    # Single-turn random interruptions stop speech without adding a hidden second question.
    for row in rng.sample([s for s in scenarios if s["kind"]=="single"],16):
        row["interruptions"]=[{"cancelTurn":0,"voiceAgeMs":rng.randint(500,1800)}]
    rng.shuffle(scenarios)
    for row in scenarios:
        row["limits"]={"listener":3,"voice":2,"action":10,"background":12} if row["kind"]=="single" else {"listener":8,"voice":7,"action":180 if row["kind"]=="long" else 40,"background":50}
        row["turnLimit"]=3 if row["kind"]=="single" else 7
        row["pcmSeconds"]=60 if row["kind"]=="single" else 180
        row["initialMath"]=EMOTIONS[row["emotion"]]
    totals={key:sum(s["limits"][key] for s in scenarios) for key in ("listener","voice","action","background")}
    result={"version":2,"seed":SEED,"scenarios":scenarios,"totals":{"scenarios":100,"dialogueTurns":180,"activities":20,
            "limits":totals,"responses":sum(totals.values()),"pcmSeconds":sum(s["pcmSeconds"] for s in scenarios)},
        "policy":{"actions":"unchanged_original_DeepSeek_tools_and_83_capabilities; model_selected_only",
          "voice":"real_Qwen_free_response; no_future_answer_for_action_model", "userAudio":"local_Windows_Huihui_synthetic",
          "unknownUsage":"confirmed_terminal_retains_full_maximum_reservation; unconfirmed_terminal_freezes_its_channel; old_ledgers_immutable",
          "timing":"user_requested_simulated_idle_10x; real_model_audio_and_native_motion; activity_clock_and_math_idle_advance; source_memory_dates_real",
          "maxAttemptsPerScenario":1}}
    validate(result)
    return result

def validate(data):
    rows=data["scenarios"]
    assert len(rows)==100 and len({s["id"] for s in rows})==100
    assert Counter(s["kind"] for s in rows)=={"single":80,"short":10,"long":10}
    assert Counter(s["emotion"] for s in rows)=={"high_sad":10,"high_excited":10,"mild_sad":40,"happy":40}
    assert sum(len(s["turns"]) for s in rows)==180
    assert Counter(a["expected"] for s in rows for a in s.get("activities",[]))=={"complete":10,"interrupted":5,"failed":5}
    for row in rows:
        assert len(row["turns"])==(1 if row["kind"]=="single" else 5)
        if row["kind"]=="long": assert all(60<t<300 for t in row["gapsSeconds"])
    return True

def write(path):
    path=Path(path)
    data=build()
    raw=json.dumps(data,ensure_ascii=False,indent=2).encode()
    path.parent.mkdir(parents=True,exist_ok=True)
    if path.exists():
        if path.read_bytes()!=raw: raise ValueError("manifest_exists_with_different_content")
    else: path.write_bytes(raw)
    return hashlib.sha256(raw).hexdigest()

if __name__=="__main__":
    import sys
    print(write(sys.argv[1]))
