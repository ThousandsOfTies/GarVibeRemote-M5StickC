#!/usr/bin/env node
// An isolated real-device test. Synthetic events/questions never grant permission.
const { createRequire } = require('node:module');
const path = require('node:path');
const crypto = require('node:crypto');
const { startDeviceBridge } = require('./device_bridge.cjs');
const pause = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
async function main() {
  const runtime = createRequire(path.resolve(process.argv[2], 'package.json'));
  const args = process.argv.slice(3),
    get = (name, fallback) => (args.includes(name) ? args[args.indexOf(name) + 1] : fallback);
  const port = get('--port'),
    transport = get('--transport'),
    duration = Number(get('--duration', 60));
  if (
    !port ||
    !['spp', 'usb'].includes(transport) ||
    !Number.isFinite(duration) ||
    duration < 1 ||
    duration > 300
  )
    throw Error('arguments');
  const { SerialPort } = runtime('serialport'),
    { WebSocket } = runtime('ws');
  const { startCodexBridge } = runtime('./codexBridge.cjs');
  const token = crypto.randomBytes(24).toString('hex'),
    sessionId = 'stickc-interface-test';
  const backend = await startCodexBridge({ port: 0, token, sessionId, label: '接続の試験' });
  let snapshot,
    deviceReady = false,
    stopping = false;
  const bridge = startDeviceBridge({
    SerialPort,
    WebSocket,
    url: backend.url,
    token,
    port,
    transport,
    onEvent: (event) => {
      console.log(JSON.stringify(event));
      if (event.event === 'device-ready') deviceReady = true;
      if (event.event === 'wrong-device') stopping = true;
    },
    onSnapshot: (value) => {
      snapshot = value;
    }
  });
  for (const signal of ['SIGINT', 'SIGTERM'])
    process.once(signal, () => {
      stopping = true;
    });
  const ticker = setInterval(() => bridge.snapshot(), 500);
  const request = async (route, body) => {
    const response = await fetch(`http://127.0.0.1:${backend.port}${route}`, {
      method: body === undefined ? 'GET' : 'POST',
      signal: AbortSignal.timeout(3000),
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
      ...(body === undefined ? {} : { body: JSON.stringify(body) })
    });
    if (!response.ok) throw Error('test-request');
    return response.json();
  };
  const until = async (check) => {
    for (let i = 0; i < 160; i++) {
      if (stopping) throw Error('stopped');
      if (check()) return;
      await pause(100);
    }
    throw Error('device-timeout');
  };
  try {
    await until(() => deviceReady);
    await request('/events', {
      hook_event_name: 'UserPromptSubmit',
      session_id: sessionId,
      turn_id: 'interface-trial',
      delivery: 'test'
    });
    await until(
      () => snapshot?.connected && snapshot.sessionId === sessionId && snapshot.state === 'running'
    );
    console.log(
      JSON.stringify({ event: 'lifecycle-delivered', scope: 'physical-interface-test', transport })
    );
    const created = await request('/input-test', {}),
      id = created.test.id;
    await until(() => snapshot?.uiId === id && snapshot.state === 'waiting');
    console.log(
      JSON.stringify({
        event: 'question-delivered',
        scope: 'physical-interface-test',
        instruction: 'CでYES/NOを選び、Aで決定してください。'
      })
    );
    const started = Date.now();
    let answer;
    while (!stopping && Date.now() - started < duration * 1000) {
      const result = await request('/input-test');
      if (result.test?.status === 'answered') {
        answer = result.test;
        break;
      }
      await pause(250);
    }
    console.log(
      JSON.stringify({
        status: 'passed',
        scope: 'physical-interface-test',
        transport,
        displayReadback: true,
        deviceInput: answer ? 'received' : 'not-checked',
        answer: answer?.answer,
        source: answer?.source
      })
    );
  } finally {
    clearInterval(ticker);
    await bridge.close();
    await backend.close();
  }
}
if (require.main === module)
  main().catch(() => {
    console.error(
      '実機接続試験を完了できませんでした。ペアリング・COMポート・他の接続中継を確認してください。'
    );
    process.exitCode = 1;
  });
