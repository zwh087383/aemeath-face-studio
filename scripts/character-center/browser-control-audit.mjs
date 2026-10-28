import fs from 'node:fs/promises';
import path from 'node:path';
import {createRequire} from 'node:module';
const {chromium}=createRequire(import.meta.url)(process.env.PLAYWRIGHT_PACKAGE??path.join(process.env.APPDATA,'npm/node_modules/@playwright/cli/node_modules/playwright'));
const browser=await chromium.launch({channel:'chrome',headless:true}),page=await browser.newPage({viewport:{width:1440,height:1000}});
const out='outputs/library-expansion-20261027/browser-controls.json';
try {
 await page.goto('http://127.0.0.1:18820/library-expansion/');await page.waitForFunction(()=>window.motionLibrary?.snapshot().ready,null,{timeout:120000});
 const result=await page.evaluate(async()=>{
  const a=window.motionLibrary;a.setManual(true);const results=[];
  async function advance(seconds){for(let i=0;i<seconds*10;i++){a.step(.1,i%30===0);if(i%20===0)await new Promise(r=>setTimeout(r,0));}return a.snapshot().scene;}
  function control(name){const token=a.snapshot().scene.actorState.activityToken;return a.submit([{action:'control:'+name+'_activity',anchor:'immediate',activity_token:token}]);}
  await a.inspect('activity:type_at_desk',{total_seconds:90});let s=await advance(72);
  results.push({case:'typing_over_60_seconds',pass:s.body.active?.action==='activity:type_at_desk'&&s.props.props.laptop.openness>.99,elapsed:s.activity?.elapsed,lid:s.props.props.laptop.openness});
  control('pause');s=await advance(2);const before=s.activity.elapsed,revision=a.scene.body.revision;
  results.push({case:'pause_actual_activity',pass:!!s.body.suspended&&s.activity.attention.rate<.001,token:s.actorState.resumeToken,elapsed:before});
  a.submit([{action:'action:nod',anchor:'immediate',performance:{variant_set:['support-preserving']}}]);s=await advance(3);
  results.push({case:'seated_nod_while_paused',pass:s.body.events.some(e=>e.action==='action:nod'&&e.type==='action_completed')&&s.actorState.seatSupported&&Math.abs(s.activity.elapsed-before)<.01,elapsed:s.activity.elapsed,lid:s.props.props.laptop.openness});
  control('resume');s=await advance(2);
  results.push({case:'resume_same_task_without_lid_reopen',pass:s.body.active?.action==='activity:type_at_desk'&&a.scene.body.revision===revision&&s.activity.elapsed>before&&s.props.props.laptop.openness>.99,elapsed:s.activity.elapsed,revision:a.scene.body.revision});
  control('finish');s=await advance(8);
  results.push({case:'finish_original_exit',pass:!s.body.active&&!s.body.suspended&&s.props.props.laptop.openness<.001,lid:s.props.props.laptop.openness});
  await a.inspect('activity:read_seated',{total_seconds:30});s=await advance(20);control('pause');s=await advance(2);
  const book=JSON.stringify(s.props.props.book.position);a.submit([{action:'action:glance',anchor:'immediate',performance:{variant_set:['support-preserving']}}]);s=await advance(3);
  results.push({case:'held_book_response',pass:s.actorState.seatSupported&&s.props.props.book.attachment==='both'&&s.body.events.some(e=>e.action==='action:glance'&&e.type==='action_completed'),bookPositionBefore:book,bookPositionAfter:s.props.props.book.position,contact:s.props.props.book.contact});
  a.cancel();s=await advance(5);const token=s.actorState.activityToken;
  results.push({case:'cancel_suspended_never_resumes',pass:!s.body.active&&!s.body.suspended&&!s.body.pending.length,token,held:s.props.props.book.attachment});
  await a.inspect('activity:type_at_desk',{total_seconds:90});
  // The real chair approach precedes typing. Interrupt the actual typing entry,
  // not a guessed wall time that could still belong to a prerequisite action.
  for(let i=0;i<250;i++){s=await advance(.1);if(s.body.active?.action==='activity:type_at_desk')break;}
  if(s.body.active?.action!=='activity:type_at_desk')throw Error('typing entry did not start after actual seat/approach prerequisites');
  a.scene.bodyDirector.pauseForAttention({reason:'user_speech_started'});s=await advance(6);
  results.push({case:'speech_during_entry_waits_for_safe_middle',pass:!!s.body.suspended&&s.activity.attention?.paused,events:s.body.events.filter(e=>e.type==='local_attention_control'||e.type==='action_rejected').map(e=>({type:e.type,reason:e.reason}))});
  return {at:new Date().toISOString(),cloudCalls:0,kind:'actual PMX accelerated-clock integration; no cloud model choice',results,events:s.body.events.map(e=>({type:e.type,action:e.action,reason:e.reason})),pass:results.every(r=>r.pass)};
 });
 await fs.writeFile(out,JSON.stringify(result,null,2));console.log(JSON.stringify(result,null,2));if(!result.pass)process.exitCode=1;
}finally{await browser.close();}
