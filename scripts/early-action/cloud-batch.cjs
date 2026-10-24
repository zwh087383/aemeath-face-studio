async page => {
  await page.waitForFunction(()=>window.earlyAction?.ready);
  // Launch without keeping a CLI request blocked for the whole batch. Each case
  // is single-use, and both browser and bridge check the hard cap and usage lock.
  await page.evaluate(()=>{
    if(window.earlyBatch?.running)throw Error('batch_already_running');
    window.earlyBatch={running:true,results:[],error:null};
    (async()=>{
      try{
        await window.earlyAction.runBatch();
      }catch(error){window.earlyBatch.error=error.message;}
      finally{window.earlyBatch.running=false;}
    })();
  });
}
