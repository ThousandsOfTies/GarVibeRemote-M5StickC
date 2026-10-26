// One chat question worker. Original identities and delivery receipts stay on the PC.
const fs = require('node:fs');
const path = require('node:path');
const { randomBytes } = require('node:crypto');
const { CodexAppClient } = require('./codex_app_client.cjs');
const { NativeQuestionLog, RolloutTail, findRollout } = require('./native_question_log.cjs');

async function startChatQuestions({
  config,
  file,
  app,
  journal,
  intervalMs = 500,
  displayContext = '',
  onEvent = () => {}
}) {
  if (!config.chatQuestions || !config.sessionId)
    throw Error('Enable chat questions for the selected session');
  const model = new NativeQuestionLog(config.sessionId);
  const tail = new RolloutTail(file ?? findRollout(config.sessionId), model);
  const client = app ?? new CodexAppClient({ sessionId: config.sessionId });
  const owner = randomBytes(24).toString('hex');
  let stopped = false,
    task,
    lastError,
    visibleKey,
    delivered = new Set(),
    failed = new Set();
  const sent = new Map();
  if (journal && fs.existsSync(journal)) {
    const entries = JSON.parse(fs.readFileSync(journal, 'utf8'));
    if (!Array.isArray(entries) || entries.some((e) => typeof e.id !== 'string'))
      throw Error('Invalid question delivery journal');
    for (const entry of entries) sent.set(entry.id, entry.status);
  }
  const save = () => {
    if (!journal) return;
    fs.mkdirSync(path.dirname(journal), { recursive: true });
    const tmp = journal + '.tmp';
    fs.writeFileSync(
      tmp,
      JSON.stringify([...sent].map(([id, status]) => ({ id, status }))) + '\n',
      { mode: 0o600 }
    );
    fs.renameSync(tmp, journal);
  };
  const sync = async (questions, release = false) => {
    const response = await fetch(`http://127.0.0.1:${config.port}/chat-questions`, {
      method: 'POST',
      signal: AbortSignal.timeout(3000),
      headers: { Authorization: `Bearer ${config.token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        kind: 'chat-choice',
        sessionId: config.sessionId,
        owner,
        questions: questions.map(({ id, question, options }) => {
          const withContext = displayContext
            ? `プロジェクト：${displayContext}\n${question}`
            : question;
          return {
            id,
            question:
              withContext.length <= 2000 && withContext.split('\n').length <= 200
                ? withContext
                : question,
            options
          };
        }),
        delivered: [...delivered],
        failed: [...failed],
        release
      })
    });
    if (!response.ok) throw Error(`Chat question bridge returned ${response.status}`);
    return response.json();
  };
  async function tick() {
    if (app?.available && !app.available()) throw Error('Codex chat inventory is unavailable');
    await tail.read();
    // A disconnected App must not leave a selectable question on the device.
    if (!app && !client.socket) await client.ready();
    const pending = model.pending();
    const visible = pending
      .filter((q) => !sent.has(q.id) || delivered.has(q.id) || failed.has(q.id))
      .slice(0, 24);
    const result = await sync(visible);
    const key = JSON.stringify(visible.map((q) => q.id));
    if (key !== visibleKey) {
      onEvent({ event: 'chat-questions-updated', pending: visible.length });
      visibleKey = key;
    }
    for (const answer of result.answers ?? []) {
      await tail.read(); // PC answers win if already present before dispatch.
      const q = model.pending().find((q) => q.id === answer.id);
      if (
        !q ||
        sent.has(q.id) ||
        !/^m5stickc-plus2-(usb|spp)$/.test(answer.source ?? '') ||
        !q.options.some((o) => o.id === answer.choiceId)
      )
        continue;
      // Persist before dispatch. A timeout or crash never automatically replays a human answer.
      sent.set(q.id, 'unconfirmed');
      save();
      try {
        await client.reply(q, answer.choiceId);
        sent.set(q.id, 'delivered');
        delivered.add(q.id);
        save();
        onEvent({ event: 'chat-answer-delivered', source: answer.source });
      } catch {
        failed.add(q.id);
        onEvent({ event: 'chat-answer-unconfirmed', source: answer.source });
      }
    }
    const ids = new Set(model.pending().map((q) => q.id));
    delivered = new Set([...delivered].filter((id) => ids.has(id)));
    failed = new Set([...failed].filter((id) => ids.has(id)));
    if (lastError) {
      onEvent({ event: 'chat-questions-reconnected' });
      lastError = undefined;
    }
  }
  async function loop() {
    while (!stopped) {
      try {
        await tick();
      } catch (error) {
        if (lastError !== error.message)
          onEvent({ event: 'chat-questions-unavailable', reason: error.message });
        lastError = error.message;
      }
      if (!stopped) await new Promise((resolve) => setTimeout(resolve, intervalMs));
    }
  }
  // Initial validation errors are actionable; do not claim a running connection.
  try {
    await client.ready();
    await tick();
  } catch (error) {
    client.close();
    throw error;
  }
  task = loop();
  return {
    model,
    close: async () => {
      stopped = true;
      await task;
      try {
        await sync([], true);
      } catch {}
      client.close();
    }
  };
}

module.exports = { startChatQuestions };
