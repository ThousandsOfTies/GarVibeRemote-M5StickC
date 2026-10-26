const test = require('node:test');
const assert = require('node:assert/strict');
const {
  NativeChatReply,
  questionReply,
  assertQuestion
} = require('../scripts/native_chat_reply.cjs');
const { fixture, question, state } = require('./helpers/native_reply_fixture.cjs');
const { NativeQuestionLog } = require('../scripts/native_question_log.cjs');

test('physical answer is normal native input to the original chat, with no delegated tool or approval', async (t) => {
  const f = await fixture(t),
    client = new NativeChatReply(f);
  t.after(() => client.close());
  await client.reply(question, 'option-2', 'chat-b');
  const m = f.mutations[0];
  assert.equal(m.method, 'thread-follower-steer-turn');
  assert.equal(m.version, 1);
  assert.equal(m.params.conversationId, 'chat-b');
  assert.equal(m.targetClientId, 'fixture-native-owner');
  assert.deepEqual(JSON.parse(m.params.input[0].text.split('\n')[1]), [
    {
      questionItemId: question.id,
      question: question.originalQuestion,
      answer: 'Later'
    }
  ]);
  assert.equal(m.params.restoreMessage.text, m.params.input[0].text);
  assert.equal(m.params.clientUserMessageId, m.params.restoreMessage.id);
  assert.equal(m.params.toolOutput, undefined);
  assert.deepEqual(
    f.requests.map((r) => r.method),
    ['initialize', 'thread-owner-discovery', 'thread-follower-steer-turn']
  );
});

test('a question answered after its turn finishes starts the next turn without changing permissions or model', async (t) => {
  const f = await fixture(t, {
      getState: (id) => state(id, question, 'completed')
    }),
    client = new NativeChatReply(f);
  await client.reply(question, 'option-0', 'chat-a');
  const m = f.mutations[0];
  assert.equal(m.method, 'thread-follower-start-turn');
  assert.equal(m.version, 2);
  assert.equal(m.params.turnStart.request.threadId, 'chat-a');
  assert.deepEqual(Object.keys(m.params.turnStart.request).sort(), [
    'clientUserMessageId',
    'input',
    'threadId'
  ]);
});

test('native validation rejects another chat, replaced question, altered choices, interruption and accepted PC answer', async (t) => {
  const cases = [
    (s) => {
      s.id = 'another-chat';
    },
    (s) => {
      s.hostId = 'remote-host';
    },
    (s) => {
      s.turns[0].items[0].id = 'call_other';
    },
    (s) => {
      s.turns[0].items[0].questions[0] = {
        title: 'Changed?',
        options: ['First', 'Second']
      };
    },
    (s) => {
      s.turns[0].status = 'interrupted';
    },
    (s) => {
      s.turns[0].items.push({
        type: 'steeringUserMessage',
        status: 'accepted',
        input: [{ type: 'text', text: questionReply(question, 'option-0') }]
      });
    }
  ];
  for (const change of cases) {
    const f = await fixture(t, {
      getState: (id) => {
        const s = structuredClone(state(id));
        change(s);
        return s;
      }
    });
    await assert.rejects(new NativeChatReply(f).reply(question, 'option-1', 'chat-a'));
    assert.equal(f.mutations.length, 0);
  }
  for (const invalid of ['option-9', 'option-01', 'approve', 'option--1'])
    assert.throws(() => questionReply(question, invalid));
});

test('canonical native history uses the newest island and ignores older in-progress turns', () => {
  const latest = state('chat-a').turns[0];
  const s = {
    ...state('chat-a'),
    turns: [],
    turnHistory: {
      kind: 'canonical',
      history: {
        entitiesByKey: {
          old: { turnId: 'old-turn', status: 'inProgress', items: [] },
          latest
        },
        islands: [
          {
            entries: [{ value: 'old' }, { value: 'latest' }],
            newerBoundary: { status: 'exhausted' }
          }
        ]
      }
    }
  };
  assert.equal(assertQuestion(s, 'chat-a', question), latest);
  s.turnHistory.history.islands[0].newerBoundary.status = 'available';
  assert.throws(() => assertQuestion(s, 'chat-a', question));
});

test('roster revocation while waiting for native state prevents a write', async (t) => {
  let current = true;
  const f = await fixture(t, {
    onSubscribe: ({ m, snapshot }) => {
      current = false;
      snapshot(state(m.params.conversationId));
    }
  });
  const client = new NativeChatReply(f);
  await assert.rejects(
    client.reply(question, 'option-0', 'chat-a', () => {
      if (!current) throw Error('revoked');
    }),
    /revoked/
  );
  assert.equal(f.mutations.length, 0);
});

test('a timeout after dispatch is unconfirmed and never falls back to a delegated message or resends', async (t) => {
  const f = await fixture(t, { timeoutMs: 60, mutation: () => {} }),
    client = new NativeChatReply(f);
  await assert.rejects(client.reply(question, 'option-0', 'chat-a'), /unconfirmed/);
  assert.equal(f.mutations.length, 1);
  assert.equal(client.peers.size, 0);
});

test('native updates between snapshot and dispatch preserve activity but reject an accepted PC answer', async (t) => {
  for (const answered of [false, true]) {
    const f = await fixture(t, {
      onSubscribe: ({ m, send }) => {
        const message = (change) => ({
          type: 'broadcast',
          method: 'thread-stream-state-changed',
          version: 11,
          sourceClientId: 'fixture-native-owner',
          targetClientIds: [m.sourceClientId],
          params: { hostId: 'local', conversationId: m.params.conversationId, change }
        });
        send([
          message({
            type: 'snapshot',
            revision: 1,
            conversationState: state(m.params.conversationId)
          }),
          message({
            type: 'patches',
            baseRevision: 1,
            revision: 2,
            patches: [
              answered
                ? {
                    op: 'add',
                    path: ['turns', 0, 'items', 1],
                    value: {
                      type: 'steeringUserMessage',
                      status: 'accepted',
                      input: [{ type: 'text', text: questionReply(question, 'option-1') }]
                    }
                  }
                : { op: 'add', path: ['turns', 0, 'durationMs'], value: 3000 }
            ]
          })
        ]);
      }
    });
    const client = new NativeChatReply(f);
    if (answered)
      await assert.rejects(client.reply(question, 'option-0', 'chat-a'), /already answered/);
    else await client.reply(question, 'option-0', 'chat-a');
    assert.equal(f.mutations.length, answered ? 0 : 1);
  }
});

test('native rejection, malformed response and disconnect cannot report delivery', async (t) => {
  for (const mutation of [
    ({ m, send }) =>
      send({
        type: 'response',
        requestId: m.requestId,
        resultType: 'error',
        error: 'rejected'
      }),
    ({ respond }) => respond({ result: {} }),
    ({ socket }) => socket.destroy()
  ]) {
    const f = await fixture(t, { mutation });
    await assert.rejects(new NativeChatReply(f).reply(question, 'option-0', 'chat-a'));
    assert.equal(f.mutations.length, 1);
  }
});

test('only accepted native steering user messages complete local mirrored questions', () => {
  const m = new NativeQuestionLog('chat-a');
  const item = {
    type: 'steeringUserMessage',
    status: 'pending',
    input: [{ type: 'text', text: questionReply(question, 'option-0') }]
  };
  const record = {
    type: 'event_msg',
    payload: { type: 'item_completed', thread_id: 'chat-a', item }
  };
  m.consume(record);
  assert.equal(m.answered.size, 0);
  item.status = 'accepted';
  m.consume({ ...record, payload: { ...record.payload, thread_id: 'chat-b' } });
  assert.equal(m.answered.size, 0);
  m.consume(record);
  assert.equal(m.answered.has(question.id), true);
});
