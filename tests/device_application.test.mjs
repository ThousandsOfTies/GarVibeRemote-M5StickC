import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import createApplication from '../simulation/runtime/lvgl-ui.mjs';

const wasmBinary=await readFile(new URL('../simulation/runtime/lvgl-ui.wasm',import.meta.url));
const usb=1,spp=2;
const question=(id='a',uiId='q-a')=>({
  type:'state',session:{id,name:`セッション ${id}`},
  ui:{id:uiId,state:'waiting',message:'PCから届いた質問です。Cで選びAで回答してください。',
    actions:[{id:'yes',label:'YES',button:'A'},{id:'no',label:'NO',button:'B'}]},
});

async function application() {
  const module=await createApplication({wasmBinary});module._gar_lv_init();module._gar_app_init();
  const read=name=>{
    const pointer=module[`_gar_app_${name}`](),value=module.UTF8ToString(pointer);
    return value?JSON.parse(value):null;
  };
  return {
    module,state:()=>read('snapshot'),
    output() {const all=[];for(let item;(item=read('take_output'));)all.push(item);return all;},
    packets() {return this.output().filter(x=>x.data).map(x=>({transport:x.transport,...JSON.parse(x.data)}));},
    feed(link,bytes) {this.feedBytes(link,Buffer.from(bytes,'utf8'));},
    feedBytes(link,bytes) {
      const pointer=module._malloc(bytes.length);
      try {module.HEAPU8.set(bytes,pointer);module._gar_app_feed_bytes(link,pointer,bytes.length);}
      finally {module._free(pointer);}
    },
    receive(link,packet) {this.feed(link,`${JSON.stringify(packet)}\n`);},
    tick(ms=0) {module._gar_app_tick(ms);},
    edge(key,phase) {module._gar_app_button(key.charCodeAt(0),phase);},
    press(key) {this.edge(key,1);this.tick(40);this.edge(key,0);this.tick();},
    hardware(powered=true,battery=82,ready=true,client=true) {
      module._gar_app_hardware(+powered,battery,+ready,+client);
    },
    hello(link=usb) {this.receive(link,{type:'hello'});},
  };
}

test('shared runtime requires hello, allows read-only snapshot, and arbitrates USB/SPP ownership',async()=>{
  const a=await application();assert.equal(a.packets()[0].type,'deviceInfo');
  assert.equal(a.state().activeTransport,'none');assert.equal(a.state().connected,false);
  a.receive(usb,question());assert.equal(a.state().sessionId,'connection');
  a.receive(usb,{type:'snapshot'});assert.equal(a.packets()[0].activeTransport,'none');
  assert.equal(a.state().activeTransport,'none');
  a.hello();assert.equal(a.packets()[0].device,'m5stickc-plus2');
  a.hardware();a.hello(spp);
  assert.deepEqual(a.packets().map(x=>[x.type,x.activeTransport]),[['busy','usb-serial']]);
  a.receive(spp,question('unauthorized'));assert.equal(a.state().sessionId,'connection');
  a.receive(usb,question());assert.equal(a.state().sessionId,'a');
  a.receive(spp,{type:'snapshot'});const snapshot=a.packets()[0];
  assert.equal(snapshot.transport,'bluetooth-spp');assert.equal(snapshot.sessionId,'a');
  assert.equal(snapshot.activeTransport,'usb-serial');
});

test('JSONL framing survives fragmented/multiple packets and recovers from oversized frames',async()=>{
  const a=await application();a.output();
  a.feed(usb,'{"type":"he');assert.equal(a.state().activeTransport,'none');
  a.feed(usb,'llo"}\r\n');assert.equal(a.packets()[0].type,'deviceInfo');
  const q=question();a.feed(usb,`${JSON.stringify(q)}\n{"type":"snapshot"}\n`);
  assert.equal(a.packets()[0].sessionId,'a');
  a.feed(usb,`${'x'.repeat(65537)}\n${JSON.stringify(question('after-overflow'))}\n`);
  assert.ok(a.state().sessions.some(x=>x.id==='after-overflow'));
  assert.ok(!a.state().sessions.some(x=>x.id==='x'));
});

test('byte-stream ABI preserves fragmented UTF-8 and recovers after embedded NUL bytes',async()=>{
  const a=await application();a.output();
  a.feedBytes(usb,Buffer.from('invalid\0bytes\n{"type":"hello"}\n'));
  assert.equal(a.packets()[0].type,'deviceInfo');
  const packet=Buffer.from(`${JSON.stringify(question())}\n`),split=packet.indexOf(Buffer.from('セッション'))+1;
  a.feedBytes(usb,packet.subarray(0,split));assert.equal(a.state().sessionId,'connection');
  a.feedBytes(usb,packet.subarray(split));
  assert.equal(a.state().session,'セッション a');assert.match(a.state().message,/PCから届いた質問/);
});

test('lease uses the shared clock, accepts only owner heartbeats, and clears unanswered actions on expiry',async()=>{
  const a=await application();a.output();a.hardware();a.hello();a.output();a.receive(usb,question());
  a.press('A');assert.equal(a.state().pending,'no');a.output();
  a.tick(4000);a.receive(spp,{type:'ping'});a.tick(3960);
  assert.equal(a.state().activeTransport,'usb-serial');
  a.tick(41);assert.equal(a.state().activeTransport,'none');
  assert.equal(a.state().pending,'');assert.equal(a.state().connected,false);
  assert.match(a.state().error,/接続/);
  a.hello(spp);assert.equal(a.packets().at(-1).activeTransport,'bluetooth-spp');
  a.tick();assert.equal(a.packets().filter(x=>x.type==='uiAction').length,0);
});

test('physical button path emits one identity-preserving action and only matching acknowledgements complete it',async()=>{
  const a=await application();a.output();a.hello();a.output();a.receive(usb,question());
  a.press('C');assert.equal(a.state().choice,0);a.press('A');
  const packets=a.packets(),actions=packets.filter(x=>x.type==='uiAction');
  assert.deepEqual(actions,[{transport:'usb-serial',type:'uiAction',sessionId:'a',uiId:'q-a',actionId:'yes',button:'A',source:'m5stickc-plus2-usb'}]);
  assert.ok(packets.some(x=>x.type==='button' && x.phase==='down'));
  a.receive(usb,{type:'ack',sessionId:'a',uiId:'old-question',actionId:'yes',ok:true});
  assert.equal(a.state().acknowledged,false);
  a.receive(usb,{type:'ack',sessionId:'a',uiId:'q-a',actionId:'yes',ok:true});
  assert.equal(a.state().acknowledged,true);
  a.press('A');assert.equal(a.packets().filter(x=>x.type==='uiAction').length,0);
});

test('SPP epoch and overflow discard partial frames, release ownership, and retain transport source',async()=>{
  const a=await application();a.output();a.hardware();a.hello(spp);a.output();
  a.feed(spp,'{"type":"state","session":');
  a.module._gar_app_transport_reset(spp,0);
  assert.equal(a.state().activeTransport,'none');
  a.feed(spp,'{"id":"broken"}}\n');a.hello(spp);a.output();
  a.feed(spp,'{"type":"state",');a.module._gar_app_transport_reset(spp,1);
  a.feed(spp,'"session":{"id":"bad"}}\n');a.receive(spp,question('spp'));
  assert.equal(a.state().sessionId,'spp');a.press('A');
  assert.equal(a.packets().find(x=>x.type==='uiAction').source,'m5stickc-plus2-spp');
  a.hardware(true,50,true,false);assert.equal(a.state().activeTransport,'none');
  assert.equal(a.state().connected,false);
});

test('pairing requires explicit C/A consent, blocks controllers while active, and never emits an application answer',async()=>{
  const a=await application();a.output();a.module._gar_app_pairing(123456);a.tick();
  assert.equal(a.state().sessionId,'bluetooth-pairing');assert.match(a.state().message,/123456/);
  a.hello();assert.equal(a.packets()[0].activeTransport,'pairing');
  a.press('C');a.press('A');
  assert.deepEqual(a.output(),[{type:'pairing-confirm',accepted:true}]);
  assert.equal(a.state().pairingState,'verifying');
  a.module._gar_app_authenticated(1);assert.equal(a.state().pairingState,'paired');
  a.hello();const info=a.packets()[0];
  assert.equal(info.authenticationAttempts,1);assert.equal(info.lastAuthentication,'success');
  assert.equal(info.activeTransport,'usb-serial');
});

test('pairing rejection/timeout and an occupied controller cannot become consent',async()=>{
  const a=await application();a.output();a.hello();a.output();
  a.module._gar_app_pairing(111111);
  assert.deepEqual(a.output(),[{type:'pairing-confirm',accepted:false}]);
  assert.equal(a.state().sessionId,'connection');
  a.receive(usb,{type:'goodbye'});a.module._gar_app_pairing(222222);a.tick(29999);
  assert.equal(a.state().pairingState,'confirming');a.tick(1);
  assert.equal(a.state().pairingState,'expired');
  assert.deepEqual(a.output(),[{type:'pairing-confirm',accepted:false}]);
  a.press('A');assert.deepEqual(a.output(),[]);
});

test('shared runtime renders the real LVGL framebuffer and routes list selection without generating answers',async()=>{
  const a=await application();a.output();a.hello();a.output();
  a.receive(usb,{type:'sessions',sessions:[question('a'),question('b')]});
  a.press('B');a.press('C');a.press('A');
  assert.equal(a.state().sessionId,'b');assert.equal(a.state().listOpen,false);
  assert.equal(a.packets().filter(x=>x.type==='uiAction').length,0);a.tick(50);
  const m=a.module,start=m._gar_lv_framebuffer(),pixels=m.HEAPU8.subarray(start,start+135*240*4);
  assert.equal(m._gar_lv_width(),135);assert.equal(m._gar_lv_height(),240);
  assert.ok(new Set(pixels).size>5);
  a.press('A');assert.equal(a.packets().find(x=>x.type==='uiAction').sessionId,'b');
});
