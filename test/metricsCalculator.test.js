/**
 * 指标合并/格式化单测。
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const MetricsCalculator = require('../src/calculators/MetricsCalculator');

test('mergeFileDetails 以 sloc 为基础合并 lizard/duplication 文件明细', () => {
  const merged = MetricsCalculator.mergeFileDetails(
    [{ filePath: 'a.js', language: 'JavaScript', loc: 10, commentLines: 2 }],
    [
      {
        filePath: 'a.js',
        functionCount: 1,
        avgFunctionLoc: 5,
        avgCyclomaticComplexity: 2,
        functionDetails: [{ functionName: 'f', functionLoc: 5, startLine: 1, endLine: 5 }]
      }
    ],
    [
      { filePath: 'a.js', duplicationRate: 10, duplicationLineCount: 1, duplicatedFiles: ['b.js'] },
      { filePath: 'b.prelds', totalLines: 12, duplicationRate: 50, duplicationLineCount: 6 }
    ]
  );

  assert.equal(merged.length, 2);
  const a = merged.find((d) => d.filePath === 'a.js');
  assert.equal(a.language, 'JavaScript');
  assert.equal(a.loc, 10);
  assert.equal(a.functionCount, 1);
  assert.equal(a.duplicationRate, 10);
  assert.deepEqual(a.duplicatedFiles, ['b.js']);

  // duplication 独有文件：loc 用 totalLines 兜底
  const b = merged.find((d) => d.filePath === 'b.prelds');
  assert.equal(b.loc, 12);
  assert.equal(b.language, '');
  assert.equal(b.duplicationLineCount, 6);
});

test('mergeResults 合并总体指标并保留明细数组', () => {
  const result = MetricsCalculator.mergeResults(
    { codeScale: 10, fileDetails: [{ filePath: 'a.js', loc: 10 }] },
    { averageFunctionLoc: 5, fileDetails: [{ filePath: 'a.js', functionCount: 1 }] },
    {
      totalCodeDuplicationRate: 1.2,
      fileDetails: [{ filePath: 'a.js', duplicationLineCount: 1 }],
      identicalFileDetails: [{ duplicatedFiles: ['a.js', 'b.js'] }],
      duplicationOccurrences: [{ groupId: 'g' }]
    }
  );

  assert.equal(result.codeScale, 10);
  assert.equal(result.averageFunctionLoc, 5);
  assert.equal(result.totalCodeDuplicationRate, 1.2);
  assert.equal(result.fileDetails.length, 1);
  assert.equal(result.fileDetails[0].duplicationLineCount, 1);
  assert.deepEqual(result.identicalFileDetails, [{ duplicatedFiles: ['a.js', 'b.js'] }]);
  assert.deepEqual(result.duplicationOccurrences, [{ groupId: 'g' }]);
});

test('mergeFileDetails 无函数文件的两个均值指标保持 null', () => {
  const merged = MetricsCalculator.mergeFileDetails(
    [{ filePath: 'readme.yaml', language: 'YAML', loc: 10, commentLines: 0 }],
    [],
    [{ filePath: 'config.json', totalLines: 5, duplicationRate: 0, duplicationLineCount: 0 }]
  );

  for (const detail of merged) {
    assert.equal(detail.functionCount, 0);
    assert.equal(detail.avgFunctionLoc, null);
    assert.equal(detail.avgCyclomaticComplexity, null);
  }
});

test('validate 校验 5 项必需指标', () => {
  const metrics = {
    codeScale: 1,
    averageFunctionLoc: 1,
    averageCyclomaticComplexity: 1,
    totalCodeDuplicationRate: 1,
    totalFileDuplicationRate: 1
  };
  assert.equal(MetricsCalculator.validate(metrics), true);
  assert.throws(() => MetricsCalculator.validate({}), /Missing required metric/);
});

test('validate 允许无函数时两个均值指标为 null，但键缺失仍报错', () => {
  const metrics = {
    codeScale: 1,
    averageFunctionLoc: null,
    averageCyclomaticComplexity: null,
    totalCodeDuplicationRate: 0,
    totalFileDuplicationRate: 0
  };
  assert.equal(MetricsCalculator.validate(metrics), true);

  // 键缺失（探测器未执行）仍按配置错误拦截
  assert.throws(
    () =>
      MetricsCalculator.validate({
        codeScale: 1,
        totalCodeDuplicationRate: 0,
        totalFileDuplicationRate: 0
      }),
    /Missing required metric: averageFunctionLoc/
  );
});

test('formatForReport 归一化数值并映射平台字段', () => {
  const formatted = MetricsCalculator.formatForReport({
    codeScale: '100',
    rawLines: '120',
    commentLines: '5',
    totalCyclomaticComplexity: '8',
    cyclomaticComplexityPerFile: '2',
    duplicatedBlocks: '1',
    duplicatedLines: '3',
    averageFunctionLoc: '4',
    averageCyclomaticComplexity: '1.5',
    totalCodeDuplicationRate: '3',
    totalFileDuplicationRate: '4',
    fileDetails: [],
    identicalFileDetails: [],
    duplicationOccurrences: []
  });

  assert.equal(formatted.codeScale, 100);
  assert.equal(formatted.codeLineTotal, 120);
  assert.equal(formatted.commentLines, 5);
  assert.equal(formatted.complexityCount, 8);
  assert.equal(formatted.cyclomaticComplexityPerFile, 2);
  assert.equal(formatted.duplicatedBlocks, 1);
  assert.equal(formatted.duplicatedLines, 3);
  assert.equal(formatted.avgFunctionLoc, 4);
  assert.equal(formatted.avgCyclomaticComplexity, 1.5);
  assert.deepEqual(formatted.fileDetails, []);
  assert.deepEqual(formatted.identicalFileDetails, []);
  assert.deepEqual(formatted.duplicationOccurrences, []);
});

test('formatForReport 缺失字段回退为 0/空数组，均值指标回退为 null', () => {
  const formatted = MetricsCalculator.formatForReport({});
  assert.equal(formatted.codeScale, 0);
  assert.equal(formatted.codeLineTotal, 0);
  // 分母为 0 时均值指标无数据，不能回退为 0
  assert.equal(formatted.avgFunctionLoc, null);
  assert.equal(formatted.avgCyclomaticComplexity, null);
  assert.deepEqual(formatted.fileDetails, []);
});
