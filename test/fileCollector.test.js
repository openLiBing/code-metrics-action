/**
 * 文件收集与排除规则单测。
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const FileCollector = require('../src/utils/fileCollector');

function makeTempDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'file-collector-'));
}

test('isAllowedFile：文件名特例优先、显式扩展名覆盖缺省白名单', () => {
  assert.equal(FileCollector.isAllowedFile('CMakeLists.txt', []), true);
  assert.equal(FileCollector.isAllowedFile('Makefile', []), true);
  assert.equal(FileCollector.isAllowedFile('main.js', []), true);
  assert.equal(FileCollector.isAllowedFile('README.xyz', []), false);
  // 覆盖式语义：显式配置后不再叠加缺省白名单
  assert.equal(FileCollector.isAllowedFile('main.cpp', ['.CPP']), true);
  assert.equal(FileCollector.isAllowedFile('main.js', ['.cpp']), false);
});

test('isExcluded：裸名称仅顶层匹配、通配符任意层级、路径锚定扫描根', () => {
  assert.equal(FileCollector.isExcluded('docs', 'docs', ['docs']), true);
  assert.equal(FileCollector.isExcluded('test.ts', 'src/test.ts', ['test.ts']), false);
  assert.equal(FileCollector.isExcluded('a.test.js', 'src/a.test.js', ['*.test.js']), true);
  assert.equal(FileCollector.isExcluded('grapesjs', 'src/opensource/grapesjs', ['src/opensource/*']), true);
  assert.equal(FileCollector.isExcluded('docs', 'docs', ['docs/']), true);
  assert.equal(FileCollector.isExcluded('lib', 'src/lib', ['/lib']), false);
});

test('isPathExcluded：任一祖先目录命中即整棵子树排除', () => {
  assert.equal(FileCollector.isPathExcluded('go/test.go', ['go/']), true);
  assert.equal(FileCollector.isPathExcluded('cpp/part.cpp', ['cpp/**']), true);
  assert.equal(FileCollector.isPathExcluded('src/go/x.go', ['go/']), false);
});

test('globToRegExp：* 不跨目录、** 跨目录、? 与字符类', () => {
  assert.match('src/a/b/test1.js', FileCollector.globToRegExp('src/**/test?.js'));
  assert.doesNotMatch('src/test12.js', FileCollector.globToRegExp('src/**/test?.js'));
  assert.match('a.js', FileCollector.globToRegExp('*.js'));
  assert.doesNotMatch('a/b.js', FileCollector.globToRegExp('*.js'));
  assert.match('a9.js', FileCollector.globToRegExp('a[0-9].js'));
});

test('globToRegExp：非法字符类与超限规则返回 null，不抛异常', () => {
  // 非法区间（[z-a]）不能让 new RegExp 抛异常中断扫描
  assert.equal(FileCollector.globToRegExp('[z-a]'), null);
  // 超长模式与 globstar 层数超限直接拒绝，兜底正则回溯风险
  assert.equal(FileCollector.globToRegExp('a'.repeat(FileCollector.MAX_GLOB_PATTERN_LENGTH + 1)), null);
  assert.equal(
    FileCollector.globToRegExp(Array(FileCollector.MAX_GLOBSTAR_COUNT + 1).fill('**').join('/')),
    null
  );
  // isExcluded 跳过非法规则，不影响其他合法规则命中
  assert.equal(FileCollector.isExcluded('docs', 'docs', ['[z-a]']), false);
  assert.equal(FileCollector.isExcluded('docs', 'docs', ['[z-a]', 'docs']), true);
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
    assert.deepEqual(
      files.map((f) => path.basename(f)),
      ['a.js']
    );
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('collectFiles：不存在的路径跳过且不抛异常', () => {
  const missing = path.join(os.tmpdir(), `missing-${Date.now()}`, 'nope');
  assert.deepEqual(FileCollector.collectFiles(missing, [], []), []);
});

test('isDefaultExcludedDir 仅排除版本控制与 IDE 私有目录', () => {
  assert.equal(FileCollector.isDefaultExcludedDir('.git'), true);
  assert.equal(FileCollector.isDefaultExcludedDir('.idea'), true);
  assert.equal(FileCollector.isDefaultExcludedDir('.gitcode'), false);
  assert.equal(FileCollector.isDefaultExcludedDir('src'), false);
});
