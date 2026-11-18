/**
 * 扫描器构造与导出单测（不执行真实扫描）。
 */
const { test, expect } = require('@jest/globals');
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
  expect(typeof MetricsScanner).toBe('function');
  expect(typeof SlocDetector).toBe('function');
  expect(typeof LizardDetector).toBe('function');
  expect(typeof DuplicationDetector).toBe('function');
  expect(typeof MetricsCalculator).toBe('function');
  expect(ConfigLoader.getDefaultConfig().output).toBe('metrics.json');
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

  expect(scanner.slocDetector).toBeTruthy();
  expect(scanner.lizardDetector).toBeTruthy();
  expect(scanner.duplicationDetector).toBeTruthy();
  expect(scanner.uploader).toBeTruthy();
  expect(scanner.logger).toBeTruthy();
  expect(scanner.workingDir).toBe(process.cwd());
  expect(scanner.duplicationDetector.minLines).toBe(10);
  expect(path.isAbsolute(scanner.workingDir)).toBe(true);
});

export {};
