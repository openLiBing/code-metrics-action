/**
 * 默认配置模块。
 * 说明：config-file（YAML/JSON 配置文件）能力无实际使用，已移除；
 * 运行参数统一由 action 输入覆盖，仅保留内置默认值。
 */
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
    duplication: {
      enabled: true,
      // 与华为云 cmetrics 官方定义对齐："连续超过 10 行代码块重复记为一次"
      minLines: 10
    }
  },
  uploader: {
    enabled: true
  }
};

class ConfigLoader {
  static getDefaultConfig() {
    return JSON.parse(JSON.stringify(DEFAULT_CONFIG));
  }
}

module.exports = ConfigLoader;
