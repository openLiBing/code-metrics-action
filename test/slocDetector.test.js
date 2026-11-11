/**
 * scc 检测器纯逻辑与本地兜底统计单测（不执行 scc 二进制）。
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const SlocDetector = require('../src/detectors/SlocDetector');

test('isFilePath 区分文件路径与语言汇总行', () => {
  const detector = new SlocDetector({});
  assert.equal(detector.isFilePath('/repo/a.js'), true);
  assert.equal(detector.isFilePath('a.js'), true);
  assert.equal(detector.isFilePath('Java'), false);
  assert.equal(detector.isFilePath(''), false);
});

test('toRelativePath 统一输出正斜杠相对路径', () => {
  const detector = new SlocDetector({});
  assert.equal(detector.toRelativePath('/repo/src/a.js', ['/repo']), 'src/a.js');
});

test('buildSccArgs 拼接 JSON/by-file 参数与扩展名覆盖参数', () => {
  const detector = new SlocDetector({ allowedExtensions: ['.js', '.cpp'] });
  assert.deepEqual(detector.buildSccArgs(['/repo'], ['node_modules']), [
    '-f',
    'json',
    '--no-cocomo',
    '--no-size',
    '--by-file',
    '--include-ext',
    'js,cpp',
    '/repo'
  ]);

  const noExt = new SlocDetector({});
  assert.deepEqual(noExt.buildSccArgs(['/repo'], []), [
    '-f',
    'json',
    '--no-cocomo',
    '--no-size',
    '--by-file',
    '/repo'
  ]);
});

test('fallbackDetect 在 scc 不可用时逐文件统计有效代码行', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sloc-fallback-'));
  try {
    fs.writeFileSync(
      path.join(dir, 'a.js'),
      ['const a = 1;', '// comment', '', 'const b = 2;'].join('\n')
    );
    const detector = new SlocDetector({});
    const result = detector.fallbackDetect([dir], []);

    assert.equal(result.codeScale, 2);
    assert.equal(result.rawLines, 4);
    assert.equal(result.commentLines, 1);
    assert.equal(result.blankLines, 1);
    assert.equal(result.fileDetails.length, 1);
    assert.equal(result.fileDetails[0].filePath, 'a.js');
    assert.equal(result.fileDetails[0].loc, 2);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('detect 在 scc 路径缺失时自动回退本地统计', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sloc-detect-'));
  try {
    fs.writeFileSync(path.join(dir, 'a.js'), 'const a = 1;\n');
    const detector = new SlocDetector({});
    detector.sccPath = null;
    const result = await detector.detect([dir]);
    assert.equal(result.codeScale, 1);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('getName 返回 sloc', () => {
  assert.equal(new SlocDetector({}).getName(), 'sloc');
});
