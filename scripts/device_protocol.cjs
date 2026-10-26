// Compact device wire format only; no sockets, serial ports or process startup.
const { TextDecoder } = require('node:util');

class JsonLines {
  constructor(receive, maximum = 65536) {
    this.receive = receive;
    this.maximum = maximum;
    this.reset();
  }
  reset() {
    this.parts = [];
    this.length = 0;
    this.dropping = false;
  }
  push(bytes) {
    for (const byte of bytes) {
      if (byte === 10) {
        if (!this.dropping && this.length) {
          try {
            this.receive(
              JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(Buffer.from(this.parts)))
            );
          } catch {}
        }
        this.reset();
      } else if (!this.dropping && byte !== 13) {
        if (this.length < this.maximum) {
          this.parts.push(byte);
          this.length++;
        } else {
          this.parts = [];
          this.length = 0;
          this.dropping = true;
        }
      }
    }
  }
}
const text = (value, limit) => typeof value === 'string' && Buffer.byteLength(value) <= limit;
function compactState(value, fallback = {}) {
  if (!value || value.type !== 'state') throw Error('state');
  const session = value.session ?? {
    id: fallback.sessionId || 'codex-monitor',
    name: fallback.label || 'Codex'
  };
  if (!text(session.id, 256) || !session.id || !text(session.name, 512)) throw Error('session');
  const statuses = ['idle', 'running', 'waiting', 'done', 'failed'];
  const ui = value.ui;
  if (ui && ui.id) {
    if (
      !text(ui.id, 256) ||
      !text(ui.message ?? '', 8192) ||
      !statuses.includes(ui.state ?? 'waiting')
    )
      throw Error('ui');
    const actions = ui.actions ?? [];
    if (!Array.isArray(actions) || actions.length > 8) throw Error('actions');
    const ids = new Set();
    for (const a of actions) {
      if (!a || !text(a.id, 256) || !a.id || !text(a.label, 128) || !a.label || ids.has(a.id))
        throw Error('action');
      ids.add(a.id);
    }
    // The portrait UI currently confirms on A release; never claim an A-hold
    // approval was performed by that short press. Such requests stay on the PC.
    const needsHold = actions.some(
      (a) => typeof a.button === 'string' && a.button.endsWith('-hold')
    );
    return {
      session,
      ui: {
        id: ui.id,
        state: ui.state ?? 'waiting',
        message: needsHold ? 'PCで承認してください。' : (ui.message ?? ''),
        actions: needsHold
          ? []
          : actions.map((a) => ({
              id: a.id,
              label: a.label,
              ...(a.button ? { button: a.button } : {})
            }))
      }
    };
  }
  if (!statuses.includes(value.agent?.status ?? 'idle') || !text(value.agent?.message ?? '', 8192))
    throw Error('agent');
  return {
    session,
    agent: {
      status: value.agent?.status ?? 'idle',
      message: value.agent?.message ?? 'Codexイベント待ち'
    }
  };
}

function validActionIdentity(message) {
  return (
    message &&
    ['sessionId', 'uiId', 'actionId'].every((key) => text(message[key], 256) && message[key])
  );
}
module.exports = { JsonLines, compactState, validActionIdentity };
