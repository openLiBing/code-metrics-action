/**
 * scc 检测器纯逻辑与本地兜底统计单测（不执行 scc 二进制；runScc 解析路径
 * 通过 mock child_process 注入固定 scc JSON）。
 */
// 以别名 jestRef 解构（与全局 jest 同一实现）：直接解构 jest 会与 Jest 注入的
// 全局名冲突（already declared），且 tsconfig types 未含 jest（TS2304）。
const { test, expect, jest: jestRef } = require('@jest/globals');
const fs = require('fs');
const os = require('os');
const path = require('path');

// mock child_process 的 execFileSync：SlocDetector 模块级解构引用该 mock，
// 用于向 runScc 注入固定的 scc JSON 输出；execSync 等其余能力透传真实实现
// （mock 必须在 require SlocDetector 之前注册才生效）。
jestRef.mock('child_process', () => {
  const actual = jestRef.requireActual('child_process');
  return { ...actual, execFileSync: jestRef.fn() };
});

const SlocDetector = require('../src/detectors/SlocDetector');

test('isFilePath 区分文件路径与语言汇总行', () => {
  const detector = new SlocDetector({});
  expect(detector.isFilePath('/repo/a.js')).toBe(true);
  expect(detector.isFilePath('a.js')).toBe(true);
  expect(detector.isFilePath('Java')).toBe(false);
  expect(detector.isFilePath('')).toBe(false);
});

test('toRelativePath 统一输出正斜杠相对路径', () => {
  const detector = new SlocDetector({});
  expect(detector.toRelativePath('/repo/src/a.js', ['/repo'])).toBe('src/a.js');
});

test('buildSccArgs 拼接 JSON/by-file 参数与扩展名覆盖参数', () => {
  const detector = new SlocDetector({ allowedExtensions: ['.js', '.cpp'] });
  expect(detector.buildSccArgs(['/repo'], ['node_modules'])).toEqual([
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
  expect(noExt.buildSccArgs(['/repo'], [])).toEqual([
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

    expect(result.codeScale).toBe(2);
    expect(result.rawLines).toBe(4);
    expect(result.commentLines).toBe(1);
    expect(result.blankLines).toBe(1);
    expect(result.fileDetails.length).toBe(1);
    expect(result.fileDetails[0].filePath).toBe('a.js');
    expect(result.fileDetails[0].loc).toBe(2);
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
    expect(result.codeScale).toBe(1);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('getName 返回 sloc', () => {
  expect(new SlocDetector({}).getName()).toBe('sloc');
});

// ============ runScc 解析路径（mock execFileSync 注入固定 scc JSON） ============

test('runScc 解析 by-file 明细并输出文件级与语言级汇总', async () => {
  const { execFileSync } = require('child_process');
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'sloc-byfile-'));
  try {
    fs.writeFileSync(path.join(tempDir, 'a.js'), 'const x = 1;\nconst y = 2;\n', 'utf8');
    // 模拟 scc --by-file 的 JSON 输出：语言条目带 Files 明细，Location 为完整路径
    const sccJson = [
      {
        Name: 'JavaScript',
        Count: 1,
        Code: 12,
        Comment: 2,
        Blank: 1,
        Lines: 15,
        Files: [
          { Name: 'a.js', Location: path.join(tempDir, 'a.js'), Code: 12, Comment: 2, Blank: 1, Lines: 15 }
        ]
      }
    ];
    execFileSync.mockReturnValueOnce(JSON.stringify(sccJson));

    const detector = new SlocDetector({});
    const result = await detector.detect(tempDir);

    expect(result.codeScale).toBe(12);
    // by-file 明细转文件级记录：路径相对 sources、loc 取 Code、语言取语言条目名
    expect(result.fileDetails.length).toBe(1);
    expect(result.fileDetails[0].filePath).toBe('a.js');
    expect(result.fileDetails[0].loc).toBe(12);
    expect(result.fileDetails[0].commentLines).toBe(2);
    expect(result.fileDetails[0].language).toBe('JavaScript');
  } finally {
    fs.rmSync(tempDir, { recursive: true, force: true });
    execFileSync.mockReset();
  }
});

test('runScc 无 by-file 明细时回退本地逐文件统计', async () => {
  const { execFileSync } = require('child_process');
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'sloc-nofile-'));
  try {
    fs.writeFileSync(path.join(tempDir, 'a.js'), 'const x = 1;\nconst y = 2;\n', 'utf8');
    // Files 为空数组：scc 只有语言汇总、没有 by-file 明细 → runScc 内部回退逐文件统计
    const sccJson = [
      { Name: 'JavaScript', Count: 2, Code: 3, Comment: 0, Blank: 0, Lines: 3, Files: [] }
    ];
    execFileSync.mockReturnValueOnce(JSON.stringify(sccJson));

    const detector = new SlocDetector({});
    const result = await detector.detect(tempDir);

    // 回退块基于 FileCollector 逐文件统计出明细，总代码行仍以 scc 语言汇总为准
    expect(result.fileDetails.length).toBe(1);
    expect(result.fileDetails[0].filePath).toBe('a.js');
    expect(result.fileDetails[0].loc).toBe(2);
    expect(result.fileDetails[0].language).toBe('JavaScript');
    expect(result.codeScale).toBe(3);
  } finally {
    fs.rmSync(tempDir, { recursive: true, force: true });
    execFileSync.mockReset();
  }
});

export {};
