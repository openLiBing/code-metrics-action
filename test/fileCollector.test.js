/**
 * 文件收集与排除规则单测。
 */
const { test, expect } = require('@jest/globals');
const fs = require('fs');
const os = require('os');
const path = require('path');
const FileCollector = require('../src/utils/fileCollector');

function makeTempDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'file-collector-'));
}

test('isAllowedFile：文件名特例优先、显式扩展名覆盖缺省白名单', () => {
  expect(FileCollector.isAllowedFile('CMakeLists.txt', [])).toBe(true);
  expect(FileCollector.isAllowedFile('Makefile', [])).toBe(true);
  expect(FileCollector.isAllowedFile('main.js', [])).toBe(true);
  expect(FileCollector.isAllowedFile('README.xyz', [])).toBe(false);
  // 覆盖式语义：显式配置后不再叠加缺省白名单
  expect(FileCollector.isAllowedFile('main.cpp', ['.CPP'])).toBe(true);
  expect(FileCollector.isAllowedFile('main.js', ['.cpp'])).toBe(false);
});

test('isExcluded：裸名称仅顶层匹配、通配符任意层级、路径锚定扫描根', () => {
  expect(FileCollector.isExcluded('docs', 'docs', ['docs'])).toBe(true);
  expect(FileCollector.isExcluded('test.ts', 'src/test.ts', ['test.ts'])).toBe(false);
  expect(FileCollector.isExcluded('a.test.js', 'src/a.test.js', ['*.test.js'])).toBe(true);
  expect(FileCollector.isExcluded('grapesjs', 'src/opensource/grapesjs', ['src/opensource/*'])).toBe(true);
  expect(FileCollector.isExcluded('docs', 'docs', ['docs/'])).toBe(true);
  expect(FileCollector.isExcluded('lib', 'src/lib', ['/lib'])).toBe(false);
});

test('isPathExcluded：任一祖先目录命中即整棵子树排除', () => {
  expect(FileCollector.isPathExcluded('go/test.go', ['go/'])).toBe(true);
  expect(FileCollector.isPathExcluded('cpp/part.cpp', ['cpp/**'])).toBe(true);
  expect(FileCollector.isPathExcluded('src/go/x.go', ['go/'])).toBe(false);
});

test('globToRegExp：* 不跨目录、** 跨目录、? 与字符类', () => {
  expect('src/a/b/test1.js').toMatch(FileCollector.globToRegExp('src/**/test?.js'));
  expect('src/test12.js').not.toMatch(FileCollector.globToRegExp('src/**/test?.js'));
  expect('a.js').toMatch(FileCollector.globToRegExp('*.js'));
  expect('a/b.js').not.toMatch(FileCollector.globToRegExp('*.js'));
  expect('a9.js').toMatch(FileCollector.globToRegExp('a[0-9].js'));
});

test('globToRegExp：非法字符类与超限规则返回 null，不抛异常', () => {
  // 非法区间（[z-a]）不能让 new RegExp 抛异常中断扫描
  expect(FileCollector.globToRegExp('[z-a]')).toBeNull();
  // 超长模式与 globstar 层数超限直接拒绝，兜底正则回溯风险
  expect(FileCollector.globToRegExp('a'.repeat(FileCollector.MAX_GLOB_PATTERN_LENGTH + 1))).toBeNull();
  expect(
    FileCollector.globToRegExp(Array(FileCollector.MAX_GLOBSTAR_COUNT + 1).fill('**').join('/'))
  ).toBeNull();
  // isExcluded 跳过非法规则，不影响其他合法规则命中
  expect(FileCollector.isExcluded('docs', 'docs', ['[z-a]'])).toBe(false);
  expect(FileCollector.isExcluded('docs', 'docs', ['[z-a]', 'docs'])).toBe(true);
});

test('collectFiles：递归收集并应用默认隐藏目录/排除目录/扩展名过滤', () => {
  const root = makeTempDir();
  try {
    fs.mkdirSync(path.join(root, 'src'), { recursive: true });
    fs.mkdirSync(path.join(root, 'node_modules'), { recursive: true });
    fs.mkdirSync(path.join(root, '.git'), { recursive: true });
    fs.mkdirSync(path.join(root, 'docs'), { recursive: true });
    fs.writeFileSync(path.join(root, 'src', 'a.js'), 'const a = 1;\n');
    fs.writeFileSync(path.join(root, 'src', 'b.cpp'), 'int b;\n');
    fs.writeFileSync(path.join(root, 'node_modules', 'x.js'), 'module.exports = {};\n');
    fs.writeFileSync(path.join(root, '.git', 'config'), '[core]\n');
    fs.writeFileSync(path.join(root, 'docs', 'readme.md'), '# readme\n');

    const files = FileCollector.collectFiles(root, ['node_modules', 'docs'], ['.js']);
    expect(files.map((f) => path.basename(f))).toEqual(['a.js']);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('collectFiles：不存在的路径跳过且不抛异常', () => {
  const missing = path.join(os.tmpdir(), `missing-${Date.now()}`, 'nope');
  expect(FileCollector.collectFiles(missing, [], [])).toEqual([]);
});

test('isDefaultExcludedDir 仅排除版本控制与 IDE 私有目录', () => {
  expect(FileCollector.isDefaultExcludedDir('.git')).toBe(true);
  expect(FileCollector.isDefaultExcludedDir('.idea')).toBe(true);
  expect(FileCollector.isDefaultExcludedDir('.gitcode')).toBe(false);
  expect(FileCollector.isDefaultExcludedDir('src')).toBe(false);
});
