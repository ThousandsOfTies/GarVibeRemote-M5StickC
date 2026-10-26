const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const net = require('node:net');
const { createRequire } = require('node:module');
const runtime = createRequire(path.join(require('../scripts/runtime.cjs'), 'package.json'));
const { startCodexBridge } = runtime('./codexBridge.cjs');
const { WebSocket } = runtime('ws');
const { NativeQuestionLog, RolloutTail, displayLabel, startChatQuestions } = require('../scripts/chat_questions.cjs');
const { CodexAppClient } = require('../scripts/codex_app_client.cjs');
const sessionId = 'isolated-native-question-chat';
const token = 'isolated-question-test-authentication';
const pause = ms => new Promise(resolve => setTimeout(resolve, ms));
async function until(check) { for (let i = 0; i < 300; i++) { const value = check(); if (value) return value; await pause(10); } throw Error('Timed out'); }
function records(call = 'call_question', questions = [{ title: 'どの方法にしますか？', options: ['そのまま進める', '修正する', '中止する'] }]) {
  return [
    { type: 'response_item', timestamp: new Date().toISOString(), payload: { type: 'function_call', name: 'request_user_input_async', call_id: call, arguments: JSON.stringify({ questions }) } },
    { type: 'response_item', payload: { type: 'function_call_output', call_id: call, output: '{"accepted":true}' } }
  ];
}
const reply = id => ({ type: 'response_item', payload: { type: 'message', role: 'user', content: [{ type: 'input_text', text:
  '<send_user_message_question_reply>\n' + JSON.stringify([{ questionItemId: id, question: '質問', answer: '回答' }]) + '\n</send_user_message_question_reply>' }] } });
function temp(t) { const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'stickc-native-questions-')); t.after(() => fs.rmSync(dir, { recursive: true, force: true })); return dir; }
async function fixture(t, now) {
  const bridge = await startCodexBridge({ token, sessionId, chatQuestions: true,
    chatQuestionSources: ['m5stickc-plus2-spp','m5stickc-plus2-usb'], port: 0, now });
  t.after(() => bridge.close());
  async function post(payload) {
    const r = await fetch(`http://127.0.0.1:${bridge.port}/chat-questions`, { method: 'POST', headers: {
      Authorization: `Bearer ${token}`, 'Content-Type': 'application/json'
    }, body: JSON.stringify(payload) });
    return { status: r.status, body: await r.json() };
  }
  const ws = new WebSocket(bridge.url), messages = [];
  t.after(() => ws.terminate());
  ws.on('message', data => messages.push(JSON.parse(String(data))));
  await new Promise(resolve => ws.once('open', resolve));
  ws.send(JSON.stringify({ type: 'hello', token }));
  await until(() => messages.find(m => m.type === 'state'));
  const state = () => [...messages].reverse().find(m => m.type === 'state');
  const choose = async (uiId, actionId, source = 'm5stickc-plus2-spp') => {
    const start = messages.length;
    ws.send(JSON.stringify({ type: 'uiAction', token, uiId, actionId, source }));
    return until(() => messages.slice(start).find(m => m.type === 'ack'));
  };
  return { bridge, post, state, choose };
}
const snapshot = (questions, extra = {}) => ({ kind: 'chat-choice', sessionId, owner: 'isolated-test-owner-1234', questions, delivered: [], failed: [], ...extra });
const question = { id: '["request_user_input_async","call_real",0]', question: '続けますか？', options: [{ id: 'option-0', label: 'YES' }, { id: 'option-1', label: 'NO' }, { id: 'option-2', label: '後で決める' }] };

test('native log matches call/index, multiple questions, PC replies, acceptance and unsupported input', () => {
  const m = new NativeQuestionLog(sessionId);
  const data = records('call_multi', [
    { title: '第一問', options: ['甲', '乙'] }, { title: '自由入力' },
    { title: '第三問', options: ['丙', '丁', '戊'] }
  ]);
  m.consume(data[0]); assert.equal(m.pending().length, 0);
  m.consume(data[1]); assert.equal(m.pending().length, 2);
  assert.equal(m.pending()[1].id, '["request_user_input_async","call_multi",2]');
  m.consume(reply(m.pending()[0].id)); assert.equal(m.pending().length, 1);
  m.consume(data[0]); assert.equal(m.pending().length, 1); // duplicated log records cannot reopen it
  const rejected = records('call_rejected'); rejected[1].payload.output = '{"accepted":false}';
  rejected.forEach(r => m.consume(r)); assert.equal(m.pending().length, 1);
  assert.throws(() => m.consume({ type: 'session_meta', payload: { id: 'another-chat' } }));
  const old = records('call_ancient'); old[0].timestamp = '2000-01-01T00:00:00Z'; old.forEach(r => m.consume(r));
  assert.equal(m.pending().length, 1);
  records('call_too_many_lines', [{ title: '\n'.repeat(1600)+'質問', options: ['はい','いいえ'] }]).forEach(r => m.consume(r));
  assert.equal(m.pending().length, 1);
  const cancelled = records('call_cancelled');
  cancelled[0].payload.internal_chat_message_metadata_passthrough = { turn_id: 'cancelled-turn' };
  cancelled.forEach(r => m.consume(r)); assert.equal(m.pending().length,2);
  m.consume({ type: 'event_msg', payload: { type: 'turn_aborted', turn_id: 'cancelled-turn' } });
  assert.equal(m.pending().length,1);
  assert.ok(Buffer.byteLength(displayLabel('長い選択肢'.repeat(80))) <= 128);
});

test('tail preserves partial UTF-8 and skips large unrelated log records', async t => {
  const dir = temp(t), file = path.join(dir, 'rollout.jsonl'), m = new NativeQuestionLog(sessionId);
  const data = Buffer.from(records().map(JSON.stringify).join('\n') + '\n');
  const split = data.indexOf(Buffer.from('ど')) + 1;
  fs.writeFileSync(file, data.subarray(0, split));
  const tail = new RolloutTail(file, m); await tail.read(); assert.equal(m.pending().length, 0);
  fs.appendFileSync(file, data.subarray(split)); await tail.read(); assert.equal(m.pending().length, 1);
  fs.appendFileSync(file, 'x'.repeat(9 * 1024 * 1024) + '\n' + JSON.stringify(reply(m.pending()[0].id)) + '\n');
  await tail.read(); assert.equal(m.pending().length, 0); assert.ok(tail.partial.length < 100);
  fs.truncateSync(file, 0); await assert.rejects(tail.read());
});

test('chat question HTTP auth, physical selection, stale/duplicate/PC answer and source lease', async t => {
  let now = 1000;
  const f = await fixture(t, () => now);
  assert.equal((await f.post(snapshot([question], { sessionId: 'other-chat' }))).status, 400);
  assert.equal((await f.post(snapshot([question], { kind: 'approval' }))).status, 400);
  assert.equal((await f.post(snapshot([question]))).status, 200);
  await until(() => f.state().ui?.source === 'chat-choice');
  const id = f.state().ui.id;
  assert.equal(f.state().ui.actions.length, 3);
  assert.equal((await f.choose(id, 'option-0', 'browser')).ok, false);
  assert.equal((await f.choose('stale-question', 'option-0')).ok, false);
  assert.equal((await f.choose(id, 'option-2')).ok, true);
  assert.equal((await f.choose(id, 'option-2')).ok, false);
  const selected = await f.post(snapshot([question]));
  assert.deepEqual(selected.body.answers, [{ id: question.id, choiceId: 'option-2', source: 'm5stickc-plus2-spp' }]);
  assert.equal((await f.post(snapshot([question], { owner: 'second-test-owner-123' }))).status, 409);
  assert.equal((await f.post(snapshot([{ ...question, question: '改ざん' }]))).status, 409);
  await f.post(snapshot([])); // actual PC reply removes the original native card
  assert.equal((await f.choose(id, 'option-1')).ok, false);
  await f.post(snapshot([question]));
  const next = await until(() => f.state().ui?.source === 'chat-choice' && f.state().ui.id !== id && f.state().ui.id);
  assert.notEqual(next, id);
  now += 5001;
  assert.equal((await f.choose(next, 'option-0')).ok, false);
  const unauth = await fetch(`http://127.0.0.1:${f.bridge.port}/chat-questions`, { method: 'POST', body: '{}' });
  assert.equal(unauth.status, 401);
  const approval = await fetch(`http://127.0.0.1:${f.bridge.port}/interactions`, { method: 'POST', headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' }, body: JSON.stringify({ kind: 'approval', sessionId, turnId: 'turn', message: 'execute' }) });
  assert.equal(approval.status, 403); // enabling ordinary questions never enables operation approval
});

test('App monitoring and native question input use separate connections', async t => {
  const { NativeChatReply } = require('../scripts/native_chat_reply.cjs');
  const { fixture, state } = require('./helpers/native_reply_fixture.cjs');
  const q = { ...question, originalQuestion: question.question, originalOptions: ['YES', 'NO', '後で決める'] };
  const native = await fixture(t, { getState: id => state(id, q) });
  let received;
  const server = net.createServer(socket => {
    let data = Buffer.alloc(0);
    socket.on('data', chunk => {
      data = Buffer.concat([data, chunk]);
      while (data.length >= 4 && data.length >= data.readUInt32LE() + 4) {
        const size = data.readUInt32LE(), m = JSON.parse(data.subarray(4, size + 4)); data = data.subarray(size + 4);
        const result = m.method === 'tools/list' ? { tools: ['list_threads','read_thread'].map(name=>({name,namespace:'codex_app'})) } : { success: true, contentItems: [] };
        if (m.method === 'tools/call') received = m;
        const b = Buffer.from(JSON.stringify({ id: m.id, jsonrpc: '2.0', result })), h = Buffer.alloc(4); h.writeUInt32LE(b.length);
        socket.write(Buffer.concat([h, b.subarray(0, 3)])); setImmediate(() => socket.write(b.subarray(3)));
      }
    });
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const client = new CodexAppClient({ pipePath: { host: '127.0.0.1', port: server.address().port }, sessionId,
    nativeReplies: new NativeChatReply(native) });
  t.after(() => { client.close(); return new Promise(resolve => server.close(resolve)); });
  await client.ready();
  await client.reply(q, 'option-2');
  assert.equal(received, undefined);
  const sent=native.mutations[0];
  assert.equal(sent.params.conversationId, sessionId);
  assert.deepEqual(JSON.parse(sent.params.input[0].text.split('\n')[1]), [{ questionItemId: question.id, question: question.question, answer: '後で決める' }]);
  await assert.rejects(client.call('send_message_to_thread', {}), /Unsupported/);
});

test('watcher delivers an actual isolated device selection, but never replays an uncertain reply', async t => {
  const dir = temp(t), file = path.join(dir, 'rollout.jsonl'), journal = path.join(dir, 'deliveries.json');
  fs.writeFileSync(file, records().map(JSON.stringify).join('\n') + '\n');
  const f = await fixture(t);
  let sent = 0;
  const app = { ready: async () => {}, close() {}, reply: async () => { sent++; throw Error('Uncertain delivery'); } };
  let service = await startChatQuestions({ config: { token, sessionId, port: f.bridge.port, chatQuestions: true }, file, app, journal, intervalMs: 20 });
  t.after(() => service.close());
  await until(() => f.state().ui?.source === 'chat-choice');
  assert.equal((await f.choose(f.state().ui.id, 'option-1')).ok, true);
  await until(() => sent === 1);
  await pause(100); assert.equal(sent, 1);
  assert.equal(JSON.parse(fs.readFileSync(journal, 'utf8'))[0].status, 'unconfirmed');
  await service.close();
  service = await startChatQuestions({ config: { token, sessionId, port: f.bridge.port, chatQuestions: true }, file, app, journal, intervalMs: 20 });
  await pause(80); assert.equal(sent, 1);
});

test('watcher returns the original option and moves to the next question after the PC records its reply', async t => {
  const dir = temp(t), file = path.join(dir, 'rollout.jsonl');
  fs.writeFileSync(file, records('call_batch', [
    { title: '一問目', options: ['方法Ａ', '方法Ｂ', '方法Ｃ'] }, { title: '二問目', options: ['続行', '中止'] }
  ]).map(JSON.stringify).join('\n') + '\n');
  const f = await fixture(t), received = [];
  const app = { ready: async () => {}, close() {}, reply: async (q, choice) => {
    received.push({ id: q.id, answer: q.originalOptions[Number(choice.slice(7))] });
    fs.appendFileSync(file, JSON.stringify(reply(q.id)) + '\n');
  } };
  const service = await startChatQuestions({ config: { token, sessionId, port: f.bridge.port, chatQuestions: true }, file, app, intervalMs: 20 });
  t.after(() => service.close());
  await until(() => f.state().ui?.message.startsWith('一問目'));
  const first = f.state().ui.id;
  await f.choose(first, 'option-2');
  await until(() => f.state().ui?.message.startsWith('二問目'));
  assert.deepEqual(received, [{ id: '["request_user_input_async","call_batch",0]', answer: '方法Ｃ' }]);
  assert.equal((await f.choose(first, 'option-1')).ok, false);
});

test('a PC answer recorded before dispatch prevents a queued device reply', async t => {
  const dir = temp(t), file = path.join(dir, 'rollout.jsonl');
  fs.writeFileSync(file, records().map(JSON.stringify).join('\n') + '\n');
  const f = await fixture(t); let sent = 0;
  const app = { ready: async () => {}, close() {}, reply: async () => { sent++; } };
  const service = await startChatQuestions({ config: { token, sessionId, port: f.bridge.port, chatQuestions: true }, file, app, intervalMs: 100 });
  t.after(() => service.close());
  await until(() => f.state().ui?.source === 'chat-choice');
  const choosing = f.choose(f.state().ui.id, 'option-0');
  fs.appendFileSync(file, JSON.stringify(reply('["request_user_input_async","call_question",0]')) + '\n');
  await choosing;
  await pause(220); assert.equal(sent, 0);
});
