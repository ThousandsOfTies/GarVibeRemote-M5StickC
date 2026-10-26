#!/usr/bin/env node
// CLI dispatcher for single-chat questions and the multi-session collector.
const path = require('node:path');
const { readPcConfig } = require('./pc_config.cjs');
const history = require('./native_question_log.cjs');
const { startChatQuestions } = require('./question_service.cjs');

async function main() {
  const i = process.argv.indexOf('--config');
  if (i < 0 || !process.argv[i + 1]) throw Error('Use --config with private PC settings');
  const config = readPcConfig(process.argv[i + 1]);
  if (config.sessionScope && config.sessionScope !== 'single') {
    await require('./session_monitor.cjs').main(config);
    return;
  }
  const service = await startChatQuestions({
    config,
    journal: path.resolve(__dirname, '../.gar/chat-questions', `${config.sessionId}.json`),
    onEvent: (event) => console.log(JSON.stringify(event))
  });
  console.log(
    JSON.stringify({ event: 'chat-questions-ready', selectedSession: true, toolApprovals: false })
  );
  for (const signal of ['SIGINT', 'SIGTERM']) process.once(signal, () => void service.close());
}
// Preserve the existing import API; services import their own modules directly.
module.exports = { ...history, startChatQuestions };
if (require.main === module)
  main().catch(() => {
    console.error(
      '質問連携を開始できません。選択中のチャット・PCブリッジ・Codex Appとの接続を確認してください。'
    );
    process.exitCode = 1;
  });
