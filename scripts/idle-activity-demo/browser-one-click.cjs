async page=>{
  const before=await page.evaluate(()=>window.idleActivityDemo.snapshot().backend.generation);
  await page.click('#auto');
  await page.waitForFunction(old=>window.idleActivityDemo.snapshot().backend.generation>old,before,{timeout:5000});
  await page.waitForFunction(()=>window.idleActivityDemo.snapshot().backend.task?.status==='done'&&window.idleActivityDemo.snapshot().motion.mode==='complete',null,{timeout:45000});
  const result=await page.evaluate(()=>{
    const s=window.idleActivityDemo.snapshot();
    const events=s.backend.events.filter(e=>e.generation===s.backend.generation).map(e=>e.event);
    const required=['started','pause','resume','resumed','speech-start','speech-end','conversation-end','artifact-ready','completed'];
    return {passed:required.every(e=>events.includes(e))&&s.errors.length===0,events,
      status:s.backend.task.status,progress:s.backend.progress,total:s.backend.total,
      generation:s.backend.generation,artifactId:s.backend.artifact?.id,motion:s.motion.mode,
      sourceSpeed:s.motion.sourceSpeed,errors:s.errors};
  });
  if(!result.passed)throw Error('One-click lifecycle incomplete: '+JSON.stringify(result));
  const download=page.waitForEvent('download');
  await page.evaluate(value=>{const a=document.createElement('a');a.href=URL.createObjectURL(new Blob([JSON.stringify(value,null,2)],{type:'application/json'}));a.download='one-click.json';a.click();},result);
  await (await download).saveAs('outputs/idle-activity-demo-20261024/one-click.json');
  return result;
}
