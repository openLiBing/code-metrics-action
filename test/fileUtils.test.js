/**
 * 文件工具类单测。
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const FileUtils = require('../src/utils/fileUtils');

function makeTempDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'file-utils-'));
}

test('writeJsonFile 自动创建目录并按需格式化', () => {
  const dir = makeTempDir();
  try {
    const file = path.join(dir, 'nested', 'metrics.json');
    FileUtils.writeJsonFile(file, { a: 1 });
    assert.equal(fs.readFileSync(file, 'utf8'), JSON.stringify({ a: 1 }, null, 2));

    FileUtils.writeJsonFile(file, { a: 1 }, false);
    assert.equal(fs.readFileSync(file, 'utf8'), '{"a":1}');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('ensureDirectory 创建并返回目录路径', () => {
  const dir = makeTempDir();
  try {
    const target = path.join(dir, 'a', 'b');
    assert.equal(FileUtils.ensureDirectory(target), target);
    assert.equal(fs.existsSync(target), true);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('getExtension 返回小写无关的扩展名原值', () => {
  assert.equal(FileUtils.getExtension('/tmp/A.JS'), '.JS');
  assert.equal(FileUtils.getExtension('README'), '');
});

test('isFileAllowed 空白名单放行且大小写不敏感', () => {
  assert.equal(FileUtils.isFileAllowed('a.js', []), true);
  assert.equal(FileUtils.isFileAllowed('a.js', undefined), true);
  assert.equal(FileUtils.isFileAllowed('a.JS', ['.js']), true);
  assert.equal(FileUtils.isFileAllowed('a.py', ['.js']), false);
});

test('isDirectoryExcluded 支持目录名与路径片段匹配', () => {
  assert.equal(FileUtils.isDirectoryExcluded('node_modules', []), false);
  assert.equal(FileUtils.isDirectoryExcluded('node_modules', ['node_modules']), true);
  assert.equal(FileUtils.isDirectoryExcluded('/repo/src/target', ['target']), true);
  assert.equal(FileUtils.isDirectoryExcluded('/repo/src', ['target']), false);
});
