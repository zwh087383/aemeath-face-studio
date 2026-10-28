async page => {
 await page.waitForFunction(()=>window.motionLibrary?.snapshot().ready,null,{timeout:120000});
 const result=await page.evaluate(()=>{const a=window.motionLibrary;a.setManual(true);a.submit(['action:chin_tap']);for(let i=0;i<12;i++)a.step(.1,false);a.scene.setView('face');a.step(0,true);return {body:a.snapshot().scene.body.active?.action,support:a.snapshot().scene.actorState.support,driverMs:a.snapshot().driverMs.slice(-12)};});
 await page.screenshot({path:'outputs/library-expansion-20261027/chin-contact-front.png'});
 await page.evaluate(()=>{const a=window.motionLibrary;a.scene.setView('side');a.step(0,true);});
 await page.screenshot({path:'outputs/library-expansion-20261027/chin-contact-side.png'});
 return result;
}
