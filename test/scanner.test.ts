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

test('scan 全流程返回总体指标与文件明细（不上传）', async () => {
  const os = require('os');
  const fs = require('fs');
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'scan-e2e-'));
  try {
    fs.writeFileSync(path.join(tempDir, 'a.js'), 'const x = 1;\nconst y = 2;\n', 'utf8');
    const scanner = new MetricsScanner({
      sourceDir: tempDir,
      detectors: { sloc: { enabled: true }, lizard: { enabled: true }, duplication: { enabled: true } }
    });
    const result = await scanner.scan();

    // validate 4 项全局指标全部就位（sloc 兜底统计保证 codeScale 有值）
    expect(result.codeScale).toBeGreaterThan(0);
    expect(typeof result.totalCodeDuplicationRate).toBe('number');
    expect(typeof result.totalFileDuplicationRate).toBe('number');
    // fileDetails 从格式化结果中分离后独立返回
    expect(Array.isArray(result.fileDetails)).toBe(true);
    expect(result.fileDetails.length).toBe(1);
    expect(result.fileDetails[0].filePath).toBe('a.js');
    // detectionInfo 携带解析后的 source 列表与三个探测器的启用状态
    expect(result.detectionInfo.sources).toEqual([tempDir]);
    expect(result.detectionInfo.tools).toEqual({ sloc: true, lizard: true, duplication: true });
  } finally {
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
});

export {};
