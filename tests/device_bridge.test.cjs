const test=require('node:test');
const assert=require('node:assert/strict');
const {EventEmitter}=require('node:events');
const {createRequire}=require('node:module');
const path=require('node:path');
const runtime=createRequire(path.resolve(__dirname,'../.gar/connection-node/package.json'));
const {WebSocket,WebSocketServer}=runtime('ws');
const {startCodexBridge}=runtime('./codexBridge.cjs');
const {JsonLines,compactState,startDeviceBridge}=require('../scripts/device_bridge.cjs');
const pause=ms=>new Promise(resolve=>setTimeout(resolve,ms));
async function until(check){for(let i=0;i<300;i++){const value=check();if(value)return value;await pause(10);}throw Error('Timed out');}
const token='isolated-device-bridge-test-token';

function fakePorts(transport='spp',autoHello=true){
  const ports=[];
  class Port extends EventEmitter {
    constructor(){super();this.isOpen=false;this.messages=[];ports.push(this);}
    open(cb){setImmediate(()=>{this.isOpen=true;cb();});}
    write(data,cb){
      const message=JSON.parse(String(data));this.messages.push(message);
      if(autoHello && message.type==='hello')setImmediate(()=>this.info());
      setImmediate(()=>cb());return true;
    }
    inject(message){
      const data=Buffer.from(JSON.stringify(message)+'\n');
      // Split inside UTF-8 sequences as a serial/RFCOMM driver may do.
      for(let i=0;i<data.length;i+=2)this.emit('data',data.subarray(i,i+2));
    }
    info(extra={}){this.inject({type:'deviceInfo',device:'m5stickc-plus2',protocol:'gar-compact-v1',width:135,height:240,
      transport:transport==='spp'?'bluetooth-spp':'usb-serial',activeTransport:transport==='spp'?'bluetooth-spp':'usb-serial',...extra});}
    drain(cb){setImmediate(cb);}
    close(cb=()=>{}){this.isOpen=false;this.emit('close');setImmediate(cb);}
  }
  return {Port,ports};
}
const state=(id='q1')=>({type:'state',session:{id:'s1',name:'長い日本語のセッション'},ui:{id,state:'waiting',message:'日本語の質問です。'.repeat(100),actions:[{id:'yes',label:'YES'},{id:'no',label:'NO'}]}});

test('serial framing preserves split UTF-8 and drops malformed, oversized and truncated lines',()=>{
  const messages=[],lines=new JsonLines(m=>messages.push(m),64),value={message:'実機と通信します'};
  for(const byte of Buffer.from(JSON.stringify(value)+'\r\n'))lines.push([byte]);
  lines.push(Buffer.from('x'.repeat(65)+'{"bad":true}\n'));
  lines.push(Buffer.from([0xff,10]));lines.push(Buffer.from('{broken}\n{"ok":true}\n'));
  assert.deepEqual(messages,[value,{ok:true}]);
  lines.push(Buffer.from('{"old":'));lines.reset();lines.push(Buffer.from('true}\n{"next":true}\n'));
  assert.deepEqual(messages.at(-1),{next:true});
});

test('normalization preserves IDs and refuses invalid or unsupported confirmation gestures',()=>{
  const value=state();assert.deepEqual(compactState(value).ui,value.ui);
  assert.equal(compactState({type:'state',agent:{status:'idle'}},{sessionId:'selected',label:'監視'}).session.id,'selected');
  const hold=state();hold.ui.actions[0].button='A-hold';
  assert.equal(compactState(hold).ui.actions.length,0);
  const duplicate=state();duplicate.ui.actions[1].id='yes';assert.throws(()=>compactState(duplicate));
  const huge=state();huge.ui.message='文'.repeat(3000);assert.throws(()=>compactState(huge));
});

test('real Codex bridge delivers a question and receives exactly one correlated device answer',async()=>{
  const backend=await startCodexBridge({port:0,token,sessionId:'s1',label:'接続試験'});
  const {Port,ports}=fakePorts(),events=[];let clockOffset=0;
  const bridge=startDeviceBridge({SerialPort:Port,WebSocket,url:backend.url,token,port:'FAKE',transport:'spp',
    now:()=>Date.now()+clockOffset,onEvent:e=>events.push(e)});
  const request=async(route,body)=>{
    const response=await fetch(`http://127.0.0.1:${backend.port}${route}`,{method:body===undefined?'GET':'POST',
      headers:{Authorization:`Bearer ${token}`,'Content-Type':'application/json'},...(body===undefined?{}:{body:JSON.stringify(body)})});
    return response.json();
  };
  try {
    const device=await until(()=>ports[0]?.messages.some(m=>m.type==='sessions') && ports[0]);
    assert.equal(JSON.stringify(device.messages).includes(token),false);
    const created=await request('/input-test',{}),uiId=created.test.id;
    await until(()=>device.messages.some(m=>m.sessions?.[0]?.ui?.id===uiId));
    device.inject({type:'uiAction',sessionId:'wrong-session',uiId,actionId:'yes'});
    await until(()=>device.messages.find(m=>m.type==='ack' && m.sessionId==='wrong-session' && !m.ok));
    assert.equal((await request('/input-test')).test.status,'pending');
    const answer={type:'uiAction',sessionId:'s1',uiId,actionId:'yes'};
    device.inject(answer);device.inject(answer);
    await until(()=>device.messages.find(m=>m.type==='ack' && m.sessionId==='s1' && m.uiId===uiId && m.actionId==='yes' && m.ok));
    assert.equal((await request('/input-test')).test.answer,'yes');
    device.inject(answer);await pause(30);
    assert.equal(events.filter(e=>e.event==='answer-sent').length,1);
    assert.equal(JSON.stringify(events).includes(token),false);
    const hellos=device.messages.filter(m=>m.type==='hello').length;
    clockOffset=4500;
    await until(()=>device.messages.filter(m=>m.type==='hello').length>hellos);
    // A reboot loses device ownership; the same open serial port must re-hello.
    const ready=events.filter(e=>e.event==='device-ready').length;
    device.info({activeTransport:'none'});
    await until(()=>events.filter(e=>e.event==='device-ready').length>ready);
  } finally {await bridge.close();await backend.close();}
});

test('timeout, upstream reconnection and serial reconnection never replay an old answer',async()=>{
  const server=new WebSocketServer({host:'127.0.0.1',port:0}),sockets=[],actions=[];
  await new Promise(resolve=>server.once('listening',resolve));
  server.on('connection',socket=>{
    sockets.push(socket);socket.on('message',data=>{
      const message=JSON.parse(String(data));
      if(message.type==='hello'){socket.send(JSON.stringify({type:'ack',ok:true}));socket.send(JSON.stringify(state()));}
      else if(message.type==='uiAction')actions.push(message);
    });
  });
  const {Port,ports}=fakePorts('usb');
  const bridge=startDeviceBridge({SerialPort:Port,WebSocket,url:`ws://127.0.0.1:${server.address().port}`,token,
    port:'FAKE',transport:'usb',retryMs:30,actionTimeoutMs:80});
  try {
    const device=await until(()=>ports[0]?.messages.some(m=>m.type==='sessions') && ports[0]);
    device.inject({type:'uiAction',sessionId:'s1',uiId:'q1',actionId:'no'});
    await until(()=>device.messages.some(m=>m.type==='ack' && m.uiId==='q1' && !m.ok));
    await until(()=>sockets.length>=2 && device.messages.filter(m=>m.type==='sessions').length>=2);
    assert.equal(actions.length,1);assert.ok(device.messages.some(m=>m.type==='goodbye'));
    device.close();
    await until(()=>ports.length===2 && ports[1].messages.some(m=>m.type==='sessions'));
    assert.equal(actions.length,1);
    // Only a new explicit physical choice may submit again.
    ports[1].inject({type:'uiAction',sessionId:'s1',uiId:'q1',actionId:'yes'});
    await until(()=>actions.length===2);assert.equal(actions[1].actionId,'yes');
  } finally {await bridge.close();for(const socket of sockets)socket.terminate();await new Promise(resolve=>server.close(resolve));}
});

test('a different device never receives application state',async()=>{
  const backend=await startCodexBridge({port:0,token});const {Port,ports}=fakePorts('spp',false);
  const bridge=startDeviceBridge({SerialPort:Port,WebSocket,url:backend.url,token,port:'FAKE',transport:'spp'});
  try {
    const device=await until(()=>ports[0]?.messages.some(m=>m.type==='hello') && ports[0]);
    device.info({device:'twatch2020'});
    await until(()=>!device.isOpen);assert.equal(device.messages.some(m=>m.type==='sessions'),false);
  } finally {await bridge.close();await backend.close();}
});
