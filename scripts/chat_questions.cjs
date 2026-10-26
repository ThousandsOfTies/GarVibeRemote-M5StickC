#!/usr/bin/env node
// Product wiring: selected local Codex chat -> ordinary device choices -> native reply.
// The rollout and App pipe formats are version-specific compatibility adapters.
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { randomBytes } = require('node:crypto');
const { CodexAppClient } = require('./codex_app_client.cjs');

function displayLabel(value) {
  if (Buffer.byteLength(value) <= 128) return value;
  let label = '';
  for (const char of value) { if (Buffer.byteLength(label + char + '…') > 128) break; label += char; }
  return label + '…';
}

class NativeQuestionLog {
  constructor(sessionId, now = Date.now) { this.sessionId = sessionId; this.now = now; this.calls = new Map(); this.answered = new Set(); }
  consume(record) {
    const p = record?.payload;
    if (!p) return;
    if (record.type === 'session_meta' && p.id !== this.sessionId) throw Error('Wrong Codex chat log');
    if (record.type !== 'response_item') return;
    if (p.type === 'function_call' && p.name?.split('.').at(-1) === 'request_user_input_async') {
      if (this.calls.has(p.call_id) || !/^[\w-]{1,128}$/.test(p.call_id ?? '')) return;
      let input; try { input = JSON.parse(p.arguments); } catch { return; }
      if (!Array.isArray(input.questions) || input.questions.length > 24) return;
      const questions = [];
      for (const [index, q] of input.questions.entries()) {
        // Optional free text / secret / unsupported choices remain in the PC card.
        if (!q || q.isSecret === true || q.multiSelect === true ||
            typeof q.title !== 'string' || !q.title.trim() || q.title.length > 2000 ||
            /[\x00-\x08\x0b-\x1f\x7f]/.test(q.title) ||
            !Array.isArray(q.options) || q.options.length < 2 || q.options.length > 8 ||
            q.options.some(o => typeof o !== 'string' || !o.trim() || /[\p{Cc}]/u.test(o))) continue;
        const id = JSON.stringify(['request_user_input_async', p.call_id, index]);
        // Full choices remain readable in the scrolling body even when a button label is ellipsized.
        const message = q.title + '\n\n選択肢\n' + q.options.map((label, i) => `${i + 1}. ${label}`).join('\n');
        if (message.length > 2000) continue;
        questions.push({ id, question: message, originalQuestion: q.title, originalOptions: [...q.options],
          options: q.options.map((label, i) => ({ id: `option-${i}`, label: displayLabel(`${i + 1}. ${label}`) })) });
      }
      const createdAt = Date.parse(record.timestamp);
      if (!Number.isFinite(createdAt)) return;
      this.calls.set(p.call_id, { accepted: false, questions, createdAt });
    } else if (p.type === 'function_call_output' && this.calls.has(p.call_id)) {
      let output; try { output = JSON.parse(p.output); } catch { return; }
      this.calls.get(p.call_id).accepted = output?.accepted === true;
    } else if (p.type === 'message' && p.role === 'user') {
      const text = (p.content ?? []).map(c => ['input_text', 'text'].includes(c.type) ? c.text : '').join('\n').trim();
      const match = /^<send_user_message_question_reply>\s*([\s\S]*?)\s*<\/send_user_message_question_reply>$/.exec(text);
      if (!match) return;
      try {
        const data = JSON.parse(match[1]);
        for (const item of Array.isArray(data) ? data : [data]) {
          if (typeof item?.questionItemId === 'string' && typeof item.answer === 'string') this.answered.add(item.questionItemId);
        }
      } catch {}
    }
  }
  pending() {
    return [...this.calls.values()].filter(c => c.accepted && this.now() - c.createdAt < 15 * 60 * 1000)
      .flatMap(c => c.questions).filter(q => !this.answered.has(q.id));
  }
}

class RolloutTail {
  constructor(file, model) { this.file = file; this.model = model; this.offset = 0; this.partial = Buffer.alloc(0); this.dropping = false; }
  async read() {
    const size = (await fs.promises.stat(this.file)).size;
    if (size < this.offset) throw Error('Codex chat log was replaced; reconnect the question adapter');
    if (size === this.offset) return;
    const handle = await fs.promises.open(this.file, 'r');
    try {
      while (this.offset < size) {
        const bytes = Buffer.alloc(Math.min(256 * 1024, size - this.offset));
        const { bytesRead } = await handle.read(bytes, 0, bytes.length, this.offset);
        if (!bytesRead) break;
        this.offset += bytesRead;
        let chunk = bytes.subarray(0, bytesRead);
        if (this.dropping) {
          const end = chunk.indexOf(10);
          if (end < 0) continue;
          chunk = chunk.subarray(end + 1); this.dropping = false;
        }
        const data = Buffer.concat([this.partial, chunk]);
        let start = 0;
        for (let i = 0; i < data.length; i++) if (data[i] === 10) {
          if (i - start <= 8 * 1024 * 1024) {
            let record; try { record = JSON.parse(data.subarray(start, i).toString('utf8')); } catch {}
            if (record) this.model.consume(record);
          }
          start = i + 1;
        }
        this.partial = data.subarray(start);
        // Large tool outputs/world-state snapshots are irrelevant to question capture.
        if (this.partial.length > 8 * 1024 * 1024) { this.partial = Buffer.alloc(0); this.dropping = true; }
      }
    } finally { await handle.close(); }
  }
}

function findRollout(sessionId, root = path.join(process.env.CODEX_HOME || path.join(os.homedir(), '.codex'), 'sessions')) {
  if (!/^[\w-]{1,128}$/.test(sessionId ?? '')) throw Error('Select a Codex chat first');
  const matches = fs.readdirSync(root, { recursive: true, withFileTypes: true })
    .filter(e => e.isFile() && e.name.endsWith(`-${sessionId}.jsonl`))
    .map(e => path.join(e.parentPath, e.name));
  if (matches.length !== 1) throw Error('The selected local Codex chat log is unavailable');
  return matches[0];
}

async function startChatQuestions({ config, file, app, journal, intervalMs = 500, onEvent = () => {} }) {
  if (!config.chatQuestions || !config.sessionId) throw Error('Enable chat questions for the selected session');
  const model = new NativeQuestionLog(config.sessionId);
  const tail = new RolloutTail(file ?? findRollout(config.sessionId), model);
  const client = app ?? new CodexAppClient({ sessionId: config.sessionId });
  await client.ready();
  const owner = randomBytes(24).toString('hex');
  let stopped = false, task, lastError, visibleKey, delivered = new Set(), failed = new Set();
  const sent = new Map();
  if (journal && fs.existsSync(journal)) {
    const entries = JSON.parse(fs.readFileSync(journal, 'utf8'));
    if (!Array.isArray(entries) || entries.some(e => typeof e.id !== 'string')) throw Error('Invalid question delivery journal');
    for (const entry of entries) sent.set(entry.id, entry.status);
  }
  const save = () => {
    if (!journal) return;
    fs.mkdirSync(path.dirname(journal), { recursive: true });
    const tmp = journal + '.tmp';
    fs.writeFileSync(tmp, JSON.stringify([...sent].map(([id, status]) => ({ id, status }))) + '\n', { mode: 0o600 });
    fs.renameSync(tmp, journal);
  };
  const sync = async (questions, release = false) => {
    const response = await fetch(`http://127.0.0.1:${config.port}/chat-questions`, {
      method: 'POST', signal: AbortSignal.timeout(3000),
      headers: { Authorization: `Bearer ${config.token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ kind: 'chat-choice', sessionId: config.sessionId, owner,
        questions: questions.map(({ id, question, options }) => ({ id, question, options })),
        delivered: [...delivered], failed: [...failed], release })
    });
    if (!response.ok) throw Error(`Chat question bridge returned ${response.status}`);
    return response.json();
  };
  async function tick() {
    await tail.read();
    // A disconnected App must not leave a selectable question on the device.
    if (!app && !client.socket) await client.ready();
    const pending = model.pending();
    const visible = pending.filter(q => !sent.has(q.id) || delivered.has(q.id) || failed.has(q.id)).slice(0, 24);
    const result = await sync(visible);
    const key = JSON.stringify(visible.map(q => q.id));
    if (key !== visibleKey) { onEvent({ event: 'chat-questions-updated', pending: visible.length }); visibleKey = key; }
    for (const answer of result.answers ?? []) {
      await tail.read(); // PC answers win if already present before dispatch.
      const q = model.pending().find(q => q.id === answer.id);
      if (!q || sent.has(q.id) || !/^m5stickc-plus2-(usb|spp)$/.test(answer.source ?? '') ||
          !q.options.some(o => o.id === answer.choiceId)) continue;
      // Persist before dispatch. A timeout or crash never automatically replays a human answer.
      sent.set(q.id, 'unconfirmed'); save();
      try {
        await client.reply(q, answer.choiceId);
        sent.set(q.id, 'delivered'); delivered.add(q.id); save();
        onEvent({ event: 'chat-answer-delivered', source: answer.source });
      } catch {
        failed.add(q.id);
        onEvent({ event: 'chat-answer-unconfirmed', source: answer.source });
      }
    }
    const ids = new Set(model.pending().map(q => q.id));
    delivered = new Set([...delivered].filter(id => ids.has(id)));
    failed = new Set([...failed].filter(id => ids.has(id)));
    if (lastError) { onEvent({ event: 'chat-questions-reconnected' }); lastError = undefined; }
  }
  async function loop() {
    while (!stopped) {
      try { await tick(); }
      catch (error) {
        if (lastError !== error.message) onEvent({ event: 'chat-questions-unavailable', reason: error.message });
        lastError = error.message;
      }
      if (!stopped) await new Promise(resolve => setTimeout(resolve, intervalMs));
    }
  }
  // Initial validation errors are actionable; do not claim a running connection.
  try { await tick(); } catch (error) { client.close(); throw error; }
  task = loop();
  return {
    model,
    close: async () => { stopped = true; await task; try { await sync([], true); } catch {} client.close(); }
  };
}

async function main() {
  const i = process.argv.indexOf('--config');
  if (i < 0 || !process.argv[i + 1]) throw Error('Use --config with private PC settings');
  const config = JSON.parse(fs.readFileSync(process.argv[i + 1], 'utf8').replace(/^\uFEFF/, ''));
  const service = await startChatQuestions({ config,
    journal: path.resolve(__dirname, '../.gar/chat-questions', `${config.sessionId}.json`),
    onEvent: event => console.log(JSON.stringify(event)) });
  console.log(JSON.stringify({ event: 'chat-questions-ready', selectedSession: true, toolApprovals: false }));
  for (const signal of ['SIGINT', 'SIGTERM']) process.once(signal, () => void service.close());
}
module.exports = { displayLabel, NativeQuestionLog, RolloutTail, findRollout, startChatQuestions };
if (require.main === module) main().catch(() => {
  console.error('質問連携を開始できません。選択中のチャット・PCブリッジ・Codex Appとの接続を確認してください。');
  process.exitCode = 1;
});
