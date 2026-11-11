/**
 * 扫描器构造与导出单测（不执行真实扫描）。
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('path');
const {
  MetricsScanner,
  ConfigLoader,
  SlocDetector,
  LizardDetector,
  DuplicationDetector,
  MetricsCalculator
} = require('../src/scanner');

test('scanner 模块导出各检测器与计算器', () => {
  assert.equal(typeof MetricsScanner, 'function');
  assert.equal(typeof SlocDetector, 'function');
  assert.equal(typeof LizardDetector, 'function');
  assert.equal(typeof DuplicationDetector, 'function');
  assert.equal(typeof MetricsCalculator, 'function');
  assert.equal(ConfigLoader.getDefaultConfig().output, 'metrics.json');
});

test('MetricsScanner 构造时按配置创建检测器与上报器', () => {
  const scanner = new MetricsScanner({
    sourceDir: '.',
    excludeDirs: [],
    allowedExtensions: [],
    detectors: {
      sloc: { enabled: false },
      lizard: { enabled: false },
      duplication: { enabled: false, minLines: 10 }
    },
    uploader: { enabled: false }
  });

  assert.ok(scanner.slocDetector);
  assert.ok(scanner.lizardDetector);
  assert.ok(scanner.duplicationDetector);
  assert.ok(scanner.uploader);
  assert.ok(scanner.logger);
  assert.equal(scanner.workingDir, process.cwd());
  assert.equal(scanner.duplicationDetector.minLines, 10);
  assert.equal(path.isAbsolute(scanner.workingDir), true);
});
