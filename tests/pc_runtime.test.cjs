// Startup and lifetime checks use isolated files and a local fake App pipe only.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const net = require('node:net');
const { readPcConfig } = require('../scripts/pc_config.cjs');
const { CodexAppClient } = require('../scripts/codex_app_client.cjs');
const { startChatQuestions } = require('../scripts/question_service.cjs');
const { NativeQuestionLog } = require('../scripts/native_question_log.cjs');

function temporary(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'stickc-runtime-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return dir;
}
const config = { token: 'isolated-private-config-token', port: 39999, sessionId: 'chat-a' };

test('PC configuration uses the same strict contract at every Node entry point and redacts errors', (t) => {
  const file = path.join(temporary(t), 'settings.json');
  fs.writeFileSync(file, '\uFEFF' + JSON.stringify({ ...config, custom: 'preserved' }));
  assert.equal(readPcConfig(file).custom, 'preserved');
  for (const change of [
    { port: 0 },
    { port: 12.5 },
    { port: '39999' },
    { token: 'secret invalid token' },
    { sessionScope: 'unknown' },
    { sessionScope: null },
    { sessionScope: 'local', sessionId: null },
    { sessionScope: 'manual', sessionIds: ['a', 'a'] },
    { sessionScope: 'project' },
    { chatQuestions: 'false' },
    { watchInput: 'true' },
    { chatQuestions: true, sessionId: null },
    { label: 'bad\nlabel' },
    { label: 'bad\u007flabel' }
  ]) {
    fs.writeFileSync(file, JSON.stringify({ ...config, ...change }));
    assert.throws(
      () => readPcConfig(file),
      (e) => !e.message.includes(config.token) && !e.message.includes('secret invalid token')
    );
  }
  fs.writeFileSync(file, 'PRIVATE_INVALID_JSON');
  assert.throws(
    () => readPcConfig(file),
    (e) => !e.message.includes('PRIVATE_INVALID_JSON')
  );
});

test('a reply revoked while reconnecting is rejected before any bytes are sent', async () => {
  const client = new CodexAppClient({ pipePath: 'unused-fixture', sessionId: 'chat-a' });
  let resume,
    writes = 0;
  client.connect = () =>
    new Promise((resolve) => {
      resume = resolve;
    });
  client.socket = {
    write: () => {
      writes++;
    },
    destroy() {}
  };
  const sending = client.reply(
    { id: 'original', originalQuestion: 'Fixture?', originalOptions: ['First', 'Second'] },
    'option-0'
  );
  client.allowReplies([]);
  resume();
  await assert.rejects(sending, /no longer monitored/);
  assert.equal(writes, 0);
  assert.equal(client.pending.size, 0);
});

test('closing an in-progress App connection settles its startup promise', async (t) => {
  const server = net.createServer((socket) => socket.destroy());
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise((resolve) => server.close(resolve)));
  const client = new CodexAppClient({
    pipePath: { host: '127.0.0.1', port: server.address().port },
    sessionId: 'chat-a'
  });
  const connecting = client.connect();
  client.close();
  await assert.rejects(connecting, /connection (closed|failed)/);
  assert.equal(client.connecting, undefined);
});

test('simulator feed loads without the physical serial bridge or its native dependencies', () => {
  require('../scripts/simulator_feed.cjs');
  assert.ok(!require.cache[require.resolve('../scripts/device_bridge.cjs')]);
  assert.ok(
    !Object.keys(require.cache).some((file) =>
      /[\\/]node_modules[\\/](?:@serialport|serialport)[\\/]/.test(file)
    )
  );
});

test('an invalid App response closes the connection instead of crashing the reader', () => {
  for (const value of [null, [], 42, 'unexpected']) {
    const client = new CodexAppClient({ pipePath: 'unused-fixture', sessionId: 'chat-a' });
    let closed = 0;
    client.socket = {
      destroy() {
        closed++;
      }
    };
    const body = Buffer.from(JSON.stringify(value)),
      header = Buffer.alloc(4);
    header.writeUInt32LE(body.length);
    client.receive(Buffer.concat([header, body]));
    assert.equal(closed, 1);
  }
});

test('a question-worker startup failure closes its App client', async (t) => {
  const file = path.join(temporary(t), 'rollout.jsonl');
  fs.writeFileSync(file, '');
  let closed = 0;
  const app = {
    ready: async () => {
      throw Error('Fixture startup failure');
    },
    close() {
      closed++;
    }
  };
  await assert.rejects(
    startChatQuestions({ config: { ...config, chatQuestions: true }, file, app }),
    /startup failure/
  );
  assert.equal(closed, 1);
});

test('completed native user messages resolve cards only for their own chat, never for tool output', () => {
  const model = new NativeQuestionLog('chat-a');
  for (const argumentsValue of ['null', '42', '[]']) {
    model.consume({
      type: 'response_item',
      payload: {
        type: 'function_call',
        name: 'request_user_input_async',
        call_id: 'malformed',
        arguments: argumentsValue
      }
    });
  }
  model.consume({ type: 'response_item', payload: { type: 'function_call', name: 42 } });
  model.consume({
    type: 'response_item',
    timestamp: new Date().toISOString(),
    payload: {
      type: 'function_call',
      name: 'request_user_input_async',
      call_id: 'call_fixture',
      arguments: JSON.stringify({
        questions: [{ title: 'Fixture?', options: ['First', 'Second'] }]
      })
    }
  });
  model.consume({
    type: 'response_item',
    payload: { type: 'function_call_output', call_id: 'call_fixture', output: '{"accepted":true}' }
  });
  const id = model.pending()[0].id;
  const content = [
    {
      type: 'text',
      text:
        '<send_user_message_question_reply>\n' +
        JSON.stringify([{ questionItemId: id, question: 'Fixture?', answer: 'First' }]) +
        '\n</send_user_message_question_reply>'
    }
  ];
  const item = { type: 'UserMessage', content };
  model.consume({
    type: 'event_msg',
    payload: { type: 'item_completed', thread_id: 'other-chat', item }
  });
  model.consume({
    type: 'event_msg',
    payload: {
      type: 'item_completed',
      thread_id: 'chat-a',
      item: { ...item, type: 'FunctionCallOutput' }
    }
  });
  model.consume({
    type: 'response_item',
    payload: { type: 'message', role: 'assistant', content }
  });
  model.consume({
    type: 'response_item',
    payload: { type: 'message', role: 'user', content: 'malformed' }
  });
  assert.equal(model.pending().length, 1);
  model.consume({
    type: 'event_msg',
    payload: { type: 'item_completed', thread_id: 'chat-a', item }
  });
  assert.equal(model.pending().length, 0);
});
