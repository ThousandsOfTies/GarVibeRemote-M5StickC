// Private PC configuration shared by the independently started Node services.
const fs = require('node:fs');

const isSessionId = (value) => typeof value === 'string' && /^[A-Za-z0-9_-]{1,128}$/.test(value);
const validPort = (value) => Number.isInteger(value) && value >= 1 && value <= 65535;
const validSessionIds = (ids) =>
  Array.isArray(ids) &&
  ids.length >= 1 &&
  ids.length <= 16 &&
  ids.every(isSessionId) &&
  new Set(ids).size === ids.length;

function readPcConfig(file) {
  let config;
  try {
    config = JSON.parse(fs.readFileSync(file, 'utf8').replace(/^\uFEFF/, ''));
  } catch {
    throw Error('Cannot read private PC configuration');
  }
  const scope = config?.sessionScope === undefined ? 'single' : config.sessionScope;
  if (
    !config ||
    typeof config !== 'object' ||
    Array.isArray(config) ||
    typeof config.token !== 'string' ||
    !/^[A-Za-z0-9_-]{16,128}$/.test(config.token) ||
    !validPort(config.port) ||
    (config.sessionId != null && !isSessionId(config.sessionId)) ||
    !['single', 'project', 'local', 'manual'].includes(scope) ||
    ['chatQuestions', 'watchInput'].some(
      (key) => config[key] !== undefined && typeof config[key] !== 'boolean'
    ) ||
    ((scope !== 'single' || config.chatQuestions) && !isSessionId(config.sessionId)) ||
    (config.label !== undefined &&
      (typeof config.label !== 'string' ||
        [...config.label].length > 120 ||
        /\p{Cc}/u.test(config.label))) ||
    (config.sessionScope === 'project' &&
      (typeof config.codexCwd !== 'string' || !config.codexCwd.trim())) ||
    (config.sessionScope === 'manual' && !validSessionIds(config.sessionIds))
  ) {
    throw Error('Invalid private PC configuration');
  }
  return config;
}

module.exports = { isSessionId, readPcConfig };
