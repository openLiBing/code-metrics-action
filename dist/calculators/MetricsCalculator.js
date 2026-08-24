class MetricsCalculator {
  static mergeResults(slocResult, lizardResult, duplicationResult) {
    // 合并总体指标（排除 fileDetails / identicalFileDetails / duplicationOccurrences，单独处理）
    const { fileDetails: slocFileDetails, ...slocMetrics } = slocResult;
    const { fileDetails: lizardFileDetails, ...lizardMetrics } = lizardResult;
    // 显式提取 duplicationOccurrences，避免被 ...duplicationMetrics 散开混入总体指标
    const {
      fileDetails: duplicationFileDetails,
      identicalFileDetails,
      duplicationOccurrences,
      ...duplicationMetrics
    } = duplicationResult;

    // 合并文件级指标：以 sloc 的 fileDetails 为基础
    const fileDetails = MetricsCalculator.mergeFileDetails(
      slocFileDetails || [],
      lizardFileDetails || [],
      duplicationFileDetails || []
    );

    return {
      ...slocMetrics,
      ...lizardMetrics,
      ...duplicationMetrics,
      fileDetails: fileDetails,
      identicalFileDetails: identicalFileDetails || [],
      // 重复块出现位置列表（含每块的明文 content，由 uploader 做 Base64 编码后分批上报）
      duplicationOccurrences: duplicationOccurrences || []
    };
  }

  // 合并三个检测器的 fileDetails
  static mergeFileDetails(slocFileDetails, lizardFileDetails, duplicationFileDetails) {
    // 以 sloc 的 fileDetails 为基础（有 filePath, language, loc）
    const fileMap = new Map();

    for (const detail of slocFileDetails) {
      fileMap.set(detail.filePath, {
        filePath: detail.filePath,
        language: detail.language || '',
        loc: detail.loc || 0,
        commentLines: detail.commentLines || 0,
        functionCount: 0,
        avgFunctionLoc: 0,
        avgCyclomaticComplexity: 0,
        functionDetails: [],
        duplicationRate: 0,
        duplicationLineCount: 0,
        duplicatedFiles: []
      });
    }

    // 合并 lizard 的 fileDetails（按 filePath 匹配）
    for (const detail of lizardFileDetails) {
      const existing = fileMap.get(detail.filePath);
      if (existing) {
        existing.functionCount = detail.functionCount || 0;
        existing.avgFunctionLoc = detail.avgFunctionLoc || 0;
        existing.avgCyclomaticComplexity = detail.avgCyclomaticComplexity || 0;
        existing.functionDetails = detail.functionDetails || [];
      } else {
        fileMap.set(detail.filePath, {
          filePath: detail.filePath,
          language: '',
          loc: 0,
          commentLines: 0,
          functionCount: detail.functionCount || 0,
          avgFunctionLoc: detail.avgFunctionLoc || 0,
          avgCyclomaticComplexity: detail.avgCyclomaticComplexity || 0,
          functionDetails: detail.functionDetails || [],
          duplicationRate: 0,
          duplicationLineCount: 0,
          duplicatedFiles: []
        });
      }
    }

    // 合并 duplication 的 fileDetails（按 filePath 匹配）
    for (const detail of duplicationFileDetails) {
      const existing = fileMap.get(detail.filePath);
      if (existing) {
        existing.duplicationRate = detail.duplicationRate || 0;
        existing.duplicationLineCount = detail.duplicationLineCount || 0;
        existing.duplicatedFiles = detail.duplicatedFiles || [];
        // 上下文片段快照（重复块±5行，整体 Base64 编码），由 buildContextSegments 生成
        existing.snapshotData = detail.snapshotData || null;
      } else {
        fileMap.set(detail.filePath, {
          filePath: detail.filePath,
          language: '',
          loc: 0,
          commentLines: 0,
          functionCount: 0,
          avgFunctionLoc: 0,
          avgCyclomaticComplexity: 0,
          functionDetails: [],
          duplicationRate: detail.duplicationRate || 0,
          duplicationLineCount: detail.duplicationLineCount || 0,
          duplicatedFiles: detail.duplicatedFiles || [],
          snapshotData: detail.snapshotData || null
        });
      }
    }

    return [...fileMap.values()];
  }

  static validate(metrics) {
    const required = [
      'codeScale',
      'averageFunctionLoc',
      'averageCyclomaticComplexity',
      'totalCodeDuplicationRate',
      'totalFileDuplicationRate'
    ];

    for (const key of required) {
      if (metrics[key] === undefined || metrics[key] === null) {
        throw new Error(`Missing required metric: ${key}`);
      }
    }

    return true;
  }

  static formatForReport(metrics) {
    // 分离 fileDetails、identicalFileDetails、duplicationOccurrences 和总体指标
    const { fileDetails, identicalFileDetails, duplicationOccurrences, ...overallMetrics } = metrics;

    return {
      codeScale: Number(overallMetrics.codeScale) || 0,
      // 扫描代码总行数：代码 + 注释 + 空行的物理总行数（scc Lines 汇总，即 rawLines），
      // 区别于 codeScale（有效代码行）；sloc 检测器禁用时 rawLines 缺失，降级为 0
      codeLineTotal: Number(overallMetrics.rawLines) || 0,
      // 注释行数：直接取 sloc 检测器的 scc 汇总 commentLines（现成数据）；
      // 每文件 commentLines 明细仍随 fileDetails 落 file_detail，供文件级下钻
      commentLines: Number(overallMetrics.commentLines) || 0,
      // 总圈复杂度：lizard 函数圈复杂度总和（方法维度总量，与 avgCyclomaticComplexity 同源）
      complexityCount: Number(overallMetrics.totalCyclomaticComplexity) || 0,
      // 文件维度圈复杂度：Σ函数圈复杂度 ÷ 含函数的文件数（lizard 口径，
      // 区别于方法维度的 avgCyclomaticComplexity）
      cyclomaticComplexityPerFile: Number(overallMetrics.cyclomaticComplexityPerFile) || 0,
      // 重复代码块数量：重复块出现位置总数（与 duplication_block 表行数一致）
      duplicatedBlocks: Number(overallMetrics.duplicatedBlocks) || 0,
      // 重复代码行数量：Σ 每文件重复行数（totalCodeDuplicationRate 的分子）
      duplicatedLines: Number(overallMetrics.duplicatedLines) || 0,
      avgFunctionLoc: Number(overallMetrics.averageFunctionLoc) || 0,
      avgCyclomaticComplexity: Number(overallMetrics.averageCyclomaticComplexity) || 0,
      totalCodeDuplicationRate: Number(overallMetrics.totalCodeDuplicationRate) || 0,
      totalFileDuplicationRate: Number(overallMetrics.totalFileDuplicationRate) || 0,
      fileDetails: fileDetails || [],
      identicalFileDetails: identicalFileDetails || [],
      // 重复块出现位置列表（含明文 content），uploader 会 Base64 编码后分批上报
      duplicationOccurrences: duplicationOccurrences || []
    };
  }
}

module.exports = MetricsCalculator;
