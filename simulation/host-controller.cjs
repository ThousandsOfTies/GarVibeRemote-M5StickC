// Product scenarios are a synthetic PC peer, never a native-chat reply service.
const longQuestion = '画面の変更とテストが完了しました。修正した内容を確認してから、次の作業へ進めてもよいですか？本文はゆっくり自動スクロールします。読み終えたらCでYESまたはNOにフォーカスを合わせ、Aで決定してください。ほかのセッションを確認するときはBで一覧を開き、Cで順番に選び、Aで切り替えます。今回は接続試験なので、PCのファイルや設定は変更しません。';
const yesNo = [{id:'yes',label:'YES'}, {id:'no',label:'NO'}];
const choices = [{id:'continue',label:'続ける'}, {id:'revise',label:'修正する'}, {id:'stop',label:'中止する'}];
const scenarioNames = new Set(['multi','long','short','choices','running','idle','done','failed']);
const links = {'usb-serial':1,'bluetooth-spp':2};

function createSimulationController(module, options={}) {
  let now=0, serial=0, lastPing=0, mode='demo', scenarioName='multi', transport='usb-serial';
  let powered=true, connected=true, reject=false, battery=82, liveConnected=false;
  let result='まだ回答していません', powerDownAt=null, powerWasOn=false;
  const states=new Map(), receipts=new Map(), events=[];
  const metrics={incomingPackets:0,outgoingPackets:0,syntheticReplies:0,acknowledgements:0,droppedReplies:0};
  const read=name=>{const ptr=module[`_gar_app_${name}`]();const value=module.UTF8ToString(ptr);return value?JSON.parse(value):null;};
  const event=text=>{events.push({sequence:(events.at(-1)?.sequence??0)+1,text});if(events.length>60)events.shift();};
  const active=()=>powered && connected && (mode==='demo' || liveConnected);
  function wire(link, bytes) {
    const encoded=Buffer.from(bytes,'utf8');
    const pointer=module._malloc(Math.max(1,encoded.length));
    if(!pointer)throw Error('Application receive buffer could not be allocated');
    try {
      module.HEAPU8.set(encoded,pointer);
      module._gar_app_feed_bytes(links[link],pointer,encoded.length);
    } finally {module._free(pointer);}
  }
  function send(packet, link=transport) {
    if(!active())return;
    wire(link,JSON.stringify(packet)+'\n');metrics.incomingPackets++;
    event(`模擬PC → 本体 / ${link}：${packet.type}`);
  }
  function hardware() {
    module._gar_app_hardware(+powered,battery,1,+(transport==='bluetooth-spp'&&active()));
  }
  function connect() {
    hardware();
    if(active()) {
      send({type:'hello'});lastPing=now;
      send({type:'sessions',sessions:[...states.values()]});
    }
  }
  function disconnect() {
    // Model the transport epoch reset, not a direct UI connection flag.
    module._gar_app_transport_reset(1,0);module._gar_app_transport_reset(2,0);
    hardware();
  }
  function state(id,name,status,message,actions=[]) {
    return {type:'state',session:{id,name},agent:{status,message},
      ui:{id:`synthetic-${++serial}`,state:status,message,actions:structuredClone(actions)}};
  }
  function scenario(name) {
    if(!scenarioNames.has(name))throw Error('Unknown scenario');
    scenarioName=name;receipts.clear();states.clear();
    send({type:'sessions',sessions:[]});
    const messages={long:longQuestion,short:'次の作業へ進めてもよいですか？',
      choices:'テスト結果を確認しました。この後の進め方を選んでください。',
      running:'画面の実装を進めています。完了したら結果をお知らせします。',
      idle:'次の指示を待っています。',done:'変更が完了しました。テストはすべて成功しました。',
      failed:'接続先から応答がありません。PC側の状態を確認してください。'};
    const waiting=['long','short','choices'].includes(name);
    const examples=name==='multi'?[
      state('screen','画面の改善','waiting',longQuestion,yesNo),
      state('notes','調査メモ','running','通信方式について調査しています。資料を確認し、結果をまとめています。'),
      state('release','公開の確認','waiting','確認用の成果物を公開してもよいですか？この質問も模擬試験です。',yesNo),
    ]:[state('screen','画面の改善',waiting?'waiting':name,messages[name],waiting?(name==='choices'?choices:yesNo):[])];
    for(const value of examples)states.set(value.session.id,value);
    send({type:'sessions',sessions:examples});result='まだ回答していません';
  }
  function outputs() {
    for(let count=0;count<256;count++) {
      const output=read('take_output');if(!output)break;
      if(output.type==='pairing-confirm') {event(`模擬Bluetooth認証：${output.accepted?'YES':'NO'}`);continue;}
      if(typeof output.data!=='string')continue;
      for(const line of output.data.split('\n').filter(Boolean)) {
        let message;try{message=JSON.parse(line);}catch{continue;}
        metrics.outgoingPackets++;event(`本体 → 模擬PC / ${output.transport}：${line}`);
        if(message.type!=='uiAction')continue;
        // Even live display input has no native-chat delivery path.
        if(mode!=='demo' || !active() || output.transport!==transport){metrics.droppedReplies++;continue;}
        const source=states.get(message.sessionId), action=source?.ui.actions.find(a=>a.id===message.actionId);
        if(!source || source.ui.id!==message.uiId || !action){metrics.droppedReplies++;continue;}
        metrics.syntheticReplies++;result=`${source.session.name}：${action.label} を模擬PCで受信しました`;
        const key=JSON.stringify([message.sessionId,message.uiId,message.actionId]);
        receipts.set(key,{...message,key,link:output.transport,due:now+500,reject,name:source.session.name,label:action.label});
      }
    }
  }
  function tick(deltaMs) {
    if(!Number.isInteger(deltaMs)||deltaMs<0||deltaMs>60000)throw Error('Invalid elapsed time');
    // A long deterministic advance still gives the synthetic PC its heartbeat
    // opportunities. This is a byte-stream peer, not a forced UI connection.
    let remaining=deltaMs;
    do {
    const step=Math.min(remaining,250);remaining-=step;now+=step;
    if(powerDownAt!==null && powerWasOn && powered && now-powerDownAt>=6000) {
      module._gar_app_button(67,-1);powered=false;receipts.clear();disconnect();
    }
    if(active() && now-lastPing>=2000){send({type:'ping'});lastPing=now;}
    module._gar_app_tick(step);outputs();
    for(const receipt of receipts.values()) {
      if(receipt.due>now || !active())continue;
      receipts.delete(receipt.key);
      if(mode!=='demo' || receipt.link!==transport || states.get(receipt.sessionId)?.ui.id!==receipt.uiId)continue;
      send({type:'ack',sessionId:receipt.sessionId,uiId:receipt.uiId,actionId:receipt.actionId,ok:!receipt.reject});
      metrics.acknowledgements++;
      result=receipt.reject?`${receipt.name}：受信エラー。選び直して再送できます。`:`${receipt.name}：${receipt.label} を受信・確認しました`;
    }
    module._gar_app_tick(0);outputs();
    } while(remaining>0);
  }
  function control(command) {
    if(!command || typeof command!=='object' || Array.isArray(command))throw Error('Invalid control');
    if(command.type==='button') {
      if(!['A','B','C'].includes(command.button)||!['down','up','cancel'].includes(command.phase))throw Error('Invalid button');
      const before=read('snapshot');
      if(command.button==='C') {
        if(command.phase==='down'){powerDownAt=now;powerWasOn=powered;}
        else {
          const turnOn=command.phase==='up' && powerDownAt!==null && !powerWasOn && now-powerDownAt>=2000;
          powerDownAt=null;
          if(turnOn){powered=true;module._gar_app_button(67,-1);connect();}
        }
      }
      if(mode==='live' && command.button==='A' && !before.listOpen) {
        module._gar_app_button(65,-1);result='この画面は閲覧用です。回答は実機から行ってください。';
      } else module._gar_app_button(command.button.charCodeAt(0),command.phase==='down'?1:command.phase==='up'?0:-1);
    } else if(command.type==='scenario') {
      if(mode!=='demo')throw Error('Live display is read-only');scenario(command.name);
    } else if(command.type==='background') {
      if(mode!=='demo')throw Error('Live display is read-only');
      const selected=read('snapshot').sessionId;
      const id=[...states.keys()].find(id=>id!==selected)||'background';
      const status=command.status==='running'?'running':'waiting';
      const value=state(id,states.get(id)?.session.name||'別の作業',status,
        status==='running'?'別のセッションで作業を開始しました。':'別のセッションから確認が届きました。この後の進め方を選んでください。',status==='running'?[]:choices);
      states.set(id,value);send(value);
    } else if(command.type==='hardware') {
      const wasActive=active(), previous=transport;
      for(const name of ['powered','connected','reject'])if(command[name]!==undefined&&typeof command[name]!=='boolean')throw Error('Invalid hardware');
      if(command.transport!==undefined&&!links[command.transport])throw Error('Invalid transport');
      if(command.battery!==undefined&&(!Number.isInteger(command.battery)||command.battery<0||command.battery>100))throw Error('Invalid battery');
      powered=command.powered??powered;connected=command.connected??connected;reject=command.reject??reject;
      transport=command.transport??transport;battery=command.battery??battery;
      if(!active() || previous!==transport){receipts.clear();disconnect();}
      if(active() && (!wasActive || previous!==transport))connect();else hardware();
    } else if(command.type==='mode') {
      if(!['demo','live'].includes(command.mode))throw Error('Invalid mode');
      if(mode!==command.mode) {
        receipts.clear();states.clear();disconnect();mode=command.mode;liveConnected=false;
        if(mode==='demo'){connect();scenario(scenarioName);}else{hardware();result='本番データの接続を待っています。';}
      }
    } else if(command.type==='live') {
      if(mode!=='live')throw Error('Not in live mode');
      if(command.connected!==undefined&&typeof command.connected!=='boolean')throw Error('Invalid live state');
      if(command.sessions!==undefined) {
        if(!Array.isArray(command.sessions)||command.sessions.length>16)throw Error('Invalid live sessions');
        const packet={type:'sessions',sessions:command.sessions};
        if(Buffer.byteLength(JSON.stringify(packet))>65536)throw Error('Live packet too large');
        const next=new Map();
        for(const value of command.sessions) {
          const id=value?.session?.id;
          if(typeof id!=='string'||!id||next.has(id))throw Error('Invalid live session');
          next.set(id,value);
        }
        states.clear();for(const [id,value] of next)states.set(id,value);
      }
      const previous=liveConnected;liveConnected=command.connected??liveConnected;
      if(!liveConnected)disconnect();else if(!previous)connect();else send({type:'sessions',sessions:[...states.values()]});
      result=liveConnected?'実機と同じCodexの状態を表示しています。':'PCブリッジとの接続を待っています。';
    } else if(command.type==='wire') {
      // Isolated protocol tests use the same byte framing as USB/SPP.
      if(mode!=='demo'||!links[command.transport]||typeof command.data!=='string'||Buffer.byteLength(command.data)>65536)throw Error('Invalid wire input');
      wire(command.transport,command.data);
    } else throw Error('Unknown control');
    module._gar_app_tick(0);outputs();
  }
  module._gar_lv_init();module._gar_app_init();outputs();hardware();connect();scenario('multi');tick(0);
  return {tick,control,
    snapshot:()=>({snapshot:read('snapshot'),frame:module._gar_lv_frame(),width:module._gar_lv_width(),height:module._gar_lv_height(),
      mode,scenario:scenarioName,hardware:{powered,connected,reject,battery,transport},liveConnected,result,events:[...events],metrics:{...metrics},elapsedMs:now}),
    frame:()=>Buffer.from(module.HEAPU8.subarray(module._gar_lv_framebuffer(),module._gar_lv_framebuffer()+module._gar_lv_width()*module._gar_lv_height()*4)),
  };
}
module.exports={createSimulationController};
