const frame=document.querySelector('iframe'),out=document.querySelector('#results');
const pause=ms=>new Promise(resolve=>setTimeout(resolve,ms));
const check=(x,m)=>{if(!x)throw Error(m);};const lines=[];let failed=0;
async function run(name,fn){try{await fn();lines.push('PASS '+name);}catch(e){failed++;lines.push('FAIL '+name+': '+e.message);}out.textContent=lines.join('\n');}
try {
  for(let i=0;i<200&&!frame.contentWindow.vibeSimulator;i++)await pause(50);
  check(frame.contentWindow.vibeSimulator,'Simulator did not start');
  const doc=frame.contentDocument,state=()=>frame.contentWindow.vibeSimulator.snapshot();
  const device=doc.querySelector('#device'),controls=doc.querySelector('#scenarios');
  const key=(k,type)=>device.shadowRoot.querySelector(`[data-key=${k}]`).dispatchEvent(new KeyboardEvent(type,{key:'Enter',bubbles:true,composed:true,cancelable:true}));
  const press=async(k,ms=30)=>{key(k,'keydown');await pause(ms);key(k,'keyup');await pause(30);};
  const scenario=name=>{const select=controls.shadowRoot.querySelector('select');select.value=name;select.dispatchEvent(new Event('change',{bubbles:true}));};
  const condition=(id,value)=>{const input=controls.shadowRoot.querySelector(`[data-control-id=${id}]`);input.checked=value;input.dispatchEvent(new Event('change',{bubbles:true}));};
  await run('button component advances and reverses actual C++ pages',async()=>{
    check(state().pages>1,'long question');await press('A');check(state().page===1,'next');await press('B');check(state().page===0,'previous');
  });
  await run('last page opens answers; short press cannot send; long press reaches mock PC',async()=>{
    while(state().page+1<state().pages)await press('A');await press('A');check(state().answering,'answer mode');
    await press('B');check(!state().pending,'short press');await press('A');check(state().choice===0,'YES selected');
    await press('B',1000);await pause(600);check(state().pending==='yes'&&state().acknowledged,'round trip ack');
    check(doc.querySelector('#answer').textContent.includes('YES'),'PC receipt visible');
  });
  await run('new question during a hold cannot receive the previous answer',async()=>{
    scenario('short');await press('A');key('B','keydown');await pause(1000);scenario('long');key('B','keyup');await pause(40);
    check(!state().pending&&!state().answering&&state().page===0,'stale release discarded');
  });
  await run('disconnect cancels a held answer and reconnect keeps the question readable',async()=>{
    scenario('short');await press('A');key('B','keydown');await pause(1000);condition('connected',false);key('B','keyup');
    check(!state().connected&&!state().pending,'disconnected');condition('connected',true);check(state().connected&&!state().pending,'reconnected');
  });
  await run('running state and power toggle are wired independently of scenario messages',async()=>{
    scenario('running');check(state().state==='running','running');condition('powered',false);check(!state().powered&&!device.powered,'off');
    condition('powered',true);check(state().powered&&device.powered,'on');scenario('long');
  });
} catch(e) {failed++;lines.push('FAIL startup: '+e.message);out.textContent=lines.join('\n');}
out.dataset.failed=String(failed);out.dataset.complete='true';
