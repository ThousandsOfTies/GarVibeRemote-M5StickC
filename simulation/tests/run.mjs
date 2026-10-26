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
  const action=id=>controls.shadowRoot.querySelector(`[data-control-id=${id}]`).click();
  const condition=(id,value)=>{const input=controls.shadowRoot.querySelector(`[data-control-id=${id}]`);input.checked=value;input.dispatchEvent(new Event('change',{bubbles:true}));};
  await run('portrait display automatically scrolls while choices remain available',async()=>{
    check(doc.querySelector('#screen').width===135&&doc.querySelector('#screen').height===240,'135 x 240');
    check(device.getAttribute('orientation')==='portrait','physical orientation');
    check(state().sessions.length===3,'three sessions');const before=state().scrollPixels;await pause(3200);
    check(state().scrollPixels>before,'automatic scrolling');check(state().answerable,'choices available');
  });
  await run('C cycles YES/NO and A short press reaches the correct mock PC session',async()=>{
    scenario('short');check(state().choice===1,'NO default');await press('C');check(state().choice===0,'YES focus');
    await press('A');await pause(600);check(state().pending==='yes'&&state().acknowledged,'round trip');
    check(doc.querySelector('#answer').textContent.includes('YES'),'PC receipt');
  });
  await run('B opens list, C rotates focus, A changes session without sending an answer',async()=>{
    scenario('multi');await press('B');check(state().listOpen,'session list');await press('C');check(state().listFocus===1,'next focus');
    await press('A');check(state().sessionId==='notes'&&!state().listOpen,'switch');check(state().pending==='','no phantom response');
  });
  await run('manual navigation keeps the selected session; all choice labels can be selected',async()=>{
    const selected=state().sessionId;action('background');check(state().sessionId===selected,'selection preserved');
    scenario('choices');check(state().actions.length===3,'three options');await press('C');await press('C');check(state().choice===2,'third option');
    await press('A');await pause(600);check(state().pending==='stop'&&state().acknowledged,'third option response');
  });
  await run('replacement question and disconnect cancel A before release',async()=>{
    scenario('short');key('A','keydown');action('resend');key('A','keyup');await pause(40);check(!state().pending,'new question guard');
    key('A','keydown');condition('connected',false);key('A','keyup');check(!state().pending&&!state().connected,'disconnect guard');
    condition('connected',true);check(state().connected,'reconnect');
  });
  await run('acknowledgement follows its original session after user switches away',async()=>{
    scenario('multi');await press('A');await press('B');await press('C');await press('A');await pause(600);
    check(state().sessionId==='notes'&&!state().acknowledged,'no foreign acknowledgement');
    await press('B');await press('C');await press('C');await press('A');check(state().sessionId==='screen'&&state().acknowledged,'background receipt retained');
  });
  await run('power controls preserve passive LCD input',async()=>{
    scenario('short');condition('powered',false);check(!state().powered&&!device.powered,'off');condition('powered',true);
    doc.querySelector('#screen').dispatchEvent(new MouseEvent('click',{bubbles:true,composed:true}));check(!state().pending,'LCD click does nothing');scenario('multi');
  });
  await run('consumed C power gestures release button state before automatic selection resumes',async()=>{
    scenario('idle');await press('C',6100);check(!state().powered,'C turns off');
    await press('C',2100);check(state().powered,'C turns on');action('start-background');
    check(state().state==='running'&&state().autoPaused==='','power key is not stuck');
  });
  await run('idle yields to running, list navigation pauses selection, and answering advances to a queued question',async()=>{
    scenario('idle');action('start-background');check(state().state==='running','running beats idle');
    const selected=state().sessionId;await press('B');action('background');
    check(state().listOpen&&state().sessionId===selected,'list stays fixed');
    await press('B');check(state().state==='waiting'&&state().sessionId!==selected,'question beats running');
    const questionSession=state().sessionId;await press('C');action('background');
    check(state().sessionId===questionSession&&state().autoPaused==='choice','choice stays fixed');
    await press('A');await pause(700);check(state().sessionId===questionSession&&state().acknowledged,'reply feedback');
    await pause(2100);check(state().sessionId!==questionSession&&state().answerable,'next unanswered question');
    scenario('multi');
  });
} catch(e) {failed++;lines.push('FAIL startup: '+e.message);out.textContent=lines.join('\n');}
out.dataset.failed=String(failed);out.dataset.complete='true';
