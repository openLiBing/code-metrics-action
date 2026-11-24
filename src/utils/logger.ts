const core = require('@actions/core');

/**
 * 统一日志封装：直接使用 @actions/core。
 * GitHub / GitCode 运行日志按 info / warning / error 级别展示；debug 仅在平台开启调试日志时输出。
 */
class Logger {
  // 支持多参数，拼接为一条消息
  debug(...args: any[]) {
    core.debug(args.map((a: any) => (typeof a === 'string' ? a : JSON.stringify(a))).join(' '));
  }

  info(message: any) {
    core.info(message);
  }

  warn(message: any) {
    core.warning(message);
  }

  error(message: any) {
    core.error(message);
  }
}

module.exports = Logger;

export {};
