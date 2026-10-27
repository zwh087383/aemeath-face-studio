"""Real local transport/control checks with fake model outputs; no cloud calls."""
import asyncio
import base64
import json
from types import SimpleNamespace
import pytest
from test_character_center_backend import fixture, user_job, actions, m, b, fake_main


def test_full_catalog_is_small_and_temporarily_unavailable_actions_remain_visible():
    rows=m.protocol.load_catalog(); view=m.input_view.compact_catalog(rows)
    assert [r[0] for r in view['actions']]==[r['id'] for r in rows]
    assert len(m.input_view.encoded(view)) < len(json.dumps(rows,ensure_ascii=False))*.25
    assert 'activity:read_seated' in m.input_view.encoded(view)
    assert '成功握取' in m.input_view.encoded(view)
    assert len(view['conditions'])==7


def test_actor_view_keeps_unknown_and_contacts_without_leaking_geometry():
    view=m.input_view.actor_view({'support':'unknown','contacts':{'L':False,'R':False},
        'bones':{'leftWrist':[123,456,789]},'props':{'book':{'visible':True,'attachment':'table','position':[1,2,3]},
                                              'cup':{'visible':False}}})
    assert view['support']=='unknown' and view['hands']=='unknown'
    assert view['objects']=={'book':{'attachment':'table'}}
    assert 'bones' not in view and 'position' not in m.input_view.encoded(view)


def test_context_keeps_negation_and_deduplicates_current_user_without_system_prefix():
    view=m.input_view.context_view([{'role':'system','content':'PRIVATE_SYSTEM_PREFIX'},
        {'role':'assistant','content':'你是要我挥手吗？'}, {'role':'user','content':'不要挥手，我在引用别人。'}],
        '不要挥手，我在引用别人。')
    assert view['delivered_context']==[{'role':'assistant','content':'你是要我挥手吗？'}]
    assert 'PRIVATE' not in m.input_view.encoded(view)


def test_action_request_does_not_wait_for_voice_request_or_tool_receipt(tmp_path):
    async def run():
        s,budget,socket,seen,t=await fixture(tmp_path,[('perform_actions',actions())])
        s._voice_wait[t['id']]=asyncio.Event()  # deliberately never released
        await asyncio.wait_for(user_job(s,t),2)
        request=next(e for e in seen if e['type']=='character_semantic_request')
        done=next(e for e in seen if e['type']=='character_semantic_done')
        assert request['timings']['context_confirmed']<=request['timings']['request_sent']
        assert done['timings']['response_created']<=done['timings']['first_complete_arguments']
        assert done['usage'] and not s._voice_wait[t['id']].is_set()
        assert next(i for i,e in enumerate(seen) if e['type']=='character_actions') < seen.index(done)
        assert budget.snapshot()['channels']['action']['used']==1
    asyncio.run(run())


def test_subtitle_anchor_tracks_actual_received_pcm_not_generation_terminal(tmp_path):
    async def run():
        seen,plans=[],[]
        async def send(e):seen.append(e)
        s=m.CharacterCenterSession(SimpleNamespace(),fake_main(),b.CenterBudget(tmp_path/'b'),tmp_path,send)
        async def plan(*args):plans.append(args)
        s._plan_assistant=plan
        await s.emit('audio',turnId='turn_1',segmentIndex=0,pcm=base64.b64encode(bytes(24000)).decode(),responseId='r',providerConnectionId='p')
        await s.emit('subtitle',turnId='turn_1',segmentIndex=0,delta='第一句话。',responseId='r',providerConnectionId='p')
        await asyncio.sleep(0)
        assert plans[0][3]['frame']==12000 and plans[0][3]['kind']=='audio_frame'
        assert not any(e['type']=='response_done' for e in seen)
    asyncio.run(run())


@pytest.mark.parametrize('status,reason',[('completed',''),('rejected','missing_book'),('failed','executor_refused')])
def test_real_receipt_drives_next_model_decision_without_choosing_an_action(tmp_path,status,reason):
    async def run():
        s,_,_,seen,t=await fixture(tmp_path,[('perform_actions',{**actions(), 'goal':'自主回应当前内容'})])
        await user_job(s,t)
        command=next(e for e in seen if e['type']=='character_actions')
        submitted=[]
        s._submit=lambda *args,**kwargs: submitted.append((args,kwargs)) or object()
        receipt={'commandId':command['commandId'],'index':0,'action':'gesture:wave','status':status,'reason':reason,
                 'actorState':{'support':'standing','hands':'free','props':{},'canYield':True}}
        result=await s.action_receipt(receipt)
        assert result['replanned'] and len(submitted)==1
        payload=submitted[0][0][3]
        assert payload['latest_execution']['status']==status
        assert payload['current_plan'][0]['goal']=='自主回应当前内容'
        assert 'next_action' not in payload
        assert not (await s.action_receipt(receipt))['accepted']
        assert len(submitted)==1 and not t.get('acknowledged')
    asyncio.run(run())


def test_unknown_receipt_and_cancelled_turn_cannot_launch_replanning(tmp_path):
    async def run():
        s,_,_,seen,t=await fixture(tmp_path,[('perform_actions',actions())]);await user_job(s,t)
        event=next(e for e in seen if e['type']=='character_actions')
        receipt={'commandId':'invented','index':0,'action':'gesture:wave','status':'completed'}
        assert not (await s.action_receipt(receipt))['accepted']
        receipt['commandId']=event['commandId'];t['cancel'].set()
        assert (await s.action_receipt(receipt))['reason']=='retired_turn'
    asyncio.run(run())


def test_keep_has_no_completion_loop_and_wait_does_not_infer_new_actions(tmp_path):
    assert m.protocol.parse_actions('{"operation":"keep","actions":[]}')['actions']==[]
    async def run():
        s,_,_,seen,t=await fixture(tmp_path,[('perform_actions',{**actions(),'review':'wait'})]);await user_job(s,t)
        event=next(e for e in seen if e['type']=='character_actions')
        result=await s.action_receipt({'commandId':event['commandId'],'index':0,'action':'gesture:wave','status':'completed'})
        assert result=={'accepted':True,'replanned':False}
    asyncio.run(run())


def test_real_tool_stream_has_separate_first_delta_and_complete_timestamps(tmp_path):
    async def run():
        s,_,socket,seen,t=await fixture(tmp_path,[('perform_actions',actions())])
        # The fake transport still uses the real parser and wire ownership checks.
        socket.generated.insert(2,{'type':'response.function_call_arguments.delta','response_id':'plan_1',
                                'item_id':'item_0','delta':'{"operation":'})
        await user_job(s,t)
        marks=next(e for e in seen if e['type']=='character_semantic_done')['timings']
        assert marks['request_sent']<=marks['first_tool_item']<=marks['first_argument_delta']<=marks['first_complete_arguments']
    asyncio.run(run())


def test_revoked_memory_during_receipt_cannot_create_another_decision(tmp_path):
    async def run():
        s,_,_,seen,t=await fixture(tmp_path,[('perform_actions',actions())]);await user_job(s,t)
        e=next(e for e in seen if e['type']=='character_actions');t['guard']=lambda:False
        result=await s.action_receipt({'commandId':e['commandId'],'index':0,'action':'gesture:wave','status':'completed'})
        assert result['reason']=='context_revoked' and not result['replanned']
        assert t['cancel'].is_set()
    asyncio.run(run())


def test_feedback_worker_serializes_duplicates_without_holding_input_reader(tmp_path):
    async def run():
        s,_,_,seen,t=await fixture(tmp_path,[('perform_actions',{**actions(),'review':'wait'})]);await user_job(s,t)
        e=next(e for e in seen if e['type']=='character_actions')
        r={'commandId':e['commandId'],'index':0,'action':'gesture:wave','status':'completed'}
        await asyncio.gather(s.receive_action_receipt(r),s.receive_action_receipt(r))
        assert len([x for x in seen if x['type']=='character_execution_feedback'])==1
        assert any(x.get('reason')=='duplicate_execution_receipt' for x in seen)
    asyncio.run(run())


def test_business_progress_keeps_pending_goal_but_pause_invalidates_it(tmp_path):
    async def run():
        seen=[]
        async def send(e):seen.append(e)
        s=m.CharacterCenterSession(SimpleNamespace(),fake_main(),b.CenterBudget(tmp_path/'b'),tmp_path,send)
        pending=SimpleNamespace(source_key='activity:read',invalidated=False)
        s.semantic_queue.active=pending
        s.activities['read']={'id':'read','version':1,'status':'running'}
        answer=await s.plan_activity({'id':'read','version':2,'status':'running','artifactSummary':'真实新进度'})
        assert answer['reason']=='progress_preserves_current_goal' and not pending.invalidated
        s.semantic_queue.active=None
        await s.plan_activity({'id':'read','version':3,'status':'paused'})
        assert 'read' not in s.activities and s.semantic_queue.source_epochs['activity:read']==1
        assert seen[-1]['type']=='character_revoke'
    asyncio.run(run())


def test_same_failed_attempt_with_new_command_id_does_not_make_an_endless_model_loop(tmp_path):
    async def run():
        s,_,_,seen,t=await fixture(tmp_path,[('perform_actions',{**actions(),'goal':'打个招呼'})]);await user_job(s,t)
        e=next(e for e in seen if e['type']=='character_actions');count=[]
        s._submit=lambda *a,**k:count.append(a) or object()
        receipt={'commandId':e['commandId'],'index':0,'action':'gesture:wave','status':'rejected','reason':'hands_occupied'}
        assert (await s.action_receipt(receipt))['replanned']
        s.issued_actions['new-call-id']={**s.issued_actions[e['commandId']],'results':{},'reviewed':False}
        answer=await s.action_receipt({**receipt,'commandId':'new-call-id'})
        assert answer['reason']=='unchanged_failure_waits_for_new_fact' and len(count)==1
    asyncio.run(run())


def test_explicit_skip_reports_a_missed_anchor_without_asking_for_replacement(tmp_path):
    async def run():
        action=actions();action['actions'][0]['late']='skip'
        s,_,_,seen,t=await fixture(tmp_path,[('perform_actions',action)]);await user_job(s,t)
        e=next(e for e in seen if e['type']=='character_actions')
        answer=await s.action_receipt({'commandId':e['commandId'],'index':0,'action':'gesture:wave','status':'expired'})
        assert answer['accepted'] and not answer['replanned'] and answer['reason']=='model_chose_skip_missed_anchor'
    asyncio.run(run())
