import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import createUi from '../simulation/runtime/lvgl-ui.mjs';
const wasmBinary = await readFile(new URL('../simulation/runtime/lvgl-ui.wasm',import.meta.url));
async function app() {
  const m=await createUi({wasmBinary});m._gar_lv_init();m._gar_app_init();
  const read=name=>{const p=m[`_gar_app_${name}`]();const v=m.UTF8ToString(p);return v?JSON.parse(v):null;};
  return {
    m,state:()=>read('snapshot'),action:()=>read('take_action'),
    receive:d=>m.ccall('gar_app_receive','number',['string'],[JSON.stringify(d)]),
    tick:ms=>{m._gar_lv_tick(ms);m._gar_app_refresh();},
    edge:(key,phase)=>m._gar_app_button(key.charCodeAt(0),phase),
    press(key,ms=40){this.edge(key,1);this.tick(ms);this.edge(key,0);},
    select(index){this.press('B');while(this.state().listFocus!==index)this.press('C');this.press('A');},
    hardware(powered=true,connected=true){m._gar_app_hardware(+powered,+connected,82);},
  };
}
const longText='日本語の長い質問を表示します。本文を読みながらCで選び、Aで回答してください。'.repeat(7);
const question=(sessionId='s1',id='q1',message=longText)=>({type:'state',session:{id:sessionId,name:`画面テスト${sessionId}`},ui:{id,state:'waiting',message,actions:[{id:'yes',label:'YES',button:'A'},{id:'no',label:'NO',button:'B'}]}});
const list=(...sessions)=>({type:'sessions',sessions});
const ack=(sessionId='s1',uiId='q1',actionId='no',ok=true)=>({type:'ack',sessionId,uiId,actionId,ok});
const status=(id,state)=>({type:'state',session:{id,name:id},agent:{status:state,message:`状態：${state}`}});

test('portrait LVGL framebuffer renders full UTF-8 text with only line breaks inserted',async()=>{
  const a=await app();assert.equal(a.m._gar_lv_width(),135);assert.equal(a.m._gar_lv_height(),240);
  a.receive(question());assert.equal(a.state().displayMessage.replaceAll('\n',''),longText);
  assert.ok(a.state().contentHeight>a.state().bodyHeight);a.tick(50);
  const start=a.m._gar_lv_framebuffer(),pixels=a.m.HEAPU8.slice(start,start+135*240*4);
  assert.ok(new Set(pixels).size>5); // Actual LVGL output, not a JavaScript mock.
});
test('state frame renders on every side inside a black LCD margin, including list and disconnect',async()=>{
  const a=await app();
  const pixel=(x,y)=>{
    const p=a.m._gar_lv_framebuffer()+(y*135+x)*4;
    return [...a.m.HEAPU8.slice(p,p+3)];
  };
  const rgb565=hex=>{
    const r=(hex>>19)&31,g=(hex>>10)&63,b=(hex>>3)&31;
    return [(r<<3)|(r>>2),(g<<2)|(g>>4),(b<<3)|(b>>2)];
  };
  // LVGL's integer RGB565 expansion may differ by one from bit replication.
  const colorAt=(x,y,color,description='frame')=>{
    const expected=rgb565(color),actual=pixel(x,y);
    assert.ok(actual.every((channel,i)=>Math.abs(channel-expected[i])<=1),`${description} at ${x},${y}: ${actual} vs ${expected}`);
  };
  for(const [state,color] of [['waiting',0x9c263b],['running',0x238a43],['idle',0x4d5552]]){
    const q=question();q.ui.state=state;a.receive(q);a.tick(50);
    assert.equal(a.state().frameWidth,4);assert.equal(a.state().frameInset,2);
    for(const [x,y] of [[2,2],[2,120],[5,120],[132,120],[67,2],[67,237]])
      colorAt(x,y,color,`${state} border`);
    for(const [x,y] of [[0,120],[1,120],[6,120],[134,120],[67,0],[67,239]])
      colorAt(x,y,0x090e0d,`${state} black margin`);
  }
  a.receive(question());a.press('B');a.tick(50);colorAt(2,120,0x9c263b);
  a.hardware(true,false);a.tick(50);assert.equal(a.state().frameColor,0x4d5552);
  colorAt(2,120,0x4d5552);
});
test('text scrolls at 9 px/s after initial pause, pauses at end, then loops',async()=>{
  const a=await app();a.receive(question());a.tick(1800);assert.equal(a.state().scrollPixels,0);
  a.tick(1000);assert.equal(a.state().scrollPixels,9);a.tick(1000);assert.equal(a.state().scrollPixels,18);
  const maximum=a.state().contentHeight-a.state().bodyHeight;
  const travel=Math.ceil(maximum*1000/9);a.tick(travel-2000);assert.equal(a.state().scrollPixels,maximum);
  a.tick(2799);assert.equal(a.state().scrollPixels,maximum);a.tick(1);assert.equal(a.state().scrollPixels,0);
});
test('session names match state frame colors with black glyphs, including list focus',async()=>{
  const a=await app();
  const pixel=(x,y)=>{
    const start=a.m._gar_lv_framebuffer()+(y*135+x)*4;
    return [...a.m.HEAPU8.slice(start,start+3)];
  };
  const colorAt=(x,y,color)=>{
    const r=(color>>19)&31,g=(color>>10)&63,b=(color>>3)&31;
    const expected=[(r<<3)|(r>>2),(g<<2)|(g>>4),(b<<3)|(b>>2)];
    assert.ok(pixel(x,y).every((channel,i)=>Math.abs(channel-expected[i])<=1),`background at ${x},${y}`);
  };
  const blackGlyphs=(x,y,w,h)=>{
    let count=0;
    for(let yy=y;yy<y+h;yy++)for(let xx=x;xx<x+w;xx++)if(pixel(xx,yy).every(c=>c===0))count++;
    return count;
  };
  const palette=[['waiting',0x9c263b],['running',0x238a43],['idle',0x4d5552],['failed',0x9c263b],['done',0x4d5552]];
  for(const [state,color] of palette){
    const q=question();q.session.name='ABC';q.ui.state=state;a.receive(q);a.tick(50);
    colorAt(10,30,color);assert.ok(blackGlyphs(13,32,50,21)>20,`${state} has black name glyphs`);
    assert.equal(a.state().sessionNameBackground,color);assert.equal(a.state().sessionNameTextColor,0);
    colorAt(2,120,color); // Actual name-band and frame pixels use the same color.
  }
  const states=palette.slice(0,3).map(([state],i)=>{
    const q=question(`s${i+1}`);q.session.name='ABC';q.ui.state=state;return q;
  });
  a.receive(list(...states));a.press('B');a.tick(50);colorAt(10,30,0x4d5552);
  for(let i=0;i<3;i++){
    colorAt(14,64+i*37,palette[i][1]);
    assert.ok(blackGlyphs(34,66+i*37,50,21)>20,`list row ${i} has black name glyphs`);
  }
  colorAt(10,70,0xffffff);colorAt(10,107,0x238a43);
  a.press('C');a.tick(50);colorAt(10,70,0x9c263b);colorAt(10,107,0xffffff);
  a.hardware(true,false);a.tick(50);colorAt(10,30,0x4d5552);
});
test('lost acknowledgement does not leave the UI pending or replay an answer on reconnect',async()=>{
  const a=await app();a.receive(question());a.press('A');assert.equal(a.action().actionId,'no');
  a.hardware(true,false);assert.equal(a.state().pending,'');assert.match(a.state().error,/接続/);
  a.hardware(true,true);a.receive(question());a.tick(100);assert.equal(a.action(),null);
  a.press('A');assert.equal(a.action().actionId,'no'); // Explicit retry only.
});
test('short text stays still; identical status updates retain scroll and choice',async()=>{
  const a=await app(),q=question();a.receive(q);a.tick(5800);a.press('C');
  const before=a.state();a.receive(q);assert.equal(a.state().scrollPixels,before.scrollPixels);assert.equal(a.state().choice,0);
  a.receive(question('s1','short','はい、進めますか？'));a.tick(50000);assert.equal(a.state().scrollPixels,0);
});
test('C rotates choices, A short press commits once with session and question IDs',async()=>{
  const a=await app();a.receive(question());assert.equal(a.state().choice,1); // NO starts focused.
  a.press('C');assert.equal(a.state().choice,0);assert.equal(a.action(),null);
  a.edge('A',1);assert.equal(a.action(),null);a.tick(30);a.edge('A',0);
  assert.deepEqual(a.action(),{type:'uiAction',sessionId:'s1',uiId:'q1',actionId:'yes',button:'A'});
  a.press('A');a.press('C');assert.equal(a.action(),null);assert.equal(a.state().pending,'yes');
});
test('more than two choices rotate in order and wrap, with the focused action sent',async()=>{
  const a=await app(),q=question();q.ui.actions=Array.from({length:5},(_,i)=>({id:`o${i}`,label:`選択${i}`,button:String(i)}));
  a.receive(q);for(let i=0;i<5;i++){assert.equal(a.state().choice,i);a.press('C');}assert.equal(a.state().choice,0);
  for(let i=0;i<4;i++)a.press('C');a.press('A');assert.equal(a.action().actionId,'o4');
});
test('B opens sessions, C wraps list focus and A switches without answering',async()=>{
  const a=await app();a.receive(list(question('s1'),question('s2'),question('s3')));
  a.press('B');assert.equal(a.state().listOpen,true);assert.equal(a.state().listFocus,0);
  a.press('C');assert.equal(a.state().listFocus,1);assert.equal(a.state().sessionId,'s1');
  a.press('A');assert.equal(a.state().sessionId,'s2');assert.equal(a.state().listOpen,false);assert.equal(a.action(),null);
  a.press('B');a.press('C');a.press('C');assert.equal(a.state().listFocus,0);
  a.press('B');assert.equal(a.state().sessionId,'s2');assert.equal(a.state().listOpen,false);
});
test('session list can rotate through more than four visible rows',async()=>{
  const a=await app();a.receive(list(...Array.from({length:7},(_,i)=>question(`s${i}`))));a.press('B');
  for(let i=0;i<7;i++){assert.equal(a.state().listFocus,i);a.press('C');}
  assert.equal(a.state().listFocus,0);a.press('C');a.press('A');assert.equal(a.state().sessionId,'s1');
});
test('scroll pauses in list and resumes at each session own reading position',async()=>{
  const a=await app();a.receive(list(question('s1'),question('s2')));a.tick(5800);
  a.press('B');const first=a.state().scrollPixels;a.tick(10000);assert.equal(a.state().scrollPixels,first);
  a.press('C');a.press('A');assert.equal(a.state().sessionId,'s2');assert.equal(a.state().scrollPixels,0);
  a.tick(7800);a.press('B');const second=a.state().scrollPixels;a.press('C');a.press('A');assert.equal(a.state().scrollPixels,first);
  a.select(1);assert.equal(a.state().scrollPixels,second);
});
test('background updates preserve a focused answer and its reading/choice',async()=>{
  const a=await app();a.receive(list(question('s1'),question('s2')));a.tick(5800);a.press('C');const before=a.state();
  a.receive(question('s2','replacement'));assert.equal(a.state().sessionId,'s1');assert.equal(a.state().scrollPixels,before.scrollPixels);assert.equal(a.state().choice,0);
  a.edge('A',1);a.receive(question('s3'));a.edge('A',0);assert.equal(a.action().sessionId,'s1');
});
test('matching acknowledgements resolve background session only, including duplicate question IDs',async()=>{
  const a=await app();a.receive(list(question('s1'),question('s2')));a.press('A');a.action();a.select(1);
  a.press('A');a.action();assert.equal(a.receive(ack('missing')),0);assert.equal(a.receive(ack('s1','old')),0);
  assert.equal(a.receive(ack('s1')),1);assert.equal(a.state().acknowledged,false);assert.equal(a.state().sessionId,'s2');
  assert.equal(a.receive(ack('s2')),1);assert.equal(a.state().acknowledged,true);a.select(0);assert.equal(a.state().acknowledged,true);
});
test('changing question, action labels or selected session cancels an in-progress A',async()=>{
  for(const change of ['question','label','remove']){
    const a=await app(),q=question();a.receive(list(q,question('s2')));a.edge('A',1);
    if(change==='remove')a.receive(list(question('s2')));
    else {const next=structuredClone(q);if(change==='question')next.ui.id='q2';else next.ui.actions[1].label='拒否する';a.receive(next);}
    a.edge('A',0);assert.equal(a.action(),null,change);
  }
});
test('disconnect, power-off and cancellation cannot complete a held answer',async()=>{
  for(const kind of ['cancel','disconnect','power']){
    const a=await app();a.receive(question());a.edge('A',1);a.tick(50);
    if(kind==='cancel')a.edge('A',-1);else a.hardware(kind!=='power',kind!=='disconnect');
    a.edge('A',0);assert.equal(a.action(),null,kind);
    const y=a.state().scrollPixels;a.tick(20000);if(kind!=='cancel')assert.equal(a.state().scrollPixels,y);
  }
});
test('authoritative snapshots preserve session identity through reordering and removal',async()=>{
  const a=await app(),one=question('s1'),two=question('s2');a.receive(list(one,two));a.select(1);a.press('B');a.press('C');
  a.edge('A',1);a.receive(list(two,one));a.edge('A',0);assert.equal(a.state().sessionId,'s2');assert.equal(a.state().listOpen,true);
  assert.equal(a.state().sessions[a.state().listFocus].id,'s1');a.press('A');assert.equal(a.state().sessionId,'s1');
  a.receive(list(two));assert.equal(a.state().sessionId,'s2');assert.equal(a.action(),null);
});
test('live status or question updates do not cancel B/C/A session navigation',async()=>{
  for(const transport of ['state','sessions'])for(const key of ['B','C','A']) {
    const a=await app(),one=question('s1'),two=question('s2');a.receive(list(one,two));
    if(key!=='B')a.press('B');
    if(key==='A')a.press('C');
    a.edge(key,1);a.tick(120);
    const updated=structuredClone(one);updated.ui.id='new-question';updated.ui.message='状態が更新されました';
    a.receive(transport==='state'?updated:list(updated,two));
    a.edge(key,0);
    if(key==='B')assert.equal(a.state().listOpen,true,transport+' open');
    if(key==='C')assert.equal(a.state().sessions[a.state().listFocus].id,'s2',transport+' focus');
    if(key==='A') {assert.equal(a.state().sessionId,'s2',transport+' select');assert.equal(a.state().listOpen,false);}
    assert.equal(a.action(),null,'navigation never answers a question');
  }
});
test('rejected response can be retried; waiting count reflects unanswered sessions',async()=>{
  const a=await app();a.receive(list(question('s1'),question('s2')));assert.equal(a.state().waitingCount,2);
  a.press('A');a.action();assert.equal(a.state().waitingCount,1);a.receive(ack('s1','q1','no',false));
  assert.equal(a.state().waitingCount,2);assert.ok(a.state().error);a.press('C');a.press('A');assert.equal(a.action().actionId,'yes');
});
test('empty list, completed sessions and malformed snapshots do not create phantom choices',async()=>{
  const a=await app();a.receive(list());a.press('B');a.press('C');a.press('A');assert.equal(a.action(),null);a.press('B');
  for(const state of ['idle','done','running','failed']){
    const q=question('s1',state);q.ui.state=state;q.ui.actions=[];a.receive(list(q));a.press('C');a.press('A');assert.equal(a.action(),null);
  }
  const before=a.state().sessionId;assert.equal(a.receive(list(question('dup'),question('dup'))),0);assert.equal(a.state().sessionId,before);
  assert.equal(a.receive(list(...Array.from({length:17},(_,i)=>question(`s${i}`)))),0);
});
test('input limits reject duplicate options and too much text without changing the question',async()=>{
  const a=await app();a.receive(question());let q=question();q.ui.actions.push(q.ui.actions[0]);assert.equal(a.receive(q),0);
  q=question();q.ui.message='x'.repeat(8193);assert.equal(a.receive(q),0);assert.equal(a.state().uiId,'q1');
  q=question();q.ui.message='\n'.repeat(2000);assert.equal(a.receive(q),0);assert.equal(a.state().uiId,'q1');
});
test('long power gesture C is not a focus step; separate instances stay independent',async()=>{
  const a=await app(),b=await app();a.receive(question('a'));b.receive(question('b'));
  a.press('C',2000);assert.equal(a.state().choice,1);a.press('C');a.press('A');assert.equal(a.action().sessionId,'a');
  assert.equal(b.state().choice,1);assert.equal(b.action(),null);
});

test('automatic selection follows waiting > failed > running > idle, including idle-to-running',async()=>{
  for(const format of ['state','sessions']){
    const a=await app();const entries=[status('idle','idle'),status('work','idle'),status('error','idle'),status('ask','idle')];
    const update=(index,value)=>{entries[index]=value;a.receive(format==='state'?value:list(...entries));};
    a.receive(list(...entries));assert.equal(a.state().sessionId,'idle');
    update(1,status('work','running'));assert.equal(a.state().sessionId,'work',format);
    update(2,status('error','failed'));assert.equal(a.state().sessionId,'error');
    update(3,question('ask'));assert.equal(a.state().sessionId,'ask');
    update(1,status('work','running'));assert.equal(a.state().sessionId,'ask');
    assert.equal(a.state().selectedPriority,4);assert.equal(a.action(),null);
  }
});

test('same-priority events and roster reordering do not bounce the selected session',async()=>{
  const a=await app();a.receive(list(status('idle','idle'),status('b','running'),status('c','running')));
  assert.equal(a.state().sessionId,'b');a.receive(status('c','running'));assert.equal(a.state().sessionId,'b');
  a.receive(list(status('c','running'),status('idle','idle'),status('b','running')));
  assert.equal(a.state().sessionId,'b');a.receive(question('c'));assert.equal(a.state().sessionId,'c');
  a.receive(question('b'));assert.equal(a.state().sessionId,'c');
});

test('automatic selection preserves the previous session reading position',async()=>{
  const a=await app(),working=status('work','running');working.agent.message=longText;
  a.receive(list(working,status('ask','idle')));a.tick(5800);const position=a.state().scrollPixels;
  assert.ok(position>0);a.receive(question('ask'));a.tick(7000);a.select(0);
  assert.equal(a.state().sessionId,'work');assert.equal(a.state().scrollPixels,position);
});

test('a held A on an idle session cannot answer a question that arrives before release',async()=>{
  const a=await app();a.receive(status('idle','idle'));a.edge('A',1);a.receive(question('new'));
  assert.equal(a.state().sessionId,'idle');assert.equal(a.state().autoPaused,'button');
  a.edge('A',0);assert.equal(a.state().sessionId,'new');assert.equal(a.action(),null);
  a.edge('A',0);assert.equal(a.action(),null); // Releasing an old key is never a new confirmation.
  a.press('A');assert.equal(a.action().sessionId,'new');
});

test('list navigation freezes automatic selection; closing the list resumes it',async()=>{
  const a=await app();a.receive(list(status('idle','idle'),status('work','idle')));a.edge('B',1);
  a.receive(status('work','running'));a.edge('B',0);assert.equal(a.state().listOpen,true);
  a.receive(question('ask'));a.tick(20000);assert.equal(a.state().sessionId,'idle');
  assert.equal(a.state().autoPaused,'list');a.press('C');assert.equal(a.state().listFocus,1);
  a.press('B');assert.equal(a.state().sessionId,'ask');assert.equal(a.action(),null);
});

test('a manually opened status stays readable for ten seconds before automatic selection resumes',async()=>{
  const a=await app();a.receive(list(status('idle','idle'),question('ask')));assert.equal(a.state().sessionId,'ask');
  a.select(0);assert.equal(a.state().sessionId,'idle');assert.equal(a.state().autoPaused,'manual');
  a.tick(9999);assert.equal(a.state().sessionId,'idle');a.tick(1);assert.equal(a.state().sessionId,'ask');
  assert.equal(a.action(),null);
});

test('choosing a reply pins its identity until answered or resolved, across live updates',async()=>{
  const a=await app();a.receive(list(question('first'),question('second')));a.press('C');
  const before=a.state();a.receive(question('second','replacement'));a.receive(status('error','failed'));a.tick(15000);
  assert.equal(a.state().sessionId,'first');assert.equal(a.state().choice,before.choice);
  assert.equal(a.state().autoPaused,'choice');assert.equal(a.state().waitingCount,2);
  a.receive(status('first','idle'));assert.equal(a.state().sessionId,'second');assert.equal(a.action(),null);
});

test('successful replies show feedback for two seconds then select the oldest remaining question',async()=>{
  const a=await app();a.receive(list(question('first'),status('second','idle'),status('third','idle')));
  a.receive(question('second'));a.receive(question('third'));a.press('A');const sent=a.action();
  assert.equal(sent.sessionId,'first');a.tick(3000);assert.equal(a.state().sessionId,'first');
  a.receive(ack('first'));assert.equal(a.state().autoPaused,'received');
  // A fresh question in the answered chat must not jump ahead of queued questions.
  a.receive(list(question('third'),question('first','next-question'),question('second')));
  a.tick(1999);assert.equal(a.state().sessionId,'first');a.tick(1);
  assert.equal(a.state().sessionId,'second');assert.equal(a.action(),null);
  a.press('A');assert.equal(a.action().sessionId,'second');a.receive(ack('second'));a.tick(2000);
  assert.equal(a.state().sessionId,'third');
});

test('reply feedback ignores an extra A press even when the same session already has a new question',async()=>{
  const a=await app();a.receive(question('same'));a.press('A');a.action();a.receive(ack('same'));
  a.receive(question('same','new-question'));assert.equal(a.state().answerable,false);
  a.press('A');assert.equal(a.action(),null);assert.equal(a.state().autoPaused,'received');
  a.tick(2000);assert.equal(a.state().answerable,true);a.press('A');assert.equal(a.action().uiId,'new-question');
});

test('PC forwarding states with no actions preserve receipt identity without blocking the next question',async()=>{
  for(const ackFirst of [true,false]){
    const a=await app();a.receive(list(question('first'),question('second')));a.press('A');a.action();
    if(ackFirst)assert.equal(a.receive(ack('first')),1);
    const forwarding=question('first');forwarding.ui.message='回答をPCへ送信中';forwarding.ui.actions=[];
    a.receive(forwarding);assert.equal(a.state().pending,'no');assert.equal(a.state().actions.length,0);
    if(!ackFirst)assert.equal(a.receive(ack('first')),1);
    a.tick(2000);assert.equal(a.state().sessionId,'second');assert.equal(a.action(),null);
  }
  const a=await app();a.receive(list(status('idle','idle'),question('ask')));a.press('A');a.action();
  a.receive(ack('ask'));a.tick(2000);assert.equal(a.state().sessionId,'ask'); // No bounce between idle peers.
});

test('failed delivery keeps the current question and its focus for explicit retry',async()=>{
  const a=await app();a.receive(list(question('first'),question('second')));a.press('C');a.press('A');a.action();
  a.receive(ack('first','q1','yes',false));a.tick(12000);
  assert.equal(a.state().sessionId,'first');assert.equal(a.state().autoPaused,'choice');assert.ok(a.state().error);
  assert.equal(a.action(),null);a.press('A');assert.equal(a.action().actionId,'yes');
});

test('completion is brief, then running wins; an urgent question interrupts the completion notice',async()=>{
  for(const finished of ['done','idle']){
    const a=await app();a.receive(list(status('a','running'),status('b','running')));
    a.receive(status('a',finished));assert.equal(a.state().sessionId,'a');assert.equal(a.state().autoPaused,'completed');
    a.tick(1999);assert.equal(a.state().sessionId,'a');a.tick(1);assert.equal(a.state().sessionId,'b');
    assert.equal(a.state().autoPaused,'');
  }
  const a=await app();a.receive(list(status('a','running'),status('b','running')));
  a.receive(status('a','done'));a.receive(question('urgent'));assert.equal(a.state().sessionId,'urgent');
  assert.equal(a.state().autoPaused,'');
  a.receive(status('urgent','running'));a.receive(status('urgent','idle'));
  assert.equal(a.state().autoPaused,'completed');a.receive(status('urgent','running'));
  assert.equal(a.state().autoPaused,''); // A new run must not keep showing the old completion.
});

test('removing a held question never transfers its A confirmation to the automatically selected replacement',async()=>{
  const a=await app();a.receive(list(question('old'),status('idle','idle'),question('next')));a.press('C');
  a.edge('A',1);a.receive(list(status('idle','idle'),question('next')));a.edge('A',0);
  assert.equal(a.state().sessionId,'next');assert.equal(a.action(),null);
  a.press('A');assert.equal(a.action().sessionId,'next');
});

test('disconnection and power-off suspend automatic selection until a valid connection returns',async()=>{
  const a=await app();a.receive(status('idle','idle'));a.hardware(true,false);a.receive(question('ask'));
  assert.equal(a.state().sessionId,'idle');assert.equal(a.state().autoPaused,'connection');
  a.hardware(true,true);assert.equal(a.state().sessionId,'ask');a.hardware(false,true);
  a.receive(status('ask','idle'));a.receive(status('work','running'));assert.notEqual(a.state().sessionId,'work');
  a.hardware(true,true);assert.equal(a.state().sessionId,'work');assert.equal(a.action(),null);
});
