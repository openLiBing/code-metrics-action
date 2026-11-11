/**
 * 运行摘要（Markdown）构建工具。
 * 从 src/index.js 抽出为无副作用模块，便于单测覆盖；GitHub/GitCode 两个平台统一使用摘要表展示。
 */

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
 * @returns {string} Markdown 文本
 */
function buildSummaryMarkdown(ctx, result) {
  const pipelineLabel = ctx.runNumber ? `#${ctx.runNumber}` : ctx.pipelineRunId || '-';
  const repoBase = String(ctx.gitUrl || '').replace(/\.git$/, '');
  const pipelineUrl = safeLinkUrl(
    repoBase && ctx.pipelineRunId ? `${repoBase}/actions/runs/${ctx.pipelineRunId}` : ''
  );
  const pipelineCell = pipelineUrl
    ? `[${escapeCell(pipelineLabel)}](${pipelineUrl})`
    : escapeCell(pipelineLabel);

  const scanRows = [
    ['仓库', ctx.gitUrl],
    ['分支', ctx.branchName],
    ['提交', ctx.commitId ? String(ctx.commitId).slice(0, 8) : ''],
    ['流水线', pipelineCell],
    ['扫描完成时间', ctx.finishedAt]
  ];
  const metricRows = [
    ['代码规模', `${result.codeScale} 行`, '有效代码行数（排除空行与注释）'],
    ['平均函数代码行', `${result.avgFunctionLoc} 行`, '函数体有效代码行的算术平均值'],
    ['平均圈复杂度', `${result.avgCyclomaticComplexity}`, '函数级圈复杂度的算术平均值'],
    ['总代码重复率', `${result.totalCodeDuplicationRate}%`, '重复代码行占有效代码行的比例'],
    ['总文件重复率', `${result.totalFileDuplicationRate}%`, '内容完全一致文件占总文件数的比例']
  ];

  const lines = [
    '## 📊 代码度量指标扫描结果',
    '',
    '| 扫描信息 | 扫描值 |',
    '|:--|:--|',
    ...scanRows.map(([key, value]) => `| ${escapeCell(key)} | ${value === pipelineCell ? value : escapeCell(value)} |`),
    '',
    '### 指标概览',
    '',
    '| 指标 | 数值 | 说明 |',
    '|:--|--:|:--|',
    ...metricRows.map(([key, value, desc]) => `| ${escapeCell(key)} | ${escapeCell(value)} | ${escapeCell(desc)} |`),
    ''
  ];
  // 详情链接同样只放行合法 http(s) URL；非法链接降级为提示文本，不生成 Markdown 链接
  const detailUrl = safeLinkUrl(ctx.detailLink);
  if (detailUrl) {
    lines.push(`> 查看详情：[代码度量指标扫描结果](${detailUrl})`);
  } else if (ctx.detailTip) {
    lines.push(`> ${escapeCell(ctx.detailTip)}`);
  }
  return `${lines.join('\n')}\n`;
}

module.exports = { escapeCell, formatCstTime, safeLinkUrl, buildSummaryMarkdown };
