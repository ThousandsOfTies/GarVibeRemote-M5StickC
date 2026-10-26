// Synthetic loopback fixtures only: never use a real App pipe, rollout or serial port.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const net = require('node:net');
const { EventEmitter } = require('node:events');
const { createRequire } = require('node:module');
const runtime = createRequire(path.join(require('../scripts/runtime.cjs'), 'package.json'));
const { WebSocket, WebSocketServer } = runtime('ws');
const { startCodexBridge } = runtime('./codexBridge.cjs');
const { selectSessions, startSessionMonitor } = require('../scripts/session_monitor.cjs');
const { CodexAppClient } = require('../scripts/codex_app_client.cjs');
const { startDeviceBridge } = require('../scripts/device_bridge.cjs');
const { startSimulatorFeed } = require('../scripts/simulator_feed.cjs');

const token = 'isolated-multi-session-test-authentication';
const anchor = 'isolated-session-alpha';
const other = 'isolated-session-beta';
const projectA = 'D:\\isolated-fixtures\\alpha';
const projectB = 'D:\\isolated-fixtures\\beta';
const rosterOwner = 'isolated-roster-owner-1234';
const questionId = '["request_user_input_async","call_shared",0]';
const pause = ms => new Promise(resolve => setTimeout(resolve, ms));
async function until(check) {
  for (let i = 0; i < 400; i++) { const value = await check(); if (value) return value; await pause(10); }
  throw Error('Isolated multi-session fixture timed out');
}
function row(id = anchor, cwd = projectA, status = 'active', extra = {}) {
  return { id, name: `Fixture ${id}`, kind: 'codex', hostId: 'local', cwd,
    status: { type: status, activeFlags: [] }, ...extra };
}
const rows = () => [row(), row(other, projectB, 'idle')];
const roster = (sessions = rows(), extra = {}) => ({ kind: 'codex-sessions', owner: rosterOwner, sessions, ...extra });
const question = (text = 'Synthetic fixture question') => ({ id: questionId, question: text,
  options: [{ id: 'option-0', label: 'Fixture first' }, { id: 'option-1', label: 'Fixture second' }] });
const questions = (sessionId, extra = {}) => ({ kind: 'chat-choice', sessionId,
  owner: `isolated-question-owner-${sessionId}`, questions: [question()], delivered: [], failed: [], ...extra });
const entry = (state, id) => state.sessions?.find(s => s.session.id === id);

async function fixture(t, options = {}) {
  const cleanups = [];
  t.after(async () => { for (const close of cleanups) await close(); });
  const cleanup = close => cleanups.unshift(close);
  const bridge = await startCodexBridge({ token, sessionId: anchor, label: 'Isolated fixtures',
    sessionScope: 'local', codexCwd: projectA, chatQuestions: true,
    chatQuestionSources: ['m5stickc-plus2-spp', 'm5stickc-plus2-usb'], port: 0, ...options });
  cleanup(() => bridge.close());
  async function request(route, payload, authentication = token) {
    const response = await fetch(`http://127.0.0.1:${bridge.port}${route}`, {
      method: payload === undefined ? 'GET' : 'POST',
      headers: { Authorization: `Bearer ${authentication}`, 'Content-Type': 'application/json' },
      ...(payload === undefined ? {} : { body: JSON.stringify(payload) })
    });
    return { status: response.status, body: await response.json() };
  }
  async function observer() {
    const socket = new WebSocket(bridge.url), messages = [];
    cleanup(() => socket.terminate());
    socket.on('error', () => {});
    socket.on('message', data => messages.push(JSON.parse(String(data))));
    await new Promise((resolve, reject) => { socket.once('open', resolve); socket.once('error', reject); });
    socket.send(JSON.stringify({ type: 'hello', token }));
    await until(() => messages.some(m => m.type === 'sessions' || m.type === 'state'));
    async function choose(sessionId, uiId, actionId = 'option-0', source = 'm5stickc-plus2-spp') {
      const start = messages.length;
      socket.send(JSON.stringify({ type: 'uiAction', token, sessionId, uiId, actionId, source }));
      return until(() => messages.slice(start).find(m => m.type === 'ack'));
    }
    return { socket, messages, choose };
  }
  return { bridge, cleanup, request, observer, state: async () => (await request('/state')).body.state };
}

function fakePorts() {
  const ports = [];
  class Port extends EventEmitter {
    constructor(options) { super(); this.options = options; this.isOpen = false; this.messages = []; ports.push(this); }
    open(cb) { setImmediate(() => { this.isOpen = true; cb(); }); }
    write(data, cb) {
      const message = JSON.parse(String(data)); this.messages.push(message);
      if (message.type === 'hello') setImmediate(() => this.inject({ type: 'deviceInfo', device: 'm5stickc-plus2',
        protocol: 'gar-compact-v1', width: 135, height: 240, transport: 'bluetooth-spp', activeTransport: 'bluetooth-spp' }));
      setImmediate(cb); return true;
    }
    inject(message) {
      const bytes = Buffer.from(JSON.stringify(message) + '\n');
      for (let i = 0; i < bytes.length; i += 3) this.emit('data', bytes.subarray(i, i + 3));
    }
    drain(cb) { setImmediate(cb); }
    close(cb = () => {}) { if (this.isOpen) { this.isOpen = false; this.emit('close'); } setImmediate(cb); }
  }
  return { Port, ports };
}

function rollout(sessionId, title) {
  return [
    { type: 'session_meta', payload: { id: sessionId } },
    { type: 'response_item', timestamp: new Date().toISOString(), payload: { type: 'function_call',
      name: 'request_user_input_async', call_id: 'call_shared',
      arguments: JSON.stringify({ questions: [{ title, options: ['Fixture first', 'Fixture second'] }] }) } },
    { type: 'response_item', payload: { type: 'function_call_output', call_id: 'call_shared', output: '{"accepted":true}' } }
  ].map(JSON.stringify).join('\n') + '\n';
}
function fakeAppFixture(f) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'stickc-multi-session-'));
  f.cleanup(() => fs.rmSync(dir, { recursive: true, force: true }));
  const files = new Map();
  for (const id of [anchor, other]) {
    const file = path.join(dir, `${id}.jsonl`); files.set(id, file);
    fs.writeFileSync(file, rollout(id, `Synthetic question for ${id}`));
  }
  const initialThreads = rows();
  const state = { threads: initialThreads, details: new Map(initialThreads.map(t => [t.id, t])),
    offline: false, allowed: [], replies: [], reads: [], lists: 0 };
  const app = {
    ready: async () => {}, available: () => !state.offline, close() {},
    listThreads: async () => { state.lists++; if (state.offline) throw Error('Synthetic App disconnection'); return [...state.threads]; },
    readThread: async id => {
      state.reads.push(id); const found = state.details.get(id);
      if (!found) throw Error('Synthetic missing chat'); return found;
    },
    allowReplies: ids => { state.allowed = [...ids]; },
    reply: async (q, choiceId, sessionId) => {
      assert.equal(state.allowed.includes(sessionId), true);
      state.replies.push({ sessionId, id: q.id, question: q.originalQuestion,
        choiceId, answer: q.originalOptions[Number(choiceId.slice(7))] });
      fs.appendFileSync(files.get(sessionId), JSON.stringify({ type: 'response_item', payload: { type: 'message', role: 'user',
        content: [{ type: 'input_text', text: '<send_user_message_question_reply>\n' +
          JSON.stringify([{ questionItemId: q.id, question: q.originalQuestion, answer: 'Synthetic fixture reply' }]) +
          '\n</send_user_message_question_reply>' }] } }) + '\n');
    }
  };
  return { dir, files, state, app };
}
async function monitorFixture(f, overrides = {}) {
  const fake = fakeAppFixture(f), events = [];
  const monitor = await startSessionMonitor({ config: { token, port: f.bridge.port, sessionId: anchor,
    sessionScope: 'local', codexCwd: projectA, chatQuestions: true }, app: fake.app,
    resolveFile: id => { assert.equal(fake.files.has(id), true); return fake.files.get(id); },
    journalRoot: path.join(fake.dir, 'journals'), intervalMs: 20, questionIntervalMs: 20,
    onEvent: e => events.push(e), ...overrides });
  f.cleanup(() => monitor.close());
  return { ...fake, monitor, events };
}

test('session discovery includes local Codex chats across projects and preserves scope and roster bounds', () => {
  const config = { sessionScope: 'local', sessionId: anchor, codexCwd: projectA };
  const inventory = [...rows(), row('remote-fixture', projectA, 'active', { hostId: 'remote' }),
    row('chatgpt-fixture', projectA, 'active', { kind: 'chatgpt' }), row('archived-fixture', projectA, 'active', { archived: true }),
    row('history-fixture', projectB, 'notLoaded')];
  assert.deepEqual(selectSessions(inventory, config).sessions.map(s => s.id), [anchor, other]);
  assert.deepEqual(selectSessions([...rows()].reverse(), config, [other, anchor]).sessions.map(s => s.id), [other, anchor]);
  const project = selectSessions(inventory, { ...config, sessionScope: 'project', codexCwd: projectA.toUpperCase() });
  assert.deepEqual(project.sessions.map(s => s.id), [anchor]);
  const manual = selectSessions(inventory, { ...config, sessionScope: 'manual', sessionIds: ['history-fixture', other] });
  assert.deepEqual(new Set(manual.sessions.map(s => s.id)), new Set(['history-fixture', other]));
  const large = [...Array.from({ length: 20 }, (_, i) => row(`bounded-fixture-${i}`, projectB)), row()];
  const bounded = selectSessions(large, config);
  assert.equal(bounded.sessions.length, 16); assert.equal(bounded.overflow, 5);
  assert.equal(bounded.sessions[0].id, anchor);
});

test('active inventory summaries are hydrated with exact runtime waiting flags without messaging a chat', async t => {
  const f = await fixture(t), reads = [];
  const app = {
    ready: async () => {}, close() {}, allowReplies() {},
    listThreads: async () => rows().map(r => ({ ...r, status: 'active' })),
    readThread: async id => { reads.push(id); return { ...row(id,id===anchor ? projectA : projectB),
      status: { type: 'active', activeFlags: [id===anchor ? 'waitingOnApproval' : 'waitingOnUserInput'] } }; },
    reply: async () => { throw Error('This read-only runtime test must never reply'); }
  };
  const monitor = await startSessionMonitor({ config: { token, port: f.bridge.port, sessionId: anchor,
    sessionScope: 'local', codexCwd: projectA, chatQuestions: false }, app, intervalMs: 20 });
  f.cleanup(() => monitor.close());
  const current = await f.state();
  assert.ok(reads.includes(anchor) && reads.includes(other));
  assert.equal(entry(current,anchor).ui.message,'承認待ち');
  assert.equal(entry(current,other).ui.message,'回答待ち');
  assert.deepEqual(entry(current,anchor).ui.actions,[]);
});

test('monitor retains an existing chat outside the recent inventory only while its details remain available', async t => {
  const f = await fixture(t), m = await monitorFixture(f);
  const initial = await until(async () => {
    const s = await f.state(); return entry(s, other)?.ui?.source === 'chat-choice' && s;
  });
  const originalUi = entry(initial, other).ui.id, initialLists = m.state.lists;
  m.state.threads = [row()]; // The recent list no longer contains the second project.
  await until(() => m.state.reads.includes(other) && m.state.lists >= initialLists + 2);
  assert.deepEqual(m.monitor.snapshot().sessions.map(s => s.id), [anchor, other]);
  assert.deepEqual(m.state.allowed, [anchor, other]);
  assert.equal(entry(await f.state(), other).ui.id, originalUi);
  m.state.details.delete(other); // A later readThread failure must remove that same chat.
  await until(() => !m.monitor.snapshot().sessions.some(s => s.id === other));
  assert.equal(m.state.allowed.includes(other), false);
  assert.equal(entry(await f.state(), other), undefined);
  assert.equal((await f.request('/chat-questions', questions(other))).status, 404);
});

test('a full roster retains all sixteen idle chats when a new active chat enters the inventory', async t => {
  const f = await fixture(t, { chatQuestions: false });
  const existing = [row(anchor, projectA, 'idle'),
    ...Array.from({ length: 15 }, (_, i) => row(`retained-idle-fixture-${i}`, projectB, 'idle'))];
  const expectedIds = existing.map(s => s.id);
  let inventory = [...existing], allowed = [];
  const app = {
    ready: async () => {}, close() {}, available: () => true,
    listThreads: async () => [...inventory], readThread: async () => { throw Error('Synthetic missing chat'); },
    allowReplies: ids => { allowed = [...ids]; }, reply: async () => { throw Error('Unexpected fixture dispatch'); }
  };
  const monitor = await startSessionMonitor({ config: { token, port: f.bridge.port, sessionId: anchor,
    sessionScope: 'local', codexCwd: projectA, chatQuestions: false }, app, intervalMs: 20 });
  f.cleanup(() => monitor.close());
  assert.deepEqual(monitor.snapshot().sessions.map(s => s.id), expectedIds);
  const newcomer = row('new-active-fixture', projectB, 'active');
  inventory = [newcomer, ...existing];
  await until(() => monitor.snapshot().overflow === 1);
  assert.deepEqual(monitor.snapshot().sessions.map(s => s.id), expectedIds);
  assert.deepEqual(allowed, expectedIds);
  assert.deepEqual((await f.state()).sessions.map(s => s.session.id), expectedIds);
  inventory = inventory.filter(s => s.id !== expectedIds.at(-1));
  await until(() => monitor.snapshot().overflow === 0 && monitor.snapshot().sessions.some(s => s.id === newcomer.id));
  assert.deepEqual(monitor.snapshot().sessions.map(s => s.id), [...expectedIds.slice(0, -1), newcomer.id]);
});

test('monitor and fake physical bridge route two simultaneous questions with identical native IDs to their own chats', async t => {
  const f = await fixture(t), m = await monitorFixture(f), observer = await f.observer();
  const { Port, ports } = fakePorts(), deviceEvents = [];
  const deviceBridge = startDeviceBridge({ SerialPort: Port, WebSocket, url: f.bridge.url, token,
    port: 'ISOLATED_FAKE_PORT', transport: 'spp', onEvent: e => deviceEvents.push(e) });
  f.cleanup(() => deviceBridge.close());
  const device = await until(() => ports[0]?.messages.some(s => s.type === 'sessions' &&
    s.sessions.length === 2 && s.sessions.every(e => e.ui?.state === 'waiting' && e.ui?.actions.length === 2)) && ports[0]);
  assert.equal(device.options.path, 'ISOLATED_FAKE_PORT');
  const state = await f.state(), uiA = entry(state, anchor).ui.id, uiB = entry(state, other).ui.id;
  assert.notEqual(uiA, uiB);
  assert.deepEqual(m.state.allowed, [anchor, other]);
  assert.equal((await observer.choose(undefined, uiA)).ok, false);
  assert.equal((await observer.choose(other, uiA)).ok, false);
  assert.equal((await observer.choose(anchor, uiA, 'option-0', 'browser')).ok, false);
  const choose = async (sessionId, uiId, actionId) => {
    const start = device.messages.length;
    device.inject({ type: 'uiAction', sessionId, uiId, actionId });
    return until(() => device.messages.slice(start).find(msg => msg.type === 'ack' && msg.uiId === uiId));
  };
  assert.equal((await choose(other, uiB, 'option-1')).ok, true);
  await until(() => m.state.replies.length === 1);
  assert.equal((await choose(anchor, uiA, 'option-0')).ok, true);
  await until(() => m.state.replies.length === 2);
  assert.deepEqual(m.state.replies.map(r => ({ sessionId: r.sessionId, id: r.id, choiceId: r.choiceId, answer: r.answer })), [
    { sessionId: other, id: questionId, choiceId: 'option-1', answer: 'Fixture second' },
    { sessionId: anchor, id: questionId, choiceId: 'option-0', answer: 'Fixture first' }
  ]);
  assert.equal(m.state.replies.every(r => r.question === `Synthetic question for ${r.sessionId}`), true);
  const before = deviceEvents.filter(e => e.event === 'answer-sent').length;
  assert.equal((await choose(other, uiB, 'option-1')).ok, true); // Local acknowledgement, never a second dispatch.
  assert.equal(deviceEvents.filter(e => e.event === 'answer-sent').length, before);
  assert.equal((await observer.choose(other, uiB, 'option-1')).ok, false);
  assert.equal(m.state.replies.length, 2);
  assert.equal(JSON.stringify(device.messages).includes(token), false);
});

test('removal and lease expiry reject old answers without affecting another session', async t => {
  let now = 10000;
  const f = await fixture(t, { now: () => now }), observer = await f.observer();
  assert.equal((await f.request('/sessions', roster())).status, 200);
  for (const id of [anchor, other]) assert.equal((await f.request('/chat-questions', questions(id))).status, 200);
  const initial = await f.state(), uiA = entry(initial, anchor).ui.id, uiB = entry(initial, other).ui.id;
  assert.equal((await observer.choose(anchor, uiA)).ok, true);
  assert.equal((await observer.choose(anchor, uiA)).ok, false);
  assert.equal((await f.request('/chat-questions', questions(other))).body.answers.length, 0);
  assert.equal((await f.request('/sessions', roster([row()]))).status, 200);
  assert.equal((await observer.choose(other, uiB)).ok, false);
  assert.equal((await f.request('/chat-questions', questions(other))).status, 404);
  const answerA = (await f.request('/chat-questions', questions(anchor))).body.answers;
  assert.deepEqual(answerA, [{ id: questionId, choiceId: 'option-0', source: 'm5stickc-plus2-spp' }]);
  assert.equal((await f.request('/sessions', roster())).status, 200);
  assert.equal((await f.request('/chat-questions', questions(other))).status, 200);
  const freshB = entry(await f.state(), other).ui.id;
  assert.notEqual(freshB, uiB); assert.equal((await observer.choose(other, uiB)).ok, false);
  now += 5001;
  assert.equal((await observer.choose(other, freshB)).ok, false);
  assert.equal((await f.request('/chat-questions', questions(other))).status, 200);
  assert.notEqual(entry(await f.state(), other).ui.id, freshB);
  now += 15001;
  const expired = await f.state();
  assert.equal(expired.sessions.length, 1);
  assert.equal(expired.sessions[0].ui.id, 'session-collector-unavailable');
  assert.equal((await f.request('/chat-questions', questions(other))).status, 404);
  assert.equal((await observer.choose(anchor, uiA)).ok, false);
});

test('bridge rejects duplicate, remote and competing rosters and enforces project/manual/single scopes', async t => {
  const f = await fixture(t);
  assert.equal((await f.request('/sessions', roster(), 'invalid-fixture-authentication')).status, 401);
  assert.equal((await f.request('/sessions', roster())).status, 200);
  for (const invalid of [[row(), row()], [row('remote-fixture', projectA, 'active', { hostId: 'remote' })],
    [row('chatgpt-fixture', projectA, 'active', { kind: 'chatgpt' })]]) {
    assert.equal((await f.request('/sessions', roster(invalid))).status, 400);
    assert.deepEqual((await f.state()).sessions.map(s => s.session.id), [anchor, other]);
  }
  assert.equal((await f.request('/sessions', roster([], { owner: 'another-isolated-roster-owner' }))).status, 409);
  assert.equal((await f.request('/sessions', roster([], { release: true }))).status, 200);
  assert.equal((await f.request('/sessions', roster([row()], { owner: 'another-isolated-roster-owner' }))).status, 200);
  const project = await fixture(t, { sessionScope: 'project' });
  assert.equal((await project.request('/sessions', roster())).status, 400);
  assert.equal((await project.request('/sessions', roster([row(anchor, projectA.toUpperCase())]))).status, 200);
  const manual = await fixture(t, { sessionScope: 'manual', sessionIds: [other] });
  assert.equal((await manual.request('/sessions', roster([row()]))).status, 400);
  assert.equal((await manual.request('/sessions', roster([row(other, projectB)]))).status, 200);
  const single = await fixture(t, { sessionScope: 'single' });
  assert.equal((await single.request('/sessions', roster())).status, 403);
  assert.equal((await single.state()).type, 'state');
});

test('App disconnection disables dispatch, expires questions and recovers with fresh UI identities', async t => {
  let now = 10000;
  const f = await fixture(t, { now: () => now }), m = await monitorFixture(f, { now: () => now }), observer = await f.observer();
  const first = await until(async () => { const s = await f.state(); return entry(s, other)?.ui?.source === 'chat-choice' && s; });
  const oldUi = entry(first, other).ui.id;
  m.state.offline = true;
  await until(() => m.state.allowed.length === 0 && m.events.some(e => e.event === 'session-inventory-unavailable'));
  now += 5001;
  assert.equal((await observer.choose(other, oldUi)).ok, false);
  assert.equal(m.state.replies.length, 0);
  m.state.offline = false;
  const recovered = await until(async () => {
    const s = await f.state(), e = entry(s, other);
    return m.state.allowed.includes(other) && e?.ui?.source === 'chat-choice' && e.ui.id !== oldUi && s;
  });
  assert.equal((await observer.choose(other, oldUi)).ok, false);
  assert.equal((await observer.choose(other, entry(recovered, other).ui.id, 'option-1')).ok, true);
  await until(() => m.state.replies.length === 1);
  assert.equal(m.state.replies[0].sessionId, other);
});

test('App pipe keeps the anchor caller and exact target chat and rejects replies after removal', async t => {
  const calls = [], sockets = new Set();
  const replies=[];
  const nativeReplies={async reply(question,choiceId,sessionId,beforeSend){beforeSend();replies.push({question,choiceId,sessionId})},close(){}};
  const server = net.createServer(socket => {
    sockets.add(socket); socket.on('close', () => sockets.delete(socket)); let data = Buffer.alloc(0);
    socket.on('data', chunk => {
      data = Buffer.concat([data, chunk]);
      while (data.length >= 4 && data.length >= data.readUInt32LE() + 4) {
        const size = data.readUInt32LE(), message = JSON.parse(data.subarray(4, size + 4)); data = data.subarray(size + 4);
        let result;
        if (message.method === 'tools/list') result = { tools: ['list_threads','read_thread'].map(name=>({name,namespace:'codex_app'})) };
        else {
          calls.push(message);
          const content = message.params.tool === 'list_threads' ? { pinnedThreads: [row()], threads: [row(other, projectB)] } :
            message.params.tool === 'read_thread' ? { thread: row(other, projectB) } : {};
          result = { success: true, contentItems: [{ type: 'inputText', text: JSON.stringify(content) }] };
        }
        const bytes = Buffer.from(JSON.stringify({ id: message.id, jsonrpc: '2.0', result })), header = Buffer.alloc(4);
        header.writeUInt32LE(bytes.length); socket.write(Buffer.concat([header, bytes.subarray(0, 5)]));
        setImmediate(() => socket.write(bytes.subarray(5)));
      }
    });
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const client = new CodexAppClient({ pipePath: { host: '127.0.0.1', port: server.address().port }, sessionId: anchor, nativeReplies });
  t.after(async () => { client.close(); for (const socket of sockets) socket.destroy(); await new Promise(resolve => server.close(resolve)); });
  await client.ready();
  assert.deepEqual((await client.listThreads()).map(s => s.id), [anchor, other]);
  assert.equal((await client.readThread(other)).id, other);
  client.allowReplies([anchor, other]);
  await client.reply({ id: questionId, originalQuestion: 'Synthetic fixture question', originalOptions: ['First', 'Second'] }, 'option-1', other);
  assert.ok(calls.every(m=>m.params.threadId===anchor));
  assert.equal(calls.some(m=>m.params.tool==='send_message_to_thread'),false);
  assert.equal(replies[0].sessionId,other); assert.equal(replies[0].question.id,questionId);
  assert.equal(replies[0].choiceId,'option-1');
  client.allowReplies([anchor]);
  const count = calls.length;
  await assert.rejects(client.reply({ id: questionId, originalQuestion: 'Synthetic fixture question', originalOptions: ['First', 'Second'] }, 'option-0', other));
  assert.equal(calls.length, count);
  assert.equal(replies.length,1);
});

test('multi-session browser feed exposes both identities but remains read-only and clears on bridge loss', async t => {
  const f = await fixture(t);
  await f.request('/sessions', roster());
  for (const id of [anchor, other]) await f.request('/chat-questions', questions(id));
  const origin = `http://127.0.0.1:${f.bridge.port}`;
  const feed = await startSimulatorFeed({ WebSocket, WebSocketServer, port: 0, url: f.bridge.url, token, origins: [origin], retryMs: 20 });
  f.cleanup(() => feed.close());
  const browser = () => {
    const socket = new WebSocket(`ws://127.0.0.1:${feed.port}/state`, { origin }), messages = [];
    socket.on('error', () => {}); socket.on('message', data => messages.push(JSON.parse(String(data))));
    f.cleanup(() => socket.terminate()); return { socket, messages };
  };
  const view = browser(), observer = browser();
  const state = await until(() => view.messages.find(m => m.type === 'sessions' && m.sessions.length === 2));
  assert.deepEqual(state.sessions.map(s => s.session.id), [anchor, other]);
  assert.equal(state.sessions.every(s => s.ui.actions.length === 2), true);
  assert.equal(JSON.stringify(view.messages).includes(token), false);
  const closed = new Promise(resolve => view.socket.once('close', resolve));
  view.socket.send(JSON.stringify({ type: 'uiAction', sessionId: other, uiId: entry(state, other).ui.id, actionId: 'option-0' }));
  assert.equal(await closed, 1008);
  for (const id of [anchor, other]) assert.deepEqual((await f.request('/chat-questions', questions(id))).body.answers, []);
  await f.bridge.close();
  await until(() => observer.messages.at(-1)?.type === 'connection' && !observer.messages.at(-1).connected);
  const fresh = browser(); await until(() => fresh.messages.length);
  assert.deepEqual(fresh.messages, [{ type: 'connection', connected: false }]);
});
