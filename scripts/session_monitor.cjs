#!/usr/bin/env node
// Read-only discovery + per-chat ordinary questions. No new chats, UI automation or hook edits.
const path = require('node:path');
const { randomBytes } = require('node:crypto');
const { CodexAppClient } = require('./codex_app_client.cjs');
const { findRollout } = require('./native_question_log.cjs');
const { startChatQuestions } = require('./question_service.cjs');
const { readPcConfig, isSessionId: validId } = require('./pc_config.cjs');
const normalize = (s) =>
  process.platform === 'win32' || /^[a-z]:[/\\]/i.test(s)
    ? path.win32.resolve(s).toLowerCase()
    : path.resolve(s);
function cleanName(s) {
  if (typeof s !== 'string') return 'Codex';
  let out = '';
  for (const char of s.replace(/\p{Cc}/gu, ' ')) {
    if (Buffer.byteLength(out + char) > 512) break;
    out += char;
  }
  return out.trim() || 'Codex';
}
function selectSessions(threads, config, previous = []) {
  if (!['project', 'local', 'manual'].includes(config.sessionScope))
    throw Error('Select a multi-session scope');
  if (config.sessionScope === 'project' && !config.codexCwd)
    throw Error('A project directory is required');
  const manual = new Set(config.sessionIds ?? []),
    candidates = new Map();
  for (const t of threads) {
    if (
      !t ||
      !validId(t.id) ||
      t.kind !== 'codex' ||
      t.hostId !== 'local' ||
      typeof t.cwd !== 'string' ||
      !t.cwd ||
      t.archived === true
    )
      continue;
    if (config.sessionScope === 'project' && normalize(t.cwd) !== normalize(config.codexCwd))
      continue;
    if (config.sessionScope === 'manual' && !manual.has(t.id)) continue;
    const status = typeof t.status === 'string' ? { type: t.status, activeFlags: [] } : t.status;
    if (!status || !['active', 'idle', 'notLoaded', 'systemError'].includes(status.type)) continue;
    // Do not fill the device with stored history. Keep an explicitly selected chat visible.
    if (
      status.type === 'notLoaded' &&
      t.id !== config.sessionId &&
      config.sessionScope !== 'manual'
    )
      continue;
    const name = cleanName(t.title ?? t.name);
    candidates.set(t.id, {
      id: t.id,
      name,
      kind: 'codex',
      hostId: 'local',
      cwd: t.cwd,
      status: {
        type: status.type,
        activeFlags: Array.isArray(status.activeFlags)
          ? status.activeFlags.slice(0, 8).filter((f) => typeof f === 'string')
          : []
      }
    });
  }
  const rank = (s) =>
    s.id === config.sessionId
      ? 0
      : s.status.type === 'active'
        ? 1
        : s.status.type === 'systemError'
          ? 2
          : 3;
  const eligible = [...candidates.values()].sort(
    (a, b) =>
      (previous.includes(a.id) ? previous.indexOf(a.id) : 1000) -
        (previous.includes(b.id) ? previous.indexOf(b.id) : 1000) || rank(a) - rank(b)
  );
  const selected = new Set(eligible.slice(0, 16).map((t) => t.id));
  // Preserve roster order while sessions execute, finish or receive questions.
  const order = [
    ...previous.filter((id) => selected.has(id)),
    ...eligible.map((t) => t.id).filter((id) => selected.has(id) && !previous.includes(id))
  ];
  return {
    sessions: order.map((id) => candidates.get(id)),
    overflow: Math.max(0, candidates.size - 16)
  };
}

async function startSessionMonitor({
  config,
  app,
  resolveFile = findRollout,
  journalRoot = path.resolve(__dirname, '../.gar/chat-questions'),
  intervalMs = 2000,
  questionIntervalMs = 500,
  now = Date.now,
  onEvent = () => {}
}) {
  if (!validId(config.sessionId)) throw Error('An anchor chat is required');
  const client = app ?? new CodexAppClient({ sessionId: config.sessionId });
  const owner = randomBytes(24).toString('hex'),
    workers = new Map(),
    starting = new Map();
  let stopped = false,
    task,
    roster = [],
    lastDiscovery = 0,
    errorState,
    rosterKey,
    overflow = 0;
  // A discovery cycle includes bounded App calls (8 s timeout). Do not revoke
  // a card merely because a successful read of a long turn takes >3 seconds.
  const available = () =>
    !stopped &&
    now() - lastDiscovery < 10000 &&
    (app?.available ? app.available() : app ? true : Boolean(client.socket));
  async function post(sessions, release = false) {
    const response = await fetch(`http://127.0.0.1:${config.port}/sessions`, {
      method: 'POST',
      signal: AbortSignal.timeout(3000),
      headers: { Authorization: `Bearer ${config.token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ kind: 'codex-sessions', owner, sessions, release })
    });
    if (!response.ok) throw Error(`Session bridge returned ${response.status}`);
    return response.json();
  }
  function startWorker(row) {
    if (!config.chatQuestions || workers.has(row.id) || starting.has(row.id)) return;
    const job = (async () => {
      const source = {
        ready: async () => {},
        available,
        reply: async (q, choice) => {
          if (!available() || !roster.some((r) => r.id === row.id))
            throw Error('The question chat is no longer monitored');
          return client.reply(q, choice, row.id);
        },
        close() {}
      };
      let service;
      try {
        service = await startChatQuestions({
          config: { ...config, sessionId: row.id },
          file: resolveFile(row.id),
          app: source,
          journal: path.join(journalRoot, `${row.id}.json`),
          intervalMs: questionIntervalMs,
          displayContext: cleanName(path.win32.basename(row.cwd.replace(/\//g, '\\')) || row.cwd),
          onEvent: (e) => onEvent({ ...e, sessionId: row.id })
        });
        if (stopped || !roster.some((r) => r.id === row.id)) await service.close();
        else workers.set(row.id, service);
      } catch {
        onEvent({ event: 'session-questions-unavailable', sessionId: row.id });
      }
    })().finally(() => starting.delete(row.id));
    starting.set(row.id, job);
  }
  async function collect() {
    let threads = await client.listThreads();
    const explicit = [
      ...new Set([
        ...(config.sessionScope === 'manual' ? (config.sessionIds ?? []) : [config.sessionId]),
        ...roster.map((r) => r.id)
      ])
    ];
    // Explicit ids can fall outside the App's recent 50 + pinned inventory.
    const missing = explicit.filter(
      (id) => !threads.some((t) => t.id === id && t.hostId === 'local')
    );
    const details = await Promise.allSettled(missing.map((id) => client.readThread(id)));
    for (const detail of details) if (detail.status === 'fulfilled') threads.push(detail.value);
    // Inventory summaries can omit activeFlags. Read active local chats for
    // waitingOnUserInput / waitingOnApproval without resuming or messaging them.
    const activeIds = selectSessions(
      threads,
      config,
      roster.map((r) => r.id)
    )
      .sessions.filter((row) =>
        threads.some((t) => t.id === row.id && t.hostId === 'local' && t.status === 'active')
      )
      .map((row) => row.id);
    const runtime = await Promise.allSettled(activeIds.map((id) => client.readThread(id)));
    const replacements = new Map(
      activeIds.map((id, i) => [
        id,
        runtime[i].status === 'fulfilled' ? runtime[i].value : undefined
      ])
    );
    threads = threads.filter((t) => !(t.hostId === 'local' && replacements.has(t.id)));
    threads.push(...[...replacements.values()].filter(Boolean));
    const next = selectSessions(
      threads,
      config,
      roster.map((r) => r.id)
    );
    await post(next.sessions);
    lastDiscovery = now();
    roster = next.sessions;
    overflow = next.overflow;
    client.allowReplies(roster.map((r) => r.id));
    const ids = new Set(roster.map((r) => r.id));
    await Promise.all(
      [...workers]
        .filter(([id]) => !ids.has(id))
        .map(async ([id, worker]) => {
          workers.delete(id);
          await worker.close();
        })
    );
    for (const row of roster) startWorker(row);
    const key = JSON.stringify(roster.map((r) => r.id));
    if (key !== rosterKey || errorState)
      onEvent({ event: 'sessions-updated', count: roster.length, overflow });
    rosterKey = key;
    errorState = undefined;
  }
  async function loop() {
    while (!stopped) {
      await new Promise((resolve) => setTimeout(resolve, intervalMs));
      if (stopped) break;
      try {
        await collect();
      } catch {
        lastDiscovery = 0;
        client.allowReplies([]);
        if (!errorState) onEvent({ event: 'session-inventory-unavailable' });
        errorState = true;
      }
    }
  }
  try {
    await client.ready();
    await collect();
  } catch (e) {
    if (!app) client.close();
    throw e;
  }
  task = loop();
  return {
    snapshot: () => ({ sessions: roster.map((r) => ({ ...r })), overflow }),
    close: async () => {
      if (stopped) return;
      stopped = true;
      client.allowReplies([]);
      await task;
      await Promise.all([...starting.values()]);
      await Promise.all([...workers.values()].map((w) => w.close()));
      workers.clear();
      try {
        await post([], true);
      } catch {}
      if (!app) client.close();
    }
  };
}

async function main(config) {
  if (!config) {
    const i = process.argv.indexOf('--config');
    if (i < 0 || !process.argv[i + 1]) throw Error('Use --config with private settings');
    config = readPcConfig(process.argv[i + 1]);
  }
  const service = await startSessionMonitor({
    config,
    onEvent: (e) => console.log(JSON.stringify(e))
  });
  console.log(
    JSON.stringify({ event: 'sessions-ready', scope: config.sessionScope, toolApprovals: false })
  );
  for (const signal of ['SIGINT', 'SIGTERM']) process.once(signal, () => void service.close());
}
module.exports = { selectSessions, startSessionMonitor, main };
if (require.main === module)
  main().catch(() => {
    console.error(
      '複数セッションの監視を開始できません。設定、PCブリッジ、Codex Appとの接続を確認してください。'
    );
    process.exitCode = 1;
  });
