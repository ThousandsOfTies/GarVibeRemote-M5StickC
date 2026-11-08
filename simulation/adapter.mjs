import '/gar-components/m5stickc-plus2.mjs';
import '/gar-components/controls.mjs';
import '/gar-components/event-log.mjs';
import '/gar-components/connection-status.mjs';
import { JsonTransport } from '/gar-components/json-transport.mjs';

// The browser only displays the PC application's framebuffer and sends test I/O.
// UI, protocol, lease and button logic run together in the Node-hosted C++ app.
const device=document.querySelector('#device'),controls=document.querySelector('#scenarios');
const log=document.querySelector('#log'),answer=document.querySelector('#answer'),debug=document.querySelector('#snapshot');
const screen=document.querySelector('#screen'),context=screen.getContext('2d');
const params=new URLSearchParams(location.search),liveMode=params.get('live')==='1';
const liveConnection=new EventTarget();liveConnection.connected=false;
let frame=-1,eventSequence=0,stopped=false,timer,liveTransport,lastState,queue=Promise.resolve();
controls.label='テスト条件';
controls.schema=[
  {id:'scenario',type:'select',label:'表示する状態',value:'multi',options:[
    {value:'multi',label:'複数セッション · 3件'},
    {value:'long',label:'入力待ち · 長い質問'},{value:'short',label:'入力待ち · 短い質問'},
    {value:'choices',label:'入力待ち · 3つの選択肢'},
    {value:'running',label:'実行中'},{value:'idle',label:'待機中'},
    {value:'done',label:'完了'},{value:'failed',label:'エラー'}]},
  {id:'resend',type:'action',label:'試験データを入れ直す'},
  {id:'start-background',type:'action',label:'別セッションで実行開始'},
  {id:'background',type:'action',label:'別セッションに質問を追加'},
  {id:'transport',type:'select',label:'模擬通信路',value:'usb-serial',options:[
    {value:'usb-serial',label:'USBシリアル'},{value:'bluetooth-spp',label:'Bluetooth SPP'}]},
  {id:'connected',type:'checkbox',label:'模擬PCとの接続',value:true},
  {id:'powered',type:'checkbox',label:'本体の電源',value:true},
  {id:'reject',type:'checkbox',label:'回答の受信エラーを試す',value:false},
];
async function request(url,command) {
  const response=await fetch(url,command?{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(command)}:{cache:'no-store'});
  if(!response.ok)throw Error(`PCシミュレータへの接続に失敗しました (${response.status})`);
  return response.json();
}
function show(state) {
  lastState=state;
  if(device.powered!==state.hardware.powered)device.powered=state.hardware.powered;
  controls.values={...state.hardware,scenario:state.scenario};
  debug.textContent=JSON.stringify({application:state.snapshot,transport:state.hardware.transport,metrics:state.metrics,elapsedMs:state.elapsedMs},null,2);
  answer.textContent=state.result;
  screen.setAttribute('aria-label',state.snapshot.label||'VibeRemote screen');
  if(state.events.at(-1)?.sequence<eventSequence)eventSequence=0;
  for(const item of state.events)if(item.sequence>eventSequence){log.append(item.text);eventSequence=item.sequence;}
  if(liveConnection.connected!==state.liveConnected){
    liveConnection.connected=state.liveConnected;
    liveConnection.dispatchEvent(new CustomEvent('connection',{detail:{connected:state.liveConnected}}));
  }
}
function control(command) {
  // Preserve down/up ordering even when HTTP responses arrive at different times.
  queue=queue.then(()=>request('/api/control',command)).then(show).catch(error=>{
    answer.textContent='PCシミュレータとの接続が切れました。GARで起動状態を確認してください。';log.append(String(error));
  });
  return queue;
}
async function poll() {
  try {
    const state=await request('/api/state');
    show(state);
    if(state.frame!==frame) {
      const response=await fetch('/api/frame',{cache:'no-store'});
      if(!response.ok)throw Error('画面を取得できませんでした');
      const bytes=new Uint8ClampedArray(await response.arrayBuffer());
      if(bytes.length!==state.width*state.height*4)throw Error('画面のサイズが一致しません');
      if(screen.width!==state.width)screen.width=state.width;
      if(screen.height!==state.height)screen.height=state.height;
      context.putImageData(new ImageData(bytes,state.width,state.height),0,0);frame=state.frame;
    }
  } catch(error) {
    answer.textContent='PCシミュレータとの接続が切れました。GARで起動状態を確認してください。';
    frame=-1;
  } finally {if(!stopped)timer=setTimeout(poll,100);}
}
function startLive() {
  document.querySelector('#scenario-panel').hidden=true;
  document.querySelector('#live-panel').hidden=false;
  document.querySelector('#mode-label').textContent='Codex 本番データ · PCアプリ';
  document.querySelector('#intro').textContent='実機と共通のアプリ本体をPCで動かし、本番データを閲覧します。';
  document.querySelector('#a-guide').textContent='一覧で決定';
  document.querySelector('#live-status').source=liveConnection;
  document.querySelector('#result-heading').textContent='本番表示';
  document.querySelector('.result .section-label').textContent='STATUS';
  document.querySelector('#answer-note').textContent='Bでセッション一覧を確認できます。YES／NOの回答は実機から行ってください。';
  const port=Number(params.get('livePort')||8775);
  if(!Number.isInteger(port)||port<1||port>65535)throw Error('Invalid live feed port');
  liveTransport=new JsonTransport({url:`ws://127.0.0.1:${port}/state`});
  liveTransport.addEventListener('connection',({detail})=>{if(!detail.connected)control({type:'live',connected:false});});
  liveTransport.addEventListener('message',({detail})=>{
    if(detail.type==='connection')control({type:'live',connected:detail.connected===true});
    else if(detail.type==='sessions'&&Array.isArray(detail.sessions))control({type:'live',connected:true,sessions:detail.sessions});
  });
  liveTransport.connect();
}
device.addEventListener('gar-button',({detail})=>control({type:'button',button:detail.button,phase:detail.phase}));
controls.addEventListener('gar-control',({detail})=>{
  if(detail.id==='scenario'||detail.id==='resend')control({type:'scenario',name:controls.values.scenario});
  else if(detail.id==='background'||detail.id==='start-background')control({type:'background',status:detail.id==='start-background'?'running':'waiting'});
  else control({type:'hardware',...controls.values});
});
window.addEventListener('pagehide',()=>{stopped=true;clearTimeout(timer);liveTransport?.close();},{once:true});
window.vibeSimulator=Object.freeze({snapshot:()=>structuredClone(lastState?.snapshot)});
control({type:'mode',mode:liveMode?'live':'demo'}).then(()=>{if(liveMode)startLive();return poll();});
