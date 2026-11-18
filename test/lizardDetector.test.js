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
  expect(details[0].functionDetails.map((f) => f.functionName)).toEqual(['a', 'b']);
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
