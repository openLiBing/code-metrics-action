/**
 * 默认配置模块单测。
 */
const { test, expect } = require('@jest/globals');
const ConfigLoader = require('../src/config/loader');

test('getDefaultConfig 返回完整默认配置', () => {
  const config = ConfigLoader.getDefaultConfig();
  expect(config.sourceDir).toBe('./');
  expect(config.output).toBe('metrics.json');
  expect(config.excludeDirs).toEqual([]);
  expect(config.allowedExtensions).toEqual([]);
  expect(config.detectors.sloc.enabled).toBe(true);
  expect(config.detectors.lizard.enabled).toBe(true);
  expect(config.detectors.duplication.enabled).toBe(true);
  expect(config.detectors.duplication.minLines).toBe(10);
  expect(config.uploader.enabled).toBe(true);
});

test('getDefaultConfig 每次返回深拷贝，调用方修改不污染内置默认值', () => {
  const first = ConfigLoader.getDefaultConfig();
  first.detectors.duplication.minLines = 1;
  first.excludeDirs.push('node_modules');

  const second = ConfigLoader.getDefaultConfig();
  expect(second.detectors.duplication.minLines).toBe(10);
  expect(second.excludeDirs).toEqual([]);
});

export {};
