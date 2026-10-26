// Version-specific local Codex coordination IPC. Only real device choices enter here.
// No delegated messages, UI automation, approvals, app patches or automatic retries.
const net = require('node:net');
const { randomUUID } = require('node:crypto');
const { isSessionId } = require('./pc_config.cjs');
const MAX_FRAME = 64 * 1024 * 1024;
const METHODS = new Map([
  ['initialize', 0],
  ['thread-owner-discovery', 1],
  ['thread-follower-steer-turn', 1],
  ['thread-follower-start-turn', 2]
]);

function questionReply(question, choiceId) {
  let id;
  try {
    id = JSON.parse(question?.id);
  } catch {}
  if (
    !Array.isArray(id) ||
    id.length !== 3 ||
    id[0] !== 'request_user_input_async' ||
    typeof id[1] !== 'string' ||
    !/^[\w-]{1,128}$/.test(id[1]) ||
    !Number.isInteger(id[2]) ||
    id[2] < 0 ||
    id[2] >= 24 ||
    JSON.stringify(id) !== question.id ||
    typeof question.originalQuestion !== 'string' ||
    !question.originalQuestion.trim() ||
    !Array.isArray(question.originalOptions) ||
    question.originalOptions.length < 2 ||
    question.originalOptions.length > 8 ||
    question.originalOptions.some((o) => typeof o !== 'string' || !o.trim()) ||
    typeof choiceId !== 'string' ||
    !/^option-[0-7]$/.test(choiceId)
  )
    throw Error('Invalid native chat reply');
  const option = question.originalOptions[Number(choiceId.slice(7))];
  if (option === undefined) throw Error('Invalid native chat reply');
  return (
    '<send_user_message_question_reply>\n' +
    JSON.stringify([
      {
        questionItemId: question.id,
        question: question.originalQuestion,
        answer: option
      }
    ]) +
    '\n</send_user_message_question_reply>'
  );
}

function latestTurn(state) {
  if (state.turnHistory?.kind === 'canonical') {
    const h = state.turnHistory.history,
      island = h?.islands?.at(-1);
    if (island?.newerBoundary?.status !== 'exhausted') return;
    const entries = island.entries;
    if (!Array.isArray(entries)) return;
    for (let i = entries.length - 1; i >= 0; i--) {
      const turn = h.entitiesByKey?.[entries[i].value];
      if (turn && (turn.turnId != null || !['completed', 'failed'].includes(turn.status)))
        return turn;
    }
    return;
  }
  return state.turns?.findLast(
    (t) => t.turnId != null || !['completed', 'failed'].includes(t.status)
  );
}

function assertQuestion(state, sessionId, question) {
  if (state?.id !== sessionId || state.hostId !== 'local' || typeof state.cwd !== 'string')
    throw Error('Unsupported native chat state');
  const turn = latestTurn(state);
  if (
    !turn?.turnId ||
    !['inProgress', 'completed'].includes(turn.status) ||
    !Array.isArray(turn.items)
  )
    throw Error('The question chat is not ready for a reply');
  const [, callId, index] = JSON.parse(question.id);
  const item = turn.items.find((i) => i.type === 'agentMessage' && i.id === callId);
  const q = item?.questions?.[index];
  if (
    !q ||
    q.title !== question.originalQuestion ||
    q.isSecret === true ||
    q.multiSelect === true ||
    JSON.stringify(q.options) !== JSON.stringify(question.originalOptions)
  )
    throw Error('The original question is no longer current');
  for (const item of turn.items) {
    const content =
      item.type === 'userMessage'
        ? item.content
        : item.type === 'steeringUserMessage' && (!('status' in item) || item.status === 'accepted')
          ? item.input
          : null;
    if (!Array.isArray(content)) continue;
    const text = content
      .filter((c) => ['text', 'input_text'].includes(c?.type))
      .map((c) => c.text)
      .join('\n')
      .trim();
    const match =
      /^<send_user_message_question_reply>\s*([\s\S]*?)\s*<\/send_user_message_question_reply>$/.exec(
        text
      );
    if (!match) continue;
    let answers;
    try {
      answers = JSON.parse(match[1]);
    } catch {
      continue;
    }
    if (Array.isArray(answers) && answers.some((a) => a?.questionItemId === question.id))
      throw Error('The original question was already answered');
  }
  return turn;
}

function applyPatches(state, patches) {
  if (!Array.isArray(patches)) throw Error('Unsupported native chat update');
  for (const patch of patches) {
    if (
      !['add', 'replace', 'remove'].includes(patch?.op) ||
      !Array.isArray(patch.path) ||
      !patch.path.length ||
      patch.path.length > 100 ||
      patch.path.some(
        (k) =>
          (typeof k !== 'string' && !Number.isInteger(k)) ||
          ['__proto__', 'constructor', 'prototype'].includes(k)
      )
    )
      throw Error('Unsupported native chat update');
    let parent = state;
    for (const key of patch.path.slice(0, -1)) {
      if (!parent || !Object.hasOwn(parent, key)) throw Error('Unsupported native chat update');
      parent = parent[key];
    }
    const key = patch.path.at(-1);
    if (!parent || typeof parent !== 'object') throw Error('Unsupported native chat update');
    if (Array.isArray(parent) && typeof key === 'number') {
      if (key < 0 || key > parent.length || (patch.op !== 'add' && key === parent.length))
        throw Error('Unsupported native chat update');
      if (patch.op === 'add') parent.splice(key, 0, patch.value);
      else if (patch.op === 'remove') parent.splice(key, 1);
      else parent[key] = patch.value;
    } else if (patch.op === 'remove') delete parent[key];
    else parent[key] = patch.value;
  }
}

class NativePeer {
  constructor(pipePath, timeoutMs) {
    this.pipePath = pipePath;
    this.timeoutMs = timeoutMs;
    this.clientId = 'initializing-client';
    this.pending = new Map();
    this.buffer = Buffer.alloc(0);
  }
  async connect() {
    await new Promise((resolve, reject) => {
      const socket = (this.socket = net.createConnection(this.pipePath));
      const timer = setTimeout(
        () => socket.destroy(Error('Native chat connection timed out')),
        this.timeoutMs
      );
      socket.once('connect', () => {
        clearTimeout(timer);
        resolve();
      });
      socket.on('error', () => {
        clearTimeout(timer);
        reject(Error('Native chat connection failed'));
      });
      socket.on('data', (data) => {
        try {
          this.receive(data);
        } catch {
          this.close();
        }
      });
      socket.on('close', () => {
        clearTimeout(timer);
        reject(Error('Native chat connection closed'));
        this.close();
      });
    });
    const init = await this.request('initialize', { clientType: 'viberemote' });
    if (typeof init.result?.clientId !== 'string' || !init.result.clientId)
      throw Error('Unsupported native chat initialization');
    this.clientId = init.result.clientId;
  }
  send(message) {
    const body = Buffer.from(JSON.stringify(message));
    if (body.length > 64 * 1024) throw Error('Native chat request is too large');
    if (!this.socket?.writable) throw Error('Native chat is disconnected');
    const header = Buffer.alloc(4);
    header.writeUInt32LE(body.length);
    this.socket.write(Buffer.concat([header, body]));
  }
  request(method, params, targetClientId, beforeSend) {
    if (!METHODS.has(method)) throw Error('Unsupported native chat operation');
    beforeSend?.();
    const requestId = randomUUID();
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(requestId);
        reject(Error('Native chat reply is unconfirmed'));
      }, this.timeoutMs);
      this.pending.set(requestId, { resolve, reject, timer, method });
      try {
        this.send({
          type: 'request',
          requestId,
          sourceClientId: this.clientId,
          version: METHODS.get(method),
          method,
          params,
          targetClientId,
          timeoutMs: this.timeoutMs
        });
      } catch (error) {
        clearTimeout(timer);
        this.pending.delete(requestId);
        reject(error);
      }
    });
  }
  receive(data) {
    this.buffer = Buffer.concat([this.buffer, data]);
    while (this.buffer.length >= 4) {
      const size = this.buffer.readUInt32LE();
      if (!size || size > MAX_FRAME) throw Error('Invalid native chat frame');
      if (this.buffer.length < size + 4) return;
      const m = JSON.parse(this.buffer.subarray(4, size + 4));
      this.buffer = this.buffer.subarray(size + 4);
      if (!m || typeof m !== 'object' || Array.isArray(m))
        throw Error('Invalid native chat message');
      if (m.type === 'client-discovery-request') {
        this.send({
          type: 'client-discovery-response',
          requestId: m.requestId,
          response: { canHandle: false }
        });
      } else if (m.type === 'response') {
        const p = this.pending.get(m.requestId);
        if (!p) continue;
        clearTimeout(p.timer);
        this.pending.delete(m.requestId);
        if (m.resultType !== 'success' || m.method !== p.method)
          p.reject(Error('Native chat rejected the request'));
        else p.resolve(m);
      } else if (m.type === 'broadcast') this.onBroadcast?.(m);
    }
  }
  snapshot(sessionId, owner) {
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.snapshotWaiter = undefined;
        reject(Error('Native chat state is unavailable'));
      }, this.timeoutMs);
      this.snapshotWaiter = { reject, timer };
      this.onBroadcast = (m) => {
        if (
          m.method !== 'thread-stream-state-changed' ||
          m.version !== 11 ||
          m.sourceClientId !== owner ||
          m.params?.hostId !== 'local' ||
          m.params.conversationId !== sessionId ||
          (m.targetClientIds && !m.targetClientIds.includes(this.clientId))
        )
          return;
        const change = m.params.change;
        if (change?.type === 'snapshot') {
          this.state = change.conversationState;
          this.revision = change.revision;
        } else if (
          change?.type === 'patches' &&
          this.state &&
          change.baseRevision === this.revision
        ) {
          try {
            applyPatches(this.state, change.patches);
            this.revision = change.revision;
          } catch {
            this.state = undefined;
          }
        } else this.state = undefined;
        // Include accepted PC answers that arrive after the initial snapshot.
        if (this.state && this.snapshotWaiter) {
          clearTimeout(timer);
          this.snapshotWaiter = undefined;
          resolve();
        }
      };
      try {
        this.send({
          type: 'broadcast',
          method: 'thread-stream-following-changed',
          version: 1,
          sourceClientId: this.clientId,
          targetClientIds: [owner],
          params: {
            hostId: 'local',
            conversationId: sessionId,
            following: true
          }
        });
      } catch (error) {
        clearTimeout(timer);
        this.snapshotWaiter = undefined;
        reject(error);
      }
    });
  }
  close() {
    this.socket?.destroy();
    this.state = undefined;
    this.buffer = Buffer.alloc(0);
    for (const p of this.pending.values()) {
      clearTimeout(p.timer);
      p.reject(Error('Native chat connection closed'));
    }
    this.pending.clear();
    if (this.snapshotWaiter) {
      clearTimeout(this.snapshotWaiter.timer);
      this.snapshotWaiter.reject(Error('Native chat connection closed'));
      this.snapshotWaiter = undefined;
    }
  }
}

class NativeChatReply {
  constructor({
    pipePath = process.platform === 'win32' ? '\\\\.\\pipe\\codex-ipc' : undefined,
    timeoutMs = 8000
  } = {}) {
    this.pipePath = pipePath;
    this.timeoutMs = timeoutMs;
    this.peers = new Set();
  }
  async reply(question, choiceId, sessionId, beforeSend) {
    if (!isSessionId(sessionId) || !this.pipePath)
      throw Error('Native chat replies are unavailable');
    const q = structuredClone(question),
      text = questionReply(q, choiceId);
    const peer = new NativePeer(this.pipePath, this.timeoutMs);
    this.peers.add(peer);
    try {
      beforeSend?.();
      await peer.connect();
      const owner = await peer.request('thread-owner-discovery', {
        hostId: 'local',
        conversationId: sessionId
      });
      if (!owner.handledByClientId || owner.result?.supportsUntrustedAppInput !== true)
        throw Error('Unsupported native chat owner');
      await peer.snapshot(sessionId, owner.handledByClientId);
      const turn = assertQuestion(peer.state, sessionId, q);
      const targetTurnId = turn.turnId,
        targetStatus = turn.status;
      const id = randomUUID(),
        input = [{ type: 'text', text, text_elements: [] }];
      const restoreMessage = {
        id,
        text,
        cwd: peer.state.cwd,
        createdAt: Date.now(),
        context: {
          prompt: text,
          addedFiles: [],
          fileAttachments: [],
          ideContext: null,
          imageAttachments: [],
          workspaceRoots: [peer.state.cwd]
        }
      };
      const params =
        turn.status === 'inProgress'
          ? {
              conversationId: sessionId,
              input,
              attachments: [],
              restoreMessage,
              clientUserMessageId: id
            }
          : {
              conversationId: sessionId,
              turnStart: {
                request: {
                  threadId: sessionId,
                  input,
                  clientUserMessageId: id
                },
                context: { restoreMessage, attachments: [] }
              }
            };
      const method =
        turn.status === 'inProgress' ? 'thread-follower-steer-turn' : 'thread-follower-start-turn';
      const result = await peer.request(method, params, owner.handledByClientId, () => {
        beforeSend?.();
        const current = assertQuestion(peer.state, sessionId, q);
        if (current.turnId !== targetTurnId || current.status !== targetStatus)
          throw Error('The original question turn changed');
      });
      const accepted = result.result?.result;
      if (!(typeof accepted?.turnId === 'string' || typeof accepted?.turn?.id === 'string'))
        throw Error('Native chat reply is unconfirmed');
      return { accepted: true };
    } finally {
      peer.close();
      this.peers.delete(peer);
    }
  }
  close() {
    for (const peer of this.peers) peer.close();
  }
}

module.exports = { NativeChatReply, questionReply, assertQuestion };
