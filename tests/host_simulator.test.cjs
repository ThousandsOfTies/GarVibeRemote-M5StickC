const test=require('node:test');
const assert=require('node:assert/strict');
const path=require('node:path');
const {loadApplication,createHostServer}=require('../simulation/host-server.cjs');
const {createSimulationController}=require('../simulation/host-controller.cjs');
const root=path.resolve(__dirname,'../simulation');
async function controller(){return createSimulationController(await loadApplication(path.join(root,'runtime')));}
function press(app,button){app.control({type:'button',button,phase:'down'});app.tick(40);app.control({type:'button',button,phase:'up'});}

test('host synthetic PC handshakes over USB, sends real JSONL and receives a matching acknowledgement',async()=>{
  const app=await controller();
  assert.equal(app.snapshot().snapshot.activeTransport,'usb-serial');
  assert.equal(app.snapshot().snapshot.waitingCount,2);
  press(app,'C');press(app,'A');
  assert.equal(app.snapshot().metrics.syntheticReplies,1);
  assert.equal(app.snapshot().snapshot.pending,'yes');
  app.tick(500);
  assert.equal(app.snapshot().snapshot.acknowledged,true);
  assert.equal(app.snapshot().metrics.acknowledgements,1);
  assert.match(app.snapshot().events.map(e=>e.text).join('\n'),/m5stickc-plus2-usb/);
  app.tick(30000);assert.equal(app.snapshot().snapshot.connected,true,'heartbeat keeps the real lease alive');
  assert.equal(app.frame().length,135*240*4);assert.ok(new Set(app.frame()).size>5);
});

test('switching the simulated cable to SPP releases ownership and routes the reply through SPP',async()=>{
  const app=await controller();app.control({type:'hardware',transport:'bluetooth-spp'});
  assert.equal(app.snapshot().snapshot.activeTransport,'bluetooth-spp');
  press(app,'A');app.tick(500);
  assert.equal(app.snapshot().metrics.syntheticReplies,1);
  assert.match(app.snapshot().events.map(e=>e.text).join('\n'),/m5stickc-plus2-spp/);
  app.control({type:'hardware',connected:false});
  assert.equal(app.snapshot().snapshot.activeTransport,'none');assert.equal(app.snapshot().snapshot.connected,false);
  app.control({type:'hardware',connected:true});app.tick(1000);
  assert.equal(app.snapshot().metrics.syntheticReplies,1,'reconnection does not replay a user action');
});

test('host preserves a held question while background sessions update, then automatically selects the next unanswered one',async()=>{
  const app=await controller();press(app,'C');
  const first=app.snapshot().snapshot.sessionId;
  app.control({type:'background',status:'waiting'});app.tick(5000);
  assert.equal(app.snapshot().snapshot.sessionId,first);assert.equal(app.snapshot().snapshot.autoPaused,'choice');
  press(app,'A');app.tick(500);assert.equal(app.snapshot().snapshot.acknowledged,true);
  app.tick(2000);assert.notEqual(app.snapshot().snapshot.sessionId,first);assert.equal(app.snapshot().snapshot.answerable,true);
  press(app,'B');const before=app.snapshot().snapshot;
  press(app,'C');press(app,'A');assert.equal(app.snapshot().snapshot.listOpen,false);
  assert.notEqual(app.snapshot().snapshot.sessionId,before.sessionId);
  assert.equal(app.snapshot().metrics.syntheticReplies,1,'list selection cannot synthesize a response');
});

test('live mode shows received sessions but browser buttons never create a reply or acknowledgement',async()=>{
  const app=await controller();app.control({type:'mode',mode:'live'});
  app.control({type:'live',connected:true,sessions:[{type:'state',session:{id:'actual',name:'閲覧する会話'},ui:{id:'native-card',state:'waiting',message:'実機で回答してください',actions:[{id:'yes',label:'YES'},{id:'no',label:'NO'}]}}]});
  assert.equal(app.snapshot().snapshot.sessionId,'actual');
  press(app,'C');press(app,'A');app.tick(6000);
  assert.equal(app.snapshot().metrics.syntheticReplies,0);assert.equal(app.snapshot().metrics.acknowledgements,0);
  assert.equal(app.snapshot().snapshot.pending,'');
  assert.throws(()=>app.control({type:'scenario',name:'multi'}),/read-only/);
  app.control({type:'live',connected:false});assert.equal(app.snapshot().snapshot.connected,false);
});

test('host models power gestures outside the shared app without turning a long C hold into an answer',async()=>{
  const app=await controller();app.control({type:'button',button:'C',phase:'down'});app.tick(6000);
  assert.equal(app.snapshot().hardware.powered,false);app.control({type:'button',button:'C',phase:'up'});
  app.control({type:'button',button:'C',phase:'down'});app.tick(2000);app.control({type:'button',button:'C',phase:'up'});
  assert.equal(app.snapshot().hardware.powered,true);assert.equal(app.snapshot().snapshot.connected,true);
  assert.equal(app.snapshot().metrics.syntheticReplies,0);
});

test('replaced questions and connection loss cancel a held A before the synthetic peer can receive it',async()=>{
  for(const kind of ['replace','disconnect']) {
    const app=await controller();app.control({type:'scenario',name:'short'});
    app.control({type:'button',button:'A',phase:'down'});app.tick(40);
    if(kind==='replace')app.control({type:'scenario',name:'short'});
    else app.control({type:'hardware',connected:false});
    app.control({type:'button',button:'A',phase:'up'});app.tick(1000);
    assert.equal(app.snapshot().metrics.syntheticReplies,0,kind);
    assert.equal(app.snapshot().snapshot.pending,'',kind);
  }
});

test('an acknowledgement remains attached to the original session after navigating away',async()=>{
  const app=await controller();press(app,'A');press(app,'B');press(app,'C');press(app,'A');
  app.tick(500);assert.equal(app.snapshot().snapshot.sessionId,'notes');assert.equal(app.snapshot().snapshot.acknowledged,false);
  press(app,'B');press(app,'C');press(app,'C');press(app,'A');
  assert.equal(app.snapshot().snapshot.sessionId,'screen');assert.equal(app.snapshot().snapshot.acknowledged,true);
});

test('HTTP panel exposes matching process identity and true pixels, and restricts static and cross-origin access',async t=>{
  const server=await createHostServer({root,componentsRoot:path.resolve(root,'../sources/gar-tools/web-simulator/components'),port:0,buildId:'test-build',instanceId:'test-instance',manualClock:true});
  t.after(()=>server.close());const base=`http://127.0.0.1:${server.port}`;
  const health=await (await fetch(base+'/health')).json();
  assert.equal(health.ok,true);assert.equal(health.buildId,'test-build');assert.equal(health.instanceId,'test-instance');assert.equal(health.pid,process.pid);
  assert.equal((await fetch(base+'/')).status,200);
  assert.equal((await fetch(base+'/gar-components/m5stickc-plus2.mjs')).status,200);
  assert.equal((await fetch(base+'/runtime/lvgl-ui.wasm')).status,404,'application binary stays in the PC host');
  assert.equal((await fetch(base+'/host-server.cjs')).status,404);
  assert.equal((await fetch(base+'/../host-controller.cjs')).status,404);
  const frame=await (await fetch(base+'/api/frame')).arrayBuffer();assert.equal(frame.byteLength,135*240*4);
  assert.equal((await fetch(base+'/api/control',{method:'POST',headers:{'Content-Type':'application/json',Origin:'https://example.com'},body:'{"type":"scenario","name":"idle"}'})).status,403);
  assert.equal((await fetch(base+'/api/control',{method:'POST',headers:{'Content-Type':'text/plain'},body:'{"type":"scenario","name":"idle"}'})).status,400);
  const valid=await fetch(base+'/api/control',{method:'POST',headers:{'Content-Type':'application/json',Origin:base},body:'{"type":"scenario","name":"idle"}'});
  assert.equal(valid.status,200);assert.equal((await valid.json()).snapshot.state,'idle');
});
