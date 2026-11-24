/**
 * 指标合并/格式化单测。
 */
const { test, expect } = require('@jest/globals');
import { MetricsCalculator } from '../src/calculators/MetricsCalculator';

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

  expect(merged.length).toBe(2);
  const a = merged.find((d) => d.filePath === 'a.js')!;
  expect(a.language).toBe('JavaScript');
  expect(a.loc).toBe(10);
  expect(a.functionCount).toBe(1);
  expect(a.duplicationRate).toBe(10);
  expect(a.duplicatedFiles).toEqual(['b.js']);

  // duplication 独有文件：loc 用 totalLines 兜底
  const b = merged.find((d) => d.filePath === 'b.prelds')!;
  expect(b.loc).toBe(12);
  expect(b.language).toBe('');
  expect(b.duplicationLineCount).toBe(6);
});

test('mergeResults 合并总体指标并保留明细数组', () => {
  const result = MetricsCalculator.mergeResults(
    { codeScale: 10, fileDetails: [{ filePath: 'a.js', loc: 10 }] },
    { averageFunctionLoc: 5, fileDetails: [{ filePath: 'a.js', functionCount: 1 }] },
    {
      totalCodeDuplicationRate: 1.2,
      fileDetails: [{ filePath: 'a.js', duplicationLineCount: 1 }],
      identicalFileDetails: [{ duplicatedFiles: ['a.js', 'b.js'] }],
      duplicationOccurrences: [
        {
          groupId: 'g',
          contentHash: 'abc123',
          occurrenceIndex: 0,
          filePath: 'a.js',
          startLine: 1,
          endLine: 5,
          content: 'console.log(1);'
        }
      ]
    }
  );

  expect(result.codeScale).toBe(10);
  expect(result.averageFunctionLoc).toBe(5);
  expect(result.totalCodeDuplicationRate).toBe(1.2);
  expect(result.fileDetails!.length).toBe(1);
  expect(result.fileDetails![0].duplicationLineCount).toBe(1);
  expect(result.identicalFileDetails).toEqual([{ duplicatedFiles: ['a.js', 'b.js'] }]);
  expect(result.duplicationOccurrences).toEqual([
    {
      groupId: 'g',
      contentHash: 'abc123',
      occurrenceIndex: 0,
      filePath: 'a.js',
      startLine: 1,
      endLine: 5,
      content: 'console.log(1);'
    }
  ]);
});

test('mergeFileDetails 无函数文件的两个均值指标保持 null', () => {
  const merged = MetricsCalculator.mergeFileDetails(
    [{ filePath: 'readme.yaml', language: 'YAML', loc: 10, commentLines: 0 }],
    [],
    [{ filePath: 'config.json', totalLines: 5, duplicationRate: 0, duplicationLineCount: 0 }]
  );

  for (const detail of merged) {
    expect(detail.functionCount).toBe(0);
    expect(detail.avgFunctionLoc).toBeNull();
    expect(detail.avgCyclomaticComplexity).toBeNull();
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
  expect(MetricsCalculator.validate(metrics)).toBe(true);
  expect(() => MetricsCalculator.validate({})).toThrow(/Missing required metric/);
});

test('validate 允许无函数时两个均值指标为 null，但键缺失仍报错', () => {
  const metrics = {
    codeScale: 1,
    averageFunctionLoc: null,
    averageCyclomaticComplexity: null,
    totalCodeDuplicationRate: 0,
    totalFileDuplicationRate: 0
  };
  expect(MetricsCalculator.validate(metrics)).toBe(true);

  // 键缺失（探测器未执行）仍按配置错误拦截
  expect(() =>
    MetricsCalculator.validate({
      codeScale: 1,
      totalCodeDuplicationRate: 0,
      totalFileDuplicationRate: 0
    })
  ).toThrow(/Missing required metric: averageFunctionLoc/);
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

  expect(formatted.codeScale).toBe(100);
  expect(formatted.codeLineTotal).toBe(120);
  expect(formatted.commentLines).toBe(5);
  expect(formatted.complexityCount).toBe(8);
  expect(formatted.cyclomaticComplexityPerFile).toBe(2);
  expect(formatted.duplicatedBlocks).toBe(1);
  expect(formatted.duplicatedLines).toBe(3);
  expect(formatted.avgFunctionLoc).toBe(4);
  expect(formatted.avgCyclomaticComplexity).toBe(1.5);
  expect(formatted.fileDetails).toEqual([]);
  expect(formatted.identicalFileDetails).toEqual([]);
  expect(formatted.duplicationOccurrences).toEqual([]);
});

test('formatForReport 缺失字段回退为 0/空数组，均值指标回退为 null', () => {
  const formatted = MetricsCalculator.formatForReport({});
  expect(formatted.codeScale).toBe(0);
  expect(formatted.codeLineTotal).toBe(0);
  // 分母为 0 时均值指标无数据，不能回退为 0
  expect(formatted.avgFunctionLoc).toBeNull();
  expect(formatted.avgCyclomaticComplexity).toBeNull();
  expect(formatted.fileDetails).toEqual([]);
});

export {};
