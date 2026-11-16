/**
 * 运行摘要（Markdown）构建工具。
 * 从 src/index.js 抽出为无副作用模块，便于单测覆盖；GitHub/GitCode 两个平台统一使用摘要表展示。
 * GitHub Actions 侧摘要固定使用英文（平台面向国际用户），GitCode 侧保持中文不变。
 */

/** 摘要文案字典：zh 为 GitCode 现有文案，en 为 GitHub 侧全英文文案 */
const SUMMARY_TEXT = {
  zh: {
    title: '## 📊 代码度量指标扫描结果',
    scanTableHeader: '| 扫描信息 | 扫描值 |',
    labels: {
      repo: '仓库',
      branch: '分支',
      commit: '提交',
      pipeline: '流水线',
      finishedAt: '扫描完成时间'
    },
    overviewTitle: '### 指标概览',
    metricTableHeader: '| 指标 | 数值 | 说明 |',
    metrics: [
      { name: '代码规模', unit: ' 行', desc: '有效代码行数（排除空行与注释）' },
      { name: '平均函数代码行', unit: ' 行', desc: '函数体有效代码行的算术平均值' },
      { name: '平均圈复杂度', unit: '', desc: '函数级圈复杂度的算术平均值' },
      { name: '总代码重复率', unit: '%', desc: '重复代码行占有效代码行的比例' },
      { name: '总文件重复率', unit: '%', desc: '内容完全一致文件占总文件数的比例' }
    ],
    detailPrefix: '> 查看详情：',
    detailText: '代码度量指标扫描结果'
  },
  en: {
    title: '## 📊 Code Metrics Scan Result',
    scanTableHeader: '| Scan Info | Value |',
    labels: {
      repo: 'Repository',
      branch: 'Branch',
      commit: 'Commit',
      pipeline: 'Pipeline',
      finishedAt: 'Scan Completed At'
    },
    overviewTitle: '### Metrics Overview',
    metricTableHeader: '| Metric | Value | Description |',
    metrics: [
      {
        name: 'Code Scale',
        unit: ' lines',
        desc: 'Effective lines of code (excluding blank lines and comments)'
      },
      {
        name: 'Avg Function LOC',
        unit: ' lines',
        desc: 'Arithmetic mean of effective lines of code per function'
      },
      {
        name: 'Avg Cyclomatic Complexity',
        unit: '',
        desc: 'Arithmetic mean of function-level cyclomatic complexity'
      },
      {
        name: 'Total Code Duplication Rate',
        unit: '%',
        desc: 'Percentage of duplicated lines among effective lines of code'
      },
      {
        name: 'Total File Duplication Rate',
        unit: '%',
        desc: 'Percentage of identical files among all files'
      }
    ],
    detailPrefix: '> View details: ',
    detailText: 'Code Metrics Scan Result',
    // 服务端返回的 detailTip 为中文，英文模式下替换为通用英文提示，保证摘要全英文
    detailFallback:
      'Detail link is unavailable. Make sure the repository and branch are registered on the openLiBing platform.'
  }
};

/** Markdown 表格单元格转义：竖线必须转义，换行压平，避免撑破表格 */
function escapeCell(value) {
  return String(value === null || value === undefined || value === '' ? '-' : value)
    .replace(/\|/g, '\\|')
    .replace(/\r?\n/g, ' ');
}

/** 格式化为东八区时间（平台展示口径统一为 UTC+8） */
function formatCstTime(date) {
  const cst = new Date(date.getTime() + 8 * 3600 * 1000);
  return `${cst.toISOString().replace('T', ' ').slice(0, 19)} (UTC+8)`;
}

/**
 * 链接 URL 安全处理（Ref #76）：仅放行 http/https，编码会破坏 Markdown 链接结构的字符。
 * 非法协议或非法 URL 返回空串，由调用方降级为纯文本，避免 `)` 提前闭合链接目标后注入 Markdown。
 */
function safeLinkUrl(value) {
  const url = String(value || '').trim();
  if (!url) {
    return '';
  }
  let parsed;
  try {
    parsed = new URL(url);
  } catch {
    return '';
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    return '';
  }
  // 括号会提前闭合 Markdown 链接目标，空白/尖括号/引号可改变链接解析，统一百分号编码
  // 注：encodeURIComponent 不编码 ( ) ! * '，此处按字符显式转 %XX
  return url.replace(/[()<>\s"]/g, (c) => `%${c.charCodeAt(0).toString(16).toUpperCase().padStart(2, '0')}`);
}

/**
 * 生成运行摘要（Markdown 表格）。
 * GitHub Actions 没有 GitCode 那样的输出面板，只能在运行摘要页展示，故两个平台统一用摘要表呈现。
 *
 * @param {Object} ctx 扫描上下文（仓库、分支、提交、流水线、完成时间、详情链接）
 * @param {Object} result 扫描结果（5 项指标）
 * @param {Object} [options] 展示选项；english=true 时输出全英文摘要（GitHub 平台）
 * @returns {string} Markdown 文本
 */
function buildSummaryMarkdown(ctx, result, options = {}) {
  const text = options.english ? SUMMARY_TEXT.en : SUMMARY_TEXT.zh;
  const pipelineLabel = ctx.runNumber ? `#${ctx.runNumber}` : ctx.pipelineRunId || '-';
  const repoBase = String(ctx.gitUrl || '').replace(/\.git$/, '');
  const pipelineUrl = safeLinkUrl(
    repoBase && ctx.pipelineRunId ? `${repoBase}/actions/runs/${ctx.pipelineRunId}` : ''
  );
  const pipelineCell = pipelineUrl
    ? `[${escapeCell(pipelineLabel)}](${pipelineUrl})`
    : escapeCell(pipelineLabel);

  const scanRows = [
    [text.labels.repo, ctx.gitUrl],
    [text.labels.branch, ctx.branchName],
    [text.labels.commit, ctx.commitId ? String(ctx.commitId).slice(0, 8) : ''],
    [text.labels.pipeline, pipelineCell],
    [text.labels.finishedAt, ctx.finishedAt]
  ];
  // 指标值按字典顺序对应：代码规模、平均函数代码行、平均圈复杂度、总代码重复率、总文件重复率
  const metricValues = [
    result.codeScale,
    result.avgFunctionLoc,
    result.avgCyclomaticComplexity,
    result.totalCodeDuplicationRate,
    result.totalFileDuplicationRate
  ];
  const metricRows = text.metrics.map((metric, index) => [
    metric.name,
    `${metricValues[index]}${metric.unit}`,
    metric.desc
  ]);

  const lines = [
    text.title,
    '',
    text.scanTableHeader,
    '|:--|:--|',
    ...scanRows.map(([key, value]) => `| ${escapeCell(key)} | ${value === pipelineCell ? value : escapeCell(value)} |`),
    '',
    text.overviewTitle,
    '',
    text.metricTableHeader,
    '|:--|--:|:--|',
    ...metricRows.map(([key, value, desc]) => `| ${escapeCell(key)} | ${escapeCell(value)} | ${escapeCell(desc)} |`),
    ''
  ];
  // 详情链接同样只放行合法 http(s) URL；非法链接降级为提示文本，不生成 Markdown 链接
  const detailUrl = safeLinkUrl(ctx.detailLink);
  if (detailUrl) {
    lines.push(`${text.detailPrefix}[${text.detailText}](${detailUrl})`);
  } else if (ctx.detailTip) {
    // GitHub 摘要要求全英文：服务端提示为中文，英文模式下替换为通用英文提示
    lines.push(`> ${escapeCell(options.english ? text.detailFallback : ctx.detailTip)}`);
  }
  return `${lines.join('\n')}\n`;
}

module.exports = { escapeCell, formatCstTime, safeLinkUrl, buildSummaryMarkdown };
