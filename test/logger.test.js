/**
 * 统一日志封装单测：验证按级别转发到 @actions/core。
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const core = require('@actions/core');
const Logger = require('../src/utils/logger');

test('Logger 将 info/warn/error/debug 转发到 @actions/core', () => {
  const original = {
    info: core.info,
    warning: core.warning,
    error: core.error,
    debug: core.debug
  };
  const calls = [];
  core.info = (message) => calls.push(['info', message]);
  core.warning = (message) => calls.push(['warn', message]);
  core.error = (message) => calls.push(['error', message]);
  core.debug = (message) => calls.push(['debug', message]);

  try {
    const logger = new Logger();
    logger.info('info-message');
    logger.warn('warn-message');
    logger.error('error-message');
    logger.debug('text', { a: 1 }, 2);
  } finally {
    Object.assign(core, original);
  }

  assert.deepEqual(calls, [
    ['info', 'info-message'],
    ['warn', 'warn-message'],
    ['error', 'error-message'],
    ['debug', 'text {"a":1} 2']
  ]);
});
