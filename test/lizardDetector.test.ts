/**
 * lizard 检测器纯逻辑单测（不执行 python3 -m lizard）。
 */
const { test, expect } = require('@jest/globals');
const fs = require('fs');
const os = require('os');
const path = require('path');
const LizardDetector = require('../src/detectors/LizardDetector');

test('isSourceLine 过滤空行与注释行', () => {
  expect(LizardDetector.isSourceLine('')).toBe(false);
  expect(LizardDetector.isSourceLine('   ')).toBe(false);
  expect(LizardDetector.isSourceLine('# comment')).toBe(false);
  expect(LizardDetector.isSourceLine('// comment')).toBe(false);
  expect(LizardDetector.isSourceLine('/* block')).toBe(false);
  expect(LizardDetector.isSourceLine('* line')).toBe(false);
  expect(LizardDetector.isSourceLine('*/')).toBe(false);
  expect(LizardDetector.isSourceLine('const a = 1;')).toBe(true);
});

test('countDefinitionLines 识别 Python 冒号与 C 风格左花括号', () => {
  const detector = new LizardDetector();
  expect(detector.countDefinitionLines('def f():\n    pass\n', 1)).toBe(1);
  // ')' 与下一行 '{' 的分支返回签名起始到 ')' 的行数
  expect(detector.countDefinitionLines('int f()\n{\n  return 1;\n}\n', 1)).toBe(1);
  // 多行签名以 '{' 结束行作为定义行数
  expect(detector.countDefinitionLines('function f(\n  a,\n  b) {\n}\n', 1)).toBe(3);
  expect(detector.countDefinitionLines('single line', 1)).toBe(1);
});

test('calculateBodyNloc 仅统计函数体有效代码行', () => {
  const detector = new LizardDetector();
  const content = ['def f():', '    a = 1', '    # comment', '    b = 2', ''].join('\n');
  expect(detector.calculateBodyNloc(content, 1, 4, 1)).toBe(2);
});

test('aggregateFileDetails 按文件聚合函数数与平均指标', () => {
  const detector = new LizardDetector();
  const details = detector.aggregateFileDetails(
    [
      { name: 'a', nloc: 4, cc: 2, startLine: 1, endLine: 4, filename: '/repo/a.js' },
      { name: 'b', nloc: 6, cc: 4, startLine: 6, endLine: 10, filename: '/repo/a.js' }
    ],
    ['/repo']
  );

  expect(details.length).toBe(1);
  expect(details[0].filePath).toBe('a.js');
  expect(details[0].functionCount).toBe(2);
  expect(details[0].avgFunctionLoc).toBe(5);
  expect(details[0].avgCyclomaticComplexity).toBe(3);
  expect(details[0].functionDetails.map((f: any) => f.functionName)).toEqual(['a', 'b']);
});

test('calculateMetricsFromLizard 从 lizard JSON 计算函数体有效行', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'lizard-'));
  try {
    const file = path.join(dir, 'a.py');
    fs.writeFileSync(file, ['def f():', '    a = 1', '    # comment', '    b = 2', ''].join('\n'));
    const detector = new LizardDetector();
    const result = detector.calculateMetricsFromLizard({
      functions: [
        { name: 'f', cyclomatic_complexity: 3, nloc: 4, start_line: 1, end_line: 4, filename: file }
      ]
    });

    expect(result.totalFunctions).toBe(1);
    expect(result.totalCC).toBe(3);
    expect(result.totalNloc).toBe(2);
    expect(result.functions[0].name).toBe('f');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('parseTextOutput 解析 lizard 文本输出', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'lizard-text-'));
  try {
    const file = path.join(dir, 'a.py');
    fs.writeFileSync(file, ['def f():', '    a = 1', ''].join('\n'));
    const detector = new LizardDetector();
    const line = `   2      5     10      0      20 f@1-2@${file}`;
    const result = detector.parseTextOutput(`NLOC CCN token PARAM length name@start-end@file\n${line}`);

    expect(result.totalFunctions).toBe(1);
    expect(result.totalCC).toBe(5);
    expect(result.totalNloc).toBe(1);
    expect(result.functions[0].startLine).toBe(1);
    expect(result.functions[0].endLine).toBe(2);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('getEmptyResult 函数总数为 0 时两个均值指标为 null', () => {
  const result = new LizardDetector().getEmptyResult();
  expect(result.totalFunctions).toBe(0);
  // 分母为 0 时均值指标不适用，必须为 null，不能是 0
  expect(result.averageFunctionLoc).toBeNull();
  expect(result.averageCyclomaticComplexity).toBeNull();
  expect(result.fileDetails).toEqual([]);
});

test('detect 汇总 runLizard 结果为函数级明细与均值', async () => {
  const os = require('os');
  const path = require('path');
  const fs = require('fs');
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'lizard-detect-'));
  try {
    fs.writeFileSync(path.join(tempDir, 'a.js'), 'function f1() {}\nfunction f2() {}\n', 'utf8');
    const detector = new LizardDetector({});
    // 覆写 runLizard（实例方法）：不依赖 python3/lizard 二进制，直接注入固定结果，
    // 让 detect() 走完文件收集 + 指标聚合的主流程
    detector.runLizard = () => ({
      totalFunctions: 2,
      totalNloc: 30,
      totalCC: 3,
      functions: [
        { name: 'f1', nloc: 10, cc: 1, startLine: 1, endLine: 10, filename: path.join(tempDir, 'a.js') },
        { name: 'f2', nloc: 20, cc: 2, startLine: 12, endLine: 31, filename: path.join(tempDir, 'a.js') }
      ]
    });
    const result = await detector.detect(tempDir);
    expect(result.totalFunctions).toBe(2);
    expect(result.totalNloc).toBe(30);
    expect(result.averageFunctionLoc).toBe(15);
    expect(result.averageCyclomaticComplexity).toBe(1.5);
    // 同一文件的函数聚合为一条文件级明细
    expect(result.fileDetails.length).toBe(1);
    expect(result.fileDetails[0].functionCount).toBe(2);
  } finally {
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
});

test('detect 在函数总数为 0 时返回无数据空结果', async () => {
  const os = require('os');
  const path = require('path');
  const fs = require('fs');
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'lizard-empty-'));
  try {
    fs.writeFileSync(path.join(tempDir, 'config.txt'), 'hello\n', 'utf8');
    const detector = new LizardDetector({});
    // runLizard 找不到 python3/lizard 时的真实降级形态：函数总数 0
    detector.runLizard = () => ({ totalFunctions: 0, totalNloc: 0, totalCC: 0, functions: [] });
    const result = await detector.detect(tempDir);
    // 均值指标无数据返回 null，而不是误报为 0
    expect(result.totalFunctions).toBe(0);
    expect(result.averageFunctionLoc).toBeNull();
    expect(result.averageCyclomaticComplexity).toBeNull();
    expect(result.fileDetails).toEqual([]);
  } finally {
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
});

export {};
