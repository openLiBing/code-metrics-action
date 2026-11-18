/**
 * 重复率检测器纯逻辑单测（不依赖 scc 二进制）。
 */
const { test, expect } = require('@jest/globals');
const fs = require('fs');
const os = require('os');
const path = require('path');
const DuplicationDetector = require('../src/detectors/DuplicationDetector');

test('getLanguageConfig 按语言返回注释与多行字符串规则', () => {
  const js = DuplicationDetector.getLanguageConfig('.js', 'a.js');
  expect(js.lineComments).toEqual(['//']);
  expect(js.blockStart).toBe('/*');

  const cmake = DuplicationDetector.getLanguageConfig('.txt', 'CMakeLists.txt');
  expect(cmake.blockComments).toEqual([['#[[', ']]']]);

  const py = DuplicationDetector.getLanguageConfig('.py', 'a.py');
  expect(py.mlStrings).toEqual(['"""', "'''"]);

  const rb = DuplicationDetector.getLanguageConfig('.rb', 'a.rb');
  expect(rb.blockStart).toBe('=begin');
  expect(rb.blockEnd).toBe('=end');
});

test('buildSourceLineMap 剔除行注释、块注释与空行', () => {
  const detector = new DuplicationDetector({ minLines: 3 });
  const content = ['const a = 1;', '// comment', '/* block', 'still block */', 'const b = 2;'].join('\n');
  const result = detector.buildSourceLineMap(content, '/repo/a.js');

  expect(result.sourceCount).toBe(2);
  expect(result.lineMap.get(1)).toBe(true);
  expect(result.lineMap.get(2)).toBe(false);
  expect(result.lineMap.get(3)).toBe(false);
  expect(result.lineMap.get(4)).toBe(false);
  expect(result.lineMap.get(5)).toBe(true);
  expect(result.sourceLines.map((l: any) => l.lineNum)).toEqual([1, 5]);
});

test('buildSourceLineMap 区分 Python docstring（注释）与行中三引号字符串（代码）', () => {
  const detector = new DuplicationDetector({ minLines: 3 });
  const content = [
    '"""module doc',
    'line2',
    '"""',
    'x = 1',
    'y = """inline',
    'still string"""'
  ].join('\n');
  const result = detector.buildSourceLineMap(content, '/repo/a.py');

  // docstring 整体不计入；行中三引号字符串整块计入代码行
  expect(result.sourceCount).toBe(3);
  expect(result.sourceLines.map((l: any) => l.lineNum)).toEqual([4, 5, 6]);
});

test('buildSourceLineMap 支持 CMake 方括号块注释且预处理行计入代码', () => {
  const detector = new DuplicationDetector({ minLines: 3 });
  const cmakeContent = ['#[[ block', 'comment', ']]', 'add_library(x)'].join('\n');
  expect(detector.buildSourceLineMap(cmakeContent, '/repo/CMakeLists.txt').sourceCount).toBe(1);

  const cContent = ['#include <stdio.h>', 'int main() {', '}'].join('\n');
  const cResult = detector.buildSourceLineMap(cContent, '/repo/a.c');
  expect(cResult.lineMap.get(1)).toBe(true);
  expect(cResult.sourceCount).toBe(3);
});

test('mergeIntervals 默认合并相邻区间，关闭后仅合并重叠', () => {
  const detector = new DuplicationDetector();
  expect(detector.mergeIntervals([
    { startLine: 1, endLine: 3 },
    { startLine: 4, endLine: 5 }
  ])).toEqual([{ startLine: 1, endLine: 5 }]);

  expect(detector.mergeIntervals([
    { startLine: 1, endLine: 3 },
    { startLine: 4, endLine: 5 }
  ], false)).toEqual([
    { startLine: 1, endLine: 3 },
    { startLine: 4, endLine: 5 }
  ]);

  expect(detector.mergeIntervals([
    { startLine: 1, endLine: 5, oversized: true },
    { startLine: 4, endLine: 8 }
  ], false)).toEqual([{ startLine: 1, endLine: 8, oversized: true }]);
});

test('toRelativePath 使用路径分隔符边界匹配', () => {
  const detector = new DuplicationDetector();
  expect(detector.toRelativePath('/repo/src/a.js', ['/repo'])).toBe('src/a.js');
  expect(detector.toRelativePath('/repo-other/a.js', ['/repo'])).toBe('/repo-other/a.js');
  expect(detector.toRelativePath('/repo', ['/repo'])).toBe('');
});

test('calculateFileDuplication 统计完全一致文件数量', () => {
  const detector = new DuplicationDetector();
  const contents = new Map([
    ['/repo/a.js', 'same'],
    ['/repo/b.js', 'same '],
    ['/repo/c.js', 'same'],
    ['/repo/d.js', 'other']
  ]);
  expect(detector.calculateFileDuplication(contents)).toBe(3);
});

test('calculateIdenticalFileDetails 每组只输出一条记录', () => {
  const detector = new DuplicationDetector();
  const contents = new Map([
    ['/repo/a.js', 'same'],
    ['/repo/b.js', 'same'],
    ['/repo/c.js', 'other']
  ]);
  expect(detector.calculateIdenticalFileDetails(contents, ['/repo'])).toEqual([
    { duplicatedFiles: ['a.js', 'b.js'] }
  ]);
});

test('buildContextSegments 生成 ±上下文快照并 Base64 编码', () => {
  const detector = new DuplicationDetector();
  const content = Array.from({ length: 10 }, (_: any, i: any) => `line${i + 1}`).join('\n');
  const fileDetails = [{ filePath: 'a.js', duplicationLineCount: 2 }];
  const occurrences = [{ filePath: 'a.js', startLine: 4, endLine: 5 }];

  const result = detector.buildContextSegments(
    fileDetails,
    occurrences,
    new Map([['/repo/a.js', content]]),
    ['/repo']
  );

  const snapshot = JSON.parse(Buffer.from(result[0].snapshotData, 'base64').toString('utf8'));
  expect(snapshot.totalLines).toBe(10);
  expect(snapshot.contextLines).toBe(5);
  expect(snapshot.truncated).toBe(false);
  expect(snapshot.segments.length).toBe(1);
  expect(Buffer.from(snapshot.segments[0].contentB64, 'base64').toString('utf8')).toBe(content);
});

test('isBinaryFile 通过 NUL 字节嗅探识别二进制文件', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dup-binary-'));
  try {
    const textFile = path.join(dir, 'a.txt');
    const binFile = path.join(dir, 'b.bin');
    fs.writeFileSync(textFile, 'plain text', 'utf8');
    fs.writeFileSync(binFile, Buffer.from([0x61, 0x00, 0x62]));
    expect(DuplicationDetector.isBinaryFile(textFile)).toBe(false);
    expect(DuplicationDetector.isBinaryFile(binFile)).toBe(true);
    expect(DuplicationDetector.isBinaryFile(path.join(dir, 'missing.txt'))).toBe(false);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('detectWithLineLevel 标记跨文件重复的源代码行', () => {
  const detector = new DuplicationDetector({ minLines: 3 });
  const makeSourceLines = () =>
    Array.from({ length: 12 }, (_: any, i: any) => ({ lineNum: i + 1, text: `code_${i + 1};` }));
  const fileSourceLineMaps = new Map([
    ['/repo/a.js', { lineMap: new Map(), sourceCount: 12, sourceLines: makeSourceLines() }],
    ['/repo/b.js', { lineMap: new Map(), sourceCount: 12, sourceLines: makeSourceLines() }]
  ]);

  const result = detector.detectWithLineLevel(['/repo/a.js', '/repo/b.js'], fileSourceLineMaps);

  expect(result.fileDuplicatedLines.get('/repo/a.js').size).toBe(12);
  expect(result.fileDuplicatedLines.get('/repo/b.js').size).toBe(12);
  // 12 行源码按窗口 3 滑动，共 10 个窗口哈希，全部在另一文件出现
  expect(result.sharedHashWindows.size).toBe(10);
});

test('getEmptyResult 返回全零指标', () => {
  const result = new DuplicationDetector().getEmptyResult();
  expect(result.totalCodeDuplicationRate).toBe(0);
  expect(result.totalFileDuplicationRate).toBe(0);
  expect(result.fileDetails).toEqual([]);
  expect(result.duplicationOccurrences).toEqual([]);
});

export {};
