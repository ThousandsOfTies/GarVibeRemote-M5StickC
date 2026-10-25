import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import createUi from '../simulation/runtime/lvgl-ui.mjs';
const wasmBinary = await readFile(new URL('../simulation/runtime/lvgl-ui.wasm', import.meta.url));
async function app() {
  const m=await createUi({wasmBinary});m._gar_lv_init();m._gar_app_init();
  const read=name=>{const p=m[`_gar_app_${name}`]();const v=m.UTF8ToString(p);return v?JSON.parse(v):null;};
  return {
    m, state:()=>read('snapshot'), action:()=>read('take_action'),
    receive:d=>m.ccall('gar_app_receive','number',['string'],[JSON.stringify(d)]),
    tick:ms=>{m._gar_lv_tick(ms);m._gar_app_refresh();},
    edge:(key,phase)=>m._gar_app_button(key.charCodeAt(0),phase),
    press(key,ms=40){this.edge(key,1);this.tick(ms);this.edge(key,0);},
    answers(){while(this.state().page+1<this.state().pages)this.press('A');this.press('A');},
  };
}
const question=(id='q1',message='次の作業へ進めますか？')=>({type:'state',session:{id:'s1',name:'画面テスト'},ui:{id,state:'waiting',message,actions:[{id:'yes',label:'YES',button:'A'},{id:'no',label:'NO',button:'B'}]}});
test('native 240×135 LVGL framebuffer and UTF-8 pagination preserve every character',async()=>{
  const a=await app();assert.equal(a.m._gar_lv_width(),240);assert.equal(a.m._gar_lv_height(),135);
  const message='日本語の長い質問を表示します。画面を読みながらページ送りし、YESかNOを選択してください。'.repeat(8);
  a.receive(question('long',message));assert.ok(a.state().pages>3);let result='';
  for(let i=0;i<a.state().pages;i++){result+=a.state().displayMessage.replaceAll('\n','');if(i+1<a.state().pages)a.press('A');}
  assert.equal(result,message);a.tick(30);
  const pixels=a.m.HEAPU8.slice(a.m._gar_lv_framebuffer(),a.m._gar_lv_framebuffer()+240*135*4);
  assert.ok(new Set(pixels).size>5); // Actual rendered pixels, not only a model snapshot.
});
test('safe default, short press, long hold, one outgoing response and matching acknowledgement',async()=>{
  const a=await app();a.receive(question());a.answers();assert.equal(a.state().choice,1);
  a.press('B',899);assert.equal(a.action(),null);a.press('A');assert.equal(a.state().choice,0);
  a.press('B',900);assert.deepEqual(a.action(),{type:'uiAction',uiId:'q1',actionId:'yes',button:'A'});
  a.press('B',1000);assert.equal(a.action(),null);
  assert.equal(a.receive({type:'ack',uiId:'old',actionId:'yes',ok:true}),0);
  a.receive({type:'ack',uiId:'q1',actionId:'yes',ok:true});assert.equal(a.state().acknowledged,true);
});
test('same state preserves page; changed question invalidates an in-progress hold',async()=>{
  const a=await app(),q=question('q1','ページ送りを確認する長い質問です。'.repeat(12));a.receive(q);a.press('A');
  const page=a.state().page;a.receive(q);assert.equal(a.state().page,page);
  a.answers();a.edge('B',1);a.tick(1000);a.receive(question('q2'));a.edge('B',0);
  assert.equal(a.action(),null);assert.equal(a.state().page,0);assert.equal(a.state().answering,false);
});
test('cancel, disconnect and power-off never complete a held answer',async()=>{
  for(const kind of ['cancel','disconnect','power']){
    const a=await app();a.receive(question());a.answers();a.edge('B',1);a.tick(1000);
    if(kind==='cancel')a.edge('B',-1);else a.m._gar_app_hardware(kind==='power'?0:1,kind==='disconnect'?0:1,82);
    a.edge('B',0);assert.equal(a.action(),null,kind);
  }
});
test('rejected response can be retried; idle, done and running never offer answers',async()=>{
  const a=await app();a.receive(question());a.answers();a.press('B',1000);a.action();
  a.receive({type:'ack',uiId:'q1',actionId:'no',ok:false,error:'Retry'});assert.equal(a.state().pending,'');
  a.press('B',1000);assert.equal(a.action().actionId,'no');
  for(const state of ['idle','done','running','failed']){
    a.receive({type:'state',session:{id:'s1'},ui:{id:state,state,message:'状態確認',actions:[]}});
    a.press('A');a.press('B',1000);assert.equal(a.state().answering,false);assert.equal(a.action(),null);
  }
});
test('instances have independent state and button input',async()=>{
  const a=await app(),b=await app();a.receive(question('first'));b.receive(question('second'));a.answers();a.press('B',1000);
  assert.equal(a.action().uiId,'first');assert.equal(b.action(),null);assert.equal(b.state().answering,false);
});
