#!/usr/bin/env node
// Read-only localhost feed. Static HTTP serving and physical SPP stay separate.
const http = require('node:http');
const { readPcConfig } = require('./pc_config.cjs');
const { compactState } = require('./device_protocol.cjs');

async function startSimulatorFeed(options) {
  const { WebSocket, WebSocketServer, token } = options;
  const now = options.now ?? Date.now,
    log = options.onEvent ?? (() => {});
  const origins = new Set(options.origins ?? ['http://127.0.0.1:8772', 'http://localhost:8772']);
  const peers = new Set(),
    wss = new WebSocketServer({ noServer: true, maxPayload: 1024 });
  let socket,
    retry,
    lastMessage = 0,
    authenticated = false,
    latest,
    stopped = false;
  const send = (peer, value) => {
    if (peer.readyState === WebSocket.OPEN) peer.send(JSON.stringify(value));
  };
  const broadcast = (value) => {
    for (const peer of peers) send(peer, value);
  };
  const connected = () => authenticated && Boolean(latest);
  function offline() {
    authenticated = false;
    latest = undefined;
    broadcast({ type: 'connection', connected: false });
  }
  function connect() {
    if (stopped) return;
    const current = new WebSocket(options.url, { maxPayload: 65536 });
    socket = current;
    lastMessage = now();
    current.on('error', () => log({ event: 'upstream-error' }));
    current.on('open', () => current.send(JSON.stringify({ type: 'hello', token })));
    current.on('message', (raw) => {
      if (socket !== current) return;
      try {
        const value = JSON.parse(String(raw));
        if (value.type === 'ack') {
          if (value.ok !== true) {
            log({ event: 'authentication-failed' });
            current.terminate();
            return;
          }
          authenticated = true;
          lastMessage = now();
          return;
        }
        if (!authenticated) return;
        const sessions =
          value.type === 'state'
            ? [compactState(value, options)]
            : value.type === 'sessions'
              ? value.sessions.map((s) => compactState({ ...s, type: 'state' }, options))
              : undefined;
        if (!sessions) return;
        if (
          sessions.length > 16 ||
          new Set(sessions.map((s) => s.session.id)).size !== sessions.length
        )
          throw Error('sessions');
        const next = { type: 'sessions', sessions };
        if (Buffer.byteLength(JSON.stringify(next)) > 65536) throw Error('size');
        const first = !latest;
        latest = next;
        lastMessage = now();
        broadcast(latest);
        broadcast({ type: 'connection', connected: true });
        if (first) log({ event: 'live-state-received' });
      } catch {
        log({ event: 'invalid-upstream-message' });
        current.terminate();
      }
    });
    current.on('close', () => {
      if (socket !== current) return;
      socket = undefined;
      offline();
      log({ event: 'upstream-disconnected' });
      if (!stopped) retry = setTimeout(connect, options.retryMs ?? 3000);
    });
  }
  const server = http.createServer((req, res) => {
    const host = req.headers.host ?? '';
    if (
      !/^(127\.0\.0\.1|localhost):\d+$/.test(host) ||
      req.url !== '/health' ||
      req.method !== 'GET'
    ) {
      res.writeHead(404);
      res.end();
      return;
    }
    res.writeHead(200, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
    res.end(JSON.stringify({ ok: true, mode: 'read-only', connected: connected() }));
  });
  server.on('upgrade', (req, stream, head) => {
    if (
      req.url !== '/state' ||
      !origins.has(req.headers.origin) ||
      peers.size >= 8 ||
      !/^(127\.0\.0\.1|localhost):\d+$/.test(req.headers.host ?? '')
    ) {
      stream.end('HTTP/1.1 403 Forbidden\r\n\r\n');
      return;
    }
    wss.handleUpgrade(req, stream, head, (peer) => {
      peers.add(peer);
      peer.on('error', () => {});
      peer.on('close', () => peers.delete(peer));
      // Browsers cannot submit an answer, event, command or token through this feed.
      peer.on('message', () => peer.close(1008, 'Read-only feed'));
      send(peer, { type: 'connection', connected: connected() });
      if (latest) send(peer, latest);
    });
  });
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(options.port ?? 8775, '127.0.0.1', resolve);
  });
  const port = server.address().port;
  const ticker = setInterval(() => {
    if (socket && now() - lastMessage > 6000) socket.terminate();
  }, 1000);
  connect();
  return {
    port,
    close: async () => {
      if (stopped) return;
      stopped = true;
      clearInterval(ticker);
      clearTimeout(retry);
      const old = socket;
      socket = undefined;
      old?.terminate();
      for (const peer of peers) peer.terminate();
      await new Promise((resolve) => wss.close(resolve));
      await new Promise((resolve) => server.close(resolve));
    }
  };
}

async function main() {
  const args = process.argv.slice(2),
    get = (name, fallback) => (args.includes(name) ? args[args.indexOf(name) + 1] : fallback);
  const config = readPcConfig(get('--config'));
  const port = Number(get('--port', 8775)),
    panelPort = Number(get('--panel-port', 8772));
  if (![port, panelPort].every((p) => Number.isInteger(p) && p > 0 && p <= 65535))
    throw Error('config');
  const { WebSocket, WebSocketServer } = require('ws');
  const feed = await startSimulatorFeed({
    WebSocket,
    WebSocketServer,
    token: config.token,
    url: `ws://127.0.0.1:${config.port}`,
    port,
    sessionId: config.sessionId,
    label: config.label,
    origins: [`http://127.0.0.1:${panelPort}`, `http://localhost:${panelPort}`],
    onEvent: (event) => console.log(JSON.stringify(event))
  });
  console.log(
    JSON.stringify({ event: 'simulator-feed-listening', port: feed.port, mode: 'read-only' })
  );
  for (const signal of ['SIGINT', 'SIGTERM'])
    process.once(signal, () => feed.close().then(() => process.exit(0)));
}
if (require.main === module)
  main().catch(() => {
    console.error(
      '本番表示の中継を起動できません。設定と使用中ポートを確認してください（秘密の値は非表示）。'
    );
    process.exitCode = 1;
  });
module.exports = { startSimulatorFeed };
