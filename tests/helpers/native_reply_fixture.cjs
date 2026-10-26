const net = require('node:net');
const { randomUUID } = require('node:crypto');
const owner = 'fixture-native-owner';
const question = {
  id: '["request_user_input_async","call_fixture",0]',
  originalQuestion: 'Fixture question?',
  originalOptions: ['First', 'Second', 'Later']
};
function state(sessionId, q = question, status = 'inProgress') {
  return {
    id: sessionId,
    hostId: 'local',
    cwd: 'D:\\fixture',
    turns: [
      {
        turnId: 'fixture-turn',
        status,
        items: [
          {
            type: 'agentMessage',
            id: JSON.parse(q.id)[1],
            questions: [{ title: q.originalQuestion, options: q.originalOptions }]
          }
        ]
      }
    ]
  };
}
async function fixture(
  t,
  { getState = (id) => state(id), onSubscribe, mutation, timeoutMs = 1500 } = {}
) {
  const sockets = new Set(),
    requests = [],
    mutations = [];
  const server = net.createServer((socket) => {
    sockets.add(socket);
    socket.on('close', () => sockets.delete(socket));
    let buffer = Buffer.alloc(0),
      clientId;
    const send = (m) => {
      const frames = (Array.isArray(m) ? m : [m]).map((value) => {
        const b = Buffer.from(JSON.stringify(value)),
          h = Buffer.alloc(4);
        h.writeUInt32LE(b.length);
        return Buffer.concat([h, b]);
      });
      socket.write(Buffer.concat(frames));
    };
    socket.on('data', (data) => {
      buffer = Buffer.concat([buffer, data]);
      while (buffer.length >= 4 && buffer.length >= buffer.readUInt32LE() + 4) {
        const size = buffer.readUInt32LE(),
          m = JSON.parse(buffer.subarray(4, size + 4));
        buffer = buffer.subarray(size + 4);
        if (m.type === 'broadcast') {
          if (m.method !== 'thread-stream-following-changed') continue;
          const snapshot = (s) =>
            send({
              type: 'broadcast',
              method: 'thread-stream-state-changed',
              version: 11,
              sourceClientId: owner,
              targetClientIds: [clientId],
              params: {
                hostId: 'local',
                conversationId: m.params.conversationId,
                change: { type: 'snapshot', revision: 1, conversationState: s }
              }
            });
          if (onSubscribe) onSubscribe({ m, snapshot, send, socket });
          else snapshot(getState(m.params.conversationId));
          continue;
        }
        if (m.type !== 'request') continue;
        requests.push(m);
        const respond = (result) =>
          send({
            type: 'response',
            requestId: m.requestId,
            resultType: 'success',
            method: m.method,
            handledByClientId: owner,
            result
          });
        if (m.method === 'initialize') {
          clientId = randomUUID();
          respond({ clientId });
        } else if (m.method === 'thread-owner-discovery')
          respond({ supportsUntrustedAppInput: true });
        else {
          mutations.push(m);
          if (mutation) mutation({ m, send, respond, socket });
          else
            respond({
              result:
                m.method === 'thread-follower-steer-turn'
                  ? { turnId: 'fixture-turn' }
                  : { turn: { id: 'next-fixture-turn' } }
            });
        }
      }
    });
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  t.after(async () => {
    for (const s of sockets) s.destroy();
    await new Promise((resolve) => server.close(resolve));
  });
  return {
    pipePath: { host: '127.0.0.1', port: server.address().port },
    timeoutMs,
    requests,
    mutations
  };
}
module.exports = { fixture, question, state };
