/**
 * 文件工具类单测。
 */
const { test, expect } = require('@jest/globals');
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
    expect(fs.readFileSync(file, 'utf8')).toBe(JSON.stringify({ a: 1 }, null, 2));

    FileUtils.writeJsonFile(file, { a: 1 }, false);
    expect(fs.readFileSync(file, 'utf8')).toBe('{"a":1}');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('ensureDirectory 创建并返回目录路径', () => {
  const dir = makeTempDir();
  try {
    const target = path.join(dir, 'a', 'b');
    expect(FileUtils.ensureDirectory(target)).toBe(target);
    expect(fs.existsSync(target)).toBe(true);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('getExtension 返回小写无关的扩展名原值', () => {
  expect(FileUtils.getExtension('/tmp/A.JS')).toBe('.JS');
  expect(FileUtils.getExtension('README')).toBe('');
});

test('isFileAllowed 空白名单放行且大小写不敏感', () => {
  expect(FileUtils.isFileAllowed('a.js', [])).toBe(true);
  expect(FileUtils.isFileAllowed('a.js', undefined)).toBe(true);
  expect(FileUtils.isFileAllowed('a.JS', ['.js'])).toBe(true);
  expect(FileUtils.isFileAllowed('a.py', ['.js'])).toBe(false);
});

test('isDirectoryExcluded 支持目录名与路径片段匹配', () => {
  expect(FileUtils.isDirectoryExcluded('node_modules', [])).toBe(false);
  expect(FileUtils.isDirectoryExcluded('node_modules', ['node_modules'])).toBe(true);
  expect(FileUtils.isDirectoryExcluded('/repo/src/target', ['target'])).toBe(true);
  expect(FileUtils.isDirectoryExcluded('/repo/src', ['target'])).toBe(false);
});

export {};
