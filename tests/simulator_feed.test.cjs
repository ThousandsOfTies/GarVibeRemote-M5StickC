const test=require('node:test'),assert=require('node:assert/strict');
const {createRequire}=require('node:module'),path=require('node:path');
const runtime=createRequire(path.join(require('../scripts/runtime.cjs'),'package.json'));
const {WebSocket,WebSocketServer}=runtime('ws');
const {startCodexBridge}=runtime('./codexBridge.cjs');
const {startSimulatorFeed}=require('../scripts/simulator_feed.cjs');
const pause=ms=>new Promise(resolve=>setTimeout(resolve,ms));
const token='isolated-simulator-feed-private-token';
async function until(check){for(let i=0;i<250;i++){const value=check();if(value)return value;await pause(10);}throw Error('Timed out');}
function browser(port,origin='http://127.0.0.1:8772'){
  const messages=[],socket=new WebSocket(`ws://127.0.0.1:${port}/state`,origin?{origin}:{});
  socket.on('message',raw=>messages.push(JSON.parse(String(raw))));socket.on('error',()=>{});
  return {messages,socket};
}

test('authorized browser sees real bridge updates without credentials and cannot answer a question',async()=>{
  const backend=await startCodexBridge({port:0,token,sessionId:'s1',label:'表示対象'});
  const feed=await startSimulatorFeed({WebSocket,WebSocketServer,port:0,url:backend.url,token});
  const a=browser(feed.port),b=browser(feed.port);
  const request=async(route,body)=>{
    const response=await fetch(`http://127.0.0.1:${backend.port}${route}`,{method:body===undefined?'GET':'POST',
      headers:{Authorization:`Bearer ${token}`,'Content-Type':'application/json'},...(body===undefined?{}:{body:JSON.stringify(body)})});
    return response.json();
  };
  try {
    await until(()=>a.messages.some(m=>m.type==='sessions') && b.messages.some(m=>m.type==='sessions'));
    await request('/events',{hook_event_name:'UserPromptSubmit',session_id:'s1',delivery:'test',prompt:'PRIVATE-PROMPT',tool_input:{command:'PRIVATE-COMMAND'}});
    const running=await until(()=>a.messages.find(m=>m.sessions?.[0]?.ui?.state==='running'));
    assert.equal(running.sessions[0].session.id,'s1');
    const created=await request('/input-test',{}),id=created.test.id;
    const waiting=await until(()=>a.messages.find(m=>m.sessions?.[0]?.ui?.id===id));
    assert.equal(waiting.sessions[0].ui.actions.length,2);
    assert.doesNotMatch(JSON.stringify(a.messages),new RegExp(`${token}|PRIVATE-PROMPT|PRIVATE-COMMAND`));
    const closed=new Promise(resolve=>a.socket.once('close',(code)=>resolve(code)));
    a.socket.send(JSON.stringify({type:'uiAction',sessionId:'s1',uiId:id,actionId:'yes'}));
    assert.equal(await closed,1008);assert.equal((await request('/input-test')).test.status,'pending');
    // Another browser continues to receive, and a backend loss clears its cached state.
    await backend.close();
    await until(()=>b.messages.at(-1)?.type==='connection' && b.messages.at(-1).connected===false);
    const fresh=browser(feed.port);
    try {await until(()=>fresh.messages.length);assert.deepEqual(fresh.messages,[{type:'connection',connected:false}]);}
    finally {fresh.socket.terminate();}
  } finally {a.socket.terminate();b.socket.terminate();await feed.close();await backend.close();}
});

test('unrelated and missing browser origins are rejected before state disclosure',async()=>{
  const backend=await startCodexBridge({port:0,token});
  const feed=await startSimulatorFeed({WebSocket,WebSocketServer,port:0,url:backend.url,token});
  try {
    for(const origin of ['https://unrelated.invalid',null]){
      const {socket,messages}=browser(feed.port,origin);
      const status=await new Promise(resolve=>socket.once('unexpected-response',(_req,res)=>{res.resume();resolve(res.statusCode);}));
      assert.equal(status,403);assert.deepEqual(messages,[]);socket.terminate();
    }
  } finally {await feed.close();await backend.close();}
});

test('upstream reconnects with current state and never forwards browser traffic',async()=>{
  const server=new WebSocketServer({host:'127.0.0.1',port:0}),peers=[],inbound=[];
  await new Promise(resolve=>server.once('listening',resolve));
  server.on('connection',socket=>{
    peers.push(socket);const generation=peers.length;
    socket.on('message',raw=>{
      const message=JSON.parse(String(raw));inbound.push(message.type);
      if(message.type==='hello'){
        socket.send(JSON.stringify({type:'ack',ok:true}));
        socket.send(JSON.stringify({type:'state',session:{id:`s${generation}`,name:'再接続'},agent:{status:'running',message:`状態${generation}`}}));
      }
    });
  });
  const feed=await startSimulatorFeed({WebSocket,WebSocketServer,port:0,token,url:`ws://127.0.0.1:${server.address().port}`,retryMs:20});
  const viewer=browser(feed.port);
  try {
    await until(()=>viewer.messages.some(m=>m.sessions?.[0]?.session.id==='s1'));
    peers[0].terminate();
    await until(()=>viewer.messages.some(m=>m.type==='connection'&&!m.connected));
    await until(()=>viewer.messages.some(m=>m.sessions?.[0]?.session.id==='s2'));
    assert.deepEqual(inbound,['hello','hello']);
  } finally {viewer.socket.terminate();await feed.close();for(const peer of peers)peer.terminate();await new Promise(resolve=>server.close(resolve));}
});
