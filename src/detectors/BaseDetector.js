class BaseDetector {
  constructor(config = {}) {
    this.config = config;
  }

  async detect(sourceDir) {
    throw new Error('Method detect() must be implemented');
  }

  getName() {
    throw new Error('Method getName() must be implemented');
  }
}

module.exports = BaseDetector;
