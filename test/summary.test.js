/**
 * 运行摘要构建工具单测（从 src/index.js 抽出的纯函数）。
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const { escapeCell, formatCstTime, buildSummaryMarkdown } = require('../src/utils/summary');

test('escapeCell 处理空值、竖线与换行', () => {
  assert.equal(escapeCell(undefined), '-');
  assert.equal(escapeCell(null), '-');
  assert.equal(escapeCell(''), '-');
  assert.equal(escapeCell(0), '0');
  assert.equal(escapeCell('a|b'), 'a\\|b');
  assert.equal(escapeCell('line1\nline2'), 'line1 line2');
});

test('formatCstTime 固定输出东八区时间', () => {
  assert.equal(formatCstTime(new Date('2026-11-10T00:00:00Z')), '2026-11-10 08:00:00 (UTC+8)');
});

test('buildSummaryMarkdown 生成流水线链接、提交短 SHA 与详情入口', () => {
  const md = buildSummaryMarkdown(
    {
      gitUrl: 'https://gitcode.com/openlibing/code-metrics-action.git',
      branchName: 'master',
      commitId: 'abcdef1234567890',
      pipelineRunId: 'run-1',
      runNumber: '7',
      finishedAt: '2026-11-10 08:00:00 (UTC+8)',
      detailLink: 'https://example.com/detail'
    },
    {
      codeScale: 100,
      avgFunctionLoc: 10,
      avgCyclomaticComplexity: 2.5,
      totalCodeDuplicationRate: 1.2,
      totalFileDuplicationRate: 3.4
    }
  );
  assert.match(md, /\[#7\]\(https:\/\/gitcode\.com\/openlibing\/code-metrics-action\/actions\/runs\/run-1\)/);
  assert.match(md, /\| 提交 \| abcdef12 \|/);
  assert.match(md, /查看详情：\[代码度量指标扫描结果\]\(https:\/\/example\.com\/detail\)/);
  assert.match(md, /\| 代码规模 \| 100 行 \|/);
});

test('buildSummaryMarkdown 无流水线 ID 时展示占位并转义提示文本', () => {
  const md = buildSummaryMarkdown(
    {
      gitUrl: '',
      branchName: 'HEAD',
      commitId: '',
      pipelineRunId: '',
      runNumber: '',
      finishedAt: '',
      detailTip: 'no|link\nline2'
    },
    {
      codeScale: 0,
      avgFunctionLoc: 0,
      avgCyclomaticComplexity: 0,
      totalCodeDuplicationRate: 0,
      totalFileDuplicationRate: 0
    }
  );
  assert.match(md, /\| 流水线 \| - \|/);
  assert.match(md, /> no\\\|link line2/);
});

test('buildSummaryMarkdown 编码破坏链接结构的字符，非法协议降级为提示文本', () => {
  const result = {
    codeScale: 1,
    avgFunctionLoc: 1,
    avgCyclomaticComplexity: 1,
    totalCodeDuplicationRate: 0,
    totalFileDuplicationRate: 0
  };
  const baseCtx = {
    gitUrl: 'https://gitcode.com/openlibing/code-metrics-action.git',
    branchName: 'master',
    commitId: '',
    pipelineRunId: 'run-1',
    runNumber: '7',
    finishedAt: '2026-11-10 08:00:00 (UTC+8)'
  };

  // 右括号/空白必须编码，避免提前闭合链接目标后注入额外 Markdown
  const injected = buildSummaryMarkdown(
    { ...baseCtx, detailLink: 'https://example.com/a)(https://evil.example/a b' },
    result
  );
  assert.match(injected, /查看详情：\[代码度量指标扫描结果\]\(https:\/\/example\.com\/a%29%28https:\/\/evil\.example\/a%20b\)/);
  assert.doesNotMatch(injected, /\]\(https:\/\/evil\.example/);

  // 非 http(s) 协议不生成链接，降级展示 detailTip
  const jsScheme = buildSummaryMarkdown(
    { ...baseCtx, detailLink: 'javascript:alert(1)', detailTip: '链接不可用' },
    result
  );
  assert.doesNotMatch(jsScheme, /javascript:/);
  assert.match(jsScheme, /> 链接不可用/);
});
