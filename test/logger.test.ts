/**
 * 统一日志封装单测：验证按级别转发到 @actions/core。
 */
// Jest 运行时已注入全局 jest，解构同名变量会重复声明，故起别名
const { test, expect, jest: jestGlobals } = require('@jest/globals');
const core = require('@actions/core');
const Logger = require('../src/utils/logger');

test('Logger 将 info/warn/error/debug 转发到 @actions/core', () => {
  const infoSpy = jestGlobals.spyOn(core, 'info').mockImplementation(() => {});
  const warningSpy = jestGlobals.spyOn(core, 'warning').mockImplementation(() => {});
  const errorSpy = jestGlobals.spyOn(core, 'error').mockImplementation(() => {});
  const debugSpy = jestGlobals.spyOn(core, 'debug').mockImplementation(() => {});

  try {
    const logger = new Logger();
    logger.info('info-message');
    logger.warn('warn-message');
    logger.error('error-message');
    logger.debug('text', { a: 1 }, 2);

    expect(infoSpy).toHaveBeenCalledWith('info-message');
    expect(warningSpy).toHaveBeenCalledWith('warn-message');
    expect(errorSpy).toHaveBeenCalledWith('error-message');
    expect(debugSpy).toHaveBeenCalledWith('text {"a":1} 2');
  } finally {
    jestGlobals.restoreAllMocks();
  }
});

export {};
