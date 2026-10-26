#!/usr/bin/env node
// Isolated PC loopback test. It never loads the user's config or real hooks.
const path = require('node:path');
const crypto = require('node:crypto');
const { createRequire } = require('node:module');
const assert = require('node:assert/strict');
const pause = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function main() {
  const runtime = path.resolve(process.argv[2]);
  const runtimeRequire = createRequire(path.join(runtime, 'package.json'));
  const { WebSocket } = runtimeRequire('ws');
  const { startCodexBridge } = runtimeRequire('./codexBridge.cjs');
  const token = crypto.randomBytes(24).toString('hex'),
    sessionId = 'pc-selftest',
    messages = [],
    checks = [];
  const bridge = await startCodexBridge({
    port: 0,
    token,
    sessionId,
    label: 'PC接続試験',
    watchInput: true
  });
  let socket;
  const request = async (route, body, authorized = true) => {
    const response = await fetch(`http://127.0.0.1:${bridge.port}${route}`, {
      method: body === undefined ? 'GET' : 'POST',
      signal: AbortSignal.timeout(3000),
      headers: {
        'Content-Type': 'application/json',
        ...(authorized ? { Authorization: `Bearer ${token}` } : {})
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) })
    });
    return { code: response.status, data: await response.json() };
  };
  const next = async (predicate) => {
    const until = Date.now() + 3000;
    while (Date.now() < until) {
      const i = messages.findIndex(predicate);
      if (i >= 0) return messages.splice(i, 1)[0];
      await pause(10);
    }
    throw Error('Timed out');
  };
  try {
    assert.equal((await request('/health')).data.ok, true);
    checks.push('http-health');
    assert.equal((await request('/state', undefined, false)).code, 401);
    checks.push('authentication');
    socket = new WebSocket(bridge.url);
    socket.on('message', (raw) => messages.push(JSON.parse(String(raw))));
    await new Promise((resolve, reject) => {
      socket.once('open', resolve);
      socket.once('error', reject);
    });
    socket.send(JSON.stringify({ type: 'hello', token }));
    await next((m) => m.type === 'ack' && m.ok === true);
    await next((m) => m.type === 'state');
    checks.push('websocket-hello');
    const response = await request('/events', {
      hook_event_name: 'UserPromptSubmit',
      session_id: sessionId,
      turn_id: 'test-turn',
      delivery: 'test',
      prompt: 'PRIVATE-SELFTEST-PROMPT',
      tool_input: { command: 'PRIVATE-SELFTEST-COMMAND' }
    });
    assert.equal(response.data.accepted, true);
    const state = await next((m) => m.type === 'state' && m.agent?.status === 'running');
    assert.equal(state.session.id, sessionId);
    assert.doesNotMatch(JSON.stringify(state), /PRIVATE-SELFTEST/);
    checks.push('event-to-status', 'metadata-only');
    const created = await request('/interactions', {
      kind: 'question',
      sessionId,
      turnId: 'test-turn',
      message: 'PC内の往復接続試験です。',
      timeoutMs: 10000
    });
    assert.equal(created.code, 201);
    const { id, receipt } = created.data.interaction;
    await next((m) => m.type === 'state' && m.ui?.id === id);
    socket.send(
      JSON.stringify({
        type: 'uiAction',
        token,
        uiId: 'expired-question',
        actionId: 'yes',
        source: 'pc-selftest'
      })
    );
    await next((m) => m.type === 'ack' && m.ok === false);
    checks.push('stale-answer-rejected');
    socket.send(
      JSON.stringify({ type: 'uiAction', token, uiId: id, actionId: 'yes', source: 'pc-selftest' })
    );
    await next((m) => m.type === 'ack' && m.ok === true);
    const result = await request(`/interactions/${id}/poll`, { receipt });
    assert.equal(result.data.interaction.status, 'answered');
    assert.equal(result.data.interaction.answer, 'yes');
    assert.equal(result.data.interaction.source, 'pc-selftest');
    checks.push('question-answer-roundtrip');
    console.log(
      JSON.stringify({ status: 'passed', scope: 'pc-loopback', deviceConnected: false, checks })
    );
  } finally {
    socket?.terminate();
    await bridge.close();
  }
}
if (require.main === module)
  main().catch(() => {
    console.error(
      JSON.stringify({ status: 'failed', scope: 'pc-loopback', deviceConnected: false })
    );
    process.exitCode = 1;
  });
