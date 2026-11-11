/**
 * 重复率检测器纯逻辑单测（不依赖 scc 二进制）。
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const DuplicationDetector = require('../src/detectors/DuplicationDetector');

test('getLanguageConfig 按语言返回注释与多行字符串规则', () => {
  const js = DuplicationDetector.getLanguageConfig('.js', 'a.js');
  assert.deepEqual(js.lineComments, ['//']);
  assert.equal(js.blockStart, '/*');

  const cmake = DuplicationDetector.getLanguageConfig('.txt', 'CMakeLists.txt');
  assert.deepEqual(cmake.blockComments, [['#[[', ']]']]);

  const py = DuplicationDetector.getLanguageConfig('.py', 'a.py');
  assert.deepEqual(py.mlStrings, ['"""', "'''"]);

  const rb = DuplicationDetector.getLanguageConfig('.rb', 'a.rb');
  assert.equal(rb.blockStart, '=begin');
  assert.equal(rb.blockEnd, '=end');
});

test('buildSourceLineMap 剔除行注释、块注释与空行', () => {
  const detector = new DuplicationDetector({ minLines: 3 });
  const content = ['const a = 1;', '// comment', '/* block', 'still block */', 'const b = 2;'].join('\n');
  const result = detector.buildSourceLineMap(content, '/repo/a.js');

  assert.equal(result.sourceCount, 2);
  assert.equal(result.lineMap.get(1), true);
  assert.equal(result.lineMap.get(2), false);
  assert.equal(result.lineMap.get(3), false);
  assert.equal(result.lineMap.get(4), false);
  assert.equal(result.lineMap.get(5), true);
  assert.deepEqual(result.sourceLines.map((l) => l.lineNum), [1, 5]);
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
  assert.equal(result.sourceCount, 3);
  assert.deepEqual(result.sourceLines.map((l) => l.lineNum), [4, 5, 6]);
});

test('buildSourceLineMap 支持 CMake 方括号块注释且预处理行计入代码', () => {
  const detector = new DuplicationDetector({ minLines: 3 });
  const cmakeContent = ['#[[ block', 'comment', ']]', 'add_library(x)'].join('\n');
  assert.equal(detector.buildSourceLineMap(cmakeContent, '/repo/CMakeLists.txt').sourceCount, 1);

  const cContent = ['#include <stdio.h>', 'int main() {', '}'].join('\n');
  const cResult = detector.buildSourceLineMap(cContent, '/repo/a.c');
  assert.equal(cResult.lineMap.get(1), true);
  assert.equal(cResult.sourceCount, 3);
});

test('mergeIntervals 默认合并相邻区间，关闭后仅合并重叠', () => {
  const detector = new DuplicationDetector();
  assert.deepEqual(detector.mergeIntervals([
    { startLine: 1, endLine: 3 },
    { startLine: 4, endLine: 5 }
  ]), [{ startLine: 1, endLine: 5 }]);

  assert.deepEqual(detector.mergeIntervals([
    { startLine: 1, endLine: 3 },
    { startLine: 4, endLine: 5 }
  ], false), [
    { startLine: 1, endLine: 3 },
    { startLine: 4, endLine: 5 }
  ]);

  assert.deepEqual(detector.mergeIntervals([
    { startLine: 1, endLine: 5, oversized: true },
    { startLine: 4, endLine: 8 }
  ], false), [{ startLine: 1, endLine: 8, oversized: true }]);
});

test('toRelativePath 使用路径分隔符边界匹配', () => {
  const detector = new DuplicationDetector();
  assert.equal(detector.toRelativePath('/repo/src/a.js', ['/repo']), 'src/a.js');
  assert.equal(detector.toRelativePath('/repo-other/a.js', ['/repo']), '/repo-other/a.js');
  assert.equal(detector.toRelativePath('/repo', ['/repo']), '');
});

test('calculateFileDuplication 统计完全一致文件数量', () => {
  const detector = new DuplicationDetector();
  const contents = new Map([
    ['/repo/a.js', 'same'],
    ['/repo/b.js', 'same '],
    ['/repo/c.js', 'same'],
    ['/repo/d.js', 'other']
  ]);
  assert.equal(detector.calculateFileDuplication(contents), 3);
});

test('calculateIdenticalFileDetails 每组只输出一条记录', () => {
  const detector = new DuplicationDetector();
  const contents = new Map([
    ['/repo/a.js', 'same'],
    ['/repo/b.js', 'same'],
    ['/repo/c.js', 'other']
  ]);
  assert.deepEqual(detector.calculateIdenticalFileDetails(contents, ['/repo']), [
    { duplicatedFiles: ['a.js', 'b.js'] }
  ]);
});

test('buildContextSegments 生成 ±上下文快照并 Base64 编码', () => {
  const detector = new DuplicationDetector();
  const content = Array.from({ length: 10 }, (_, i) => `line${i + 1}`).join('\n');
  const fileDetails = [{ filePath: 'a.js', duplicationLineCount: 2 }];
  const occurrences = [{ filePath: 'a.js', startLine: 4, endLine: 5 }];

  const result = detector.buildContextSegments(
    fileDetails,
    occurrences,
    new Map([['/repo/a.js', content]]),
    ['/repo']
  );

  const snapshot = JSON.parse(Buffer.from(result[0].snapshotData, 'base64').toString('utf8'));
  assert.equal(snapshot.totalLines, 10);
  assert.equal(snapshot.contextLines, 5);
  assert.equal(snapshot.truncated, false);
  assert.equal(snapshot.segments.length, 1);
  assert.equal(
    Buffer.from(snapshot.segments[0].contentB64, 'base64').toString('utf8'),
    content
  );
});

test('isBinaryFile 通过 NUL 字节嗅探识别二进制文件', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dup-binary-'));
  try {
    const textFile = path.join(dir, 'a.txt');
    const binFile = path.join(dir, 'b.bin');
    fs.writeFileSync(textFile, 'plain text', 'utf8');
    fs.writeFileSync(binFile, Buffer.from([0x61, 0x00, 0x62]));
    assert.equal(DuplicationDetector.isBinaryFile(textFile), false);
    assert.equal(DuplicationDetector.isBinaryFile(binFile), true);
    assert.equal(DuplicationDetector.isBinaryFile(path.join(dir, 'missing.txt')), false);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('detectWithLineLevel 标记跨文件重复的源代码行', () => {
  const detector = new DuplicationDetector({ minLines: 3 });
  const makeSourceLines = () =>
    Array.from({ length: 12 }, (_, i) => ({ lineNum: i + 1, text: `code_${i + 1};` }));
  const fileSourceLineMaps = new Map([
    ['/repo/a.js', { lineMap: new Map(), sourceCount: 12, sourceLines: makeSourceLines() }],
    ['/repo/b.js', { lineMap: new Map(), sourceCount: 12, sourceLines: makeSourceLines() }]
  ]);

  const result = detector.detectWithLineLevel(['/repo/a.js', '/repo/b.js'], fileSourceLineMaps);

  assert.equal(result.fileDuplicatedLines.get('/repo/a.js').size, 12);
  assert.equal(result.fileDuplicatedLines.get('/repo/b.js').size, 12);
  // 12 行源码按窗口 3 滑动，共 10 个窗口哈希，全部在另一文件出现
  assert.equal(result.sharedHashWindows.size, 10);
});

test('getEmptyResult 返回全零指标', () => {
  const result = new DuplicationDetector().getEmptyResult();
  assert.equal(result.totalCodeDuplicationRate, 0);
  assert.equal(result.totalFileDuplicationRate, 0);
  assert.deepEqual(result.fileDetails, []);
  assert.deepEqual(result.duplicationOccurrences, []);
});
