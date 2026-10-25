#!/usr/bin/env node
// Product adapter: authenticated Codex WS <-> compact UI JSONL over SPP or USB.
// Tokens stay on the PC. It owns no HTTP server, hooks, build or pairing UI.
const fs=require('node:fs');
const {TextDecoder}=require('node:util');

class JsonLines {
  constructor(receive,maximum=65536){this.receive=receive;this.maximum=maximum;this.reset();}
  reset(){this.parts=[];this.length=0;this.dropping=false;}
  push(bytes){
    for(const byte of bytes){
      if(byte===10){
        if(!this.dropping && this.length){
          try {this.receive(JSON.parse(new TextDecoder('utf-8',{fatal:true}).decode(Buffer.from(this.parts))));} catch {}
        }
        this.reset();
      } else if(!this.dropping && byte!==13){
        if(this.length<this.maximum){this.parts.push(byte);this.length++;}
        else {this.parts=[];this.length=0;this.dropping=true;}
      }
    }
  }
}
const text=(value,limit)=>typeof value==='string' && Buffer.byteLength(value)<=limit;
function compactState(value,fallback={}) {
  if(!value || value.type!=='state')throw Error('state');
  const session=value.session ?? {id:fallback.sessionId || 'codex-monitor',name:fallback.label || 'Codex'};
  if(!text(session.id,256) || !session.id || !text(session.name,512))throw Error('session');
  const statuses=['idle','running','waiting','done','failed'];
  const ui=value.ui;
  if(ui && ui.id){
    if(!text(ui.id,256) || !text(ui.message ?? '',8192) || !statuses.includes(ui.state ?? 'waiting'))throw Error('ui');
    const actions=ui.actions ?? [];
    if(!Array.isArray(actions) || actions.length>8)throw Error('actions');
    const ids=new Set();
    for(const a of actions){
      if(!a || !text(a.id,256) || !a.id || !text(a.label,128) || !a.label || ids.has(a.id))throw Error('action');
      ids.add(a.id);
    }
    // The portrait UI currently confirms on A release; never claim an A-hold
    // approval was performed by that short press. Such requests stay on the PC.
    const needsHold=actions.some(a=>typeof a.button==='string' && a.button.endsWith('-hold'));
    return {session,ui:{id:ui.id,state:ui.state ?? 'waiting',message:needsHold?'PCで承認してください。':ui.message ?? '',
      actions:needsHold?[]:actions.map(a=>({id:a.id,label:a.label,...(a.button?{button:a.button}:{})}))}};
  }
  if(!statuses.includes(value.agent?.status ?? 'idle') || !text(value.agent?.message ?? '',8192))throw Error('agent');
  return {session,agent:{status:value.agent?.status ?? 'idle',message:value.agent?.message ?? 'Codexイベント待ち'}};
}

function startDeviceBridge(options) {
  const {SerialPort,WebSocket,port,token}=options;
  const transport=options.transport==='spp'?'bluetooth-spp':'usb-serial';
  const log=options.onEvent ?? (()=>{}),now=options.now ?? Date.now;
  const retryMs=options.retryMs ?? 3000,actionTimeoutMs=options.actionTimeoutMs ?? 5000;
  let stopped=false,serial,upstream,portTimer,wsTimer,actionTimer,authenticated=false,deviceReady=false;
  let latest,lastState=0,lastDevice=0,lastHello=0,lastPing=0,pending,writing=false,queue=[],stateQueued;
  const flushWaiters=new Set();
  const answered=new Map();
  const event=(name,extra={})=>log({event:name,transport,...extra});
  const key=m=>JSON.stringify([m.sessionId,m.uiId,m.actionId]);
  const receipt=(m,ok)=>({type:'ack',sessionId:m.sessionId,uiId:m.uiId,actionId:m.actionId,ok});
  function pump(){
    if(writing || !serial?.isOpen)return;
    const message=queue.shift() ?? stateQueued;
    if(!message){for(const resolve of flushWaiters)resolve();flushWaiters.clear();return;}
    if(message===stateQueued)stateQueued=undefined;
    writing=true;const target=serial;
    target.write(Buffer.from(JSON.stringify(message)+'\n'),error=>{
      if(serial!==target)return;
      writing=false;
      if(error){target.close(()=>{});return;}
      pump();
    });
  }
  function send(message){
    if(!serial?.isOpen)return;
    if(message.type==='sessions')stateQueued=message;
    else if(queue.length<16)queue.push(message);
    else {event('device-backpressure');serial.close(()=>{});return;}
    pump();
  }
  function rejectPending(){
    clearTimeout(actionTimer);
    if(pending)send(receipt(pending,false));
    pending=undefined;
  }
  function offline(){
    stateQueued=undefined;queue=[];rejectPending();
    if(deviceReady)send({type:'goodbye'});
    deviceReady=false;authenticated=false;latest=undefined;answered.clear();
  }
  function deviceMessage(message){
    if(!message || typeof message!=='object')return;
    if(message.type==='deviceInfo'){
      if(message.device!=='m5stickc-plus2' || message.protocol!=='gar-compact-v1' ||
          message.width!==135 || message.height!==240 || message.transport!==transport){
        event('wrong-device');close();return;
      }
      if(message.activeTransport!==transport){
        deviceReady=false;rejectPending();
        if(authenticated && latest){send({type:'hello'});lastHello=now();}
        return;
      }
      if(!authenticated || !latest)return;
      const first=!deviceReady;deviceReady=true;lastDevice=now();send(latest);
      if(first)event('device-ready',{firmware:message.firmware,sppReady:message.sppReady});
    } else if(message.type==='busy'){
      event('device-busy',{activeTransport:message.activeTransport});
    } else if(message.type==='uiAction'){
      if(!['sessionId','uiId','actionId'].every(k=>text(message[k],256) && message[k])){
        event('answer-rejected');return;
      }
      const cached=answered.get(key(message));
      if(cached){send(cached);return;}
      if(pending && key(pending)===key(message))return;
      const session=latest?.sessions.find(s=>s.session.id===message.sessionId);
      const valid=deviceReady && authenticated && upstream?.readyState===WebSocket.OPEN &&
        session?.ui?.id===message.uiId && session.ui.state==='waiting' &&
        session.ui.actions.some(a=>a.id===message.actionId) && !pending && now()-lastState<6000;
      if(!valid){send(receipt(message,false));event('answer-rejected');return;}
      pending={sessionId:message.sessionId,uiId:message.uiId,actionId:message.actionId};
      upstream.send(JSON.stringify({type:'uiAction',...pending,source:`m5stickc-plus2-${options.transport}`,token}));
      event('answer-sent');
      actionTimer=setTimeout(()=>{event('answer-timeout');rejectPending();upstream?.terminate();},actionTimeoutMs);
    } else if(message.type==='snapshot'){
      options.onSnapshot?.(message);
    }
  }
  const lines=new JsonLines(deviceMessage);
  function connectUpstream(){
    if(stopped || !serial?.isOpen || upstream)return;
    const socket=new WebSocket(options.url,{maxPayload:65536});upstream=socket;
    let helloAt=now();
    socket.on('open',()=>socket.send(JSON.stringify({type:'hello',token})));
    socket.on('error',()=>event('upstream-error'));
    socket.on('message',raw=>{
      if(socket!==upstream)return;
      try {
        const message=JSON.parse(String(raw));
        if(message.type==='ack'){
          if(!authenticated){
            if(message.ok!==true){event('authentication-failed');socket.terminate();return;}
            authenticated=true;lastState=now();event('upstream-connected');
          } else if(pending){
            clearTimeout(actionTimer);const ack=receipt(pending,message.ok===true);
            if(ack.ok)answered.set(key(pending),ack);
            while(answered.size>32)answered.delete(answered.keys().next().value);
            pending=undefined;send(ack);event(ack.ok?'answer-accepted':'answer-rejected');
          }
          return;
        }
        if(!authenticated)return;
        const sessions=message.type==='sessions'?message.sessions.map(s=>compactState({...s,type:'state'},options)):
          message.type==='state'?[compactState(message,options)]:undefined;
        if(!sessions)return;
        if(sessions.length>16 || new Set(sessions.map(s=>s.session.id)).size!==sessions.length)throw Error('sessions');
        const next={type:'sessions',sessions};
        if(Buffer.byteLength(JSON.stringify(next))>65536)throw Error('size');
        latest=next;lastState=now();helloAt=now();
        if(deviceReady)send(latest);
        else if(now()-lastHello>=1000){send({type:'hello'});lastHello=now();}
      } catch {event('invalid-upstream-message');socket.terminate();}
    });
    socket.on('close',()=>{
      if(socket!==upstream)return;
      upstream=undefined;offline();event('upstream-disconnected');
      if(!stopped && serial?.isOpen)wsTimer=setTimeout(connectUpstream,retryMs);
    });
    socket._garHelloAt=()=>helloAt;
  }
  function connectSerial(){
    if(stopped || serial)return;
    const target=new SerialPort({path:port,baudRate:115200,autoOpen:false,hupcl:false});serial=target;
    target.on('data',data=>{if(serial===target)lines.push(data);});
    target.on('error',()=>event('serial-error'));
    target.on('close',()=>{
      if(serial!==target)return;
      serial=undefined;writing=false;lines.reset();offline();
      for(const resolve of flushWaiters)resolve();flushWaiters.clear();
      clearTimeout(wsTimer);const socket=upstream;upstream=undefined;socket?.terminate();
      event('serial-disconnected');if(!stopped)portTimer=setTimeout(connectSerial,retryMs);
    });
    target.open(error=>{
      if(stopped){if(target.isOpen)target.close(()=>{});return;}
      if(error){
        if(serial!==target)return;
        serial=undefined;event('serial-open-failed');portTimer=setTimeout(connectSerial,retryMs);return;
      }
      event('serial-opened');connectUpstream();
    });
  }
  const ticker=setInterval(()=>{
    if(upstream && now()-(authenticated?lastState:upstream._garHelloAt())>6000){upstream.terminate();return;}
    if(authenticated && latest && serial?.isOpen){
      if(deviceReady && now()-lastDevice>7000){deviceReady=false;rejectPending();event('device-timeout');}
      // Periodic identity/ownership round trips also recover a lost device lease
      // without relying on a USB reset or a new RFCOMM connection.
      if(now()-lastHello>=(deviceReady?4000:2000)){send({type:'hello'});lastHello=now();}
      if(deviceReady && now()-lastPing>=2000){send({type:'ping'});lastPing=now();}
    }
  },250);
  async function close(){
    if(stopped)return Promise.resolve();
    stopped=true;clearInterval(ticker);clearTimeout(portTimer);clearTimeout(wsTimer);
    offline();const socket=upstream;upstream=undefined;socket?.terminate();
    if(writing || queue.length)await new Promise(resolve=>{
      const timer=setTimeout(done,1000);
      function done(){clearTimeout(timer);flushWaiters.delete(done);resolve();}
      flushWaiters.add(done);
    });
    return new Promise(resolve=>{
      if(!serial?.isOpen){resolve();return;}
      const target=serial;
      target.drain(()=>target.close(()=>resolve()));
    });
  }
  connectSerial();
  return {close,snapshot:()=>send({type:'snapshot'})};
}

async function main(){
  const args=process.argv.slice(2),get=name=>args[args.indexOf(name)+1];
  if(args.length!==6 || !['usb','spp'].includes(get('--transport')) ||
      !args.includes('--config') || !args.includes('--port') || !args.includes('--transport'))throw Error('arguments');
  const config=JSON.parse(fs.readFileSync(get('--config'),'utf8').replace(/^\uFEFF/,''));
  if(typeof config.token!=='string' || !/^[A-Za-z0-9_-]{16,128}$/.test(config.token) ||
      !Number.isInteger(config.port) || config.port<1 || config.port>65535)throw Error('config');
  const {SerialPort}=require('serialport'),{WebSocket}=require('ws');
  const bridge=startDeviceBridge({SerialPort,WebSocket,token:config.token,url:`ws://127.0.0.1:${config.port}`,
    port:get('--port'),transport:get('--transport'),sessionId:config.sessionId,label:config.label,
    onEvent:event=>{console.log(JSON.stringify(event));if(event.event==='wrong-device')process.exitCode=1;}});
  for(const signal of ['SIGINT','SIGTERM'])process.once(signal,()=>bridge.close().then(()=>process.exit(0)));
}
if(require.main===module)main().catch(()=>{console.error('接続中継を起動できません。設定とポートを確認してください（秘密の値は非表示）。');process.exitCode=1;});
module.exports={JsonLines,compactState,startDeviceBridge};
