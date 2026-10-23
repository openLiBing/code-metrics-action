const winston = require('winston');

class Logger {
  constructor(config = {}) {
    this.verbose = config.verbose || false;
    this.logger = winston.createLogger({
      level: this.verbose ? 'debug' : 'info',
      format: winston.format.combine(
        winston.format.timestamp({ format: 'YYYY-MM-DD HH:mm:ss' }),
        winston.format.colorize(),
        winston.format.printf(({ timestamp, level, message }) => {
          return `${timestamp} [${level}] ${message}`;
        })
      ),
      transports: [
        new winston.transports.Console()
      ]
    });
  }

  // 支持多参数，拼接为一条消息
  debug(...args) {
    if (this.verbose) {
      this.logger.debug(args.map(a => typeof a === 'string' ? a : JSON.stringify(a)).join(' '));
    }
  }

  info(message) {
    this.logger.info(message);
  }

  warn(message) {
    this.logger.warn(message);
  }

  error(message) {
    this.logger.error(message);
  }
}

module.exports = Logger;
