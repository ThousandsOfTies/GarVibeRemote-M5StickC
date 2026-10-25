import '/gar-components/m5stickc-plus2.mjs';
import '/gar-components/controls.mjs';
import '/gar-components/event-log.mjs';
import { LvglSurface } from '/gar-components/lvgl-surface.mjs';

const device = document.querySelector('#device');
const controls = document.querySelector('#scenarios');
const log = document.querySelector('#log');
const answer = document.querySelector('#answer');
const debug = document.querySelector('#snapshot');
const longQuestion = '画面の変更とテストが完了しました。修正した内容を確認してから、次の作業へ進めてもよいですか？変更点は、実行状態を枠の色で見分けられること、長い質問をボタンでページ送りできること、YESとNOを選んでから長押しで回答できることです。まずは本文を最後まで読み、回答画面で希望する項目を選んでください。今回は接続試験なので、PCのファイルや設定は変更しません。';
let serial = 0, ui, current, acknowledgeTimer;
controls.label = 'テスト条件';
controls.schema = [
  { id:'scenario', type:'select', label:'表示する状態', value:'long', options:[
    {value:'long',label:'入力待ち · 長い質問'}, {value:'short',label:'入力待ち · 短い質問'},
    {value:'running',label:'実行中'}, {value:'idle',label:'待機中'},
    {value:'done',label:'完了'}, {value:'failed',label:'エラー'}]},
  { id:'resend', type:'action', label:'質問を最初からやり直す' },
  { id:'connected', type:'checkbox', label:'模擬PCとの接続', value:true },
  { id:'powered', type:'checkbox', label:'本体の電源', value:true },
  { id:'reject', type:'checkbox', label:'回答の受信エラーを試す', value:false },
];
function hardware() {
  const { powered, connected } = controls.values;
  device.powered = powered;
  ui.hardware({ powered, connected, battery:82 });
}
function scenario(name) {
  clearTimeout(acknowledgeTimer);
  const waiting = name === 'long' || name === 'short';
  const state = waiting ? 'waiting' : name;
  const messages = {
    long:longQuestion, short:'次の作業へ進めてもよいですか？',
    running:'画面の実装を進めています。完了したら結果をお知らせします。',
    idle:'次の指示を待っています。', done:'変更が完了しました。テストはすべて成功しました。',
    failed:'接続先から応答がありません。PC側の状態を確認してください。',
  };
  current = {
    type:'state', session:{id:'local-test', name:'M5StickC画面の改善'},
    agent:{status:state, message:messages[name]},
    ui:{id:`local-${++serial}`, state, message:messages[name], actions:waiting ? [
      {id:'yes', label:'YES', button:'A'}, {id:'no', label:'NO', button:'B'},
    ] : []},
  };
  ui.receive(current);
  answer.textContent = 'まだ回答していません';
  log.append(`模擬PC → 本体：${name} / ${current.ui.id}`);
}
async function start() {
  const { default:createUi } = await import('./runtime/lvgl-ui.mjs');
  const module = await createUi();
  const read = name => {
    const ptr = module[`_gar_app_${name}`]();
    const json = module.UTF8ToString(ptr); return json ? JSON.parse(json) : null;
  };
  const adapter = {
    init:() => module._gar_app_init(),
    receive:message => module.ccall('gar_app_receive','number',['string'],[JSON.stringify(message)]),
    refresh:() => { module._gar_app_refresh(); return read('snapshot'); },
    takeAction:() => read('take_action'),
    hardware:({powered,connected,battery}) => module._gar_app_hardware(+powered,+connected,battery),
  };
  // Passive canvas: there is deliberately no LCD touch path to the application.
  ui = new LvglSurface(module, document.querySelector('#screen'), { adapter });
  ui.element.inert = true;
  ui.addEventListener('action', ({detail}) => {
    log.append(`本体 → 模擬PC：${JSON.stringify(detail)}`);
    answer.textContent = `${detail.actionId.toUpperCase()} を受信しました\n${detail.uiId}`;
    const reject = controls.values.reject;
    acknowledgeTimer = setTimeout(() => {
      if (!controls.values.connected || !controls.values.powered || current.ui.id !== detail.uiId) return;
      const ack = {type:'ack', uiId:detail.uiId, actionId:detail.actionId, ok:!reject};
      if (reject) ack.error = '受信エラー。再確認してください';
      ui.receive(ack);
      answer.textContent = reject ? '模擬PCが回答を拒否しました。再度選択・確定できます。' : `${detail.actionId.toUpperCase()} を受信・確認しました`;
      log.append(`模擬PC → 本体：${reject?'受信エラー':'受信確認'}`);
    }, 500);
  });
  device.addEventListener('gar-button', ({detail}) => {
    const {button,phase,durationMs} = detail;
    ui.advanceClock();
    if (button==='C' && phase==='up' && durationMs >= (device.powered ? 6000 : 2000)) {
      controls.values = {powered:!device.powered}; hardware();
    } else {
      module._gar_app_button(button.charCodeAt(0), phase==='down'?1:phase==='up'?0:-1);
      ui.update();
    }
    log.append(`${button} / ${phase}${durationMs ? ` / ${durationMs}ms` : ''}`);
  });
  controls.addEventListener('gar-control', ({detail}) => {
    if (detail.id === 'scenario' || detail.id === 'resend') scenario(controls.values.scenario);
    if (detail.id === 'connected' || detail.id === 'powered') { hardware(); ui.element.inert=true; }
  });
  hardware(); ui.element.inert=true; scenario('long');
  const timer = setInterval(() => {
    debug.textContent = JSON.stringify(ui.snapshot,null,2);
    // Text alternative for the pixel display, using the application's real state.
    document.querySelector('#screen').setAttribute('aria-label', ui.snapshot.label);
  }, 150);
  window.addEventListener('pagehide', () => { clearInterval(timer);clearTimeout(acknowledgeTimer);ui.destroy(); }, {once:true});
  // Read-only diagnostics, available to a developer without shadow-DOM access.
  window.vibeSimulator = Object.freeze({ snapshot:() => structuredClone(ui.snapshot) });
}
start().catch(error => {
  answer.textContent = '画面を起動できませんでした。READMEのビルド手順を確認してください。';
  log.append(String(error)); console.error(error);
});
