/**
 * lizard 检测器纯逻辑单测（不执行 python3 -m lizard）。
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const LizardDetector = require('../src/detectors/LizardDetector');

test('isSourceLine 过滤空行与注释行', () => {
  assert.equal(LizardDetector.isSourceLine(''), false);
  assert.equal(LizardDetector.isSourceLine('   '), false);
  assert.equal(LizardDetector.isSourceLine('# comment'), false);
  assert.equal(LizardDetector.isSourceLine('// comment'), false);
  assert.equal(LizardDetector.isSourceLine('/* block'), false);
  assert.equal(LizardDetector.isSourceLine('* line'), false);
  assert.equal(LizardDetector.isSourceLine('*/'), false);
  assert.equal(LizardDetector.isSourceLine('const a = 1;'), true);
});

test('countDefinitionLines 识别 Python 冒号与 C 风格左花括号', () => {
  const detector = new LizardDetector();
  assert.equal(detector.countDefinitionLines('def f():\n    pass\n', 1), 1);
  // ')' 与下一行 '{' 的分支返回签名起始到 ')' 的行数
  assert.equal(detector.countDefinitionLines('int f()\n{\n  return 1;\n}\n', 1), 1);
  // 多行签名以 '{' 结束行作为定义行数
  assert.equal(detector.countDefinitionLines('function f(\n  a,\n  b) {\n}\n', 1), 3);
  assert.equal(detector.countDefinitionLines('single line', 1), 1);
});

test('calculateBodyNloc 仅统计函数体有效代码行', () => {
  const detector = new LizardDetector();
  const content = ['def f():', '    a = 1', '    # comment', '    b = 2', ''].join('\n');
  assert.equal(detector.calculateBodyNloc(content, 1, 4, 1), 2);
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

  assert.equal(details.length, 1);
  assert.equal(details[0].filePath, 'a.js');
  assert.equal(details[0].functionCount, 2);
  assert.equal(details[0].avgFunctionLoc, 5);
  assert.equal(details[0].avgCyclomaticComplexity, 3);
  assert.deepEqual(details[0].functionDetails.map((f) => f.functionName), ['a', 'b']);
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

    assert.equal(result.totalFunctions, 1);
    assert.equal(result.totalCC, 3);
    assert.equal(result.totalNloc, 2);
    assert.equal(result.functions[0].name, 'f');
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

    assert.equal(result.totalFunctions, 1);
    assert.equal(result.totalCC, 5);
    assert.equal(result.totalNloc, 1);
    assert.equal(result.functions[0].startLine, 1);
    assert.equal(result.functions[0].endLine, 2);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('getEmptyResult 返回全零指标', () => {
  const result = new LizardDetector().getEmptyResult();
  assert.equal(result.totalFunctions, 0);
  assert.equal(result.averageFunctionLoc, 0);
  assert.equal(result.averageCyclomaticComplexity, 0);
  assert.deepEqual(result.fileDetails, []);
});
