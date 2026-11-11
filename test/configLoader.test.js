/**
 * 默认配置模块单测。
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const ConfigLoader = require('../src/config/loader');

test('getDefaultConfig 返回完整默认配置', () => {
  const config = ConfigLoader.getDefaultConfig();
  assert.equal(config.sourceDir, './');
  assert.equal(config.output, 'metrics.json');
  assert.deepEqual(config.excludeDirs, []);
  assert.deepEqual(config.allowedExtensions, []);
  assert.equal(config.detectors.sloc.enabled, true);
  assert.equal(config.detectors.lizard.enabled, true);
  assert.equal(config.detectors.duplication.enabled, true);
  assert.equal(config.detectors.duplication.minLines, 10);
  assert.equal(config.uploader.enabled, true);
});

test('getDefaultConfig 每次返回深拷贝，调用方修改不污染内置默认值', () => {
  const first = ConfigLoader.getDefaultConfig();
  first.detectors.duplication.minLines = 1;
  first.excludeDirs.push('node_modules');

  const second = ConfigLoader.getDefaultConfig();
  assert.equal(second.detectors.duplication.minLines, 10);
  assert.deepEqual(second.excludeDirs, []);
});
