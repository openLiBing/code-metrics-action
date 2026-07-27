const fs = require('fs');
const path = require('path');
const yaml = require('js-yaml');

const DEFAULT_CONFIG = {
  sourceDir: './',
  output: 'metrics.json',
  // 排除目录：常见构建产物、依赖目录和 IDE/工具配置目录
  excludeDirs: [],
  // 支持的文件扩展名：覆盖主流编程语言
  allowedExtensions: [],
  detectors: {
    sloc: {
      enabled: true
    },
    lizard: {
      enabled: true
    },
    jscpd: {
      enabled: true,
      // 与华为云 cmetrics 官方定义对齐："连续超过 10 行代码块重复记为一次"
      minLines: 10,
      minTokens: 85,
      threshold: 0.3
    }
  },
  uploader: {
    enabled: true,
    coderepoUrl: '',
    timeout: 30
  },
  verbose: false,
  parallel: true
};

class ConfigLoader {
  static load(configPath) {
    let config = { ...DEFAULT_CONFIG };

    if (configPath && fs.existsSync(configPath)) {
      try {
        const fileContent = fs.readFileSync(configPath, 'utf8');
        const ext = path.extname(configPath).toLowerCase();

        let userConfig;
        if (ext === '.yaml' || ext === '.yml') {
          userConfig = yaml.load(fileContent);
        } else if (ext === '.json') {
          userConfig = JSON.parse(fileContent);
        } else {
          throw new Error(`Unsupported config file format: ${ext}`);
        }

        config = this.mergeConfig(config, userConfig);
      } catch (error) {
        console.warn(`Warning: Failed to load config file ${configPath}: ${error.message}`);
      }
    }

    return config;
  }

  static mergeConfig(defaultConfig, userConfig) {
    const merged = { ...defaultConfig };

    for (const key of Object.keys(userConfig)) {
      if (userConfig[key] === undefined || userConfig[key] === null) {
        continue;
      }

      if (Array.isArray(userConfig[key])) {
        // 如果用户配置了数组，完全替换默认值
        merged[key] = [...userConfig[key]];
      } else if (typeof userConfig[key] === 'object' && userConfig[key] !== null) {
        if (typeof merged[key] === 'object' && merged[key] !== null) {
          merged[key] = this.mergeConfig(merged[key], userConfig[key]);
        } else {
          merged[key] = userConfig[key];
        }
      } else {
        merged[key] = userConfig[key];
      }
    }

    return merged;
  }

  static getDefaultConfig() {
    return JSON.parse(JSON.stringify(DEFAULT_CONFIG));
  }
}

module.exports = ConfigLoader;
