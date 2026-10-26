// Adapter for the locally installed Codex App Tools pipe. No UI automation.
const net = require('node:net');
const { randomUUID } = require('node:crypto');
const MAX_FRAME = 8 * 1024 * 1024;

class CodexAppClient {
  constructor({ pipePath = process.env.CODEX_APP_TOOLS_PIPE_PATH, sessionId, timeoutMs = 8000 } = {}) {
    if (!pipePath || !/^[\w-]{1,128}$/.test(sessionId ?? '')) throw Error('Codex App connection is unavailable');
    this.pipePath = pipePath; this.sessionId = sessionId; this.timeoutMs = timeoutMs;
    this.nextId = 0; this.pending = new Map(); this.buffer = Buffer.alloc(0);
  }
  async connect() {
    if (this.socket && !this.socket.destroyed) return;
    if (this.connecting) return this.connecting;
    this.connecting = new Promise((resolve, reject) => {
      const socket = net.createConnection(this.pipePath);
      const timer = setTimeout(() => socket.destroy(Error('Codex App connection timed out')), this.timeoutMs);
      socket.once('connect', () => { clearTimeout(timer); this.socket = socket; resolve(); });
      socket.on('data', data => this.receive(data));
      socket.on('error', () => { clearTimeout(timer); reject(Error('Codex App connection failed')); });
      socket.on('close', () => {
        if (this.socket !== socket) return;
        this.socket = undefined; this.buffer = Buffer.alloc(0);
        for (const p of this.pending.values()) { clearTimeout(p.timer); p.reject(Error('Codex App connection closed')); }
        this.pending.clear();
      });
    }).finally(() => { this.connecting = undefined; });
    return this.connecting;
  }
  receive(data) {
    this.buffer = Buffer.concat([this.buffer, data]);
    while (this.buffer.length >= 4) {
      const length = this.buffer.readUInt32LE();
      if (!length || length > MAX_FRAME) { this.close(); return; }
      if (this.buffer.length < length + 4) return;
      let message;
      try { message = JSON.parse(this.buffer.subarray(4, length + 4).toString('utf8')); }
      catch { this.close(); return; }
      this.buffer = this.buffer.subarray(length + 4);
      const pending = this.pending.get(message.id);
      if (!pending) continue;
      clearTimeout(pending.timer); this.pending.delete(message.id);
      if (message.jsonrpc !== '2.0' || message.error) pending.reject(Error('Codex App rejected the request'));
      else pending.resolve(message.result);
    }
  }
  async request(method, params) {
    await this.connect();
    const id = ++this.nextId;
    const body = Buffer.from(JSON.stringify({ jsonrpc: '2.0', id, method, params }));
    if (body.length > MAX_FRAME) throw Error('Codex App request is too large');
    const header = Buffer.alloc(4); header.writeUInt32LE(body.length);
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => { this.pending.delete(id); reject(Error('Codex App reply is unconfirmed')); }, this.timeoutMs);
      this.pending.set(id, { resolve, reject, timer });
      this.socket.write(Buffer.concat([header, body]));
    });
  }
  async ready() {
    const result = await this.request('tools/list', { threadStartKind: 'all' });
    const tool = result?.tools?.find(t => t.name === 'send_message_to_thread' && t.namespace === 'codex_app');
    if (!tool) throw Error('This Codex App does not expose chat replies');
  }
  async reply(question, choiceId) {
    const option = question.originalOptions[Number(choiceId.replace(/^option-/, ''))];
    if (!/^option-\d+$/.test(choiceId) || typeof option !== 'string' || !question.id || !question.originalQuestion)
      throw Error('Invalid native chat reply');
    const prompt = '<send_user_message_question_reply>\n' + JSON.stringify([{
      questionItemId: question.id, question: question.originalQuestion, answer: option
    }]) + '\n</send_user_message_question_reply>';
    const result = await this.request('tools/call', {
      namespace: 'codex_app', tool: 'send_message_to_thread', callerSource: 'codex',
      threadId: this.sessionId, turnId: `viberemote-${randomUUID()}`, callId: `viberemote-${randomUUID()}`,
      arguments: { threadId: this.sessionId, prompt }
    });
    if (!result?.success) throw Error('Codex App did not accept the reply');
    return result;
  }
  close() { this.socket?.destroy(); }
}
module.exports = { CodexAppClient };
