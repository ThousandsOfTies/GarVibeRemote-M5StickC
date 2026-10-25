import '/gar-components/m5stickc-plus2.mjs';
import '/gar-components/controls.mjs';
import '/gar-components/event-log.mjs';
import '/gar-components/connection-status.mjs';
import { LvglSurface } from '/gar-components/lvgl-surface.mjs';
import { JsonTransport } from '/gar-components/json-transport.mjs';

const device = document.querySelector('#device');
const controls = document.querySelector('#scenarios');
const log = document.querySelector('#log');
const answer = document.querySelector('#answer');
const debug = document.querySelector('#snapshot');
const states = new Map(), receipts = new Map();
const params=new URLSearchParams(location.search),liveMode=params.get('live')==='1';
const liveConnection=new EventTarget();liveConnection.connected=false;
let liveTransport;
const longQuestion = '画面の変更とテストが完了しました。修正した内容を確認してから、次の作業へ進めてもよいですか？本文はゆっくり自動スクロールします。読み終えたらCでYESまたはNOにフォーカスを合わせ、Aで決定してください。ほかのセッションを確認するときはBで一覧を開き、Cで順番に選び、Aで切り替えます。今回は接続試験なので、PCのファイルや設定は変更しません。';
const yesNo = [{id:'yes',label:'YES',button:'A'}, {id:'no',label:'NO',button:'B'}];
const choices = [{id:'continue',label:'続ける',button:'A'}, {id:'revise',label:'修正する',button:'B'}, {id:'stop',label:'中止する',button:'C'}];
let serial = 0, ui;
controls.label = 'テスト条件';
controls.schema = [
  { id:'scenario', type:'select', label:'表示する状態', value:'multi', options:[
    {value:'multi',label:'複数セッション · 3件'},
    {value:'long',label:'入力待ち · 長い質問'}, {value:'short',label:'入力待ち · 短い質問'},
    {value:'choices',label:'入力待ち · 3つの選択肢'},
    {value:'running',label:'実行中'}, {value:'idle',label:'待機中'},
    {value:'done',label:'完了'}, {value:'failed',label:'エラー'}]},
  { id:'resend', type:'action', label:'試験データを入れ直す' },
  { id:'background', type:'action', label:'別セッションに質問を追加' },
  { id:'connected', type:'checkbox', label:'模擬PCとの接続', value:true },
  { id:'powered', type:'checkbox', label:'本体の電源', value:true },
  { id:'reject', type:'checkbox', label:'回答の受信エラーを試す', value:false },
];
function receive(message) {
  ui.receive(message);
  log.append(`${liveMode?'Codex':'模擬PC'} → 本体：${message.type}${message.session ? ` / ${message.session.name}` : ''}`);
}
function acknowledge(receipt) {
  const { sessionId, uiId, actionId } = receipt;
  if (states.get(sessionId)?.ui.id !== uiId) { receipts.delete(receipt.key); return; }
  if (!controls.values.powered || !controls.values.connected) return;
  ui.receive({type:'ack',sessionId,uiId,actionId,ok:!receipt.reject});
  answer.textContent = receipt.reject ? `${receipt.name}：受信エラー。選び直して再送できます。` : `${receipt.name}：${receipt.label} を受信・確認しました`;
  log.append(`模擬PC → 本体：${receipt.reject ? '受信エラー' : '受信確認'} / ${sessionId} / ${uiId}`);
  receipts.delete(receipt.key);
}
function hardware() {
  const { powered } = controls.values;
  const connected=liveMode?liveConnection.connected:controls.values.connected;
  device.powered = powered;
  ui.hardware({ powered, connected, battery:82 });
  ui.element.inert = true;
  for (const receipt of receipts.values()) if (receipt.ready) acknowledge(receipt);
}
function liveConnected(connected) {
  if(liveConnection.connected===connected)return;
  liveConnection.connected=connected;
  liveConnection.dispatchEvent(new CustomEvent('connection',{detail:{connected}}));hardware();
}
function startLive() {
  document.querySelector('#scenario-panel').hidden=true;
  document.querySelector('#live-panel').hidden=false;
  document.querySelector('#mode-label').textContent='Codex 本番データ';
  document.querySelector('#intro').textContent='実機と同じCodexの状態を表示します。';
  document.querySelector('#a-guide').textContent='一覧で決定';
  document.querySelector('#live-status').source=liveConnection;
  document.querySelector('#result-heading').textContent='本番表示';
  document.querySelector('.result .section-label').textContent='STATUS';
  document.querySelector('#answer-note').textContent='Bでセッション一覧を確認できます。YES／NOの回答は実機から行ってください。';
  answer.textContent='本番データの接続を待っています。';
  const port=Number(params.get('livePort') || 8775);
  if(!Number.isInteger(port) || port<1 || port>65535)throw Error('Invalid live feed port');
  // Fixed loopback destination; no credential or remote endpoint in the page.
  liveTransport=new JsonTransport({url:`ws://127.0.0.1:${port}/state`});
  liveTransport.addEventListener('connection',({detail})=>{
    if(!detail.connected){liveConnected(false);answer.textContent='本番データとの接続が切れました。再接続を待っています。';}
  });
  liveTransport.addEventListener('message',({detail})=>{
    if(detail.type==='connection') {
      liveConnected(detail.connected===true);
      if(!detail.connected)answer.textContent='PCブリッジとの接続を待っています。';
    } else if(detail.type==='sessions' && Array.isArray(detail.sessions)) {
      states.clear();for(const entry of detail.sessions)states.set(entry.session.id,entry);
      liveConnected(true);receive(detail);
      answer.textContent='実機と同じCodexの状態を表示しています。';
    }
  });
  liveTransport.connect();
}
function state(id, name, status, message, actions = []) {
  return {type:'state',session:{id,name},agent:{status,message},
    ui:{id:`local-${++serial}`,state:status,message,actions}};
}
function scenario(name) {
  for (const receipt of receipts.values()) clearTimeout(receipt.timer);
  receipts.clear(); states.clear();
  let examples;
  if (name === 'multi') examples = [
    state('screen','画面の改善','waiting',longQuestion,yesNo),
    state('notes','調査メモ','running','通信方式について調査しています。資料を確認し、結果をまとめています。'),
    state('release','公開の確認','waiting','確認用の成果物を公開してもよいですか？この質問も模擬試験です。',yesNo),
  ];
  else {
    const waiting = ['long','short','choices'].includes(name);
    const messages = {
      long:longQuestion, short:'次の作業へ進めてもよいですか？',
      choices:'テスト結果を確認しました。この後の進め方を選んでください。',
      running:'画面の実装を進めています。完了したら結果をお知らせします。',
      idle:'次の指示を待っています。',done:'変更が完了しました。テストはすべて成功しました。',
      failed:'接続先から応答がありません。PC側の状態を確認してください。',
    };
    examples = [state('screen','画面の改善',waiting ? 'waiting' : name,messages[name],waiting ? name === 'choices' ? choices : yesNo : [])];
  }
  for (const example of examples) states.set(example.session.id,example);
  receive({type:'sessions',sessions:examples});
  answer.textContent = 'まだ回答していません';
}
function backgroundQuestion() {
  const selected = ui.snapshot.sessionId;
  const target = [...states.keys()].find(id => id !== selected) || 'background';
  const previous = states.get(target);
  const example = state(target,previous?.session.name || '別の作業','waiting',
    '別のセッションから確認が届きました。この後の進め方を選んでください。',choices);
  states.set(target,example); receive(example);
}
async function start() {
  const { default:createUi } = await import('./runtime/lvgl-ui.mjs');
  const module = await createUi();
  const read = name => {
    const pointer = module[`_gar_app_${name}`]();
    const json = module.UTF8ToString(pointer); return json ? JSON.parse(json) : null;
  };
  const adapter = {
    init:() => module._gar_app_init(),
    receive:message => module.ccall('gar_app_receive','number',['string'],[JSON.stringify(message)]),
    refresh:() => { module._gar_app_refresh(); return read('snapshot'); },
    takeAction:() => read('take_action'),
    hardware:({powered,connected,battery}) => module._gar_app_hardware(+powered,+connected,battery),
  };
  // The LCD is passive. Only physical button edges reach the C++ application.
  ui = new LvglSurface(module,document.querySelector('#screen'),{adapter});
  ui.element.inert = true;
  ui.addEventListener('action',({detail}) => {
    if(liveMode)return; // The feed never sends browser answers upstream.
    const source = states.get(detail.sessionId);
    const action = source?.ui.actions.find(action => action.id === detail.actionId);
    if (!source || source.ui.id !== detail.uiId || !action) { log.append('期限切れの回答を破棄しました'); return; }
    log.append(`本体 → 模擬PC：${JSON.stringify(detail)}`);
    answer.textContent = `${source.session.name}：${action.label} を受信しました`;
    const key = JSON.stringify([detail.sessionId,detail.uiId,detail.actionId]);
    const receipt = {...detail,key,name:source.session.name,label:action.label,reject:controls.values.reject,ready:false};
    receipt.timer = setTimeout(() => { receipt.ready = true; acknowledge(receipt); },500);
    receipts.set(key,receipt);
  });
  device.addEventListener('gar-button',({detail}) => {
    const {button,phase,durationMs} = detail;ui.advanceClock();
    if(liveMode && button==='A' && !ui.snapshot.listOpen) {
      if(phase==='up')answer.textContent='この画面は閲覧用です。回答は実機から行ってください。';
      return;
    }
    if (button === 'C' && phase === 'up' && durationMs >= (device.powered ? 6000 : 2000)) {
      controls.values = {powered:!device.powered};hardware();
    } else {
      module._gar_app_button(button.charCodeAt(0),phase === 'down' ? 1 : phase === 'up' ? 0 : -1);ui.update();
    }
    log.append(`${button} / ${phase}${durationMs ? ` / ${durationMs}ms` : ''}`);
  });
  controls.addEventListener('gar-control',({detail}) => {
    if (detail.id === 'scenario' || detail.id === 'resend') scenario(controls.values.scenario);
    if (detail.id === 'background') backgroundQuestion();
    if (detail.id === 'connected' || detail.id === 'powered') hardware();
  });
  hardware();if(liveMode)startLive();else scenario('multi');
  const timer = setInterval(() => {
    debug.textContent = JSON.stringify(ui.snapshot,null,2);
    document.querySelector('#screen').setAttribute('aria-label',ui.snapshot.label);
  },150);
  window.addEventListener('pagehide',() => {
    clearInterval(timer);liveTransport?.close();for (const receipt of receipts.values()) clearTimeout(receipt.timer);ui.destroy();
  },{once:true});
  window.vibeSimulator = Object.freeze({snapshot:() => structuredClone(ui.snapshot)});
}
start().catch(error => {
  answer.textContent = '画面を起動できませんでした。READMEのビルド手順を確認してください。';
  log.append(String(error));console.error(error);
});
