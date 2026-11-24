class BaseDetector {
  config: any;

  constructor(config: any = {}) {
    this.config = config;
  }

  async detect(sourceDir: any) {
    throw new Error('Method detect() must be implemented');
  }

  getName() {
    throw new Error('Method getName() must be implemented');
  }
}

module.exports = BaseDetector;

export {};
