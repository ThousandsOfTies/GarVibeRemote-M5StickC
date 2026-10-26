// Local Codex history parsing and incremental JSONL reading; no network or replies.
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');

function displayLabel(value) {
  if (Buffer.byteLength(value) <= 128) return value;
  let label = '';
  for (const char of value) {
    if (Buffer.byteLength(label + char + '…') > 128) break;
    label += char;
  }
  return label + '…';
}

class NativeQuestionLog {
  constructor(sessionId, now = Date.now) {
    this.sessionId = sessionId;
    this.now = now;
    this.calls = new Map();
    this.answered = new Set();
  }
  consume(record) {
    const p = record?.payload;
    if (!p) return;
    if (record.type === 'session_meta' && p.id !== this.sessionId)
      throw Error('Wrong Codex chat log');
    if (record.type === 'event_msg') {
      if (p.thread_id && p.thread_id !== this.sessionId) return;
      if (p.type === 'turn_aborted' && typeof p.turn_id === 'string') {
        for (const call of this.calls.values())
          if (call.turnId === p.turn_id) call.accepted = false;
      } else if (
        p.type === 'item_completed' &&
        p.thread_id === this.sessionId &&
        ['UserMessage', 'userMessage'].includes(p.item?.type)
      ) {
        this.recordReply(p.item.content);
      }
      return;
    }
    if (record.type !== 'response_item') return;
    if (
      p.type === 'function_call' &&
      typeof p.name === 'string' &&
      p.name.split('.').at(-1) === 'request_user_input_async'
    ) {
      if (
        this.calls.has(p.call_id) ||
        typeof p.call_id !== 'string' ||
        !/^[\w-]{1,128}$/.test(p.call_id)
      )
        return;
      let input;
      try {
        input = JSON.parse(p.arguments);
      } catch {
        return;
      }
      if (!Array.isArray(input?.questions) || input.questions.length > 24) return;
      const questions = [];
      for (const [index, q] of input.questions.entries()) {
        // Optional free text / secret / unsupported choices remain in the PC card.
        if (
          !q ||
          q.isSecret === true ||
          q.multiSelect === true ||
          typeof q.title !== 'string' ||
          !q.title.trim() ||
          q.title.length > 2000 ||
          /[\x00-\x08\x0b-\x1f\x7f]/.test(q.title) ||
          !Array.isArray(q.options) ||
          q.options.length < 2 ||
          q.options.length > 8 ||
          q.options.some((o) => typeof o !== 'string' || !o.trim() || /[\p{Cc}]/u.test(o))
        )
          continue;
        const id = JSON.stringify(['request_user_input_async', p.call_id, index]);
        // Full choices remain readable in the scrolling body even when a button label is ellipsized.
        const message =
          q.title + '\n\n選択肢\n' + q.options.map((label, i) => `${i + 1}. ${label}`).join('\n');
        // CompactUi uses signed LVGL coordinates. Pathological line breaks must
        // not cause one card to reject the entire multi-session snapshot.
        if (message.length > 2000 || message.split('\n').length > 200) continue;
        questions.push({
          id,
          question: message,
          originalQuestion: q.title,
          originalOptions: [...q.options],
          options: q.options.map((label, i) => ({
            id: `option-${i}`,
            label: displayLabel(`${i + 1}. ${label}`)
          }))
        });
      }
      const createdAt = Date.parse(record.timestamp);
      if (!Number.isFinite(createdAt)) return;
      this.calls.set(p.call_id, {
        accepted: false,
        questions,
        createdAt,
        turnId: p.internal_chat_message_metadata_passthrough?.turn_id
      });
    } else if (p.type === 'function_call_output' && this.calls.has(p.call_id)) {
      let output;
      try {
        output = JSON.parse(p.output);
      } catch {
        return;
      }
      this.calls.get(p.call_id).accepted = output?.accepted === true;
    } else if (p.type === 'message' && p.role === 'user') {
      this.recordReply(p.content);
    }
  }
  recordReply(content) {
    if (!Array.isArray(content)) return;
    const text = content
      .map((c) =>
        ['input_text', 'text'].includes(c?.type) && typeof c.text === 'string' ? c.text : ''
      )
      .join('\n')
      .trim();
    const match =
      /^<send_user_message_question_reply>\s*([\s\S]*?)\s*<\/send_user_message_question_reply>$/.exec(
        text
      );
    if (!match) return;
    try {
      const data = JSON.parse(match[1]);
      for (const item of Array.isArray(data) ? data : [data]) {
        if (typeof item?.questionItemId === 'string' && typeof item.answer === 'string')
          this.answered.add(item.questionItemId);
      }
    } catch {}
  }
  pending() {
    return [...this.calls.values()]
      .filter((c) => c.accepted && this.now() - c.createdAt < 15 * 60 * 1000)
      .flatMap((c) => c.questions)
      .filter((q) => !this.answered.has(q.id));
  }
}

class RolloutTail {
  constructor(file, model) {
    this.file = file;
    this.model = model;
    this.offset = 0;
    this.partial = Buffer.alloc(0);
    this.dropping = false;
  }
  async read() {
    const size = (await fs.promises.stat(this.file)).size;
    if (size < this.offset)
      throw Error('Codex chat log was replaced; reconnect the question adapter');
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
          chunk = chunk.subarray(end + 1);
          this.dropping = false;
        }
        const data = Buffer.concat([this.partial, chunk]);
        let start = 0;
        for (let i = 0; i < data.length; i++)
          if (data[i] === 10) {
            if (i - start <= 8 * 1024 * 1024) {
              let record;
              try {
                record = JSON.parse(data.subarray(start, i).toString('utf8'));
              } catch {}
              if (record) this.model.consume(record);
            }
            start = i + 1;
          }
        this.partial = data.subarray(start);
        // Large tool outputs/world-state snapshots are irrelevant to question capture.
        if (this.partial.length > 8 * 1024 * 1024) {
          this.partial = Buffer.alloc(0);
          this.dropping = true;
        }
      }
    } finally {
      await handle.close();
    }
  }
}

function findRollout(
  sessionId,
  root = path.join(process.env.CODEX_HOME || path.join(os.homedir(), '.codex'), 'sessions')
) {
  if (!/^[\w-]{1,128}$/.test(sessionId ?? '')) throw Error('Select a Codex chat first');
  const matches = fs
    .readdirSync(root, { recursive: true, withFileTypes: true })
    .filter((e) => e.isFile() && e.name.endsWith(`-${sessionId}.jsonl`))
    .map((e) => path.join(e.parentPath, e.name));
  if (matches.length !== 1) throw Error('The selected local Codex chat log is unavailable');
  return matches[0];
}

module.exports = { displayLabel, NativeQuestionLog, RolloutTail, findRollout };
